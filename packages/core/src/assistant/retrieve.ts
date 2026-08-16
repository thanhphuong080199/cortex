import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiClient } from "../ai/client.js";
import { recordUsage } from "../enrich/budget.js";
import { errorMessage, mapPostgrestError } from "../errors.js";

export interface Citation {
  /** Matches @cortex/shared's Citation. Set at construction so nothing downstream maps. */
  type: "note";
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  matchedBy: string;
}

/** A row exactly as `search_notes` returns it (supabase/migrations/00026_vietnamese_fts.sql). */
interface SearchRow {
  note_id: string;
  title: string | null;
  snippet: string;
  score: number;
  matched_by: string;
}

/**
 * One retrieval path for both branches of a turn -- a question's citations and a statement's
 * "you wrote about this before" are the same query with the same ranking.
 *
 * `db` MUST be the service-role client: search_notes is SECURITY DEFINER over note_chunks,
 * which has RLS enabled with no policies and is invisible to `authenticated` by design.
 * `userId` therefore comes from the verified JWT and never from anything the caller typed --
 * with RLS out of the picture it is the only thing separating two users' corpora.
 */
export async function retrieve(
  deps: { db: SupabaseClient; ai: AiClient },
  args: { userId: string; text: string; requestId: string; limit?: number },
): Promise<Citation[]> {
  const { db, ai } = deps;
  const { vectors, inputTokens, model } = await ai.embed([args.text]);
  const embedding = vectors[0];
  // noUncheckedIndexedAccess makes this `number[] | undefined`. Failing loudly beats passing
  // `undefined` into the RPC, which Postgres would accept as a legitimate-looking null argument
  // and answer from FTS alone -- a plausible result set that is quietly half the search.
  if (!embedding) throw new Error("assistant: embed() returned no vector for the query");

  // Metered, never fatal -- the same trade search.controller.ts documents. A ledger outage
  // must not turn a working turn into a failed one; a silent under-count is the accepted cost.
  // errorMessage, not String(err): PostgREST errors are plain objects and stringify to
  // "[object Object]". Never log args.text -- it is note content (§15.6 rule 1); the requestId
  // is an opaque correlation id (00027's column) and is not, so a ledger outage yields N lines
  // that can each be traced back to a turn rather than N identical ones.
  //
  // The catch is scoped to recordUsage ALONE, deliberately. Widening it to cover the search
  // below would turn a failed search into an empty citation list, and the answer prompt cannot
  // tell "you have no notes about this" apart from "the search broke" -- so the model would
  // answer from general knowledge as if it were the user's own thinking.
  //
  // The ORDER is load-bearing too: the money is spent at ai.embed above, so the ledger row is
  // written before the search rather than after it. Moving this below the RPC would leave every
  // failed search as an unbilled embed -- the blind spot the ledger exists to close.
  try {
    await recordUsage(db, {
      userId: args.userId, kind: "embed", model, inputTokens, outputTokens: 0,
      source: "assistant", requestId: args.requestId, contentChars: args.text.length,
    });
  } catch (err) {
    console.error(
      `[assistant] usage_ledger write failed (request ${args.requestId}): ${errorMessage(err)}`,
    );
  }

  const { data, error } = await db.rpc("search_notes", {
    p_user_id: args.userId,
    p_query: args.text,
    p_embedding: embedding,
    p_limit: args.limit ?? 5,
  });
  // Mapped, not rethrown raw. This module is on the HTTP path (POST /assistant), and a raw
  // PostgrestError has no `kind`, is not an HttpException, and carries `code` but no `status` --
  // so CoreErrorFilter falls through every branch and logs the literal "[object Object]". The
  // sweep's modules (budget/embed/extract) rethrow raw because they never reach the filter.
  // The PostgREST internals stay in `cause`, out of the caller-facing message (errors.ts:9-13).
  if (error) throw mapPostgrestError(error);

  // Five, not search's twenty: these go into a prompt, not a scrollable result list, and every
  // extra snippet is context budget spent on a note the answer will not cite.
  return ((data ?? []) as SearchRow[]).map((r) => ({
    type: "note" as const,
    noteId: r.note_id,
    title: r.title,
    snippet: r.snippet,
    score: r.score,
    matchedBy: r.matched_by,
  }));
}
