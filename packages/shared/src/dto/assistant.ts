import { z } from "zod";

/**
 * `.strict()`, matching searchInput: a body carrying a userId must be a 400, not a value the
 * server quietly drops. The user id comes from the verified JWT and nowhere else.
 */
export const assistantInput = z
  .object({
    noteId: z.string().uuid(),
    sessionId: z.string().uuid().optional(),
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
