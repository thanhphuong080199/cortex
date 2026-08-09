import type { NoteLifecycle } from "@cortex/shared";

import { NOW_ISO } from "./sql";

/**
 * The three local mutations the editor performs.
 *
 * They live here rather than in the screen for the same reason the capture statement does:
 * anything importing a React Native component dies under the suite's `environment: "node"`, so
 * SQL left in a `.tsx` is SQL nothing can execute in a test — and these carry the timestamp
 * format the entire conflict path depends on.
 *
 * Every one stamps `updated_at` through `NOW_ISO`. The conflict base no longer reads that column
 * -- it is a body now, because `updated_at` is server-owned and the two never matched -- but the
 * format still decides how locally written rows SORT against synced ones, which is the first of
 * the three failures documented in `sql.ts`.
 */
export interface NoteEditTarget {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

export const UPDATE_CONTENT_SQL = `UPDATE notes SET content = ?, updated_at = ${NOW_ISO} WHERE id = ?`;

export const SET_LIFECYCLE_SQL = `UPDATE notes SET lifecycle = ?, updated_at = ${NOW_ISO} WHERE id = ?`;

/**
 * Soft delete, never a real one: the row has to survive so the deletion replicates and so the
 * trash view has something to show. `deleted_at` and `updated_at` are stamped together — a
 * delete that does not move `updated_at` is a change the server cannot order against others.
 *
 * The `IS NULL` / `IS NOT NULL` guards make each statement a no-op against a row already in
 * the target state, matching `NoteService.softDelete` and `NoteService.restore`. Without them
 * a repeat tap re-stamps both columns, and since PowerSync emits every local UPDATE as a
 * PATCH, that is a server round trip for nothing plus an `updated_at` that reorders the row
 * against edits that really happened.
 */
export const TRASH_NOTE_SQL = `UPDATE notes SET deleted_at = ${NOW_ISO}, updated_at = ${NOW_ISO} WHERE id = ? AND deleted_at IS NULL`;

export const RESTORE_NOTE_SQL = `UPDATE notes SET deleted_at = NULL, updated_at = ${NOW_ISO} WHERE id = ? AND deleted_at IS NOT NULL`;

export async function updateNoteContent(
  db: NoteEditTarget,
  id: string,
  content: string,
): Promise<void> {
  await db.execute(UPDATE_CONTENT_SQL, [content, id]);
}

export async function setNoteLifecycle(
  db: NoteEditTarget,
  id: string,
  lifecycle: NoteLifecycle,
): Promise<void> {
  await db.execute(SET_LIFECYCLE_SQL, [lifecycle, id]);
}

export async function trashNote(db: NoteEditTarget, id: string): Promise<void> {
  await db.execute(TRASH_NOTE_SQL, [id]);
}

export async function restoreNote(db: NoteEditTarget, id: string): Promise<void> {
  await db.execute(RESTORE_NOTE_SQL, [id]);
}
