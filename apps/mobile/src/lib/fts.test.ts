import { noteFiltersToSql, toSqlitePlaceholders, type NoteFilters } from "@cortex/shared";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setupNotesFts, type FtsTarget } from "./fts.js";

/**
 * Runs against a faithful stand-in for PowerSync's local layout, then executes the REAL clause
 * `noteFiltersToSql` emits over it.
 *
 * The shape is not invented: `(id TEXT PRIMARY KEY NOT NULL, data TEXT)` was read out of the
 * `libpowersync.so` in the APK we ship, and the `notes` view is auto-generated as
 * `json_extract` over that `data` column. That is what lets this suite catch the failure the
 * plan's version would have shipped -- a rowid-keyed FTS table that matches nothing without
 * ever erroring, so every search silently returns empty and nothing anywhere reports a problem.
 */
const COLUMNS = ["title", "content", "lifecycle", "domain", "created_at", "updated_at", "deleted_at"];

function powersyncLike() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE ps_data__notes (id TEXT PRIMARY KEY NOT NULL, data TEXT)`);
  db.exec(
    `CREATE VIEW notes AS SELECT id, ${COLUMNS.map(
      (c) => `json_extract(data, '$.${c}') AS ${c}`,
    ).join(", ")} FROM ps_data__notes`,
  );
  db.exec(`CREATE TABLE ps_data__note_tags (id TEXT PRIMARY KEY NOT NULL, data TEXT)`);
  db.exec(
    `CREATE VIEW note_tags AS SELECT id,
       json_extract(data, '$.note_id') AS note_id,
       json_extract(data, '$.tag_id') AS tag_id,
       json_extract(data, '$.deleted_at') AS deleted_at
     FROM ps_data__note_tags`,
  );
  return db;
}

function target(db: Database.Database): FtsTarget {
  return { execute: async (sql, params) => db.prepare(sql).run((params ?? []) as never[]) };
}

/** Writes the way replication does -- into the internal table, never through the view. */
function put(db: Database.Database, id: string, row: Record<string, unknown>) {
  db.prepare("INSERT OR REPLACE INTO ps_data__notes (id, data) VALUES (?, ?)").run(
    id,
    JSON.stringify({ lifecycle: "inbox", deleted_at: null, ...row }),
  );
}

/** Runs the production query for a set of filters and returns the ids it selects. */
function search(db: Database.Database, filters: NoteFilters): string[] {
  const { where, params, join } = noteFiltersToSql(filters);
  const sql = `SELECT n.id FROM notes n ${join} WHERE ${toSqlitePlaceholders(where)}
               ORDER BY n.updated_at DESC`;
  return (db.prepare(sql).all(params as never[]) as { id: string }[]).map((r) => r.id);
}

let db: Database.Database;
beforeEach(async () => {
  db = powersyncLike();
  await setupNotesFts(target(db));
});
afterEach(() => {
  db.close();
});

describe("setupNotesFts", () => {
  it("builds a table the emitted clause can actually select `id` from", async () => {
    put(db, "a", { content: "quantum entanglement notes" });
    put(db, "b", { content: "grocery list" });

    // The whole trap: a rowid-keyed table returns [] here and raises nothing.
    expect(search(db, { view: "inbox", q: "entanglement" })).toEqual(["a"]);
  });

  it("is idempotent across launches rather than duplicating every row", async () => {
    put(db, "a", { content: "unique term zorblat" });

    await setupNotesFts(target(db));
    await setupNotesFts(target(db));

    const hits = db
      .prepare("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH 'zorblat'")
      .get() as { n: number };
    // A rebuild that appended instead of replacing would return the note once per launch, and
    // the list would show three copies of one note.
    expect(hits.n).toBe(1);
  });

  it("rebuilds rows that replication delivered before the index existed", async () => {
    const fresh = powersyncLike();
    // Rows arrive first; the index is created afterwards, which is every upgrade path.
    fresh
      .prepare("INSERT INTO ps_data__notes (id, data) VALUES (?, ?)")
      .run(
        "old",
        JSON.stringify({ content: "pre-existing corpus", lifecycle: "inbox", deleted_at: null }),
      );

    await setupNotesFts(target(fresh));

    expect(search(fresh, { view: "inbox", q: "corpus" })).toEqual(["old"]);
    fresh.close();
  });
});

describe("the triggers keep the index in step with replication", () => {
  it("indexes a note the moment it arrives", () => {
    put(db, "a", { content: "freshly synced text" });
    expect(search(db, { view: "inbox", q: "synced" })).toEqual(["a"]);
  });

  it("stops matching the old body after an edit, and matches the new one", () => {
    put(db, "a", { content: "original wording" });
    put(db, "a", { content: "replacement wording" });

    // Leaving the old text behind is the failure that looks like it works: search keeps
    // finding notes by words they no longer contain.
    expect(search(db, { view: "inbox", q: "original" })).toEqual([]);
    expect(search(db, { view: "inbox", q: "replacement" })).toEqual(["a"]);
  });

  /**
   * `put` writes with INSERT OR REPLACE. This covers the other pattern replication could use,
   * so the index stays correct whichever one it is -- the triggers are not allowed to depend
   * on that choice.
   */
  it("follows a plain UPDATE of the row as well as a replace", () => {
    put(db, "a", { content: "before the update" });
    db.prepare("UPDATE ps_data__notes SET data = ? WHERE id = ?").run(
      JSON.stringify({ content: "after the update", lifecycle: "inbox", deleted_at: null }),
      "a",
    );

    expect(search(db, { view: "inbox", q: "before" })).toEqual([]);
    expect(search(db, { view: "inbox", q: "after" })).toEqual(["a"]);
  });

  it("drops a note from the index when the row is removed", () => {
    put(db, "a", { content: "temporary thought" });
    db.prepare("DELETE FROM ps_data__notes WHERE id = ?").run("a");

    expect(search(db, { view: "inbox", q: "temporary" })).toEqual([]);
    expect(
      (db.prepare("SELECT count(*) AS n FROM notes_fts").get() as { n: number }).n,
    ).toBe(0);
  });

  it("does not leave a duplicate behind when a note is edited twice", () => {
    put(db, "a", { content: "same word here" });
    put(db, "a", { content: "same word again" });
    put(db, "a", { content: "same word finally" });

    expect(search(db, { view: "inbox", q: "same" })).toEqual(["a"]);
    expect(
      (db.prepare("SELECT count(*) AS n FROM notes_fts WHERE id = 'a'").get() as { n: number }).n,
    ).toBe(1);
  });
});

describe("search composes with the view narrowing rather than fighting it", () => {
  beforeEach(() => {
    put(db, "inboxed", { content: "shared keyword alpha", lifecycle: "inbox" });
    put(db, "archived", { content: "shared keyword alpha", lifecycle: "archived" });
    put(db, "trashed", {
      content: "shared keyword alpha",
      lifecycle: "inbox",
      deleted_at: "2026-08-03T10:00:00.000Z",
    });
  });

  it("narrows a search to the current view", () => {
    expect(search(db, { view: "inbox", q: "alpha" })).toEqual(["inboxed"]);
    expect(search(db, { view: "archived", q: "alpha" })).toEqual(["archived"]);
  });

  it("still searches inside the trash view", () => {
    expect(search(db, { view: "trash", q: "alpha" })).toEqual(["trashed"]);
  });

  /**
   * The REBUILD is the only place a `deleted_at` filter could creep back in -- the triggers
   * index unconditionally -- so the trashed row has to predate `setupNotesFts` for this to
   * mean anything. The test above does NOT cover it: its rows are written after setup, so the
   * trigger indexes them whatever the rebuild does, and it stayed green under the plan's
   * `WHERE deleted_at IS NULL`.
   *
   * With that filter the two conditions contradict -- the view demands `deleted_at is not
   * null` while the index holds only rows where it IS null -- so trash search is dead and
   * nothing errors.
   */
  it("searches a note that was already trashed before the index was built", async () => {
    const fresh = powersyncLike();
    fresh.prepare("INSERT INTO ps_data__notes (id, data) VALUES (?, ?)").run(
      "gone",
      JSON.stringify({
        content: "deleted but findable",
        lifecycle: "inbox",
        deleted_at: "2026-08-03T10:00:00.000Z",
      }),
    );

    await setupNotesFts(target(fresh));

    expect(search(fresh, { view: "trash", q: "findable" })).toEqual(["gone"]);
    fresh.close();
  });

  it("returns every note in the view when there is no query at all", () => {
    // The q clause must be absent, not empty -- an always-false match would empty the list.
    expect(search(db, { view: "inbox" }).sort()).toEqual(["inboxed"]);
  });

  it("finds nothing for a term no note contains", () => {
    expect(search(db, { view: "inbox", q: "nonexistentterm" })).toEqual([]);
  });
});

/**
 * FTS5 parses the string BOUND to `match` as a query expression, so binding it prevents
 * injection but not parsing. The search box feeds raw keystrokes straight in
 * (`note-list.tsx`), and the screen renders a thrown query as "Could not read notes on this
 * device" -- so before `toFtsQuery`, typing an apostrophe broke search outright.
 *
 * Each case asserts the RAW string's behaviour as well as the escaped one. Without that the
 * suite cannot show the escaping is load-bearing: every assertion below would pass just as
 * well against an implementation that never escaped anything, if FTS5 happened to tolerate
 * the input.
 */
describe("raw user input reaches FTS5 as text, not as a query language", () => {
  /** What `toFtsQuery` protects against: the same string bound without it. */
  function raw(database: Database.Database, q: string): string[] {
    return (
      database.prepare("SELECT id FROM notes_fts WHERE notes_fts MATCH ?").all(q) as {
        id: string;
      }[]
    ).map((r) => r.id);
  }

  beforeEach(() => {
    put(db, "apostrophe", { content: "don't panic and carry a towel" });
    put(db, "plain", { content: "hello world" });
    put(db, "literal", { content: "content:hello is written out here" });
  });

  it("finds the note when the user types an apostrophe", () => {
    expect(search(db, { view: "inbox", q: "don't" })).toEqual(["apostrophe"]);
    // The unescaped form does not return the wrong rows -- it throws, taking the whole list
    // with it. This is the bug in its original form.
    expect(() => raw(db, "don't")).toThrow(/syntax error/);
  });

  it("survives an unbalanced double quote", () => {
    expect(search(db, { view: "inbox", q: 'foo"' })).toEqual([]);
    expect(() => raw(db, 'foo"')).toThrow(/unterminated string/);
  });

  it("searches for a trailing operator word instead of obeying it", () => {
    // `AND` is an FTS5 operator, and a dangling one is a syntax error. Quoted it is just a
    // word -- which the apostrophe note happens to contain, so this also proves the token
    // survives escaping rather than being dropped.
    expect(search(db, { view: "inbox", q: "hello AND" })).toEqual([]);
    expect(search(db, { view: "inbox", q: "panic AND" })).toEqual(["apostrophe"]);
    expect(() => raw(db, "hello AND")).toThrow(/syntax error/);
  });

  it("treats a colon as text rather than as a column filter", () => {
    // The dangerous one: this input does NOT throw unescaped. FTS5 reads `content:hello` as
    // "column content matches hello" and quietly returns every note containing "hello", so
    // the failure is a wrong answer rather than an error nobody could miss.
    expect(search(db, { view: "inbox", q: "content:hello" })).toEqual(["literal"]);
    expect(raw(db, "content:hello").sort()).toEqual(["literal", "plain"]);
  });

  it("returns no matches, rather than raising, for a query that is all punctuation", () => {
    // `"!!!"` is a valid phrase that matches nothing, which is what the web side does with
    // the same input. An empty list is a fine answer here; an error is not.
    expect(search(db, { view: "inbox", q: "!!!" })).toEqual([]);
    expect(() => raw(db, "!!!")).toThrow(/syntax error/);
  });

  it("drops the clause entirely when the query is only whitespace", () => {
    // `match ''` is itself a syntax error, so an escaped-but-empty query still has to be
    // left out of the SQL rather than bound. The search box trims, but nothing in
    // `noteFiltersToSql`'s contract says its caller must.
    expect(search(db, { view: "inbox", q: "  \t " }).sort()).toEqual([
      "apostrophe",
      "literal",
      "plain",
    ]);
    expect(() => raw(db, "")).toThrow(/syntax error/);
  });
});
