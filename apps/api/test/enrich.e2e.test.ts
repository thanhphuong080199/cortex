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

describe("runSweep", () => {
  beforeAll(async () => {
    // 00008_invite_gate.sql fires on every auth.users insert, including through the admin
    // API, so createUser fails with "Signup not allowed" unless the email is allow-listed
    // first -- the same step embed.test.ts / extract.test.ts / budget.test.ts perform.
    const email = `sweep-${Date.now()}@example.com`;
    const { error: upsertErr } = await db.from("allowed_emails").upsert({ email });
    if (upsertErr) throw upsertErr;
    const { data } = await db.auth.admin.createUser({
      email, password: "x".repeat(16), email_confirm: true,
    });
    userId = data.user!.id;
  });

  // The brief's version did `db.from("notes").update({ updated_at: ... })`, which
  // notes_set_updated_at (00002, moddatetime) silently overwrites back to now() on every
  // update -- proven directly in 00018's own comment on _test_backdate_note. That left the
  // claim predicate's 90-second debounce permanently unsatisfied, so a note seeded this way
  // is never actually claimed. _test_backdate_note (00018) disables triggers for the one
  // UPDATE that needs to stick.
  const seedBackdated = async (content: string) => {
    const { data } = await db.from("notes").insert({ user_id: userId, content }).select("id").single();
    const { error } = await db.rpc("_test_backdate_note", {
      p_note_id: data!.id, p_when: new Date(Date.now() - 300_000).toISOString(),
    });
    if (error) throw error;
    return data!.id as string;
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

    const { data: chunks } = await db.from("note_chunks").select("id").eq("note_id", noteId);
    expect(chunks!.length).toBeGreaterThan(0);
    const { data: note } = await db.from("notes").select("domain, enriched_at").eq("id", noteId).single();
    expect(note!.domain).toBe("health");
    expect(note!.enriched_at).not.toBeNull();

    const second = await runSweep({ db, ai, budgetUsd: 100, limit: 10 });
    expect(second.processed).toBe(0);
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
      const { error } = await db.rpc("_test_backdate_note", {
        p_note_id: noteId, p_when: new Date(Date.now() - 300_000).toISOString(),
      });
      if (error) throw error;
    }

    const { data } = await db.from("note_enrichment").select("attempts, last_error").eq("note_id", noteId).single();
    expect(data!.attempts).toBe(5);
    expect(data!.last_error).toMatch(/gemini 500/);
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

    await seedBackdated("would be enriched if there were money");
    const out = await runSweep({ db, ai, budgetUsd: 1, limit: 10 });
    expect(out.processed).toBe(0);
    expect(out.skippedOverBudget).toBeGreaterThan(0);
  });
});
