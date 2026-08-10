import { z } from "zod";

/**
 * Tables PowerSync replicates to Android clients, and therefore the only tables
 * POST /sync/upload will write. Narrower than parent spec §6.7, which listed tables that
 * still have no service or UI: each table joins this list in the phase that builds its
 * feature, with its sync rule and isolation test in the same PR.
 *
 * Server-only tables are deliberately absent from here (see `SERVER_ONLY_TABLES` below);
 * they must never appear here, as integrations in particular holds credentials that never
 * leave the server.
 */
export const SYNC_TABLES = [
  "notes", "tags", "note_tags", "links", "media_items", "checkins",
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/**
 * Tables deliberately absent from the PowerSync sync rules and from the `powersync`
 * publication. The omission is load-bearing -- `integrations` holds credentials that must
 * never reach a device, and the rest are server-side machinery -- so it is asserted rather
 * than trusted: packages/db's sync-rules isolation suite and packages/sync's schema suite
 * both read this list.
 *
 * ONE copy. Two hand-maintained copies existed until 2026-08-10, which is the same
 * parallel-list trap phase 1b's Task 22 fixed for the media status vocabulary.
 */
export const SERVER_ONLY_TABLES = [
  "note_chunks",
  "usage_ledger",
  "integrations",
  "feedback_events",
  "memory_revisions",
  "ingest_inbox",
  "flashcards",
  "note_enrichment",
] as const;

export const syncOpKind = z.enum(["PUT", "PATCH", "DELETE"]);

export const syncOp = z.object({
  // PowerSync's own op id, echoed back so the client can correlate a per-op failure.
  op_id: z.string().min(1).max(64),
  op: syncOpKind,
  table: z.enum(SYNC_TABLES),
  // Zod v4 top-level form, matching tags.ts. (media.ts uses z.iso.date(), a different
  // top-level constructor for a different type -- not this one.) The chained
  // z.string().uuid() still works but is deprecated and would leave two styles in one package.
  id: z.uuid(),
  data: z.record(z.string(), z.unknown()).nullish(),
  /**
   * The note BODY the client's edit was based on. The connector sends it only on a notes
   * PATCH -- this schema does not gate that, and accepting a stray one elsewhere is harmless
   * because nothing downstream reads it.
   *
   * It was `base_updated_at: z.iso.datetime()` and that could not work, for two independent
   * reasons that both produced the same symptom: a conflict copy on EVERY edit, with nothing
   * in conflict.
   *
   *   1. `notes.updated_at` is server-owned. The insert path ignores whatever the client sends
   *      (`default now()`), and `notes_set_updated_at` overwrites it on every update. A note
   *      created on a device therefore holds the DEVICE clock locally and a Postgres clock on
   *      the server -- two different instants, never equal.
   *   2. Even for a note the device downloaded, the two serialisers disagree. PowerSync writes
   *      `2026-08-04T04:13:37.916374Z`; PostgREST returns `2026-08-04T04:13:37.916374+00:00`.
   *      Same instant, same precision, different zone suffix -- and the server compared them
   *      as strings.
   *
   * Both are gone here rather than papered over with `Date.parse`, which would fix (2) and
   * leave (1). A body is the thing the user actually edited: it needs no clock, survives any
   * serialiser, and does not depend on the device having completed a download first.
   *
   * An empty string is a legitimate base -- a user may edit a note down to nothing and then
   * edit it again -- so callers must test for `undefined`, never for falsiness.
   */
  base_content: z.string().optional(),
});
export type SyncOp = z.infer<typeof syncOp>;

/**
 * Caps a single request's work: the router replays ops sequentially through core services,
 * each of which is at least one PostgREST round trip. PowerSync retries the remainder in the
 * next batch, so a cap costs latency, never data.
 *
 * Exported because the MOBILE CONNECTOR has to respect it too, and a second literal would be
 * silent data loss rather than a mismatch. `getCrudBatch()` with no limit can return more ops
 * than this; that request is rejected 400, and the connector treats 4xx as permanent and
 * discards the batch. The client must therefore ask for at most this many.
 */
export const SYNC_UPLOAD_MAX_OPS = 500;

export const syncUploadInput = z.object({
  ops: z.array(syncOp).min(1).max(SYNC_UPLOAD_MAX_OPS),
});
export type SyncUploadInput = z.infer<typeof syncUploadInput>;
