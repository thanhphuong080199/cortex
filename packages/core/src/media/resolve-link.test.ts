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
    await offlineMediaNote({ kind: "movie", title: "Dune" });
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
});
