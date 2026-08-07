/** Anything that can read one row and run a statement -- PowerSync's db, or SQLite in a test. */
export interface EditBaseTarget {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Remembers the note BODY an editing session started from (spec §6.2). The connector attaches
 * it to the upload so the server can tell "the phone edited a stale body" from "the phone
 * edited the current one".
 *
 * IT USED TO REMEMBER `notes.updated_at`, AND THAT COULD NOT WORK. `updated_at` is server-owned
 * -- the insert path ignores what the client sends and `notes_set_updated_at` overwrites it on
 * every update -- so a note created on this device holds a device clock the server has never
 * seen. And for a note downloaded from the server the two serialisers still disagree: PowerSync
 * writes `2026-08-04T04:13:37.916374Z` where PostgREST returns `...916374+00:00`. Either way the
 * server's string comparison found the row "moved" and every single edit produced a conflict
 * copy with nothing in conflict. A body needs no clock and no agreement between serialisers.
 *
 * Written ONCE per session and never overwritten. Refreshing it would walk the base forward to
 * the user's own last local write, the server's check would never fire, and conflict handling
 * would silently degrade to last-write-wins -- which is the whole thing this prevents. The
 * connector clears it after a successful upload.
 *
 * THE VALUE MUST BE THE BODY THE USER ACTUALLY STARTED FROM, captured when the editor seeded
 * its text -- not whatever the row says at first save. The editor seeds its content once and
 * then leaves it alone, so a change arriving from the server mid-session replaces the row's
 * body while the text on screen still reflects the older one. Passing the row's current value
 * there would record a base saying the user edited the NEW version, the server would find
 * nothing moved, and the stale-based edit would overwrite the newer one with no conflict copy.
 * See `note-editor.tsx`, which holds the seeded value in a ref.
 *
 * A base surviving from an earlier session is kept, not replaced: it means an edit was made and
 * never uploaded, and that edit is still based on the older body.
 */
export async function recordEditBase(
  db: EditBaseTarget,
  noteId: string,
  content: string,
): Promise<void> {
  const existing = await db.getOptional("SELECT note_id FROM note_edit_base WHERE note_id = ?", [
    noteId,
  ]);
  if (existing) return;
  await db.execute("INSERT INTO note_edit_base (id, note_id, base_content) VALUES (uuid(), ?, ?)", [
    noteId,
    content,
  ]);
}
