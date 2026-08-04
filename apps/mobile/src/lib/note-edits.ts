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
 * Every one stamps `updated_at` through `NOW_ISO`. That column is what the NEXT editing session
 * records as its `base_updated_at` and what the connector sends to a server that validates it
 * as `z.iso.datetime()`, so a `datetime('now')` here is not a formatting nit — it is an upload
 * the server rejects.
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
 */
export const TRASH_NOTE_SQL = `UPDATE notes SET deleted_at = ${NOW_ISO}, updated_at = ${NOW_ISO} WHERE id = ?`;

export const RESTORE_NOTE_SQL = `UPDATE notes SET deleted_at = NULL, updated_at = ${NOW_ISO} WHERE id = ?`;

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
