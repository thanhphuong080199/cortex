import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

let alice: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  alice = await makeUser("db-purge-alice@test.local");
});

async function seedNote(content: string): Promise<string> {
  const { data, error } = await alice.client
    .from("notes")
    .insert({ user_id: alice.id, content })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

/** Trash, then purge — the two-step the UI performs. */
async function purge(id: string) {
  const { error: trashError } = await alice.client
    .from("notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  // Checked, so a failure surfaces here rather than as a confusing assertion three lines down.
  if (trashError) throw trashError;
  const { error } = await alice.client
    .from("notes")
    .delete()
    .eq("id", id)
    .not("deleted_at", "is", null);
  if (error) throw error;
}

/**
 * A purged note must actually LEAVE the device, not merely the server (spec §7.7).
 *
 * PowerSync ships a tombstone only when the row is genuinely gone from the replicated table,
 * and logical replication bypasses RLS — so every assertion here reads through `admin`
 * (service_role). A row still visible to service_role is a row still on the phone, whatever
 * RLS shows the user.
 */
describe("purge is a hard delete, so it can propagate as a tombstone", () => {
  it("removes the row entirely rather than flagging it", async () => {
    const id = await seedNote("purge me");

    await purge(id);

    // The point is not that DELETE deletes — it is that nothing downstream (a rule, a trigger,
    // a soft-delete convention) quietly rewrites it into an update that would leave the row,
    // and its content, sitting in local SQLite forever.
    const { data } = await admin.from("notes").select("id, deleted_at").eq("id", id);
    expect(data).toEqual([]);
  });

  it("leaves no orphaned note_tags rows behind to resurrect the reference", async () => {
    const id = await seedNote("tagged then purged");
    const { data: tag, error: tagError } = await alice.client
      .from("tags")
      .insert({ user_id: alice.id, name: `purge-tag-${Date.now()}` })
      .select("id")
      .single();
    if (tagError) throw tagError;
    // `source` is NOT NULL with no default (00003). Omitting it is a 23502 that the original
    // unchecked insert swallowed, so this test seeded no join row at all and its `toEqual([])`
    // below held over a set that was empty before the purge ever ran.
    const { error: linkError } = await alice.client
      .from("note_tags")
      .insert({ user_id: alice.id, note_id: id, tag_id: tag!.id, source: "user" });
    if (linkError) throw linkError;

    // The row must EXIST before the purge, or `toEqual([])` below is satisfied by a join row
    // that was never created and the cascade is never exercised at all.
    const { data: before } = await admin.from("note_tags").select("id").eq("note_id", id);
    expect(before).toHaveLength(1);

    await purge(id);

    const { data } = await admin.from("note_tags").select("id").eq("note_id", id);
    expect(data).toEqual([]); // ON DELETE CASCADE (00003)
  });

  /**
   * `links` carries its own `user_id` AND a foreign key into `notes` in both directions — the
   * same shape Task 12 found could bucket a child row into a stream its parent does not belong
   * to. A surviving link would sync to the device pointing at a note that is gone, which is a
   * dangling reference the client has no way to resolve.
   */
  it("removes links pointing at the purged note from BOTH directions", async () => {
    const purged = await seedNote("purged end of a link");
    const survivor = await seedNote("surviving end of a link");
    // `reference`, not `related`: links_kind_check allows only semantic | manual | reference |
    // conflict_copy (00003, widened by 00015). An invalid kind is a 23514 that, unchecked,
    // inserts nothing and leaves both assertions below passing over an empty set.
    const { error } = await alice.client.from("links").insert([
      { user_id: alice.id, from_note_id: purged, to_note_id: survivor, kind: "reference" },
      { user_id: alice.id, from_note_id: survivor, to_note_id: purged, kind: "reference" },
    ]);
    if (error) throw error;

    // Both directions must EXIST first, or the cascade assertions prove nothing.
    const { data: seededOut } = await admin.from("links").select("id").eq("from_note_id", purged);
    const { data: seededIn } = await admin.from("links").select("id").eq("to_note_id", purged);
    expect(seededOut).toHaveLength(1);
    expect(seededIn).toHaveLength(1);

    await purge(purged);

    const { data: outgoing } = await admin.from("links").select("id").eq("from_note_id", purged);
    const { data: incoming } = await admin.from("links").select("id").eq("to_note_id", purged);
    // An FK cascade on only one column is easy to miss and leaves half the references behind.
    expect(outgoing).toEqual([]);
    expect(incoming).toEqual([]);

    const { data: kept } = await admin.from("notes").select("id").eq("id", survivor);
    expect(kept).toHaveLength(1);
  });

  it("purges only the note it names", async () => {
    const target = await seedNote("goes");
    const bystander = await seedNote("stays");

    await purge(target);

    // A purge whose predicate is too broad is unrecoverable, and it propagates as tombstones
    // for every row it took.
    const { data } = await admin.from("notes").select("id").eq("id", bystander);
    expect(data).toHaveLength(1);
  });

  // REMOVED: "refuses to purge a note that was never trashed". It could not fail — the DELETE
  // it issued carried `.not("deleted_at","is",null)` itself, so the live row was excluded by
  // the test's own predicate, and the docstring claimed a database guard that does not exist
  // (`notes_own` in 00002 has no deleted_at condition). The trashed-first rule is enforced in
  // NoteService.purge and is already tested there, against the real surface.
});
