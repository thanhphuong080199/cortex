import { z } from "zod";

export const createTagInput = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type CreateTagInput = z.infer<typeof createTagInput>;

export const attachTagInput = z.object({ tagId: z.uuid() });
export type AttachTagInput = z.infer<typeof attachTagInput>;
