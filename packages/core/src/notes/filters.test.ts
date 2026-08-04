// applyNoteFilters against a REAL PostgREST query. The predicate half (parseNoteFilters,
// matchesFilters, noteSelect, requiresRefetch) is pure and tested in @cortex/shared; only
// what needs a database lives here.
//
// Every assertion below is an EXACT id set, not `data.every(...)`. `every` over a query's
// own narrowing restates the query and is vacuously true on an empty result -- the Task 12
// failure mode. An exact set fails in both directions: a row wrongly admitted and a row
// wrongly excluded.
import { beforeAll, describe, expect, it } from "vitest";
import { applyNoteFilters, noteSelect, type NoteFilters } from "@cortex/shared";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { TagService } from "../organize/service.js";
import { NoteService } from "./service.js";

let alice: Awaited<ReturnType<typeof makeUser>>;
const ids: Record<string, string> = {};
let tagId: string;

beforeAll(async () => {
  alice = await makeUser("core-filters-alice@test.local");
  const client = createUserClient(alice.token);
  const svc = new NoteService(client, alice.id);
  const tags = new TagService(client, alice.id);

  // Rerunnable without a db reset (issue-log A2): makeUser reuses a fixed email, so
  // without this the seeded set grows every run and the exact-set assertions rot.
  await client.from("notes").delete().eq("user_id", alice.id);

  ids.inboxMedia = (await svc.create({ content: "alpha pricing psychology", domain: "media" })).id;
  ids.inboxPlain = (await svc.create({ content: "beta plain" })).id;

  const active = await svc.create({ content: "gamma" });
  await svc.update(active.id, { lifecycle: "active" });
  ids.active = active.id;

  const evergreen = await svc.create({ content: "delta" });
  await svc.update(evergreen.id, { lifecycle: "evergreen" });
  ids.evergreen = evergreen.id;

  const archived = await svc.create({ content: "epsilon" });
  await svc.update(archived.id, { lifecycle: "archived" });
  ids.archived = archived.id;

  // Two trashed notes, one domained and one not, so `{view:"trash", domain:"media"}` has
  // something to wrongly admit as well as something to wrongly exclude.
  const trashedMedia = await svc.create({ content: "zeta", domain: "media" });
  await svc.softDelete(trashedMedia.id);
  ids.trashedMedia = trashedMedia.id;

  const trashedPlain = await svc.create({ content: "eta" });
  await svc.softDelete(trashedPlain.id);
  ids.trashedPlain = trashedPlain.id;

  tagId = (await tags.findOrCreate({ name: "filters-fixture" })).id;
  await tags.attach(ids.inboxMedia, tagId);
});

/** The ids applyNoteFilters actually returns, sorted so set comparison is order-free. */
async function run(f: NoteFilters): Promise<string[]> {
  const { data, error } = await applyNoteFilters(
    createUserClient(alice.token).from("notes").select(noteSelect(f)),
    f,
  );
  if (error) throw error;
  return (data as unknown as { id: string }[]).map((r) => r.id).sort();
}

const set = (...keys: string[]) => keys.map((k) => ids[k]).sort();

describe("applyNoteFilters against the database", () => {
  it("inbox returns the inbox notes and nothing else", async () => {
    expect(await run({ view: "inbox" })).toEqual(set("inboxMedia", "inboxPlain"));
  });

  it("active covers both active and evergreen", async () => {
    // Named risk: one view over two lifecycle states. An applier that emitted
    // eq("lifecycle","active") would drop the evergreen note and fail here.
    expect(await run({ view: "active" })).toEqual(set("active", "evergreen"));
  });

  it("archived returns only the archived note", async () => {
    expect(await run({ view: "archived" })).toEqual(set("archived"));
  });

  it("trash returns the deleted notes and only those", async () => {
    expect(await run({ view: "trash" })).toEqual(set("trashedMedia", "trashedPlain"));
  });

  it("full-text search narrows to the note containing the word", async () => {
    // Both directions: the match is present AND the other inbox note is gone. Asserting
    // only `length > 0` would pass with `q` ignored entirely.
    expect(await run({ view: "inbox", q: "pricing" })).toEqual(set("inboxMedia"));
  });

  it("full-text search returns nothing for a word no note contains", async () => {
    expect(await run({ view: "inbox", q: "nonexistentword" })).toEqual([]);
  });

  it("domain narrows the live views", async () => {
    expect(await run({ view: "inbox", domain: "media" })).toEqual(set("inboxMedia"));
  });

  it("domain narrows without overriding the view", async () => {
    // The trashed media note is in; the trashed undomained note is out (domain applied)
    // and the LIVE media note is out (view not overridden). Both directions, one filter.
    expect(await run({ view: "trash", domain: "media" })).toEqual(set("trashedMedia"));
  });

  it("a domain with no notes in the view returns nothing", async () => {
    expect(await run({ view: "inbox", domain: "health" })).toEqual([]);
  });

  it("tag narrows through the note_tags join", async () => {
    expect(await run({ view: "inbox", tag: tagId })).toEqual(set("inboxMedia"));
  });

  it("an unused tag returns nothing rather than everything", async () => {
    // The inner join is the whole point: get the embedded filter wrong and PostgREST
    // returns every note with an empty note_tags array instead of no notes at all.
    const other = await new TagService(createUserClient(alice.token), alice.id)
      .findOrCreate({ name: "filters-fixture-unused" });
    expect(await run({ view: "inbox", tag: other.id })).toEqual([]);
  });

  it("orders by updated_at descending", async () => {
    const { data, error } = await applyNoteFilters(
      createUserClient(alice.token).from("notes").select("id, updated_at"),
      { view: "inbox" },
    );
    if (error) throw error;
    const rows = data as unknown as { id: string; updated_at: string }[];

    // Asserting `stamps === [...stamps].sort().reverse()` derives the expectation from the
    // answer, so it says only "is sorted" -- vacuously true on 0 or 1 rows, and true on ties,
    // which two notes created back-to-back can easily produce. This is the ONE property the
    // equivalence suite cannot cross-check (both sides sort ids before comparing, and
    // noteFiltersToSql emits no ORDER BY at all), so it has to be exact here.
    //
    // `inboxPlain` is created after `inboxMedia` and neither is updated afterwards, so newest
    // first is an exact, known sequence.
    expect(rows.map((r) => r.id)).toEqual([ids.inboxPlain, ids.inboxMedia]);
    // And the stamps must genuinely differ: on a tie the order is arbitrary, so the assertion
    // above would be pinning luck. Better to fail loudly than to flake later.
    expect(rows[0]!.updated_at).not.toBe(rows[1]!.updated_at);
  });
});
