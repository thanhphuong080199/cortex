import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { NoteService } from "./service.js";

let alice: Awaited<ReturnType<typeof makeUser>>;
let svc: NoteService;

beforeAll(async () => {
  alice = await makeUser("core-conflict-alice@test.local");
  svc = new NoteService(createUserClient(alice.token), alice.id);
});

describe("NoteService.updateWithConflictCopy", () => {
  it("applies normally when the base matches", async () => {
    const note = await svc.create({ content: "original" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "offline edit" }, note.updated_at);
    expect(r.conflictCopy).toBeNull();
    expect(r.note.content).toBe("offline edit");
  });

  it("keeps the server body and copies the incoming one when both diverged", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.updated_at;
    // Someone else (web) edits first; the offline client still holds `base`.
    const server = await svc.update(note.id, { content: "web edit" });
    expect(server.updated_at).not.toBe(base);

    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base);

    expect(r.note.content).toBe("web edit");        // server wins
    expect(r.conflictCopy).not.toBeNull();
    expect(r.conflictCopy!.content).toBe("phone edit");
    expect(r.conflictCopy!.lifecycle).toBe("inbox");
  });

  it("links the copy back to the original", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.updated_at;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base);

    const { data } = await createUserClient(alice.token).from("links")
      .select("kind, from_note_id, to_note_id")
      .eq("from_note_id", r.conflictCopy!.id).single();
    expect(data!.kind).toBe("conflict_copy");
    expect(data!.to_note_id).toBe(note.id);
  });

  it("is NOT a conflict when the row moved but content is identical", async () => {
    const note = await svc.create({ content: "same" });
    const base = note.updated_at;
    await svc.update(note.id, { lifecycle: "active" });   // moves updated_at, not content
    const r = await svc.updateWithConflictCopy(note.id, { content: "same" }, base);
    expect(r.conflictCopy).toBeNull();
    expect(r.note.content).toBe("same");
  });

  it("applies unconditionally when no base is supplied", async () => {
    const note = await svc.create({ content: "original" });
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" });
    expect(r.conflictCopy).toBeNull();
    expect(r.note.content).toBe("phone edit");
  });

  it("reports linkFailed when the link cannot be written, without losing the copy", async () => {
    // Force the link insert to fail by pointing the service at a client whose `links`
    // writes are rejected -- the copy must still exist and be returned.
    const note = await svc.create({ content: "original" });
    const base = note.updated_at;
    await svc.update(note.id, { content: "web edit" });

    const sabotaged = createUserClient(alice.token);
    const realFrom = sabotaged.from.bind(sabotaged);
    sabotaged.from = ((table: string) =>
      table === "links"
        ? { insert: async () => ({ error: { code: "42501", message: "denied" } }) }
        : realFrom(table)) as typeof sabotaged.from;

    const r = await new NoteService(sabotaged, alice.id)
      .updateWithConflictCopy(note.id, { content: "phone edit" }, base);

    expect(r.linkFailed).toBe(true);
    expect(r.conflictCopy).not.toBeNull();
    expect(r.conflictCopy!.content).toBe("phone edit");   // the text survived
  });

  it("omits linkFailed entirely on the happy path", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.updated_at;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base);
    expect(r.linkFailed).toBeUndefined();
  });

  it("copies only the body, applying metadata to the surviving note", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.updated_at;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(
      note.id, { content: "phone edit", lifecycle: "archived" }, base,
    );
    expect(r.note.content).toBe("web edit");
    expect(r.note.lifecycle).toBe("archived");   // metadata is last-write-wins
  });
});
