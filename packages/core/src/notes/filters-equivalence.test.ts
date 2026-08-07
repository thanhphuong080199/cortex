// noteFiltersToSql emits the same narrowing as applyNoteFilters, for mobile's local
// SQLite replica. This suite is the only guard against the two drifting apart.
//
// It runs the clause against REAL SQLite, not against Postgres pretending to be SQLite.
// The point is that the dialect actually executes on the engine the phone runs -- Postgres
// has no FTS5 `match` and uses $n rather than ? placeholders, so testing there would prove
// less while looking like it proved more.
//
// Every case is anchored to an EXPECTED id set, not just to the other side's answer.
// Agreement alone is the weaker property: two implementations that both drop `evergreen`
// agree perfectly, and two empty results agree too.
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyNoteFilters,
  noteFiltersToSql,
  noteSelect,
  toSqlitePlaceholders,
  type NoteFilters,
} from "@cortex/shared";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { TagService } from "../organize/service.js";
import { NoteService } from "./service.js";

let alice: Awaited<ReturnType<typeof makeUser>>;
let sqlite: Database.Database;
const ids: Record<string, string> = {};
let tagId: string;

beforeAll(async () => {
  alice = await makeUser("core-equiv-alice@test.local");
  const client = createUserClient(alice.token);
  const svc = new NoteService(client, alice.id);
  const tags = new TagService(client, alice.id);

  // Rerunnable without a db reset (issue-log A2).
  await client.from("notes").delete().eq("user_id", alice.id);

  ids.inbox = (await svc.create({ content: "inbox note" })).id;
  ids.media = (await svc.create({ content: "media note alpha pricing", domain: "media" })).id;

  const active = await svc.create({ content: "active note" });
  await svc.update(active.id, { lifecycle: "active" });
  ids.active = active.id;

  const ever = await svc.create({ content: "evergreen note" });
  await svc.update(ever.id, { lifecycle: "evergreen" });
  ids.evergreen = ever.id;

  const arch = await svc.create({ content: "archived note" });
  await svc.update(arch.id, { lifecycle: "archived" });
  ids.archived = arch.id;

  const gone = await svc.create({ content: "trashed note" });
  await svc.softDelete(gone.id);
  ids.trashed = gone.id;

  const goneMedia = await svc.create({ content: "trashed media note", domain: "media" });
  await svc.softDelete(goneMedia.id);
  ids.trashedMedia = goneMedia.id;

  tagId = (await tags.findOrCreate({ name: "equiv-fixture" })).id;
  await tags.attach(ids.media, tagId);

  // Mirror the same rows into a real SQLite database, mimicking what PowerSync would have
  // replicated to the device. notes_fts is the shape Task 19 must create: FTS5 rowids are
  // integers, so a TEXT uuid has to be carried as its own UNINDEXED column.
  sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE notes (
    id TEXT PRIMARY KEY, content TEXT, title TEXT, lifecycle TEXT,
    domain TEXT, updated_at TEXT, deleted_at TEXT
  );
  CREATE TABLE note_tags (id TEXT PRIMARY KEY, note_id TEXT, tag_id TEXT, deleted_at TEXT);
  CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, content);`);

  const { data: notes, error: notesError } = await client.from("notes")
    .select("*").eq("user_id", alice.id);
  if (notesError) throw notesError;
  const insertNote = sqlite.prepare(
    `INSERT INTO notes (id, content, title, lifecycle, domain, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = sqlite.prepare(`INSERT INTO notes_fts (id, content) VALUES (?, ?)`);
  for (const n of notes as Record<string, string | null>[]) {
    insertNote.run(n.id, n.content, n.title, n.lifecycle, n.domain, n.updated_at, n.deleted_at);
    insertFts.run(n.id, n.content);
  }

  const { data: noteTags, error: tagsError } = await client.from("note_tags")
    .select("id, note_id, tag_id, deleted_at").eq("user_id", alice.id);
  if (tagsError) throw tagsError;
  const insertTag = sqlite.prepare(
    `INSERT INTO note_tags (id, note_id, tag_id, deleted_at) VALUES (?, ?, ?, ?)`,
  );
  for (const t of noteTags as Record<string, string | null>[]) {
    insertTag.run(t.id, t.note_id, t.tag_id, t.deleted_at);
  }
  // A mirror that silently copied nothing would make every equivalence assertion agree on
  // two empty sets. Fail here instead, where the cause is obvious.
  expect(sqlite.prepare("SELECT count(*) c FROM notes").get()).toEqual({ c: 7 });
  expect(sqlite.prepare("SELECT count(*) c FROM note_tags").get()).toEqual({ c: 1 });
});

function sqlIds(f: NoteFilters): string[] {
  const { where, params, join } = noteFiltersToSql(f);
  const rows = sqlite
    .prepare(`SELECT n.id FROM notes n ${join} WHERE ${toSqlitePlaceholders(where)}`)
    .all(...(params as string[])) as { id: string }[];
  return rows.map((r) => r.id).sort();
}

async function postgrestIds(f: NoteFilters): Promise<string[]> {
  const { data, error } = await applyNoteFilters(
    createUserClient(alice.token).from("notes").select(noteSelect(f)), f,
  );
  if (error) throw error;
  return (data as unknown as { id: string }[]).map((r) => r.id).sort();
}

const set = (...keys: string[]) => keys.map((k) => ids[k]).sort();

describe("filter equivalence: PostgREST vs SQLite", () => {
  // `q` is absent on purpose: Postgres websearch_to_tsquery and SQLite FTS5 are different
  // engines with different tokenizers, and asserting they rank identically would be a test
  // that lies (spec §3.3). Each engine's `q` handling is asserted separately below.
  const structural: [string, NoteFilters, string[]][] = [
    ["inbox", { view: "inbox" }, ["inbox", "media"]],
    ["active covers evergreen too", { view: "active" }, ["active", "evergreen"]],
    ["archived", { view: "archived" }, ["archived"]],
    ["trash", { view: "trash" }, ["trashed", "trashedMedia"]],
    ["inbox + domain", { view: "inbox", domain: "media" }, ["media"]],
    ["trash + domain", { view: "trash", domain: "media" }, ["trashedMedia"]],
  ];

  for (const [name, f, expected] of structural) {
    it(`agrees, and is right, for ${name}`, async () => {
      // Three-way: SQLite == expected == PostgREST. The middle term is what stops two
      // implementations that are wrong in the same way from passing each other.
      expect(sqlIds(f)).toEqual(set(...expected));
      expect(await postgrestIds(f)).toEqual(set(...expected));
    });
  }

  it("agrees, and is right, for a tag filter", async () => {
    // The join branch: `join note_tags nt` on one side, `note_tags!inner` on the other.
    // Two entirely different mechanisms for one filter, so it needs its own case.
    const f: NoteFilters = { view: "inbox", tag: tagId };
    expect(sqlIds(f)).toEqual(set("media"));
    expect(await postgrestIds(f)).toEqual(set("media"));
  });

  it("agrees, and is right, for a tag nothing carries", async () => {
    const unused = await new TagService(createUserClient(alice.token), alice.id)
      .findOrCreate({ name: "equiv-fixture-unused" });
    const f: NoteFilters = { view: "inbox", tag: unused.id };
    expect(sqlIds(f)).toEqual([]);
    expect(await postgrestIds(f)).toEqual([]);
  });
});

describe("the q clause executes on the engine the phone runs", () => {
  // Not an equivalence assertion. FTS5 and Postgres FTS are different engines; what is
  // asserted here is that the SQLite clause is valid SQL that selects the right row --
  // which nothing else in this suite does, because `q` is excluded from `structural`.
  it("finds the note by a word in its body", () => {
    expect(sqlIds({ view: "inbox", q: "pricing" })).toEqual(set("media"));
  });

  it("returns nothing for a word no note carries", () => {
    expect(sqlIds({ view: "inbox", q: "nonexistentword" })).toEqual([]);
  });

  it("still applies the view alongside q", () => {
    // "trashed media note" matches `media`, but it is not in the inbox.
    expect(sqlIds({ view: "inbox", q: "media" })).toEqual(set("media"));
    expect(sqlIds({ view: "trash", q: "media" })).toEqual(set("trashedMedia"));
  });

  it("matches a TEXT uuid, not an FTS5 rowid", () => {
    // The named risk: FTS5 rowids are integers and notes.id is a uuid, so a clause built
    // on `select rowid from notes_fts` compiles, runs, and silently matches nothing.
    // A q that matches a row must therefore return that row, never an empty set.
    expect(sqlIds({ view: "inbox", q: "alpha" })).not.toEqual([]);
  });
});

describe("noteFiltersToSql parameterisation", () => {
  it("parameterises rather than interpolating, so a quote cannot break the clause", () => {
    const { where, params } = noteFiltersToSql({ view: "inbox", domain: "media" });
    expect(where).not.toContain("media");
    expect(params).toContain("media");
  });

  it("survives a value containing a quote, against real SQLite", () => {
    // Executed, not just inspected: an interpolating implementation produces a syntax
    // error here rather than a wrong-but-quiet answer.
    expect(sqlIds({ view: "inbox", tag: "it's-not-a-tag" })).toEqual([]);
  });

  it("emits numbered placeholders and converts them positionally", () => {
    const { where, params } = noteFiltersToSql({ view: "active", domain: "media" });
    expect(where).toContain("$1");
    expect(params).toHaveLength(3); // active, evergreen, media
    expect(toSqlitePlaceholders(where)).not.toContain("$");
    expect(toSqlitePlaceholders(where).match(/\?/g)).toHaveLength(3);
  });
});
