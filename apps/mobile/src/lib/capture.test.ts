import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CAPTURE_NOTE_SQL, captureNote, type CaptureTarget } from "./capture.js";

/**
 * The statement runs on REAL SQLite, not against a string assertion.
 *
 * Asserting the SQL text would restate the implementation and pass on anything that parsed.
 * The properties that matter -- what `strftime` actually produces, that the placeholders bind
 * in the order the columns expect, that the row is insertable at all -- are only observable by
 * executing it. This is the Task 15 precedent: two engines, one statement, real output.
 *
 * `uuid()` belongs to the PowerSync SQLite core extension rather than SQLite, so it is
 * registered here. The mirror table matches `packages/sync/src/schema.ts` -- PowerSync's local
 * tables are views over its own storage, but the column set and affinities are the contract.
 */
function sqlite() {
  const db = new Database(":memory:");
  db.function("uuid", () => randomUUID());
  db.exec(`CREATE TABLE notes (
    id TEXT PRIMARY KEY, title TEXT, content TEXT, source_type TEXT, lifecycle TEXT,
    domain TEXT, domain_meta TEXT, media_item_id TEXT, pinned INTEGER,
    created_at TEXT, updated_at TEXT, deleted_at TEXT
  )`);
  return db;
}

/** Adapts better-sqlite3's synchronous API to the async shape PowerSync exposes. */
function target(db: Database.Database): CaptureTarget {
  return { execute: async (sql, params) => db.prepare(sql).run(params as never[]) };
}

let db: Database.Database;
beforeEach(() => {
  db = sqlite();
});
afterEach(() => {
  db.close();
});

function rows() {
  return db.prepare("SELECT * FROM notes").all() as Record<string, unknown>[];
}

describe("captureNote", () => {
  it("writes one note that SQLite actually accepts", async () => {
    const wrote = await captureNote(target(db), { content: "a thought", domain: null });

    expect(wrote).toBe(true);
    const [row] = rows();
    expect(row.content).toBe("a thought");
    expect(row.domain).toBeNull();
    expect(row.title).toBeNull();
  });

  /**
   * The one the plan's `datetime('now')` fails.
   *
   * `datetime()` yields `2026-08-03 10:00:00`: space-separated, no zone, second precision.
   * Rows echoed back by the server carry a `T` and a `Z`, and a space sorts BEFORE `T` in
   * ASCII -- so within a single day every locally captured note would sort ahead of every
   * synced one whatever its real time. `base_updated_at` is `z.iso.datetime()` on the server,
   * which rejects the space form outright.
   */
  it("stores timestamps as ISO-8601 UTC with milliseconds", async () => {
    await captureNote(target(db), { content: "x", domain: null });

    const [row] = rows();
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(row.created_at).toMatch(iso);
    expect(row.updated_at).toMatch(iso);
    // Parseable as the instant it claims to be, not merely shaped like one.
    expect(Number.isNaN(Date.parse(row.created_at as string))).toBe(false);
  });

  it("writes a timestamp byte-comparable with the one replication delivers", async () => {
    await captureNote(target(db), { content: "local", domain: null });
    const local = rows()[0].created_at as string;

    // A server row one second OLDER than the capture, in the format replication delivers.
    // Derived from the captured value rather than hardcoded, so the comparison is against
    // whatever the statement really produced -- an earlier draft of this test overwrote the
    // captured timestamp with an ISO literal first, which hid the format entirely and made the
    // assertion a test of SQLite's string sort instead of of the statement.
    const earlier = new Date(Date.parse(local) - 1000).toISOString();
    db.prepare(
      "INSERT INTO notes (id, content, created_at, updated_at) VALUES ('s', 'synced', ?, ?)",
    ).run(earlier, earlier);

    const ordered = (
      db.prepare("SELECT content FROM notes ORDER BY created_at DESC").all() as {
        content: string;
      }[]
    ).map((r) => r.content);

    // ORDER BY on a TEXT column is a byte comparison. Under `datetime('now')` the local row
    // reads "2026-08-03 10:00:00" and a space (0x20) sorts below "T" (0x54), so the newer
    // local capture lands BELOW the older synced row. Task 19 orders the note list by this.
    expect(ordered).toEqual(["local", "synced"]);
  });

  it("stores the chosen domain", async () => {
    await captureNote(target(db), { content: "x", domain: "health" });
    expect(rows()[0].domain).toBe("health");
  });

  it("writes the column defaults the server will echo back", async () => {
    await captureNote(target(db), { content: "x", domain: null });

    // Migration 00002: source_type 'quick', lifecycle 'inbox', pinned false. A local row that
    // disagrees visibly changes under the user when replication delivers the server's version.
    const [row] = rows();
    expect(row.lifecycle).toBe("inbox");
    expect(row.source_type).toBe("quick");
    expect(row.pinned).toBe(0);
  });

  it("gives every note a distinct id", async () => {
    await captureNote(target(db), { content: "one", domain: null });
    await captureNote(target(db), { content: "two", domain: null });

    const ids = rows().map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    // The id is what makes the local optimistic row and the server row the same row, so it
    // has to be a real uuid rather than anything SQLite would coerce.
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses to write a note that is only whitespace", async () => {
    const write = vi.fn();
    const wrote = await captureNote({ execute: write }, { content: "   \n\t ", domain: null });

    expect(wrote).toBe(false);
    // Not written, not merely reported false -- an empty note is indistinguishable from a bug
    // once it has synced.
    expect(write).not.toHaveBeenCalled();
  });

  it("stores the trimmed content, not the raw input", async () => {
    await captureNote(target(db), { content: "  padded  ", domain: null });
    // What was rejected as empty must not be what gets written.
    expect(rows()[0].content).toBe("padded");
  });

  it("binds content and domain in the order the columns expect", async () => {
    // A swapped pair still inserts cleanly on SQLite's dynamic typing and only surfaces as a
    // note whose body is "health" once it has synced.
    await captureNote(target(db), { content: "body text", domain: "finance" });

    const [row] = rows();
    expect(row.content).toBe("body text");
    expect(row.domain).toBe("finance");
    expect(CAPTURE_NOTE_SQL.match(/\?/g)).toHaveLength(2);
  });
});
