import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { NoteService } from "./service.js";

let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
let svc: NoteService;

beforeAll(async () => {
  alice = await makeUser("core-notes-alice@test.local");
  bob = await makeUser("core-notes-bob@test.local");
  svc = new NoteService(createUserClient(alice.token), alice.id);
});

describe("NoteService.create", () => {
  it("creates an inbox note with defaults", async () => {
    const note = await svc.create({ content: "hello world" });
    expect(note.lifecycle).toBe("inbox");
    expect(note.user_id).toBe(alice.id);
    expect(note.title).toBeNull();
  });
});

describe("NoteService.update", () => {
  it("patches only provided fields", async () => {
    const note = await svc.create({ content: "before", title: "t" });
    const updated = await svc.update(note.id, { lifecycle: "archived" });
    expect(updated.lifecycle).toBe("archived");
    expect(updated.content).toBe("before"); // untouched
  });
  it("clears the title on an explicit null", async () => {
    const note = await svc.create({ content: "titled", title: "drop me" });
    const updated = await svc.update(note.id, { title: null });
    expect(updated.title).toBeNull();
  });
  it("throws not_found for another user's note", async () => {
    const bobsNote = await new NoteService(createUserClient(bob.token), bob.id)
      .create({ content: "bob's" });
    await expect(svc.update(bobsNote.id, { content: "steal" }))
      .rejects.toMatchObject({ kind: "not_found" });
  });
  it("throws not_found for a random uuid", async () => {
    await expect(svc.update(crypto.randomUUID(), { content: "x" }))
      .rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("NoteService trash lifecycle", () => {
  it("softDelete sets deleted_at; restore clears it", async () => {
    const note = await svc.create({ content: "trash me" });
    const trashed = await svc.softDelete(note.id);
    expect(trashed.deleted_at).not.toBeNull();
    const restored = await svc.restore(note.id);
    expect(restored.deleted_at).toBeNull();
  });

  it("purge on a live note is not_found (two-step deletion)", async () => {
    const note = await svc.create({ content: "still alive" });
    await expect(svc.purge(note.id)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("purge on a trashed note hard-deletes it", async () => {
    const note = await svc.create({ content: "goodbye" });
    await svc.softDelete(note.id);
    await svc.purge(note.id);
    const { data } = await alice.client.from("notes").select("id").eq("id", note.id);
    expect(data).toEqual([]);
  });

  it("update refuses a trashed note (not_found)", async () => {
    const note = await svc.create({ content: "trashed, not editable" });
    await svc.softDelete(note.id);
    await expect(svc.update(note.id, { content: "zombie edit" }))
      .rejects.toMatchObject({ kind: "not_found" });
  });

  it("restore on a live note is not_found", async () => {
    const note = await svc.create({ content: "never trashed" });
    await expect(svc.restore(note.id)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("Bob cannot purge Alice's trashed note", async () => {
    const note = await svc.create({ content: "alice's trash" });
    await svc.softDelete(note.id);
    const bobSvc = new NoteService(createUserClient(bob.token), bob.id);
    await expect(bobSvc.purge(note.id)).rejects.toMatchObject({ kind: "not_found" });
  });
});
