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
    const r = await svc.updateWithConflictCopy(note.id, { content: "offline edit" }, note.content);
    expect(r.conflictCopy).toBeNull();
    expect(r.note.content).toBe("offline edit");
  });

  it("keeps the server body and copies the incoming one when both diverged", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.content;
    // Someone else (web) edits first; the offline client still holds `base`.
    const server = await svc.update(note.id, { content: "web edit" });
    expect(server.content).not.toBe(base);

    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base);

    expect(r.note.content).toBe("web edit");        // server wins
    expect(r.conflictCopy).not.toBeNull();
    expect(r.conflictCopy!.content).toBe("phone edit");
    expect(r.conflictCopy!.lifecycle).toBe("inbox");
  });

  it("links the copy back to the original", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.content;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base);

    const { data } = await createUserClient(alice.token).from("links")
      .select("kind, from_note_id, to_note_id")
      .eq("from_note_id", r.conflictCopy!.id).single();
    expect(data!.kind).toBe("conflict_copy");
    expect(data!.to_note_id).toBe(note.id);
  });

  it("is NOT a conflict when the row was touched but its body is identical", async () => {
    const note = await svc.create({ content: "same" });
    const base = note.content;
    await svc.update(note.id, { lifecycle: "active" });   // moves updated_at, not content
    const r = await svc.updateWithConflictCopy(note.id, { content: "same" }, base);
    expect(r.conflictCopy).toBeNull();
    expect(r.note.content).toBe("same");
  });

  /**
   * The case the device hit, and the one this whole file failed to cover: an ordinary edit with
   * nobody racing it produced a conflict copy every single time.
   *
   * Under `base_updated_at` that was unavoidable. `updated_at` is server-owned -- ignored on
   * insert (`default now()`), overwritten by `notes_set_updated_at` on update -- so a note
   * created on a device holds a device clock the server never issued, and a downloaded one is
   * written by PowerSync as `2026-08-04T04:13:37.916374Z` where PostgREST returns
   * `...916374+00:00`. Compared as strings, the row had always "moved".
   *
   * Every test above fed `note.updated_at` back from the response that produced it, so the
   * matching branch was only ever exercised with a byte-identical PostgREST string -- the one
   * input no client can ever hold.
   */
  it("does not copy an edit that nobody raced, however the base was obtained", async () => {
    const note = await svc.create({ content: "original" });
    // Deliberately NOT `note.updated_at`: the point is that a base the client actually has --
    // the body it displayed -- is enough, with no clock and no serialiser agreement.
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, "original");
    expect(r.conflictCopy).toBeNull();
    expect(r.note.content).toBe("phone edit");
  });

  it("treats an empty body as a real base, not as an absent one", async () => {
    // A note edited down to nothing has "" as the next session's base. If any guard on the path
    // tests falsiness, that base vanishes and the edit applies unconditionally -- last-write-wins
    // over whatever the server holds, on the note whose text the user just destroyed.
    const note = await svc.create({ content: "original" });
    await svc.update(note.id, { content: "" });
    await svc.update(note.id, { content: "web wrote something here" });

    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, "");

    expect(r.conflictCopy).not.toBeNull();
    expect(r.note.content).toBe("web wrote something here");
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
    const base = note.content;
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
    const base = note.content;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base);
    expect(r.linkFailed).toBeUndefined();
  });

  it("copies only the body, applying metadata to the surviving note", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.content;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(
      note.id, { content: "phone edit", lifecycle: "archived" }, base,
    );
    expect(r.note.content).toBe("web edit");
    expect(r.note.lifecycle).toBe("archived");   // metadata is last-write-wins
  });
});
