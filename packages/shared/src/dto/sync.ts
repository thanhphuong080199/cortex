import { z } from "zod";

/**
 * Tables `POST /sync/upload` will write — everything a device is allowed to originate.
 *
 * A subset of SYNCED_TABLES, and the two were ONE list until 2026-08-22. Splitting them is
 * what lets chat_messages reach the device without becoming forgeable: the table holds the
 * assistant's own replies, `00006` grants `authenticated` full DML on it, and RLS scopes that
 * to the owner's rows — so an owner CAN insert a message their assistant never sent. Nothing
 * downstream of `syncOp` re-checks the table name; this enum is the check.
 */
export const UPLOADABLE_TABLES = [
  "notes", "tags", "note_tags", "links", "media_items", "checkins",
] as const;
export type UploadableTable = (typeof UPLOADABLE_TABLES)[number];

/**
 * Tables PowerSync replicates DOWN to the device. Everything uploadable, plus the ones the
 * server writes and the device only reads.
 *
 * `chat_messages` is the first of the read-only kind. It is here because chat is now the whole
 * app: opening it without a network and finding an empty screen is not a degraded experience
 * but a broken one (S1 spec §4).
 *
 * Server-only tables are deliberately absent (see `SERVER_ONLY_TABLES`); `integrations` in
 * particular holds credentials that must never reach a device.
 */
export const SYNCED_TABLES = [...UPLOADABLE_TABLES, "chat_messages"] as const;
export type SyncTable = (typeof SYNCED_TABLES)[number];

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
  // S3's per-session mood readings. Server-written, server-read, and read by nothing at all
  // today -- see the S3 spec §6. Listed here so schema.test.ts's "never declares a server-only
  // table" assertion covers it without anyone remembering to add it.
  "mood_readings",
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
  // UPLOADABLE, not SYNCED. See the comment on UPLOADABLE_TABLES: this line is the only thing
  // between a client and an inserted assistant reply.
  table: z.enum(UPLOADABLE_TABLES),
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
