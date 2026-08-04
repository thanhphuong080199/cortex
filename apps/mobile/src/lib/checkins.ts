import { randomUUID } from "expo-crypto";

import { NOW_ISO } from "./sql";

/**
 * Mood check-ins (life-domains spec §2.3). Inserts and deletes only -- a wrong mood is undone
 * and re-tapped, never edited -- and both work offline unchanged, because neither needs a
 * server-side decision.
 *
 * `updated_at` is deliberately not written. `packages/sync`'s local schema declares it, but
 * `public.checkins` has no such column (migration 00013), so anything written there exists on
 * this device only and is null the moment the server's version syncs back. See the handoff's
 * deferred list -- the local schema is what should lose the column.
 */
export interface CheckinTarget {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

export const LOG_CHECKIN_SQL = `INSERT INTO checkins (id, mood, energy, label, created_at)
     VALUES (?, ?, NULL, NULL, ${NOW_ISO})`;

/**
 * A DELETE, NOT an `UPDATE ... SET deleted_at`.
 *
 * This is the whole correctness of undo. The sync router accepts exactly two ops on checkins:
 *
 *     if (op.op === "DELETE") await checkins.softDelete(op.id);
 *     else if (op.op === "PUT") ...
 *     else throw { kind: "validation", message: "checkins are insert-or-delete only" };
 *
 * PowerSync turns a local `UPDATE` into a PATCH, which lands in that `throw`. The op is
 * reported in `failed` while the response is still 200, so the connector completes the batch
 * and the undo is discarded: the check-in stays on the server forever while the phone shows it
 * gone. A local `DELETE` becomes a DELETE op, which `softDelete` tombstones properly.
 *
 * Hard locally, soft on the server, and that asymmetry is intended: the row is gone from this
 * device because the user asked for it to be, and the server keeps the tombstone every synced
 * table needs.
 */
export const UNDO_CHECKIN_SQL = `DELETE FROM checkins WHERE id = ?`;

/** Returns the new row's id so the caller can offer an undo for it. */
export async function logCheckin(db: CheckinTarget, mood: number): Promise<string> {
  // React Native has no global `crypto.randomUUID`. The id is generated here rather than by
  // SQL's `uuid()` because the caller needs it back, and it is the same id the server row gets
  // -- the local optimistic row and the server row are one row, so a resend patches.
  const id = randomUUID();
  await db.execute(LOG_CHECKIN_SQL, [id, mood]);
  return id;
}

export async function undoCheckin(db: CheckinTarget, id: string): Promise<void> {
  await db.execute(UNDO_CHECKIN_SQL, [id]);
}
