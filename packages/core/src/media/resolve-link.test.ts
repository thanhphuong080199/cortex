import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { NoteService } from "../notes/service.js";
import { MediaService } from "./service.js";

let alice: Awaited<ReturnType<typeof makeUser>>;
let media: MediaService;
let notes: NoteService;

beforeAll(async () => {
  alice = await makeUser("core-resolve-alice@test.local");
  const client = createUserClient(alice.token);
  media = new MediaService(client, alice.id);
  notes = new NoteService(client, alice.id);
  // Fixture tables have unique constraints; clear this user's rows so a rerun without a
  // db reset behaves identically to the first run (issue-log A2).
  await client.from("media_items").delete().eq("user_id", alice.id);
});

async function offlineMediaNote(pending: Record<string, unknown>) {
  return notes.create({
    content: "impression", title: String(pending.title), domain: "media",
    domainMeta: { status: "finished", pending_item: pending },
  });
}

describe("MediaService.resolveNoteMediaLink", () => {
  it("returns null when the meta has no pending_item", async () => {
    const note = await notes.create({ content: "plain" });
    expect(await media.resolveNoteMediaLink(note.id, {})).toBeNull();
  });

  it("creates the item and stamps media_item_id", async () => {
    const note = await offlineMediaNote({ kind: "movie", title: "Arrival" });
    const item = await media.resolveNoteMediaLink(note.id, {
      status: "finished", pending_item: { kind: "movie", title: "Arrival" },
    });
    expect(item!.title).toBe("Arrival");
    const stored = await notes.getById(note.id);
    expect(stored.media_item_id).toBe(item!.id);
  });

  it("reuses the existing item when two devices log the same title", async () => {
    const first = await offlineMediaNote({ kind: "movie", title: "Dune" });
    const a = await media.resolveNoteMediaLink(first.id, {
      status: "finished", pending_item: { kind: "movie", title: "Dune" },
    });
    const second = await offlineMediaNote({ kind: "movie", title: "dune" }); // different casing
    const b = await media.resolveNoteMediaLink(second.id, {
      status: "finished", pending_item: { kind: "movie", title: "dune" },
    });
    expect(b!.id).toBe(a!.id);
  });

  it("does not wildcard on % or *", async () => {
    // Seed the "Dune" ITEM explicitly. Relying on an earlier test having created it
    // makes this pass vacuously when run in isolation or under a shuffled order --
    // and a wildcard-regression guard that quietly stops guarding is worse than none.
    const seed = await offlineMediaNote({ kind: "movie", title: "Dune" });
    await media.resolveNoteMediaLink(seed.id, {
      status: "finished", pending_item: { kind: "movie", title: "Dune" },
    });
    const note = await offlineMediaNote({ kind: "movie", title: "D%" });
    const item = await media.resolveNoteMediaLink(note.id, {
      status: "finished", pending_item: { kind: "movie", title: "D%" },
    });
    expect(item!.title).toBe("D%");   // a NEW item, not the existing "Dune"
  });

  it("clears pending_item from the stored meta once resolved", async () => {
    const note = await offlineMediaNote({ kind: "book", title: "Piranesi" });
    await media.resolveNoteMediaLink(note.id, {
      status: "finished", pending_item: { kind: "book", title: "Piranesi" },
    });
    const stored = await notes.getById(note.id);
    expect(stored.domain_meta.pending_item).toBeUndefined();
    expect(stored.domain_meta.status).toBe("finished");
  });

  it("surfaces a contradicting year as a conflict", async () => {
    const first = await offlineMediaNote({ kind: "movie", title: "Solaris", year: 1972 });
    await media.resolveNoteMediaLink(first.id, {
      status: "finished", pending_item: { kind: "movie", title: "Solaris", year: 1972 },
    });
    const second = await offlineMediaNote({ kind: "movie", title: "Solaris", year: 2002 });
    await expect(media.resolveNoteMediaLink(second.id, {
      status: "finished", pending_item: { kind: "movie", title: "Solaris", year: 2002 },
    })).rejects.toMatchObject({ kind: "conflict" });
  });

  it("deletes the item it just created when the note cannot be updated", async () => {
    // A foreign or missing noteId matches zero rows. The item must not survive as an
    // orphan -- there is no delete surface for media_items.
    const orphanTitle = `Orphan ${Date.now()}`;
    await expect(media.resolveNoteMediaLink(
      "00000000-0000-4000-8000-000000000000",
      { status: "finished", pending_item: { kind: "movie", title: orphanTitle } },
    )).rejects.toMatchObject({ kind: "not_found" });

    const { data } = await createUserClient(alice.token).from("media_items")
      .select("id").eq("user_id", alice.id).eq("title", orphanTitle);
    expect(data).toEqual([]);
  });

  it("leaves a pre-existing item alone when the note cannot be updated", async () => {
    // Unique title so this test's assertions do not depend on run order against the
    // "clears pending_item" test, which also logs a book titled "Piranesi".
    const title = `Piranesi ${Date.now()}`;
    const note = await offlineMediaNote({ kind: "book", title });
    await media.resolveNoteMediaLink(note.id, {
      status: "finished", pending_item: { kind: "book", title },
    });

    await expect(media.resolveNoteMediaLink(
      "00000000-0000-4000-8000-000000000000",
      { status: "finished", pending_item: { kind: "book", title } },
    )).rejects.toMatchObject({ kind: "not_found" });

    const { data } = await createUserClient(alice.token).from("media_items")
      .select("id").eq("user_id", alice.id).eq("title", title).is("deleted_at", null);
    expect(data).toHaveLength(1);   // compensation must not touch what it did not create
  });
});
