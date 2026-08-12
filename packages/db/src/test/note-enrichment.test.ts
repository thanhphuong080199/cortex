import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

/**
 * claim_notes_for_enrichment has no user filter -- it sweeps every user's notes globally
 * (00018), ordered oldest-updated-first. Every OTHER suite under packages/db/src/test/ also
 * inserts notes and almost none delete them, and there is no globalSetup/reset between test
 * files, so notes accumulate run over run. Callers filter to this suite's own userId so their
 * assertions don't depend on what other suites left behind -- but that filter runs in JS, AFTER
 * the SQL `limit`, so a fixture pushed out of the claim by older foreign rows is indistinguishable
 * from one the predicate correctly refused.
 *
 * A large `limit` is NOT a fix, which is the whole reason `backdate` below anchors to the head of
 * the ordering instead. PostgREST's `max_rows = 1000` (config.toml) caps the RESPONSE at 1000
 * rows no matter what p_limit says -- so `limit 5000` returns the same 1000 oldest rows as
 * `limit 1000`, silently, which is the same truncation trap 00021's header documents. Measured
 * against this local stack while writing 00023: 1001 notes already satisfied the predicate, i.e.
 * this suite had just crossed the boundary where a 300-second-old fixture is not reached at all.
 */
const claim = async (limit = 1000, excludeUserIds?: string[]) => {
  const { data, error } = await admin.rpc("claim_notes_for_enrichment", {
    p_limit: limit,
    // Omitted, not passed as null, when a caller does not use it: this is the one-argument call
    // shape 00018 shipped, and 00023 keeps it working via a DEFAULT rather than making every
    // caller learn about the exclusion list.
    ...(excludeUserIds ? { p_exclude_user_ids: excludeUserIds } : {}),
  });
  if (error) throw error;
  return data as { note_id: string; user_id: string; content_text: string; content_hash: string }[];
};

/**
 * The head of `order by updated_at asc`, reserved for this run -- see the truncation problem on
 * `claim` above. Anchoring to the oldest row that ALREADY exists puts every fixture this run
 * seeds ahead of every note in the database, so no amount of accumulated backlog can push one out
 * of the claim. A fixed offset (this was `now - 300s`) cannot do that: each run lands slightly
 * NEWER than the last, so a suite's own leftovers queue up permanently in front of it.
 */
let ageCursor = 0;

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
  admin.rpc("_test_backdate_note", { p_note_id: id, p_when: new Date((ageCursor += 1000)).toISOString() });

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
    const { data: oldest, error } = await admin.from("notes")
      .select("updated_at").order("updated_at", { ascending: true }).limit(1).maybeSingle();
    if (error) throw error;
    // A full day of headroom, so the per-fixture 1-second steps never walk back into the backlog.
    ageCursor = (oldest ? Date.parse(oldest.updated_at as string) : Date.now()) - 24 * 60 * 60 * 1000;
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
    const md5 = await admin.rpc("_test_md5_content_text", { p_note_id: data!.id });
    await admin.from("note_enrichment").insert({
      // attempts_hash matters as much as attempts here (00023): the cap is scoped to the text
      // the failures were counted against, so a row claiming 5 attempts against NO text is
      // deliberately still claimable. Without this field the assertion below would pass for the
      // wrong reason before 00023 and fail outright after it.
      note_id: data!.id, user_id: userId, attempts: 5, attempts_hash: md5.data, last_error: "boom",
    });
    await backdate(data!.id);
    expect(await claimedIdsForThisUser()).not.toContain(data!.id);
  });

  // THE PERMANENT TOMBSTONE. Five failures used to veto a note forever, because attempts is
  // reset only by a successful sweep and a sweep can never succeed on a note the predicate no
  // longer claims. Rewriting the note -- the one action a user has available -- did nothing.
  it("claims a five-times-failed note again once the text it failed on is rewritten", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "poison version one" }).select("id").single();
    const md5 = await admin.rpc("_test_md5_content_text", { p_note_id: data!.id });
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId, attempts: 5, attempts_hash: md5.data, last_error: "boom",
    });
    await backdate(data!.id);
    expect(await claimedIdsForThisUser()).not.toContain(data!.id);

    // The user rewrites the note. attempts is still 5 and nothing resets it -- the claim has to
    // notice that those 5 failures belong to text that no longer exists.
    await admin.from("notes").update({ content: "a completely different thought" }).eq("id", data!.id);
    await backdate(data!.id);
    expect(await claimedIdsForThisUser()).toContain(data!.id);
  });

  // A row written before 00023 has attempts_hash = null, i.e. five failures counted against
  // nothing identifiable. Those notes must come back, or the migration ships the tombstone it
  // was written to remove.
  it("claims a note whose five failures predate attempts_hash", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "tombstoned before 00023" }).select("id").single();
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId, attempts: 5, last_error: "boom", // no attempts_hash
    });
    await backdate(data!.id);
    expect(await claimedIdsForThisUser()).toContain(data!.id);
  });

  // THE STARVATION GUARD, at the SQL level. enrich.service.ts re-claims with the users it just
  // found over budget; this is the parameter that makes that possible. Without it, an
  // over-budget user's notes sit at the head of `order by updated_at asc` forever and no user's
  // notes are enriched again until the month rolls over.
  it("skips the users it is told to exclude, and only those", async () => {
    const { data: mine } = await admin.from("notes")
      .insert({ user_id: userId, content: "excluded owner" }).select("id").single();
    await backdate(mine!.id);
    expect(await claimedIdsForThisUser()).toContain(mine!.id);

    const excluded = (await claim(1000, [userId])).map((r) => r.note_id);
    expect(excluded).not.toContain(mine!.id);
    // Not vacuous: the exclusion must remove THIS user's rows and leave everyone else's, so the
    // claim has to still return something. Another user's note is guaranteed to exist -- the
    // "is invisible to an authenticated client" case and every other suite in this package
    // insert notes under their own users into this same database.
    const { data: other } = await admin.from("notes")
      .insert({ user_id: (await makeUser("enrich-exclude-other@example.com")).id, content: "other owner" })
      .select("id, user_id").single();
    await backdate(other!.id);
    const stillClaimed = await claim(1000, [userId]);
    expect(stillClaimed.map((r) => r.note_id)).toContain(other!.id);
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
