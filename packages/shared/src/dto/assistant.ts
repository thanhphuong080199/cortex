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
    /**
     * The caller's IANA time zone, e.g. "Asia/Ho_Chi_Minh". Both clients read it from
     * `Intl.DateTimeFormat().resolvedOptions().timeZone`, which needs no permission and no
     * stored setting -- and which follows the user when they travel, unlike a column would.
     *
     * Optional, and never trusted: the server runs it through `resolveTimeZone` before it
     * reaches Intl. The cap is a sanity bound on an untrusted string, not a real limit -- the
     * longest IANA identifier is about 30 characters.
     */
    timeZone: z.string().max(64).optional(),
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
  /**
   * The discriminator, added in stage C3. Rows written before C3 have no `type` at all; read
   * them through `readCitation`, which defaults a missing one to "note". Never widen this to
   * `string`: the whole point is that a reader can switch on it exhaustively.
   */
  type: "note";
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  matchedBy: string;
}

/** A web source Gemini grounded an answer on (life-domains spec §6.2). */
export interface WebCitation {
  type: "web";
  url: string;
  title: string;
}

export type AnyCitation = Citation | WebCitation;

/**
 * Reads one entry out of a persisted `chat_messages.citations` array.
 *
 * `citations` is jsonb and therefore has no shape the database enforces, so this is where the
 * shape is decided: a missing `type` means a pre-C3 row and reads as a note, and anything
 * unreadable is dropped rather than rendered. One bad entry must not cost the user the rest of
 * the transcript.
 */
export function readCitation(raw: unknown): AnyCitation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (r.type === "web") {
    return typeof r.url === "string" && r.url !== ""
      ? { type: "web", url: r.url, title: typeof r.title === "string" ? r.title : r.url }
      : null;
  }
  if (typeof r.noteId !== "string") return null;
  return {
    type: "note",
    noteId: r.noteId,
    title: typeof r.title === "string" ? r.title : null,
    snippet: typeof r.snippet === "string" ? r.snippet : "",
    score: typeof r.score === "number" ? r.score : 0,
    matchedBy: typeof r.matchedBy === "string" ? r.matchedBy : "",
  };
}
