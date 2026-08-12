import { Body, Controller, Inject, Post, UseGuards } from "@nestjs/common";
import type { AiClient } from "@cortex/core";
import { createServiceClient, errorMessage, mapPostgrestError, recordUsage } from "@cortex/core";
import { searchInput, type SearchInput, type SearchResult } from "@cortex/shared";
import { AI_CLIENT } from "./ai-client.provider";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";

/** A row exactly as `search_notes` returns it (supabase/migrations/00022_search_notes.sql). */
interface SearchRow {
  note_id: string;
  title: string | null;
  snippet: string;
  score: number;
  matched_by: string;
}

@Controller("search")
@UseGuards(SupabaseAuthGuard)
export class SearchController {
  // A service-role client -- search_notes is SECURITY DEFINER over note_chunks, which has RLS
  // enabled with no policies and is invisible to `authenticated` by design (see
  // 00022_search_notes.sql). Built once per controller instance (a singleton, like
  // enrich.module.ts's own `db: createServiceClient()`), not per request: it carries no
  // per-caller state (unlike createUserClient, which is stamped with the caller's JWT), so
  // there is nothing request-scoped to justify reallocating a full PostgREST/GoTrue/Realtime
  // client on every search.
  private readonly db = createServiceClient();

  constructor(@Inject(AI_CLIENT) private readonly ai: AiClient) {}

  @Post()
  async search(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(searchInput)) body: SearchInput,
  ): Promise<{ results: SearchResult[] }> {
    const { vectors, inputTokens, model } = await this.ai.embed([body.q]);
    const embedding = vectors[0];
    // noUncheckedIndexedAccess means `vectors[0]` is `number[] | undefined`. Failing loudly
    // here (a 500, via CoreErrorFilter's catch-all) beats silently passing `undefined` to the
    // RPC, which would either error opaquely inside Postgres or -- worse -- be accepted as a
    // legitimate-looking null argument.
    if (!embedding) {
      throw new Error("search: embed() returned no vector for the query");
    }

    // METERED, NOT GATED -- deliberately, and the asymmetry with the sweep is the point.
    //
    // Metered: every search embeds its query through Gemini, so without this row the ONLY place
    // that spend appears is Google's console. usage_ledger is what isOverBudget reads, and
    // isOverBudget is documented (enrich/budget.ts) as failing CLOSED specifically so an outage
    // in the spend query can never become unlimited spend -- a guarantee that means nothing for
    // a spend path the ledger never sees. The dollar figure is small (~$0.0000045 a query, ~200k
    // queries per dollar); the blind spot is what mattered.
    //
    // Not gated: refusing to let someone search their own notes because a BACKGROUND job
    // overspent is the wrong trade, and it would put a second round trip (isOverBudget's RPC) in
    // front of an interactive request. The budget's job is to bound what Cortex spends on its
    // own initiative; a search is the user asking.
    //
    // Never fatal: a failed ledger write must not turn a working search into a 500. The catch is
    // scoped to recordUsage alone and logs `errorMessage(err)` -- not the error object (PostgREST
    // errors are plain objects and stringify to "[object Object]"), and never `body.q`, which is
    // user content (§15.6 rule 1). A silent under-count is the accepted cost; the counter-case is
    // a ledger outage taking search down with it.
    //
    // The 'embed' inputTokens here is a chars/4 ESTIMATE, same caveat as embedNote's -- see
    // enrich/budget.ts's note. One row per search, one per note batch, summed alike.
    try {
      await recordUsage(this.db, {
        userId: user.id,
        kind: "embed",
        model,
        inputTokens,
        outputTokens: 0,
      });
    } catch (err) {
      console.error(`[search] usage_ledger write failed: ${errorMessage(err)}`);
    }

    // user.id comes from the VERIFIED JWT (SupabaseAuthGuard). search_notes runs as
    // service_role with RLS out of the picture, so this parameter is the only thing separating
    // two users' corpora -- it must never be read from the body. searchInput is .strict(), so a
    // body carrying a userId is a 400 rather than a value that gets quietly dropped.
    const { data, error } = await this.db.rpc("search_notes", {
      p_user_id: user.id,
      p_query: body.q,
      p_embedding: embedding,
      p_limit: body.limit ?? 20,
    });
    // mapPostgrestError, not a raw throw: a bare PostgREST error object ({message, details,
    // hint, code}, no `status`) matches none of CoreErrorFilter's branches (isCoreError needs
    // `kind`, it isn't an HttpException, and `exception instanceof Error` is false), so it fell
    // through to the catch-all with the log line `JSON.stringify(exception.cause)` on
    // `exception` itself -- the literal string "[object Object]", zero diagnostic for a
    // production PG failure (bad embedding dimension, a missing grant, anything). Wrapping it
    // gives CoreErrorFilter a `kind` to log `cause` under, without changing what the client
    // sees (still a generic 500 message -- PostgREST detail is not caller-facing, spec §6).
    if (error) throw mapPostgrestError(error);

    // The one place search_notes' snake_case columns (00022) are mapped to the camelCase DTO.
    // The Supabase client here is untyped (this repo generates no `Database` types), so `data`
    // arrives as `any` and the cast below is what gives the mapping something to check against.
    // Both halves are now pinned: SearchRow names what SQL returns, and the annotated
    // Promise<{ results: SearchResult[] }> names what @cortex/shared promises the clients --
    // so renaming a column on either side fails to compile HERE rather than rendering
    // `undefined` on web and mobile with every other package still green.
    const rows = (data ?? []) as SearchRow[];
    return {
      results: rows.map((r) => ({
        noteId: r.note_id,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
        matchedBy: r.matched_by,
      })),
    };
  }
}
