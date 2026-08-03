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
  await alice.client
    .from("notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
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
    const { data: tag } = await alice.client
      .from("tags")
      .insert({ user_id: alice.id, name: `purge-tag-${Date.now()}` })
      .select("id")
      .single();
    await alice.client
      .from("note_tags")
      .insert({ user_id: alice.id, note_id: id, tag_id: tag!.id });

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
    await alice.client.from("links").insert([
      { user_id: alice.id, from_note_id: purged, to_note_id: survivor, kind: "related" },
      { user_id: alice.id, from_note_id: survivor, to_note_id: purged, kind: "related" },
    ]);

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

  /**
   * The guard that makes purge a deliberate second step rather than something a stray DELETE
   * can do. Without it, any delete path reaches live notes directly.
   */
  it("refuses to purge a note that was never trashed", async () => {
    const id = await seedNote("still live");

    await alice.client.from("notes").delete().eq("id", id).not("deleted_at", "is", null);

    const { data } = await admin.from("notes").select("id").eq("id", id);
    expect(data).toHaveLength(1);
  });
});
