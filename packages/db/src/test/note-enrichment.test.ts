import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients";

const claim = async (limit = 50) => {
  const { data, error } = await admin.rpc("claim_notes_for_enrichment", { p_limit: limit });
  if (error) throw error;
  return data as { note_id: string; user_id: string; content_text: string; content_hash: string }[];
};

/**
 * The sweep ignores anything edited in the last 90s, so fixtures must be backdated.
 *
 * NOT a plain `.update({ updated_at: ... })`: notes_set_updated_at (00002) is a moddatetime
 * trigger that unconditionally overwrites updated_at with now() on every UPDATE, including one
 * that sets updated_at explicitly in the same statement, so a normal PostgREST update here is a
 * no-op -- confirmed directly against this stack. _test_backdate_note (00018) bypasses the
 * trigger for one statement via session_replication_role, which is the only way to age a note
 * without touching its content.
 */
const backdate = (id: string) =>
  admin.rpc("_test_backdate_note", { p_note_id: id, p_when: new Date(Date.now() - 300_000).toISOString() });

describe("claim_notes_for_enrichment", () => {
  let userId: string;

  beforeAll(async () => {
    ({ id: userId } = await makeUser("enrich-claim@example.com"));
    await admin.from("notes").delete().eq("user_id", userId);
  });

  it("claims a note that has never been enriched", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "a fresh thought" }).select("id").single();
    await backdate(data!.id);

    const claimed = await claim();
    expect(claimed.map((r) => r.note_id)).toContain(data!.id);
  });

  it("does not claim a note edited within the debounce window", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "still typing" }).select("id").single();
    // deliberately NOT backdated
    const claimed = await claim();
    expect(claimed.map((r) => r.note_id)).not.toContain(data!.id);
  });

  // THE COST REGRESSION. A timestamp predicate claims this note and bills an embed plus a
  // model call for a change that touched no text.
  it("does not claim a note that was only pinned", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "unchanged body" }).select("id").single();
    // Mark both steps done for the CURRENT text.
    const md5 = await admin.rpc("_test_md5_content_text", { p_note_id: data!.id });
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId,
      embedded_hash: md5.data, extracted_hash: md5.data,
    });
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).not.toContain(data!.id);

    // Pinning bumps updated_at via the moddatetime trigger, and must change nothing here.
    await admin.from("notes").update({ pinned: true }).eq("id", data!.id);
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).not.toContain(data!.id);
  });

  it("claims again when the text actually changes", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "version one" }).select("id").single();
    const md5 = await admin.rpc("_test_md5_content_text", { p_note_id: data!.id });
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId, embedded_hash: md5.data, extracted_hash: md5.data,
    });
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).not.toContain(data!.id);

    await admin.from("notes").update({ content: "version two" }).eq("id", data!.id);
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).toContain(data!.id);
  });

  it("stops claiming a note that has failed five times", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "poison" }).select("id").single();
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId, attempts: 5, last_error: "boom",
    });
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).not.toContain(data!.id);
  });

  it("does not claim a trashed note", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "gone", deleted_at: new Date().toISOString() })
      .select("id").single();
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).not.toContain(data!.id);
  });

  it("is invisible to an authenticated client", async () => {
    const { client } = await makeUser("enrich-rls@example.com");
    const { data, error } = await client.from("note_enrichment").select("note_id");
    expect(data ?? []).toEqual([]);
    expect(error === null || error.code === "42501").toBe(true);
  });
});
