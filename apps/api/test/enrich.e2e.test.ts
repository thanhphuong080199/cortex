import { beforeAll, describe, expect, it } from "vitest";
import { createFakeAi, createServiceClient, recordUsage } from "@cortex/core";
import { runSweep } from "../src/enrich/enrich.service";

const db = createServiceClient();
let userId: string;

const ai = createFakeAi({
  generateJson: async () => ({
    value: { domain: "health", domain_meta: { activity_type: "run" }, tags: [{ name: "running", confidence: 0.9 }] },
    inputTokens: 10, outputTokens: 5, model: "fake-classify",
  }),
});

// 00008_invite_gate.sql fires on every auth.users insert, including through the admin API, so
// createUser fails with "Signup not allowed" unless the email is allow-listed first -- the same
// step embed.test.ts / extract.test.ts / budget.test.ts perform.
const makeUser = async (label: string): Promise<string> => {
  const email = `sweep-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const { error: upsertErr } = await db.from("allowed_emails").upsert({ email });
  if (upsertErr) throw upsertErr;
  const { data, error } = await db.auth.admin.createUser({
    email, password: "x".repeat(16), email_confirm: true,
  });
  if (error) throw error;
  return data.user!.id;
};

/**
 * The head of `order by updated_at asc`, reserved for this run.
 *
 * claim_notes_for_enrichment orders GLOBALLY with no per-run scoping (00018:58), and this suite's
 * fixtures are far from the only notes in this shared local Postgres: notes.e2e, tags.e2e,
 * media.e2e and packages/core's and packages/db's suites all insert notes and none of them clean
 * up, across every session that has ever run this repo's tests. A fixture that is not near the
 * front of that ordering is simply never claimed at `limit: 10`, and the test fails for a reason
 * that has nothing to do with what it is testing.
 *
 * The previous approach here -- a fixed "~10 years ago" offset -- does not actually achieve that,
 * and 00023 is what made it visible. Every run backdates to `now - 10y`, so each run's fixtures
 * land slightly NEWER than the previous run's, and this suite's own un-enriched leftovers
 * ("this one always fails", "would be enriched if there were money") queue up permanently ahead
 * of the current run. Measured directly against this database while writing 00023: nine such
 * notes, all at 2016-08-13, all ahead of anything a fresh run could seed. They were invisible
 * only because the old predicate tombstoned them at `attempts = 5`; 00023 deliberately gives
 * every previously-tombstoned note one more chance, which put all nine back at the head of the
 * queue and left one claim slot for the note under test.
 *
 * A cursor anchored to the oldest row that ALREADY exists is unconditional: every fixture this
 * run seeds is older than every note in the database at the moment the suite starts, in the order
 * it was seeded, no matter what previous runs left behind. Reading it costs one query.
 */
let ageCursor = 0;
const nextInstant = () => new Date((ageCursor += 1000)).toISOString();

describe("runSweep", () => {
  beforeAll(async () => {
    userId = await makeUser("main");
    const { data: oldest, error } = await db.from("notes")
      .select("updated_at").order("updated_at", { ascending: true }).limit(1).maybeSingle();
    if (error) throw error;
    // A full day of headroom in front of it, so the per-fixture 1-second steps below never walk
    // back into the existing backlog however many fixtures a run seeds.
    ageCursor = (oldest ? Date.parse(oldest.updated_at as string) : Date.now()) - 24 * 60 * 60 * 1000;
  });

  // NOT `db.from("notes").update({ updated_at: ... })`: notes_set_updated_at (00002, moddatetime)
  // silently overwrites updated_at back to now() on every update, including one that sets it
  // explicitly in the same statement -- proven directly in 00018's own comment on
  // _test_backdate_note. That leaves the claim predicate's 90-second debounce permanently
  // unsatisfied, so a note seeded that way is never claimed at all. _test_backdate_note (00018)
  // disables triggers for the one UPDATE that needs to stick.
  const backdate = async (noteId: string) => {
    const { error } = await db.rpc("_test_backdate_note", { p_note_id: noteId, p_when: nextInstant() });
    if (error) throw error;
  };

  const seedBackdated = async (content: string, opts: { owner?: string } = {}) => {
    const { data, error: insErr } = await db.from("notes")
      .insert({ user_id: opts.owner ?? userId, content }).select("id").single();
    if (insErr) throw insErr;
    await backdate(data!.id);
    return data!.id as string;
  };

  const md5Of = async (noteId: string) => {
    const { data, error } = await db.rpc("_test_md5_content_text", { p_note_id: noteId });
    if (error) throw error;
    return data as string;
  };

  it("embeds and extracts a claimed note, and does nothing on a second run", async () => {
    const noteId = await seedBackdated("ran 5km this morning");

    const first = await runSweep({ db, ai, budgetUsd: 100, limit: 10 });
    // >= 1, not === 1: claim_notes_for_enrichment is deliberately global, not scoped to this
    // test's user (that is the whole point of a sweep -- see enrich.service.ts). Run under
    // the full monorepo gate, @cortex/core's and @cortex/db's own suites are inserting notes
    // into this same local Postgres at the same time, and a slow full run can carry some of
    // those past the claim predicate's 90-second debounce before this assertion runs, so this
    // note is not always the only thing legitimately eligible. The next four assertions pin
    // down that THIS note specifically was embedded and extracted, which is what this test is
    // actually responsible for.
    expect(first.processed).toBeGreaterThanOrEqual(1);

    const { data: chunks } = await db.from("note_chunks")
      .select("id, chunk_index, content_hash").eq("note_id", noteId).order("chunk_index");
    expect(chunks!.length).toBeGreaterThan(0);
    const { data: note } = await db.from("notes").select("domain, enriched_at").eq("id", noteId).single();
    expect(note!.domain).toBe("health");
    expect(note!.enriched_at).not.toBeNull();
    const { data: enrichedBefore } = await db.from("note_enrichment")
      .select("updated_at").eq("note_id", noteId).single();

    // `second.processed` is a GLOBAL counter -- claim_notes_for_enrichment is deliberately not
    // scoped to this test's user (00018:50-60), so another suite's note legitimately aging past
    // the 90-second debounce during this test could make it nonzero without this note being
    // touched again, and `expect(second.processed).toBe(0)` would go red for a reason that has
    // nothing to do with whether the sweep actually re-processed THIS note. Assert the
    // note-scoped effect instead, which is immune to the shared database: nothing about this
    // specific note moved on the second run.
    await runSweep({ db, ai, budgetUsd: 100, limit: 10 });
    const { data: chunksAfter } = await db.from("note_chunks")
      .select("id, chunk_index, content_hash").eq("note_id", noteId).order("chunk_index");
    expect(chunksAfter).toEqual(chunks);
    const { data: enrichedAfter } = await db.from("note_enrichment")
      .select("updated_at").eq("note_id", noteId).single();
    expect(enrichedAfter!.updated_at).toBe(enrichedBefore!.updated_at);
  });

  it("records the failure and stops after five attempts rather than retrying forever", async () => {
    const noteId = await seedBackdated("this one always fails");
    const failing = createFakeAi({
      generateJson: async () => { throw new Error("gemini 500"); },
    });

    // 6 iterations against a cap of 5: if claim_notes_for_enrichment's `attempts < 5` guard
    // were ever removed, this would claim (and fail) the note a 6th time and attempts would
    // read 6, not 5 -- the assertion below would go red.
    for (let i = 0; i < 6; i++) {
      await runSweep({ db, ai: failing, budgetUsd: 100, limit: 10 });
      await backdate(noteId);
    }

    const { data } = await db.from("note_enrichment")
      .select("attempts, attempts_hash, last_error").eq("note_id", noteId).single();
    expect(data!.attempts).toBe(5);
    expect(data!.last_error).toMatch(/gemini 500/);
    // The count is only allowed to tombstone the note because it is scoped to the text it was
    // counted against (00023). If attempts_hash were never written, the claim predicate's
    // `attempts_hash is distinct from md5(content_text)` disjunct would be permanently true and
    // the 5-attempt cap above would never bite at all.
    expect(data!.attempts_hash).toBe(await md5Of(noteId));
  });

  // THE PERMANENT TOMBSTONE, from the sweep's side. 00023 makes the claim predicate willing to
  // take a rewritten note back; this is the other half -- the catch block has to restart the
  // count rather than resume it, or a note that failed 4 times on its old text gets exactly one
  // attempt on its new text before being tombstoned again for reasons that no longer exist.
  it("restarts the attempt count when the note is rewritten, rather than resuming it", async () => {
    const noteId = await seedBackdated("first draft, always fails");
    const failing = createFakeAi({
      generateJson: async () => { throw new Error("gemini 500"); },
    });

    await runSweep({ db, ai: failing, budgetUsd: 100, limit: 10 });
    const { data: first } = await db.from("note_enrichment")
      .select("attempts, attempts_hash").eq("note_id", noteId).single();
    expect(first!.attempts).toBe(1);

    // The user rewrites the note. The old failure belonged to text that no longer exists.
    await db.from("notes").update({ content: "a completely different second draft" }).eq("id", noteId);
    await backdate(noteId);
    await runSweep({ db, ai: failing, budgetUsd: 100, limit: 10 });

    const { data: second } = await db.from("note_enrichment")
      .select("attempts, attempts_hash").eq("note_id", noteId).single();
    expect(second!.attempts).toBe(1);
    expect(second!.attempts_hash).toBe(await md5Of(noteId));
    expect(second!.attempts_hash).not.toBe(first!.attempts_hash);
  });

  // THE DIAGNOSTIC. Every throw site in embed.ts and extract.ts rethrows the RAW PostgREST error
  // object, which is a plain object, not an Error -- so `err instanceof Error ? err.message :
  // String(err)` produced the literal string "[object Object]", in the log AND in
  // note_enrichment.last_error, for all five attempts before the note was tombstoned. The one
  // field in the schema designed to hold a diagnostic held nothing.
  //
  // The failure is provoked with a REAL PostgREST error rather than a thrown fixture (which is
  // what the five-attempts test above uses, and why it could never have caught this): a
  // 3-dimensional vector against note_chunks.embedding, an extensions.vector(1536) column.
  it("records a raw PostgREST failure as its real message, not [object Object]", async () => {
    const noteId = await seedBackdated("this note provokes a real postgrest error");
    const wrongWidth = createFakeAi({
      embed: async (texts: string[]) => ({
        vectors: texts.map(() => [0.1, 0.2, 0.3]), inputTokens: 1, model: "fake-embed",
      }),
    });

    await runSweep({ db, ai: wrongWidth, budgetUsd: 100, limit: 10 });

    const { data } = await db.from("note_enrichment").select("last_error").eq("note_id", noteId).single();
    expect(data!.last_error).not.toContain("[object Object]");
    expect(data!.last_error).toMatch(/dimension/i);
  });

  it("claims nothing when the user is over budget", async () => {
    // The brief's version reused the shared `ai` fake, whose model ids ("fake-embed",
    // "fake-classify") carry no entry in MODEL_PRICES_USD_PER_MTOK -- priceUsd prices an
    // unknown model at zero (deliberately, so a model swap can't wedge the pipeline; see
    // budget.ts), so every recorded call this suite makes costs $0 and monthToDateUsd never
    // rises above zero. Against a real, priced model (budget.test.ts's own pattern) the same
    // fake AI would never trip the gate no matter how small budgetUsd is. Recording a real
    // priced call directly is what actually pushes this user over budget.
    await recordUsage(db, {
      userId, kind: "tag", model: "gemini-3.5-flash-lite", inputTokens: 20_000_000, outputTokens: 0,
    });

    const noteId = await seedBackdated("would be enriched if there were money");
    // `out.processed`/`out.skippedOverBudget` are both GLOBAL counters and both exposed here,
    // in opposite directions: `processed` could read nonzero from a wholly unrelated,
    // under-budget note elsewhere in the shared database (the false positive already hit
    // above), while `skippedOverBudget` could read 0 even though the over-budget gate is
    // working correctly, because claim_notes_for_enrichment orders globally by updated_at asc
    // (00018:58) and `limit: 10` can fill entirely on older foreign notes before it ever
    // reaches this one -- a false negative. Assert what the over-budget gate is actually
    // responsible for instead: THIS note was never embedded or extracted, which holds whether
    // it was claimed-then-skipped for budget or never claimed at all.
    await runSweep({ db, ai, budgetUsd: 1, limit: 10 });

    const { data: chunks } = await db.from("note_chunks").select("id").eq("note_id", noteId);
    expect(chunks).toEqual([]);
    const { data: note } = await db.from("notes").select("enriched_at").eq("id", noteId).single();
    expect(note!.enriched_at).toBeNull();
  });

  // THE GLOBAL STARVATION. The claim is deliberately multi-user and ordered `updated_at asc`
  // (00018:58). An over-budget note used to be `continue`d inside the loop, which increments no
  // counter and writes nothing to `notes` -- so its updated_at never advanced and it stayed at
  // the head of that ordering forever. One user crossing ENRICH_MONTHLY_BUDGET_USD while holding
  // the oldest un-enriched notes stopped enrichment for EVERY user until the UTC month rolled
  // over, while the cron kept firing and the logs kept printing a single warning.
  //
  // `limit: 1` is what makes this a test rather than a coincidence: the hog's note fills the
  // entire claim, so the other user's note is reachable only if runSweep re-claims with the hog
  // excluded. The age cursor puts both fixtures ahead of everything else in this shared database
  // and seeds them one second apart, so the claim's global ordering takes the hog's note first
  // and the other user's second, deterministically.
  //
  // The `finally` deletes this test's own two users' notes -- not anyone else's. An over-budget
  // user holding an un-enriched note at the very head of the global ordering is exactly the
  // blocker this fix is about, and leaving one behind every run would degrade every other suite
  // in this file for the rest of the calendar month.
  it("does not let one over-budget user starve every other user's notes", async () => {
    const hog = await makeUser("hog");
    const other = await makeUser("other");
    // A real priced model: the fake AI's "fake-embed"/"fake-classify" carry no entry in
    // MODEL_PRICES_USD_PER_MTOK and price at zero, so no amount of fake traffic crosses a budget.
    await recordUsage(db, {
      userId: hog, kind: "tag", model: "gemini-3.5-flash-lite", inputTokens: 20_000_000, outputTokens: 0,
    });

    const hogNote = await seedBackdated("over budget, and first in line", { owner: hog });
    const otherNote = await seedBackdated("under budget, and stuck behind it", { owner: other });

    try {
      const out = await runSweep({ db, ai, budgetUsd: 1, limit: 1 });

      expect(out.skippedOverBudget).toBeGreaterThanOrEqual(1);
      // The point of the whole fix: a different user's work got done in the same tick.
      const { data: otherChunks } = await db.from("note_chunks").select("id").eq("note_id", otherNote);
      expect(otherChunks!.length).toBeGreaterThan(0);
      const { data: otherRow } = await db.from("notes").select("enriched_at").eq("id", otherNote).single();
      expect(otherRow!.enriched_at).not.toBeNull();

      // And the budget still held for the user who blew it -- the fix must not have become
      // "process everyone".
      const { data: hogChunks } = await db.from("note_chunks").select("id").eq("note_id", hogNote);
      expect(hogChunks).toEqual([]);
    } finally {
      await db.from("notes").delete().eq("user_id", hog);
      await db.from("notes").delete().eq("user_id", other);
    }
  });
});
