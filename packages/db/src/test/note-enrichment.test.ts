import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

/**
 * claim_notes_for_enrichment has no user filter -- it sweeps every user's notes globally
 * (00018), ordered oldest-updated-first. This suite's own fixtures land at ~now-300s, but every
 * OTHER suite under packages/db/src/test/ also inserts notes and almost none delete them, and
 * there is no globalSetup/reset between test files, so notes accumulate run over run. A `limit
 * 50` would silently fill with hours-old leftovers from unrelated suites -- rows genuinely
 * older than this suite's fixtures -- long before this suite's own rows are reached. The limit
 * is raised well past any plausible leftover count so this suite's rows are never pushed out,
 * and callers additionally filter to this suite's own userId so its assertions don't depend on
 * what other suites happened to leave behind.
 */
const claim = async (limit = 1000) => {
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

  /**
   * The sweep has no user filter, so a global claim() also carries whatever other suites left
   * behind (see the comment on `claim` above). Every assertion below narrows to this suite's own
   * userId before checking containment, so it means what it says regardless of run history.
   */
  const claimedIdsForThisUser = async () =>
    (await claim()).filter((r) => r.user_id === userId).map((r) => r.note_id);

  beforeAll(async () => {
    ({ id: userId } = await makeUser("enrich-claim@example.com"));
    await admin.from("notes").delete().eq("user_id", userId);
  });

  it("claims a note that has never been enriched", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "a fresh thought" }).select("id").single();
    await backdate(data!.id);

    expect(await claimedIdsForThisUser()).toContain(data!.id);
  });

  it("does not claim a note edited within the debounce window", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "still typing" }).select("id").single();
    // deliberately NOT backdated
    expect(await claimedIdsForThisUser()).not.toContain(data!.id);
  });

  // THE COST REGRESSION. A timestamp predicate claims this note and bills an embed plus a
  // model call for a change that touched no text.
  it("does not claim a note that was only pinned", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "unchanged body" }).select("id").single();
    // Mark both steps done for the CURRENT text -- and BEFORE the note's own updated_at, not
    // merely present. A bookkeeping row inserted at ~now (same instant as the note) gives a
    // timestamp predicate nothing to be wrong about: `e.updated_at < n.updated_at` would already
    // be false regardless of whether pinning ever happens, so the second half of this test would
    // pass identically against a broken predicate. Backdating embedded_hash/extracted_hash's
    // *timestamp* further into the past than the note itself is what makes the pin below an
    // actual test: after the pin bumps notes.updated_at forward, a timestamp predicate newly
    // satisfies `e.updated_at < n.updated_at` and reclaims; the hash predicate does not, because
    // the hash never changed.
    const md5 = await admin.rpc("_test_md5_content_text", { p_note_id: data!.id });
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId,
      embedded_hash: md5.data, extracted_hash: md5.data,
      updated_at: new Date(Date.now() - 600_000).toISOString(),
    });
    await backdate(data!.id);
    expect(await claimedIdsForThisUser()).not.toContain(data!.id);

    // Pinning bumps updated_at via the moddatetime trigger, and must change nothing here.
    await admin.from("notes").update({ pinned: true }).eq("id", data!.id);
    await backdate(data!.id);
    expect(await claimedIdsForThisUser()).not.toContain(data!.id);
  });

  it("claims again when the text actually changes", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "version one" }).select("id").single();
    const md5 = await admin.rpc("_test_md5_content_text", { p_note_id: data!.id });
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId, embedded_hash: md5.data, extracted_hash: md5.data,
    });
    await backdate(data!.id);
    expect(await claimedIdsForThisUser()).not.toContain(data!.id);

    await admin.from("notes").update({ content: "version two" }).eq("id", data!.id);
    await backdate(data!.id);
    expect(await claimedIdsForThisUser()).toContain(data!.id);
  });

  it("stops claiming a note that has failed five times", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "poison" }).select("id").single();
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId, attempts: 5, last_error: "boom",
    });
    await backdate(data!.id);
    expect(await claimedIdsForThisUser()).not.toContain(data!.id);
  });

  it("does not claim a trashed note", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "gone", deleted_at: new Date().toISOString() })
      .select("id").single();
    await backdate(data!.id);
    expect(await claimedIdsForThisUser()).not.toContain(data!.id);
  });

  it("is invisible to an authenticated client", async () => {
    const { client } = await makeUser("enrich-rls@example.com");
    const { data, error } = await client.from("note_enrichment").select("note_id");
    expect(data ?? []).toEqual([]);
    expect(error === null || error.code === "42501").toBe(true);
  });
});
