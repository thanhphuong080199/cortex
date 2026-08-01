import { z } from "zod";
import { mediaKind } from "../enums.js";

// One media log: find-or-create the item, then write a note carrying the impression.
// `title` is trimmed here rather than in the service, so " Dune " and "Dune" collapse to
// one media_items row before find-or-create ever runs its lookup.
export const logMediaInput = z.object({
  kind: mediaKind,
  title: z.string().trim().min(1).max(500),
  year: z.number().int().min(1000).max(2100).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  impression: z.string().max(100_000).optional(),  // same ceiling as note content
  consumedAt: z.iso.date().optional(),
  // Absent means "finished" (the service defaults it): the common case stays one tap,
  // but a book 40 pages in is no longer asserted finished by omission.
  status: z.enum(["finished", "in_progress", "abandoned"]).optional(),
});
export type LogMediaInput = z.infer<typeof logMediaInput>;
