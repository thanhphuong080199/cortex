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
