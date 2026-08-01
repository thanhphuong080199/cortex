import { describe, expect, it } from "vitest";
import { makeUser } from "./clients.js";

describe("note_tags detach → re-attach", () => {
  it("allows re-attaching a tag after soft-deleting the link", async () => {
    const { client, id } = await makeUser("reattach@test.local");
    // Idempotency (see rls-isolation.test.ts): "cycle" hits tags' unique index on the
    // second run without a `supabase db reset`, and the tag insert below is unchecked,
    // so the failure surfaces as a confusing "Cannot read properties of null".
    await client.from("tags").delete().eq("name", "cycle");
    const { data: note } = await client.from("notes")
      .insert({ user_id: id, content: "re-attach cycle" }).select().single();
    const { data: tag } = await client.from("tags")
      .insert({ user_id: id, name: "cycle" }).select().single();

    const first = await client.from("note_tags")
      .insert({ user_id: id, note_id: note!.id, tag_id: tag!.id, source: "user" })
      .select().single();
    expect(first.error).toBeNull();

    const del = await client.from("note_tags")
      .update({ deleted_at: new Date().toISOString() }).eq("id", first.data!.id);
    expect(del.error).toBeNull();

    const second = await client.from("note_tags")
      .insert({ user_id: id, note_id: note!.id, tag_id: tag!.id, source: "user" });
    expect(second.error).toBeNull(); // fails with 23505 before migration 00011
  });
});
