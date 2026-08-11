import { Body, Controller, Inject, Post, UseGuards } from "@nestjs/common";
import type { AiClient } from "@cortex/core";
import { createServiceClient } from "@cortex/core";
import { searchInput, type SearchInput } from "@cortex/shared";
import { AI_CLIENT } from "./ai-client.provider";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("search")
@UseGuards(SupabaseAuthGuard)
export class SearchController {
  constructor(@Inject(AI_CLIENT) private readonly ai: AiClient) {}

  @Post()
  async search(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(searchInput)) body: SearchInput,
  ) {
    // A fresh service-role client per request -- search_notes is SECURITY DEFINER over
    // note_chunks, which has RLS enabled with no policies and is invisible to `authenticated`
    // by design (see 00022_search_notes.sql).
    const db = createServiceClient();

    const { vectors } = await this.ai.embed([body.q]);
    const embedding = vectors[0];
    // noUncheckedIndexedAccess means `vectors[0]` is `number[] | undefined`. Failing loudly
    // here (a 500, via CoreErrorFilter's catch-all) beats silently passing `undefined` to the
    // RPC, which would either error opaquely inside Postgres or -- worse -- be accepted as a
    // legitimate-looking null argument.
    if (!embedding) {
      throw new Error("search: embed() returned no vector for the query");
    }

    // user.id comes from the VERIFIED JWT (SupabaseAuthGuard). search_notes runs as
    // service_role with RLS out of the picture, so this parameter is the only thing separating
    // two users' corpora -- it must never be read from the body. searchInput is .strict(), so a
    // body carrying a userId is a 400 rather than a value that gets quietly dropped.
    const { data, error } = await db.rpc("search_notes", {
      p_user_id: user.id,
      p_query: body.q,
      p_embedding: embedding,
      p_limit: body.limit ?? 20,
    });
    if (error) throw error;

    return {
      results: (data ?? []).map((r: Record<string, unknown>) => ({
        noteId: r.note_id,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
        matchedBy: r.matched_by,
      })),
    };
  }
}
