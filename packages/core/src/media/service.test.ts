import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase.js";
import { makeUser, type TestUser } from "../test/harness.js";
import { NoteService } from "../notes/service.js";
import { MediaService } from "./service.js";

let alice: TestUser;
let svc: MediaService;

beforeAll(async () => {
  alice = await makeUser("core-media-alice@test.local");
  svc = new MediaService(createUserClient(alice.token), alice.id);
  // Idempotent across reruns: media_items_user_kind_title_uidx is a live-row unique
  // index, so yesterday's fixtures would satisfy find-or-create instead of exercising it.
  await alice.client.from("media_items").delete().eq("user_id", alice.id);
});

describe("MediaService.findOrCreateItem", () => {
  it("dedupes case-insensitively within a kind", async () => {
    const a = await svc.findOrCreateItem({ kind: "movie", title: "Dune", year: 2021 });
    const b = await svc.findOrCreateItem({ kind: "movie", title: "DUNE" });
    expect(b.id).toBe(a.id);
  });

  it("treats the same title in a different kind as a different item", async () => {
    const movie = await svc.findOrCreateItem({ kind: "movie", title: "Dune" });
    const book = await svc.findOrCreateItem({ kind: "book", title: "Dune" });
    expect(book.id).not.toBe(movie.id);
  });

  it("does not let LIKE metacharacters match an unrelated item", async () => {
    // Regression: a bare `.ilike(title)` makes '%' and '_' wildcards, so "D%" would match
    // the existing "Dune" and this log would attach to the WRONG entity. The unique index
    // is on lower(title) -- exact -- so the lookup has to be exact too.
    await svc.findOrCreateItem({ kind: "movie", title: "Dune" });
    const wildcard = await svc.findOrCreateItem({ kind: "movie", title: "D%" });
    expect(wildcard.title).toBe("D%");

    const underscore = await svc.findOrCreateItem({ kind: "movie", title: "Dun_" });
    expect(underscore.title).toBe("Dun_");
    expect(underscore.id).not.toBe(wildcard.id);
  });

  it("keeps the year and creator given at creation time", async () => {
    const item = await svc.findOrCreateItem({
      kind: "book", title: "Thinking, Fast and Slow", year: 2011, creator: "Kahneman",
    });
    expect(item.year).toBe(2011);
    expect(item.creator).toBe("Kahneman");
  });

  it("treats '*' as a literal (PostgREST maps '*' to '%' inside ilike patterns)", async () => {
    // "MASH" matches the pattern M%A%S%H, so an ilike-based lookup for "M*A*S*H" scans
    // wildcard-wide. The imatch lookup must both stay exact and round-trip the literal.
    await svc.findOrCreateItem({ kind: "tv", title: "MASH" });
    const star = await svc.findOrCreateItem({ kind: "tv", title: "M*A*S*H" });
    expect(star.title).toBe("M*A*S*H");
    const again = await svc.findOrCreateItem({ kind: "tv", title: "M*A*S*H" });
    expect(again.id).toBe(star.id);
  });

  it("backfills a missing year on an existing item", async () => {
    const bare = await svc.findOrCreateItem({ kind: "movie", title: "Stalker" });
    expect(bare.year).toBeNull();
    const dated = await svc.findOrCreateItem({ kind: "movie", title: "Stalker", year: 1979 });
    expect(dated.id).toBe(bare.id);
    expect(dated.year).toBe(1979);
  });

  it("rejects a contradicting year as a conflict instead of silently discarding it", async () => {
    await svc.findOrCreateItem({ kind: "movie", title: "Solaris", year: 1972 });
    await expect(svc.findOrCreateItem({ kind: "movie", title: "Solaris", year: 2002 }))
      .rejects.toMatchObject({ kind: "conflict" });
  });
});

describe("MediaService.logMedia", () => {
  it("creates the item plus a media note carrying the rating", async () => {
    const { item, note } = await svc.logMedia({
      kind: "book", title: "Thinking, Fast and Slow",
      rating: 5, impression: "changed how I see bias",
    });
    expect(note.domain).toBe("media");
    expect(note.media_item_id).toBe(item.id);
    expect(note.domain_meta).toMatchObject({ rating: 5, status: "finished" });
    expect(note.content).toBe("changed how I see bias");
    expect(note.title).toBe(item.title);
  });

  it("logs with no impression at all (a rating alone is a valid log)", async () => {
    const { note } = await svc.logMedia({ kind: "podcast", title: "Founders", rating: 4 });
    expect(note.content).toBe("");
    expect(note.domain_meta).toMatchObject({ rating: 4 });
  });

  it("makes a rewatch a second note against the same item", async () => {
    // The Letterboxd model (spec §2.2): the item is an entity, each viewing is its own
    // dated log with its own rating.
    const first = await svc.logMedia({ kind: "movie", title: "Arrival", rating: 4 });
    const second = await svc.logMedia({
      kind: "movie", title: "Arrival", rating: 5, impression: "better on rewatch",
    });
    expect(second.item.id).toBe(first.item.id);
    expect(second.note.id).not.toBe(first.note.id);
    expect(second.note.domain_meta).toMatchObject({ rating: 5 });
  });

  it("records consumedAt in domain_meta when given", async () => {
    const { note } = await svc.logMedia({
      kind: "tv", title: "Severance", consumedAt: "2026-07-14",
    });
    expect(note.domain_meta).toMatchObject({ consumed_at: "2026-07-14" });
  });

  it("carries an explicit status and defaults omitted status to finished", async () => {
    const inProgress = await svc.logMedia({
      kind: "book", title: "Gödel, Escher, Bach", status: "in_progress",
    });
    expect(inProgress.note.domain_meta).toMatchObject({ status: "in_progress" });
    const defaulted = await svc.logMedia({ kind: "book", title: "Gödel, Escher, Bach" });
    expect(defaulted.note.domain_meta).toMatchObject({ status: "finished" });
  });

  it("deletes a just-created item when the note insert fails (no orphan in the library)", async () => {
    // rating 6 passes the (unvalidated-at-service-level) input type but fails
    // domainMetaSchemas.media inside NoteService.create -- the note never lands.
    await expect(svc.logMedia({
      kind: "movie", title: "Orphan Probe", rating: 6 as never,
    })).rejects.toMatchObject({ kind: "internal" });
    const { data } = await alice.client.from("media_items")
      .select("id").eq("user_id", alice.id).eq("title", "Orphan Probe");
    expect(data).toEqual([]);
  });

  it("leaves a pre-existing item alone when the note insert fails", async () => {
    const kept = await svc.findOrCreateItem({ kind: "movie", title: "Kept Item" });
    await expect(svc.logMedia({
      kind: "movie", title: "Kept Item", rating: 6 as never,
    })).rejects.toMatchObject({ kind: "internal" });
    const { data } = await alice.client.from("media_items")
      .select("id").eq("id", kept.id);
    expect(data).toHaveLength(1);
  });
});

describe("NoteService carries domain", () => {
  it("creates a note with a domain and validated meta", async () => {
    const notes = new NoteService(createUserClient(alice.token), alice.id);
    const note = await notes.create({
      content: "ran 5k, felt strong", domain: "health",
      domainMeta: { activity_type: "run", duration_min: 28 },
    });
    expect(note.domain).toBe("health");
    expect(note.domain_meta).toMatchObject({ activity_type: "run" });
  });

  it("defaults an undomained note to null domain and empty meta", async () => {
    const notes = new NoteService(createUserClient(alice.token), alice.id);
    const note = await notes.create({ content: "just a thought" });
    expect(note.domain).toBeNull();
    expect(note.domain_meta).toEqual({});
  });

  it("sets and then clears a domain through update", async () => {
    const notes = new NoteService(createUserClient(alice.token), alice.id);
    const note = await notes.create({ content: "maybe finance?" });
    const set = await notes.update(note.id, { domain: "finance" });
    expect(set.domain).toBe("finance");
    const cleared = await notes.update(note.id, { domain: null });
    expect(cleared.domain).toBeNull();
  });

  it("rejects a domain change that strands existing meta (B3)", async () => {
    // A media log's {rating, status} meta fits no other domain's strict schema, so
    // re-domaining the note must 400, not persist a row phase 2 can never read back.
    const { note } = await svc.logMedia({ kind: "movie", title: "Domain Switch", rating: 3 });
    const notes = new NoteService(createUserClient(alice.token), alice.id);
    await expect(notes.update(note.id, { domain: "health" }))
      .rejects.toMatchObject({ kind: "validation" });

    // Clearing the domain stays allowed -- meta without a domain is dormant --
    // and empty meta moves freely between domains.
    const cleared = await notes.update(note.id, { domain: null });
    expect(cleared.domain).toBeNull();
    const plain = await notes.create({ content: "no meta" });
    const moved = await notes.update(plain.id, { domain: "health" });
    expect(moved.domain).toBe("health");
  });

  it("rejects meta that does not match its domain's shape", async () => {
    const notes = new NoteService(createUserClient(alice.token), alice.id);
    await expect(notes.create({
      content: "x", domain: "media", domainMeta: { rating: 6 },
    })).rejects.toMatchObject({ kind: "internal" });
  });
});
