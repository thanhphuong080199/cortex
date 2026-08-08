import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordEditBase, type EditBaseTarget } from "./edit-base.js";
import {
  restoreNote,
  setNoteLifecycle,
  trashNote,
  updateNoteContent,
  type NoteEditTarget,
} from "./note-edits.js";

function sqlite() {
  const db = new Database(":memory:");
  db.function("uuid", () => randomUUID());
  db.exec(`CREATE TABLE notes (
    id TEXT PRIMARY KEY, title TEXT, content TEXT, lifecycle TEXT,
    domain TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
  )`);
  // localOnly in packages/sync/src/schema.ts, so it never syncs -- but it is a real table on
  // the device and the connector reads it by note_id.
  db.exec(`CREATE TABLE note_edit_base (id TEXT PRIMARY KEY, note_id TEXT, base_content TEXT)`);
  return db;
}

function target(db: Database.Database): EditBaseTarget & NoteEditTarget {
  return {
    getOptional: async <T,>(sql: string, params?: unknown[]) =>
      (db.prepare(sql).get((params ?? []) as never[]) as T) ?? null,
    execute: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).run((params ?? []) as never[]),
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const T0 = "2026-08-02T10:00:00.000Z";
const T1 = "2026-08-02T11:00:00.000Z";
// The base is a BODY, not a timestamp: `updated_at` is server-owned, so the value this table
// used to hold was one the server had never issued and every edit read as a conflict.
const B0 = "body";
const B1 = "a later body";

let db: Database.Database;
beforeEach(() => {
  db = sqlite();
  db.prepare(
    "INSERT INTO notes (id, content, lifecycle, created_at, updated_at) VALUES ('n1', 'body', 'inbox', ?, ?)",
  ).run(T0, T0);
});
afterEach(() => {
  db.close();
});

const bases = () =>
  db.prepare("SELECT * FROM note_edit_base").all() as Record<string, unknown>[];
const note = () =>
  db.prepare("SELECT * FROM notes WHERE id = 'n1'").get() as Record<string, unknown>;

describe("recordEditBase", () => {
  it("records the base on the first edit of a session", async () => {
    await recordEditBase(target(db), "n1", B0);

    const [row] = bases();
    expect(row.note_id).toBe("n1");
    expect(row.base_content).toBe(B0);
    // The connector reads this by note_id, so a row without one is invisible to it.
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stores an empty body as a base rather than skipping it", async () => {
    // "" is a real base: a note edited down to nothing opens again with an empty box, and the
    // next edit is still based on that emptiness. Every falsy check on this path -- here, in the
    // connector, in the editor's save guard -- would drop it, and the upload would then carry no
    // base at all and apply as last-write-wins, which is what the base exists to prevent.
    await recordEditBase(target(db), "n1", "");

    expect(bases()).toHaveLength(1);
    expect(bases()[0].base_content).toBe("");
  });

  it("does NOT overwrite an existing base", async () => {
    await recordEditBase(target(db), "n1", B0);
    await recordEditBase(target(db), "n1", B1);

    // Advancing it would walk the base forward to the user's own last keystroke, the server's
    // check would never fire, and conflict handling would silently become last-write-wins --
    // the exact thing spec 6.2 exists to prevent.
    expect(bases()).toHaveLength(1);
    expect(bases()[0].base_content).toBe(B0);
  });

  it("keeps a base left over from a session that never uploaded", async () => {
    db.prepare("INSERT INTO note_edit_base (id, note_id, base_content) VALUES ('x', 'n1', ?)").run(
      B0,
    );

    await recordEditBase(target(db), "n1", B1);

    // That leftover means an edit exists which was never uploaded, and it is still based on
    // the older body. Replacing it would tell the server the edit was newer than it is.
    expect(bases()[0].base_content).toBe(B0);
  });

  it("tracks each note separately", async () => {
    db.prepare(
      "INSERT INTO notes (id, content, lifecycle, updated_at) VALUES ('n2', 'other', 'inbox', ?)",
    ).run(T1);

    await recordEditBase(target(db), "n1", B0);
    await recordEditBase(target(db), "n2", B1);

    // A guard keyed on "any base exists" rather than on this note would silently skip the
    // second note, and only that note's conflicts would go undetected.
    expect(bases()).toHaveLength(2);
    expect(bases().map((b) => b.base_content).sort()).toEqual([B1, B0].sort());
  });

  it("writes nothing when a base is already there", async () => {
    const write = vi.fn();
    const found: EditBaseTarget = {
      getOptional: async <T,>() => ({ note_id: "n1" }) as T,
      execute: write,
    };

    await recordEditBase(found, "n1", B1);

    expect(write).not.toHaveBeenCalled();
  });
});

describe("the editor's local mutations", () => {
  it("writes the new body and advances updated_at in ISO form", async () => {
    await updateNoteContent(target(db), "n1", "edited body");

    const n = note();
    expect(n.content).toBe("edited body");
    // The conflict base no longer reads this column, but the format still decides how locally
    // written rows sort against synced ones -- `datetime('now')` puts every one of them below
    // every synced row within the same day. See sql.ts.
    expect(n.updated_at).toMatch(ISO);
    expect(n.updated_at).not.toBe(T0);
  });

  it("moves a note between lifecycles and stamps the change", async () => {
    await setNoteLifecycle(target(db), "n1", "archived");

    expect(note().lifecycle).toBe("archived");
    expect(note().updated_at).toMatch(ISO);
    // The fixture's own updated_at is already ISO, so the regex above holds even if the
    // statement stamped nothing at all. Its two siblings carry this assertion; this one did
    // not, so a `SET lifecycle = ?` that dropped updated_at -- a change the server cannot
    // order against any other -- shipped green.
    expect(note().updated_at).not.toBe(T0);
  });

  it("soft-deletes rather than removing the row", async () => {
    await trashNote(target(db), "n1");

    const n = note();
    // The row has to survive: a hard delete cannot replicate as a deletion and the trash view
    // would have nothing to show.
    expect(n.id).toBe("n1");
    expect(n.deleted_at).toMatch(ISO);
    // A delete that leaves updated_at alone is a change the server cannot order against others.
    expect(n.updated_at).toMatch(ISO);
    expect(n.updated_at).not.toBe(T0);
  });

  it("restores a trashed note by clearing deleted_at", async () => {
    await trashNote(target(db), "n1");
    await restoreNote(target(db), "n1");

    expect(note().deleted_at).toBeNull();
  });

  it("binds parameters in the order each statement expects", async () => {
    // A swapped pair still runs on SQLite's dynamic typing and only surfaces as a note whose
    // body is a uuid once it has synced.
    await updateNoteContent(target(db), "n1", "correct body");
    await setNoteLifecycle(target(db), "n1", "evergreen");

    expect(note().content).toBe("correct body");
    expect(note().lifecycle).toBe("evergreen");
    expect(note().id).toBe("n1");
  });

  it("touches only the note it names", async () => {
    db.prepare(
      "INSERT INTO notes (id, content, lifecycle, updated_at) VALUES ('n2', 'untouched', 'inbox', ?)",
    ).run(T0);

    await trashNote(target(db), "n1");

    const other = db.prepare("SELECT * FROM notes WHERE id = 'n2'").get() as Record<string, unknown>;
    expect(other.deleted_at).toBeNull();
    expect(other.updated_at).toBe(T0);
  });

  /**
   * Every local UPDATE becomes a PowerSync PATCH. Re-trashing an already-trashed note
   * therefore costs a server round trip for a change that changes nothing -- and it re-stamps
   * updated_at, reordering the row against genuine edits. `NoteService.softDelete` carries
   * `.is("deleted_at", null)` for the same reason; the device statement did not.
   *
   * The already-trashed state is SEEDED with fixed timestamps rather than produced by calling
   * trashNote twice. NOW_ISO is `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (sql.ts:24) --
   * millisecond resolution -- so two calls inside one test can land on the same millisecond and
   * the assertion would then hold whether or not the guard exists. Seeding T0 makes the two
   * outcomes impossible to confuse.
   */
  it("does not re-stamp a note that is already trashed", async () => {
    db.prepare("UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = 'n1'").run(T0, T0);

    await trashNote(target(db), "n1");

    expect(note().deleted_at).toBe(T0);
    expect(note().updated_at).toBe(T0);
  });

  it("does not re-stamp a note that is already live", async () => {
    // The fixture note is live already: beforeEach inserts it with deleted_at NULL and
    // updated_at = T0.
    await restoreNote(target(db), "n1");

    expect(note().updated_at).toBe(T0);
  });
});
