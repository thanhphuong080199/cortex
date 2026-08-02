import { z } from "zod";

/**
 * Tables PowerSync replicates to Android clients, and therefore the only tables
 * POST /sync/upload will write. Narrower than parent spec §6.7, which listed tables that
 * still have no service or UI: each table joins this list in the phase that builds its
 * feature, with its sync rule and isolation test in the same PR.
 *
 * `flashcards` is deliberately absent (phase 6). Server-only tables -- note_chunks,
 * ingest_inbox, memory_revisions, feedback_events, usage_ledger, integrations -- must
 * never appear here; integrations in particular holds credentials that never leave the
 * server.
 */
export const SYNC_TABLES = [
  "notes", "tags", "note_tags", "links", "media_items", "checkins",
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export const syncOpKind = z.enum(["PUT", "PATCH", "DELETE"]);

export const syncOp = z.object({
  // PowerSync's own op id, echoed back so the client can correlate a per-op failure.
  op_id: z.string().min(1).max(64),
  op: syncOpKind,
  table: z.enum(SYNC_TABLES),
  id: z.string().uuid(),
  data: z.record(z.string(), z.unknown()).nullish(),
  // The notes.updated_at the client's edit was based on. Present only on notes PATCH;
  // absent means "no base known", which the router treats as an unconditional update.
  base_updated_at: z.string().datetime().optional(),
});
export type SyncOp = z.infer<typeof syncOp>;

// 500 caps a single request's work: the router replays ops sequentially through core
// services, each of which is at least one PostgREST round trip. PowerSync retries the
// remainder in the next batch, so a cap costs latency, never data.
export const syncUploadInput = z.object({
  ops: z.array(syncOp).min(1).max(500),
});
export type SyncUploadInput = z.infer<typeof syncUploadInput>;
