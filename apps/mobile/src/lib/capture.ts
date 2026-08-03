import type { NoteDomain } from "@cortex/shared";

/**
 * The local INSERT behind quick capture (spec §5.2).
 *
 * Writes straight into local SQLite. The row IS the note -- there is no queue to inspect and
 * no "pending" state, because PowerSync's upload queue is the pending state. Capture therefore
 * succeeds in airplane mode through exactly the same code path as online.
 *
 * TIMESTAMPS ARE ISO-8601 WITH A `Z`, NOT `datetime('now')`. SQLite's `datetime()` returns
 * `2026-08-03 10:00:00` -- space-separated, second precision, no zone. Two things break on
 * that:
 *
 *   - Sorting. Rows the server has echoed back carry ISO strings with a `T`. In ASCII a space
 *     (0x20) sorts before `T` (0x54), so within one day every locally captured note sorts
 *     ahead of every synced note regardless of its actual time. Task 19 orders by these.
 *   - The conflict-copy base. `syncOp.base_updated_at` is `z.iso.datetime()`, which rejects
 *     both the space form and a numeric offset -- it demands the `Z`. Task 20 reads
 *     `notes.updated_at` into `note_edit_base` and sends it back, so a non-ISO local value
 *     is rejected server-side rather than merely sorted oddly.
 *
 * `%f` is seconds with milliseconds (`05.123`), so this yields `2026-08-03T10:00:00.123Z`.
 *
 * `uuid()` is registered by the PowerSync SQLite core extension, not by SQLite -- PowerSync's
 * own AttachmentQueue relies on it (`SELECT uuid() as id`).
 *
 * `lifecycle`, `source_type` and `pinned` repeat the server's column defaults from migration
 * 00002 deliberately: the local row must look the way the synced row will, or the note visibly
 * changes under the user when replication echoes it back. The server ignores these fields on
 * the way up -- `createWithId` inserts only id, content, title, domain and domain_meta -- so
 * they are here for local fidelity, not to instruct the server.
 */
export const CAPTURE_NOTE_SQL = `INSERT INTO notes (id, content, title, domain, domain_meta, lifecycle,
                    source_type, pinned, created_at, updated_at)
     VALUES (uuid(), ?, NULL, ?, '{}', 'inbox', 'quick', 0,
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export interface CaptureInput {
  content: string;
  domain: NoteDomain | null;
}

/** Anything that can run a parameterised statement -- PowerSync's db, or SQLite in a test. */
export interface CaptureTarget {
  execute(sql: string, params: unknown[]): Promise<unknown>;
}

/**
 * Returns false without writing when there is nothing to capture.
 *
 * Whitespace-only input is the accidental-tap case, and an empty note is indistinguishable
 * from a bug once it has synced. The stored content is trimmed for the same reason the check
 * is: what was rejected as empty must not be what gets written.
 */
export async function captureNote(db: CaptureTarget, input: CaptureInput): Promise<boolean> {
  const content = input.content.trim();
  if (!content) return false;
  await db.execute(CAPTURE_NOTE_SQL, [content, input.domain]);
  return true;
}
