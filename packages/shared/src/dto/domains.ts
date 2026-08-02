import { z, type ZodType } from "zod";
import { noteDomain } from "../enums.js";
import { pendingMediaItem } from "./media.js";

export type NoteDomain = z.infer<typeof noteDomain>;

// Life-domains spec §2.1. Every field is optional and every schema is `.strict()`:
//
// - optional, because freeform text remains the source of truth. Structure is
//   *extracted* from the note by phase-2 enrichment, never demanded at capture -- the
//   pattern the workout-logging research validates. `{}` is always valid.
// - strict, because domain_meta is untyped jsonb at the database layer, so a typo
//   ('ratng') would otherwise persist silently forever and never be read back.
//
// Keyed by NoteDomain so adding an enum value is a compile error here until it gets a
// schema; domains.test.ts asserts the key set matches the enum at runtime too.
export const domainMetaSchemas: Record<NoteDomain, ZodType> = {
  media: z.object({
    rating: z.number().int().min(1).max(5).optional(),
    consumed_at: z.iso.date().optional(),
    status: z.enum(["finished", "in_progress", "abandoned"]).optional(),
    // Present only between an offline device's write and this note's next upload
    // resolution (MediaService.resolveNoteMediaLink), which deletes the key -- see there
    // for why leaving it behind would fail this same strict schema on the next validate.
    pending_item: pendingMediaItem.optional(),
  }).strict(),
  health: z.object({
    activity_type: z.string().max(100).optional(),
    duration_min: z.number().int().positive().optional(),
    intensity: z.number().int().min(1).max(5).optional(),
  }).strict(),
  finance: z.object({
    amount: z.number().optional(),
    currency: z.string().length(3).optional(),      // ISO 4217
    decision_type: z.enum(["purchase", "investment", "other"]).optional(),
  }).strict(),
  learning: z.object({
    language: z.string().max(50).optional(),
    topic: z.string().max(200).optional(),
  }).strict(),
  // Freeform only -- the note body carries everything worth carrying.
  life: z.object({}).strict(),
  reflection: z.object({}).strict(),
};

/** Validates a domain_meta payload against its domain's shape. */
export function validateDomainMeta(domain: NoteDomain, meta: unknown) {
  return domainMetaSchemas[domain].safeParse(meta);
}
