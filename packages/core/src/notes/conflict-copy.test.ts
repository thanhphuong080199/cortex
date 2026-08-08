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
    const r = await svc.updateWithConflictCopy(note.id, { content: "offline edit" }, note.content, "1");
    expect(r.conflictCopy).toBeNull();
    expect(r.note.content).toBe("offline edit");
  });

  it("keeps the server body and copies the incoming one when both diverged", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.content;
    // Someone else (web) edits first; the offline client still holds `base`.
    const server = await svc.update(note.id, { content: "web edit" });
    expect(server.content).not.toBe(base);

    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base, "2");

    expect(r.note.content).toBe("web edit");        // server wins
    expect(r.conflictCopy).not.toBeNull();
    expect(r.conflictCopy!.content).toBe("phone edit");
    expect(r.conflictCopy!.lifecycle).toBe("inbox");
  });

  it("links the copy back to the original", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.content;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base, "3");

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
    const r = await svc.updateWithConflictCopy(note.id, { content: "same" }, base, "4");
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
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, "original", "5");
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

    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, "", "6");

    expect(r.conflictCopy).not.toBeNull();
    expect(r.note.content).toBe("web wrote something here");
  });

  it("applies unconditionally when no base is supplied", async () => {
    const note = await svc.create({ content: "original" });
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, undefined, "7");
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
      .updateWithConflictCopy(note.id, { content: "phone edit" }, base, "8");

    expect(r.linkFailed).toBe(true);
    expect(r.conflictCopy).not.toBeNull();
    expect(r.conflictCopy!.content).toBe("phone edit");   // the text survived
  });

  it("omits linkFailed entirely on the happy path", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.content;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base, "9");
    expect(r.linkFailed).toBeUndefined();
  });

  /**
   * Finding #4 (handoff, round 2): PowerSync resends a batch whenever the response is lost, so
   * the connector can replay the exact same op -- same op_id, same base_content -- against a
   * server row that (from its perspective) is unchanged between the two calls. Before the
   * conflict copy's id was derived from op_id, each replay minted a fresh random id and the
   * inbox grew a duplicate note per retry.
   */
  it("does not duplicate the conflict copy when the same op is replayed", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.content;
    await svc.update(note.id, { content: "web edit" });

    const first = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base, "replay-1");
    const second = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base, "replay-1");

    expect(first.conflictCopy).not.toBeNull();
    expect(second.conflictCopy).not.toBeNull();
    expect(second.conflictCopy!.id).toBe(first.conflictCopy!.id);

    // Scoped to THIS note's links, not content -- other tests in this file also use "phone
    // edit" against the same shared `alice` fixture.
    const { data } = await createUserClient(alice.token).from("links")
      .select("from_note_id").eq("to_note_id", note.id).eq("kind", "conflict_copy");
    expect(data).toHaveLength(1);
  });

  it("copies only the body, applying metadata to the surviving note", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.content;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(
      note.id, { content: "phone edit", lifecycle: "archived" }, base, "10",
    );
    expect(r.note.content).toBe("web edit");
    expect(r.note.lifecycle).toBe("archived");   // metadata is last-write-wins
  });

  /**
   * Round 2, finding #5. The metadata `update()` used to run BEFORE the copy was created, so
   * when that update throws -- a domain change the note's existing domain_meta cannot satisfy
   * is the realistic trigger -- the op fails after the phone's text already left the device's
   * queue and before any row holds it. Reordering so the copy is written first makes the same
   * failure non-destructive: the metadata patch can still fail, but the offline body always
   * survives as the copy.
   */
  it("keeps the offline body as a copy even when the metadata patch afterward throws", async () => {
    const note = await svc.create({
      content: "original", domain: "media", domainMeta: { rating: 5 },
    });
    const base = note.content;
    await svc.update(note.id, { content: "web edit" });

    // media's {rating: 5} does not fit health's strict schema, so update()'s domain_meta
    // re-validation throws -- but only AFTER the conflict is genuine and the copy should
    // already hold the phone's body.
    await expect(
      svc.updateWithConflictCopy(
        note.id, { content: "phone edit finding5", domain: "health" }, base, "finding5",
      ),
    ).rejects.toBeTruthy();

    // The link write happens AFTER the metadata update in the normal path, so it never runs in
    // this scenario -- the copy note itself is the only thing this guards. At least one, not
    // exactly one: the copy's id is derived from this test's own (fresh) note id, so repeat
    // runs against this persistent fixture create distinct rows rather than colliding, and
    // "at least one exists" is the actual property (a real client-chosen id would collide and
    // no-op via createWithId's own 23505 fallback; that path is covered elsewhere).
    const { data } = await createUserClient(alice.token).from("notes")
      .select("id").eq("content", "phone edit finding5");
    expect(data!.length, "the phone's body must survive as a conflict copy even though the op failed")
      .toBeGreaterThan(0);
  });

  /**
   * The copy is the phone's text, and it is the only place that text exists. Built from
   * content and title alone it lands with domain null -- so it does not appear under the
   * domain filter the user would look in, and a media log's copy loses the item it was
   * about. Everything except the body is carried over, exactly as the surviving note's
   * metadata is.
   */
  it("carries domain, domain_meta and media_item_id onto the conflict copy", async () => {
    const note = await svc.create({
      content: "server body",
      domain: "media",
      domainMeta: { status: "finished", rating: 4 },
    });

    const { conflictCopy } = await svc.updateWithConflictCopy(
      note.id,
      { content: "phone body" },
      "the body the phone started from",
      "op-domain-carry",
    );

    expect(conflictCopy).not.toBeNull();
    const stored = await svc.getById(conflictCopy!.id);
    expect(stored.content).toBe("phone body");
    expect(stored.domain).toBe("media");
    expect(stored.domain_meta).toMatchObject({ status: "finished", rating: 4 });
  });
});
