import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { NoteService } from "../notes/service.js";
import { TagService } from "./service.js";

let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
let tags: TagService;
let notes: NoteService;

beforeAll(async () => {
  alice = await makeUser("core-tags-alice@test.local");
  bob = await makeUser("core-tags-bob@test.local");
  tags = new TagService(createUserClient(alice.token), alice.id);
  notes = new NoteService(createUserClient(alice.token), alice.id);
});

describe("TagService.findOrCreate", () => {
  it("is idempotent and case-insensitive", async () => {
    const a = await tags.findOrCreate({ name: "Ideas" });
    const b = await tags.findOrCreate({ name: "ideas" });
    expect(b.id).toBe(a.id);
    expect(a.created_by).toBe("user");
  });

  // `_` and `%` are LIKE wildcards. An unescaped ilike() lookup makes "a_c" match an
  // existing "abc" and silently return the WRONG tag instead of creating a new one.
  it("treats LIKE metacharacters as literals, not wildcards", async () => {
    const literal = await tags.findOrCreate({ name: "abc" });
    const wildcard = await tags.findOrCreate({ name: "a_c" });
    expect(wildcard.id).not.toBe(literal.id);
    expect(wildcard.name).toBe("a_c");

    const pct = await tags.findOrCreate({ name: "50% done" });
    expect(pct.name).toBe("50% done");
    expect((await tags.findOrCreate({ name: "50% done" })).id).toBe(pct.id);
  });
});

describe("attach / detach / re-attach", () => {
  it("survives the full cycle (migration 00011 contract)", async () => {
    const note = await notes.create({ content: "taggable" });
    const tag = await tags.findOrCreate({ name: "cycle-core" });
    const link = await tags.attach(note.id, tag.id);
    expect(link.status).toBe("accepted");
    await tags.detach(note.id, tag.id);
    const relink = await tags.attach(note.id, tag.id); // must not 23505
    expect(relink.id).not.toBe(link.id);
  });

  // note_tags' RLS policy only checks user_id, and the FK to notes is evaluated as
  // table owner (bypassing RLS) -- so nothing in the database stops Alice from
  // linking her tag to Bob's note. The ownership check must live in the service.
  it("attaching to a foreign note is not_found", async () => {
    const bobsNote = await new NoteService(createUserClient(bob.token), bob.id)
      .create({ content: "bob note" });
    const tag = await tags.findOrCreate({ name: "trespass" });
    await expect(tags.attach(bobsNote.id, tag.id))
      .rejects.toMatchObject({ kind: "not_found" });
  });

  it("attaching a foreign tag is not_found", async () => {
    const bobsTag = await new TagService(createUserClient(bob.token), bob.id)
      .findOrCreate({ name: "bob-only" });
    const note = await notes.create({ content: "mine" });
    await expect(tags.attach(note.id, bobsTag.id))
      .rejects.toMatchObject({ kind: "not_found" });
  });

  it("attaching to a trashed note is not_found", async () => {
    const note = await notes.create({ content: "about to be trashed" });
    await notes.softDelete(note.id);
    const tag = await tags.findOrCreate({ name: "too-late" });
    await expect(tags.attach(note.id, tag.id))
      .rejects.toMatchObject({ kind: "not_found" });
  });

  it("attaching an already-attached tag is a conflict, not a duplicate row", async () => {
    const note = await notes.create({ content: "double tag" });
    const tag = await tags.findOrCreate({ name: "dupe" });
    await tags.attach(note.id, tag.id);
    await expect(tags.attach(note.id, tag.id))
      .rejects.toMatchObject({ kind: "conflict" });
  });

  it("detaching a non-attached tag is not_found", async () => {
    const note = await notes.create({ content: "bare" });
    const tag = await tags.findOrCreate({ name: "never-attached" });
    await expect(tags.detach(note.id, tag.id))
      .rejects.toMatchObject({ kind: "not_found" });
  });
});
