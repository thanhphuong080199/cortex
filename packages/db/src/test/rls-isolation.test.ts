import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makeUser } from "./clients.js";

const CLIENT_TABLES = [
  "notes", "tags", "note_tags", "links", "tasks", "review_queue",
  "digests", "memory_facts", "chat_sessions", "chat_messages",
  "calendar_links", "attachments",
];

let alice: { client: SupabaseClient; id: string };
let bob: { client: SupabaseClient; id: string };
let aliceNoteId: string;

beforeAll(async () => {
  alice = await makeUser("alice@test.local");
  bob = await makeUser("bob@test.local");
  const { data } = await alice.client.from("notes")
    .insert({ user_id: alice.id, title: "secret", content: "alice only" })
    .select("id").single();
  aliceNoteId = data!.id;
});

describe("cross-user isolation", () => {
  it("bob reads zero rows from every client-visible table", async () => {
    for (const table of CLIENT_TABLES) {
      const { data, error } = await bob.client.from(table).select("id");
      expect(error, table).toBeNull();
      expect(data, table).toHaveLength(0);
    }
  });

  it("bob cannot read alice's note by id", async () => {
    const { data } = await bob.client.from("notes").select("*").eq("id", aliceNoteId);
    expect(data).toHaveLength(0);
  });

  it("bob cannot update or delete alice's note", async () => {
    const { data: upd } = await bob.client.from("notes")
      .update({ title: "hacked" }).eq("id", aliceNoteId).select();
    expect(upd).toHaveLength(0);                       // 0 rows affected
    const { data: del } = await bob.client.from("notes")
      .delete().eq("id", aliceNoteId).select();
    expect(del).toHaveLength(0);
    const { data: still } = await alice.client.from("notes").select("title").eq("id", aliceNoteId).single();
    expect(still!.title).toBe("secret");
  });

  it("bob cannot insert rows owned by alice", async () => {
    const { error } = await bob.client.from("notes")
      .insert({ user_id: alice.id, content: "forged" });
    expect(error).not.toBeNull();                      // with check blocks foreign user_id
  });

  it("anonymous clients read nothing", async () => {
    const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } });
    const { data } = await anon.from("notes").select("id");
    expect(data ?? []).toHaveLength(0);
  });
});
