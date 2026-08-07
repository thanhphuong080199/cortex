import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SYNC_TABLES } from "@cortex/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { admin, makeUser } from "./clients.js";

const rulesPath = fileURLToPath(new URL("../../../sync/src/sync-rules.yaml", import.meta.url));
const rules = readFileSync(rulesPath, "utf8");

/**
 * The file with its comments stripped.
 *
 * Only used by the static substring checks below (edition 3, bucket_definitions,
 * request.user_id, parameters:, server-only table names) -- properties about what appears
 * ANYWHERE in the file, not about individual queries. The prose deliberately names both the
 * legacy `bucket_definitions` form and each server-only table, in order to record why they are
 * absent; asserting over the raw file (as the plan's draft did) fails on exactly those
 * explanations, so staying green would mean deleting the most useful comments in the file.
 *
 * SPLIT ON `\r?\n`, NOT `\n`. With a CRLF checkout -- git's default on Windows, and this repo
 * warns `LF will be replaced by CRLF` on every commit -- splitting on `\n` leaves a `\r` at the
 * end of every line. `\r` is a line terminator to a JavaScript regex, so `.` will not cross it,
 * `#.*$` matches nothing, and NOT ONE COMMENT IS STRIPPED: `directives` silently becomes the
 * raw file, which is precisely the thing this const exists to avoid. On Linux it passed and on
 * Windows it failed, which is the worst of both.
 */
const directives = rules
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*$/, "").trimEnd())
  .filter((l) => l.trim().length > 0)
  .join("\n");

/**
 * Round 2, finding #8. The query list used to be found by filtering raw FILE LINES for the
 * literal prefix `- SELECT`, which is blind to every other legal YAML form of the same list
 * item: lowercase SQL (`- select ...`), a quoted scalar (`- "SELECT ..."`), or a block scalar
 * (`- |` with the query on the following, differently-indented line). A rule written in any of
 * those forms was invisible to every assertion below, INCLUDING the table-set equality -- an
 * unscoped duplicate `notes` query in one of those forms would ship every user's notes to every
 * device with all six static tests green, because the duplicate simply never became a
 * `dataQueries` entry for anything to check.
 *
 * Parsing the YAML for real fixes this at the root: `queries` becomes an array of the actual
 * string values PowerSync will run, regardless of how each was spelled in the file. Table/column
 * extraction stays a regex (there is no SQL parser here), now case-insensitive and run over that
 * real string rather than over a raw file line.
 */
function extractDataQueries(yamlText: string): { query: string; table?: string; column?: string }[] {
  const parsed = parseYaml(yamlText) as { streams?: Record<string, { queries?: string[] }> };
  const allQueries = Object.values(parsed.streams ?? {}).flatMap((s) => s.queries ?? []);
  return allQueries
    .filter((q) => /^\s*SELECT\b/i.test(q))
    .map((q) => ({
      query: q,
      table: /FROM\s+(\w+)/i.exec(q)?.[1],
      column: /WHERE\s+(\w+)\s*=\s*auth\.user_id\(\)/i.exec(q)?.[1],
    }));
}

const scopings = extractDataQueries(rules);
const dataQueries = scopings.map((s) => s.query);

let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
/** Row ids seeded per user per table, so the assertions can name what must and must not appear. */
const seeded: Record<string, { alice: string; bob: string }> = {};

/**
 * Throws rather than returning undefined. A missing seed means the fixture did not run, and
 * every assertion downstream would silently compare against `undefined` -- passing "bob's row
 * is absent" for a row that was never inserted.
 */
function seedIds(table: string): { alice: string; bob: string } {
  const s = seeded[table];
  if (!s) throw new Error(`no rows seeded for ${table}; the fixture did not cover it`);
  return s;
}

beforeAll(async () => {
  alice = await makeUser("db-syncrules-alice@test.local");
  bob = await makeUser("db-syncrules-bob@test.local");

  // BOTH users get real rows in EVERY synced table. E3: asserting "bob sees zero" against a
  // table where alice also has none passes with the rule deleted, which proves nothing. The
  // rows are also related to each other (tags attached to notes, links between notes) because
  // the leak worth catching is a child row whose user_id says one owner while its parent
  // belongs to another -- invisible to any check that only reads the rules file.
  for (const u of [alice, bob]) {
    // Children first: FKs cascade from notes, so deleting notes last would orphan nothing,
    // but tags/media/checkins are independent and must be cleared explicitly.
    for (const t of ["links", "note_tags", "notes", "tags", "media_items", "checkins"]) {
      await admin.from(t).delete().eq("user_id", u.id);
    }
  }

  for (const [name, u] of [
    ["alice", alice],
    ["bob", bob],
  ] as const) {
    const note = await admin
      .from("notes")
      .insert({ user_id: u.id, content: `note for ${name}` })
      .select("id")
      .single();
    if (note.error) throw note.error;

    const other = await admin
      .from("notes")
      .insert({ user_id: u.id, content: `second note for ${name}` })
      .select("id")
      .single();
    if (other.error) throw other.error;

    const tag = await admin
      .from("tags")
      .insert({ user_id: u.id, name: `tag-${name}` })
      .select("id")
      .single();
    if (tag.error) throw tag.error;

    const noteTag = await admin
      .from("note_tags")
      .insert({ user_id: u.id, note_id: note.data.id, tag_id: tag.data.id, source: "user" })
      .select("id")
      .single();
    if (noteTag.error) throw noteTag.error;

    const link = await admin
      .from("links")
      .insert({ user_id: u.id, from_note_id: note.data.id, to_note_id: other.data.id })
      .select("id")
      .single();
    if (link.error) throw link.error;

    const media = await admin
      .from("media_items")
      .insert({ user_id: u.id, kind: "book", title: `book for ${name}` })
      .select("id")
      .single();
    if (media.error) throw media.error;

    const checkin = await admin
      .from("checkins")
      .insert({ user_id: u.id, mood: 3 })
      .select("id")
      .single();
    if (checkin.error) throw checkin.error;

    for (const [table, id] of [
      ["notes", note.data.id],
      ["tags", tag.data.id],
      ["note_tags", noteTag.data.id],
      ["links", link.data.id],
      ["media_items", media.data.id],
      ["checkins", checkin.data.id],
    ] as const) {
      seeded[table] ??= { alice: "", bob: "" };
      seeded[table][name] = id;
    }
  }
});

describe("sync rules — static shape", () => {
  it("covers exactly the tables in SYNC_TABLES", () => {
    const tables = scopings
      .map((s) => s.table)
      .filter((t): t is string => Boolean(t))
      .sort();
    expect(tables).toEqual([...SYNC_TABLES].sort());
  });

  it("scopes every data query to the authenticated user", () => {
    for (const q of dataQueries) {
      expect(q, `unscoped sync stream query: ${q}`).toMatch(
        /WHERE\s+user_id\s*=\s*auth\.user_id\(\)/i,
      );
    }
  });

  it("uses sync streams edition 3, not the legacy bucket_definitions form", () => {
    expect(directives).toMatch(/config:\s*\n\s*edition:\s*3/);
    expect(directives).not.toContain("bucket_definitions");
  });

  it("takes the user id from the JWT, never from client-supplied parameters", () => {
    // request.user_id() and a `parameters:` block belong to the legacy form. auth.user_id()
    // resolves from the verified Supabase token; anything a client could set must not
    // appear in a scoping predicate.
    expect(directives).not.toContain("request.user_id");
    expect(directives).not.toMatch(/^\s*parameters:/m);
  });

  it("names no server-only table anywhere", () => {
    for (const t of [
      "note_chunks",
      "usage_ledger",
      "integrations",
      "feedback_events",
      "memory_revisions",
      "ingest_inbox",
      "flashcards",
    ]) {
      expect(directives, `server-only table in a sync rule: ${t}`).not.toContain(t);
    }
  });
});

/**
 * Round 2, finding #8, proven directly against the parser rather than against the real file:
 * each fixture below writes the same leaky duplicate -- a second, UNSCOPED `notes` query -- in
 * a YAML form the old line-based `l.startsWith("- SELECT")` filter could not see at all. Every
 * case must come back with the leak PRESENT in the result; a missing one means the parser
 * dropped it silently, which is exactly how the leak shipped with all six static tests green.
 */
describe("extractDataQueries sees every query form, not just the literal `- SELECT` line", () => {
  const scopedNotes = "SELECT * FROM notes WHERE user_id = auth.user_id()";

  it("a lowercase query", () => {
    const yaml = `
streams:
  user_data:
    queries:
      - ${scopedNotes}
      - select * from notes
`;
    const found = extractDataQueries(yaml);
    expect(found).toHaveLength(2);
    expect(found.filter((s) => s.table === "notes")).toHaveLength(2);
    // The leak: no WHERE user_id = auth.user_id() at all, so no column parses.
    expect(found.some((s) => s.column === undefined)).toBe(true);
  });

  it("a double-quoted scalar", () => {
    const yaml = `
streams:
  user_data:
    queries:
      - ${scopedNotes}
      - "SELECT * FROM notes"
`;
    const found = extractDataQueries(yaml);
    expect(found).toHaveLength(2);
    expect(found.filter((s) => s.table === "notes")).toHaveLength(2);
    expect(found.some((s) => s.column === undefined)).toBe(true);
  });

  it("a block-scalar query, on a line the old filter never inspected", () => {
    const yaml = `
streams:
  user_data:
    queries:
      - ${scopedNotes}
      - |
        SELECT * FROM notes
`;
    const found = extractDataQueries(yaml);
    expect(found).toHaveLength(2);
    expect(found.filter((s) => s.table === "notes")).toHaveLength(2);
    expect(found.some((s) => s.column === undefined)).toBe(true);
  });

  it("still parses the real file's queries as exactly the six scoped rules", () => {
    // Not a fixture: the actual file must have no leak of its own, in any form.
    expect(scopings).toHaveLength(SYNC_TABLES.length);
    expect(scopings.every((s) => s.column === "user_id")).toBe(true);
  });
});

describe("the powersync publication — the layer beneath the sync rules", () => {
  /**
   * No skip guard, deliberately.
   *
   * The plan's draft returned early when the RPC was absent (PGRST202) and again when the
   * publication was empty. Both conditions held everywhere -- neither the function nor a
   * locally-created publication existed -- so the test would have passed by skipping, forever,
   * on the one property that keeps integrations.credentials out of the replication stream.
   * Both now ship in migration 00016, so absence is a failure, not a skip.
   */
  it("replicates exactly the six synced tables, and nothing server-only", async () => {
    const { data, error } = await admin.rpc("_test_publication_tables", { p_pub: "powersync" });
    expect(error).toBeNull();

    const tables = (data as { tablename: string }[]).map((r) => r.tablename).sort();
    expect(tables).toEqual([...SYNC_TABLES].sort());

    // Named separately from the equality above: this is the assertion whose failure explains
    // itself if someone runs PowerSync's own `FOR ALL TABLES` instruction.
    for (const t of ["integrations", "note_chunks", "usage_ledger", "memory_revisions"]) {
      expect(tables).not.toContain(t);
    }
  });
});

describe("sync rules — the declared predicate against real data", () => {
  it("parsed a table and a scoping column out of every rule", () => {
    // Guards the two describes below: if a rule stopped matching, `scopings` would carry
    // undefined and every execution assertion would quietly test nothing.
    for (const s of scopings) {
      expect(s.table, `no table parsed from: ${s.query}`).toBeTruthy();
      expect(s.column, `no auth.user_id() scoping parsed from: ${s.query}`).toBeTruthy();
    }
    expect(scopings).toHaveLength(SYNC_TABLES.length);
  });

  it.each(SYNC_TABLES)("seeds real rows for BOTH users in %s", async (table) => {
    const ids = seedIds(table);
    const { data, error } = await admin.from(table).select("id").in("id", [ids.alice, ids.bob]);
    expect(error).toBeNull();
    // Without this, "bob's row is absent" below would pass against an empty table.
    expect(data).toHaveLength(2);
  });

  it("returns the owner's row and never the other user's, for every rule", async () => {
    for (const { table, column, query } of scopings) {
      const { data, error } = await admin.from(table!).select("id").eq(column!, alice.id);
      expect(error, `executing ${query}`).toBeNull();

      const ids = (data as { id: string }[]).map((r) => r.id);
      // Both directions. "Bob absent" alone is satisfied by a predicate that returns nothing,
      // which is how a rule scoped on the wrong column would pass.
      const expected = seedIds(table!);
      expect(ids, `${query} did not return the owner's row`).toContain(expected.alice);
      expect(ids, `${query} leaked another user's row`).not.toContain(expected.bob);
    }
  });
});

/**
 * The leak a rules file cannot show you.
 *
 * note_tags and links each carry their own user_id AND a foreign key into notes. The sync rule
 * buckets them on user_id alone, so a child row whose user_id says alice while its parent note
 * belongs to bob is shipped straight into alice's bucket -- carrying bob's note id, and landing
 * on her device as a dangling reference. Every static check in this file passes in that state,
 * and so does every predicate execution above, because the row's user_id is genuinely alice's.
 */
describe("child rows agree with the owner of their parent note", () => {
  it("note_tags never points at another user's note", async () => {
    const { data, error } = await admin
      .from("note_tags")
      .select("id, user_id, notes!inner(user_id)")
      .in("user_id", [alice.id, bob.id]);
    expect(error).toBeNull();

    const rows = data as unknown as { id: string; user_id: string; notes: { user_id: string } }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.notes.user_id, `note_tags ${r.id} is bucketed away from its note's owner`).toBe(
        r.user_id,
      );
    }
  });

  it("links never points at another user's note, on either end", async () => {
    const { data, error } = await admin
      .from("links")
      .select("id, user_id, from:notes!links_from_note_id_fkey(user_id), to:notes!links_to_note_id_fkey(user_id)")
      .in("user_id", [alice.id, bob.id]);
    expect(error).toBeNull();

    const rows = data as unknown as {
      id: string;
      user_id: string;
      from: { user_id: string };
      to: { user_id: string };
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.from.user_id, `link ${r.id} starts at another user's note`).toBe(r.user_id);
      expect(r.to.user_id, `link ${r.id} ends at another user's note`).toBe(r.user_id);
    }
  });
});

/**
 * The write-side half of the leak above. Reading back seeded rows only proves the fixture
 * behaved; it never attempts the row the rules file cannot stop. Each case here inserts a
 * genuine cross-owner reference and asserts the database refuses it -- this must fail (insert
 * succeeds, error is null) before the composite FK exists, and pass once it does.
 */
describe("a cross-owner child row is rejected at the constraint level", () => {
  it("note_tags cannot be inserted with another user's note_id", async () => {
    const { error } = await admin.from("note_tags").insert({
      user_id: alice.id,
      note_id: seedIds("notes").bob,
      tag_id: seedIds("tags").alice,
      source: "user",
    });
    expect(error, "cross-owner note_id on note_tags should be rejected").not.toBeNull();
  });

  it("note_tags cannot be inserted with another user's tag_id", async () => {
    const { error } = await admin.from("note_tags").insert({
      user_id: alice.id,
      note_id: seedIds("notes").alice,
      tag_id: seedIds("tags").bob,
      source: "user",
    });
    expect(error, "cross-owner tag_id on note_tags should be rejected").not.toBeNull();
  });

  it("links cannot be inserted with another user's note_id as from_note_id", async () => {
    const { error } = await admin.from("links").insert({
      user_id: alice.id,
      from_note_id: seedIds("notes").bob,
      to_note_id: seedIds("notes").alice,
    });
    expect(error, "cross-owner from_note_id on links should be rejected").not.toBeNull();
  });

  it("links cannot be inserted with another user's note_id as to_note_id", async () => {
    const { error } = await admin.from("links").insert({
      user_id: alice.id,
      from_note_id: seedIds("notes").alice,
      to_note_id: seedIds("notes").bob,
    });
    expect(error, "cross-owner to_note_id on links should be rejected").not.toBeNull();
  });
});
