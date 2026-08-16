import { z } from "zod";

/**
 * `.strict()`, matching searchInput: a body carrying a userId must be a 400, not a value the
 * server quietly drops. The user id comes from the verified JWT and nowhere else.
 */
export const assistantInput = z
  .object({
    noteId: z.string().uuid(),
    sessionId: z.string().uuid().optional(),
    /**
     * Present when the caller has a note the server may not have yet -- mobile writes to local
     * SQLite first and PowerSync uploads on its own schedule, so the first turn about a note
     * always races the upload. The turn creates it if it is missing (get-or-create) and
     * otherwise ignores this: once the row exists, the text comes from `content_text` in the
     * database and never from the caller's copy of it.
     *
     * The cap matches createNoteInput's 100_000. Restating it as a smaller number here would
     * make the same note acceptable through POST /notes and rejected through here.
     */
    content: z.string().min(1).max(100_000).optional(),
    /** An offline capture's real timestamp, not the reconnect time. Same field NoteService takes. */
    createdAt: z.string().datetime().optional(),
  })
  .strict();

export type AssistantInput = z.infer<typeof assistantInput>;

/**
 * One row of the `citations` SSE event `POST /assistant` streams -- the OUTPUT half of the
 * contract, mirroring how `SearchResult` (search.ts, same directory) already documents the
 * reasoning for declaring a response shape once in `@cortex/shared` rather than letting each
 * package redeclare its own copy: "three copies of a shape is not three times the safety, it is
 * zero."
 *
 * `@cortex/core`'s `assistant/retrieve.ts` also declares a `Citation` interface with this exact
 * shape. That copy is NOT replaced by this one and the two are not import-linked -- `apps/web`
 * depends on `@cortex/shared` only, not `@cortex/core`, so adding a dependency purely to reach a
 * type would be a heavier coupling than the HTTP/JSON boundary between server and browser needs.
 * TypeScript's structural typing already makes the two interchangeable on either side of that
 * boundary; the redundancy here is between a server-internal type and a wire type, not between
 * two clients of the same code, which is the case the `SearchResult` doc comment warns against.
 */
export interface Citation {
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  matchedBy: string;
}
