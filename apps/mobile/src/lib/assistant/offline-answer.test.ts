import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { offlineAnswer, type FtsReadTarget } from "./offline-answer.js";

/** The real FTS5 shape from lib/fts.ts: the uuid is its own UNINDEXED column, not the rowid. */
function sqlite() {
  const db = new Database(":memory:");
  db.exec(`CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, content, tokenize='unicode61')`);
  return db;
}

function target(db: Database.Database): FtsReadTarget {
  return {
    getAll: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all((params ?? []) as never[]) as T[],
  };
}

function put(db: Database.Database, id: string, content: string) {
  db.prepare("INSERT INTO notes_fts(id, content) VALUES (?, ?)").run(id, content);
}

let db: Database.Database;
beforeEach(() => { db = sqlite(); });
afterEach(() => { db.close(); });

describe("offlineAnswer", () => {
  it("returns the notes that match, with a snippet of each", async () => {
    put(db, "n1", "định giá theo giá trị chứ không theo chi phí");
    put(db, "n2", "hôm nay chạy bộ 5km");

    const hits = await offlineAnswer(target(db), "định giá");

    expect(hits.map((h) => h.id)).toEqual(["n1"]);
    expect(hits[0].snippet).toContain("định giá");
  });

  /**
   * Red the moment toFtsQuery is dropped and the raw text is bound: FTS5 parses the bound
   * value as a query language, and an apostrophe raises `fts5: syntax error near "'"`. This
   * is the single most likely simplification someone will make to this file.
   */
  it("does not throw on punctuation a person actually types", async () => {
    put(db, "n1", "don't ship it on a friday");

    for (const q of ["don't", 'foo"', "hello AND", "!!!", "-hello", "content:hello"]) {
      await expect(offlineAnswer(target(db), q)).resolves.toBeInstanceOf(Array);
    }
  });

  /**
   * Red when the empty-term guard is removed. `match ''` is itself an FTS5 syntax error, so
   * without this the box crashes on a query of nothing but punctuation -- and it must not
   * merely not-throw, it must not run a query at all.
   */
  it("makes no query when the text escapes to nothing", async () => {
    const getAll = vi.fn();
    const hits = await offlineAnswer({ getAll }, "   \n\t ");

    expect(hits).toEqual([]);
    expect(getAll).not.toHaveBeenCalled();
  });

  // Red when the LIMIT is dropped: three is what the box can show without becoming a list.
  it("returns at most three matches", async () => {
    for (const i of [1, 2, 3, 4, 5]) put(db, `n${i}`, "pricing psychology note");

    expect(await offlineAnswer(target(db), "pricing")).toHaveLength(3);
  });

  it("returns an empty array when nothing matches, without throwing", async () => {
    put(db, "n1", "unrelated");
    expect(await offlineAnswer(target(db), "khôngcótừnày")).toEqual([]);
  });
});
