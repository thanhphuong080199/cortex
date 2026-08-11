import { z } from "zod";

// .strict() rejects any key this schema doesn't define -- e.g. a body-supplied userId -- with a
// 400 instead of silently dropping it. That distinction is load-bearing: POST /search's
// isolation depends on p_user_id coming ONLY from the verified JWT, never from the request
// body, so a client that thinks it's supplying a user id must find out immediately, not have
// the field quietly ignored while the request still succeeds.
export const searchInput = z
  .object({
    q: z.string().trim().min(1).max(500),
    limit: z.number().int().positive().max(50).optional(),
  })
  .strict();
export type SearchInput = z.infer<typeof searchInput>;

/**
 * One row of POST /search's `{ results: [...] }` body -- the OUTPUT half of this DTO, which for a
 * while only existed as three hand-copied interface declarations (search.controller.ts,
 * apps/web/src/lib/api.ts, apps/mobile/src/lib/semantic-search.ts) with nothing binding them.
 *
 * Three copies of a shape is not three times the safety, it is zero: renaming `matchedBy`
 * server-side typechecked cleanly in all four packages, because each client was describing what
 * it HOPED to receive rather than what the server had agreed to send. Both clients would then
 * have rendered `undefined` -- web's `WHY[r.matchedBy]` falls through to showing the raw value,
 * so the regression surfaces as slightly-wrong copy under every result, not as a crash anyone
 * would notice. Declaring it once here makes the controller's mapping the thing that fails to
 * compile, which is where the change actually is.
 *
 * A plain interface, not a zod schema: unlike searchInput this is never PARSED. The server
 * builds it from search_notes' rows and the clients consume it, so there is no untrusted
 * boundary for a schema to guard -- adding one would imply a runtime check nobody performs.
 *
 * `matchedBy` is `string`, not the `"vector" | "fts" | "both"` union 00022 emits today. The
 * clients already treat an unrecognised value as displayable text (web's `WHY[...] ?? r.matchedBy`),
 * so widening the SQL function's vocabulary must not be a breaking type change for them.
 */
export interface SearchResult {
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  matchedBy: string;
}
