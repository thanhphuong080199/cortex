import { z } from "zod";

// Mirrors the checkins table (00013): scores are 1..5 smallints and at least one of
// mood/energy must be present, matching the checkins_mood_or_energy constraint. The
// refine is what turns "label only" into a 400 with a message rather than a raw 23514.
export const createCheckinInput = z.object({
  mood: z.number().int().min(1).max(5).optional(),
  energy: z.number().int().min(1).max(5).optional(),
  label: z.string().max(100).optional(),          // the optional 1-2 words
}).refine((o) => o.mood !== undefined || o.energy !== undefined, {
  message: "mood or energy required",
});
export type CreateCheckinInput = z.infer<typeof createCheckinInput>;
