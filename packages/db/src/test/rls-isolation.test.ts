import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makeUser } from "./clients.js";

const CLIENT_TABLES = [
  "notes", "tags", "note_tags", "links", "tasks", "review_queue",
  "digests", "memory_facts", "chat_sessions", "chat_messages",
  "calendar_links", "attachments",
  // Life-domain tables (00013). Spec §5 calls RLS the primary real protection for
  // health/mood/finance rows, so these carry the same provable isolation as the rest.
  "media_items", "checkins", "flashcards",
];

let alice: { client: SupabaseClient; id: string };
let bob: { client: SupabaseClient; id: string };
let aliceNoteId: string;

beforeAll(async () => {
  alice = await makeUser("alice@test.local");
  bob = await makeUser("bob@test.local");
  // Idempotent across reruns without `supabase db reset`: clear any leftover fixture
  // note from a prior run (scoped to alice's own rows via RLS) before inserting fresh.
  await alice.client.from("notes").delete().eq("title", "secret");
  const { data } = await alice.client.from("notes")
    .insert({ user_id: alice.id, title: "secret", content: "alice only" })
    .select("id").single();
  aliceNoteId = data!.id;
});

describe("cross-user isolation", () => {
  it("bob reads zero rows from every client-visible table", async () => {
    // Collect failures across all tables instead of stopping at the first one, so a
    // single run names every broken table rather than requiring several fix/rerun cycles.
    const failures: string[] = [];
    for (const table of CLIENT_TABLES) {
      const { data, error } = await bob.client.from(table).select("id");
      if (error !== null) {
        failures.push(`${table}: expected no error, got ${JSON.stringify(error)}`);
      } else if (!Array.isArray(data) || data.length !== 0) {
        failures.push(`${table}: expected 0 rows, got ${JSON.stringify(data)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("alice can read her own note (owner access still works)", async () => {
    // Positive control for the negative assertions above: if `notes_own` were dropped
    // entirely (RLS stays enabled, zero applicable policies), SELECT does not error --
    // it silently returns zero rows, which the isolation tests alone cannot distinguish
    // from bob's correct empty view. This test would go red in that case. It covers only
    // `notes`, not the other 11 CLIENT_TABLES entries -- see report for the gap.
    const { data, error } = await alice.client.from("notes")
      .select("id, title").eq("id", aliceNoteId).single();
    expect(error).toBeNull();
    expect(data?.title).toBe("secret");
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

  it("anonymous clients are denied at the grant layer (permission denied, not RLS)", async () => {
    // Only `authenticated` holds a select grant on notes (00002_content.sql), so an
    // anon-key client is rejected by PostgREST's privilege check before RLS is ever
    // evaluated: 42501 permission denied, data null -- not an empty result set. Asserting
    // `data ?? []` here would mask that and pass even if RLS alone (not the grant) were
    // the only thing standing between anon and other users' rows. Match the 42501 pattern
    // used for server-only tables in schema-content.test.ts / schema-domain.test.ts.
    const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } });
    const { data, error } = await anon.from("notes").select("id");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
    expect(data).toBeNull();
  });
});
