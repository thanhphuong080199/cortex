import { z } from "zod";
import { noteLifecycle } from "../enums.js";

export const createNoteInput = z.object({
  content: z.string().max(100_000),
  title: z.string().max(500).optional(),
});
export type CreateNoteInput = z.infer<typeof createNoteInput>;

// `title: null` is meaningfully different from `title` absent -- null clears the title,
// absent leaves it untouched -- so title is `.nullable().optional()` and the service
// patches on `!== undefined`, not on truthiness.
export const updateNoteInput = z
  .object({
    content: z.string().max(100_000).optional(),
    title: z.string().max(500).nullable().optional(),
    lifecycle: noteLifecycle.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "at least one field required");
export type UpdateNoteInput = z.infer<typeof updateNoteInput>;
