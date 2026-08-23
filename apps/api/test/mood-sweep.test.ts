import { describe, expect, it, vi } from "vitest";
import { runMoodSweep } from "../src/mood/mood.service";

interface Claimed {
  user_id: string; session_id: string; session_start: string;
  session_end: string; message_count: number; prior_attempts: number;
}

/**
 * A scripted Supabase client. `upserts` and `updates` are what the assertions read: the whole
 * point of this sweep is WHICH rows it writes and which it deliberately leaves alone.
 */
function fakeDb(opts: {
  claims: Claimed[][];
  messages?: Record<string, { id: string; role: string; content: string }[]>;
  monthToDate?: Record<string, number>;
}) {
  const state = {
    upserts: [] as Record<string, unknown>[],
    updates: [] as { id: unknown; patch: Record<string, unknown> }[],
    claimCalls: [] as Record<string, unknown>[],
    round: 0,
  };
  const db = {
    async rpc(fn: string, params: Record<string, unknown>) {
      if (fn === "usage_month_to_date_usd") {
        return { data: opts.monthToDate?.[params.p_user_id as string] ?? 0, error: null };
      }
      state.claimCalls.push(params);
      return { data: opts.claims[state.round++] ?? [], error: null };
    },
    from(table: string) {
      if (table === "chat_messages") {
        return {
          select: () => ({
            eq: (_col: string, sessionId: string) => ({
              // Chained twice in the real query (session_id, then user_id), followed by a
              // .limit() bounding the read -- see mood.service.ts. The fake only needs to thread
              // the session id through to look up the fixture.
              eq: () => ({
                limit: () => ({
                  order: () => ({ data: opts.messages?.[sessionId] ?? [], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      // mood_readings (and usage_ledger, via recordUsage inside readSessionMood -- a no-op insert
      // is enough since no assertion in this file checks usage_ledger rows)
      return {
        insert: async () => ({ error: null }),
        upsert: (row: Record<string, unknown>) => {
          state.upserts.push(row);
          return { select: () => ({ single: async () => ({ data: { id: `row-${state.upserts.length}` }, error: null }) }) };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: unknown) => { state.updates.push({ id, patch }); return { error: null }; },
        }),
      };
    },
  };
  return { db: db as never, state };
}

const ai = (value: unknown) => ({
  embed: vi.fn(), generateStream: vi.fn(),
  generateJson: vi.fn().mockResolvedValue({
    value, inputTokens: 100, outputTokens: 20, model: "gemini-2.5-flash",
  }),
}) as never;

const claimed = (over: Partial<Claimed> = {}): Claimed => ({
  user_id: "u1", session_id: "s1", message_count: 3, prior_attempts: 0,
  session_start: "2026-08-20T01:00:00Z", session_end: "2026-08-20T02:00:00Z", ...over,
});

describe("runMoodSweep", () => {
  it("resolves a readable session to ok, carrying the message ids as evidence", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed()], []],
      messages: { s1: [
        { id: "m1", role: "user", content: "mệt quá" },
        { id: "m2", role: "assistant", content: "sao vậy" },
        { id: "m3", role: "user", content: "deadline dí" },
      ] },
    });

    const result = await runMoodSweep({
      db, ai: ai({ valence: 2, summary: "mệt vì deadline", topics: ["công việc"], confidence: 0.8 }),
      budgetUsd: 10, limit: 20,
    });

    expect(result).toMatchObject({ processed: 1, noReading: 0, failed: 0, skippedOverBudget: 0 });
    // Claimed first as pending with the attempt counted, THEN resolved. A crash between the two
    // is what the stale-pending branch of the claim exists to recover.
    expect(state.upserts[0]).toMatchObject({ session_id: "s1", status: "pending", attempts: 1 });
    expect(state.updates[0]!.patch).toMatchObject({
      status: "ok", valence: 2, summary: "mệt vì deadline", topics: ["công việc"],
      evidence: ["m1", "m2", "m3"],
    });
  });

  // The anti-fabrication path end to end: a session the model declined to score is FINISHED, not
  // failed. Red if the sweep maps a null valence onto 'failed' -- which would retry it twice more
  // and then leave a permanently failed row for a session that was simply unremarkable.
  it("resolves a session the model declined to score as no_reading", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed()], []],
      messages: { s1: [
        { id: "m1", role: "user", content: "1111" },
        { id: "m2", role: "user", content: "ok" },
      ] },
    });

    const result = await runMoodSweep({
      db, ai: ai({ valence: null, summary: null, topics: [], confidence: 0.1 }),
      budgetUsd: 10, limit: 20,
    });

    expect(result).toMatchObject({ processed: 0, noReading: 1, failed: 0 });
    expect(state.updates[0]!.patch).toMatchObject({ status: "no_reading", valence: null });
  });

  it("writes no_reading without a model call when the session is below the floor", async () => {
    const generateJson = vi.fn();
    const { db, state } = fakeDb({
      claims: [[claimed({ message_count: 1 })], []],
      messages: { s1: [{ id: "m1", role: "user", content: "ok" }] },
    });

    const result = await runMoodSweep({
      db, ai: { embed: vi.fn(), generateStream: vi.fn(), generateJson } as never,
      budgetUsd: 10, limit: 20,
    });

    expect(result).toMatchObject({ noReading: 1 });
    expect(generateJson).not.toHaveBeenCalled();
    expect(state.updates[0]!.patch).toMatchObject({ status: "no_reading" });
  });

  // Spec §3's hard rule. Red the moment the pending upsert moves above the budget check: a user
  // over budget would then burn one of their three attempts on every tick, and a session would be
  // permanently 'failed' after three hours for a reason that has nothing to do with it.
  it("writes nothing at all for a user over budget", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed()], []],
      monthToDate: { u1: 999 },
    });

    const result = await runMoodSweep({ db, ai: ai({}), budgetUsd: 10, limit: 20 });

    expect(result).toMatchObject({ skippedOverBudget: 1, processed: 0 });
    expect(state.upserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("re-claims past an over-budget user so one user cannot starve the rest", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed({ user_id: "poor", session_id: "s-poor" })], [claimed({ user_id: "u2", session_id: "s2" })], []],
      messages: { s2: [
        { id: "m1", role: "user", content: "vui" }, { id: "m2", role: "user", content: "lắm" },
      ] },
      monthToDate: { poor: 999 },
    });

    const result = await runMoodSweep({
      db, ai: ai({ valence: 5, summary: "vui", topics: [], confidence: 0.9 }),
      budgetUsd: 10, limit: 20,
    });

    expect(result).toMatchObject({ processed: 1, skippedOverBudget: 1 });
    // The second claim must EXCLUDE the user the first round found over budget, or the claim is
    // ordered oldest-first and would hand back the same sessions forever.
    expect(state.claimCalls[1]!.p_exclude_user_ids).toEqual(["poor"]);
  });

  it("marks a session failed when the model throws, and keeps sweeping", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed(), claimed({ session_id: "s2" })], []],
      messages: {
        s1: [{ id: "m1", role: "user", content: "a" }, { id: "m2", role: "user", content: "b" }],
        s2: [{ id: "m3", role: "user", content: "c" }, { id: "m4", role: "user", content: "d" }],
      },
    });
    const generateJson = vi.fn()
      .mockRejectedValueOnce(new Error("429 rate limited"))
      .mockResolvedValueOnce({
        value: { valence: 4, summary: "ổn", topics: [], confidence: 0.7 },
        inputTokens: 10, outputTokens: 5, model: "gemini-2.5-flash",
      });

    const result = await runMoodSweep({
      db, ai: { embed: vi.fn(), generateStream: vi.fn(), generateJson } as never,
      budgetUsd: 10, limit: 20,
    });

    expect(result).toMatchObject({ processed: 1, failed: 1 });
    // Left 'pending', not 'failed': the claim's `attempts < 3` is what retires it, and writing
    // 'failed' here would retire it after ONE transient 429.
    expect(state.upserts[0]).toMatchObject({ session_id: "s1", status: "pending" });
  });

  it("counts a re-claimed session's prior attempts rather than restarting at one", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed({ prior_attempts: 2 })], []],
      messages: { s1: [
        { id: "m1", role: "user", content: "a" }, { id: "m2", role: "user", content: "b" },
      ] },
    });

    await runMoodSweep({
      db, ai: ai({ valence: 3, summary: "x", topics: [], confidence: 0.5 }),
      budgetUsd: 10, limit: 20,
    });

    expect(state.upserts[0]).toMatchObject({ attempts: 3 });
  });

  // Spec §8's backfill case. One tick is bounded by `limit` and by MAX_CLAIM_ROUNDS' early break
  // -- a round that did real work STOPS, deliberately, and leaves the rest to the next tick. So a
  // backlog larger than one page is only drained across ticks, and this asserts that it actually
  // is: two successive runMoodSweep calls, each seeing the next page.
  //
  // Red against an implementation that keeps looping until the claim is empty (which would let one
  // tick spend the whole month's budget in a single hour), and red against one that re-reads page
  // A on the second tick -- the fixture's second claim returns page B precisely because the real
  // claim excludes sessions that now hold a resolved row.
  it("drains a backlog larger than one page across two ticks", async () => {
    const pageA = [claimed({ session_id: "s1" }), claimed({ session_id: "s2" })];
    const pageB = [claimed({ session_id: "s3" })];
    const two = (id: string) => [
      { id: `${id}-m1`, role: "user", content: "a" },
      { id: `${id}-m2`, role: "user", content: "b" },
    ];
    const { db, state } = fakeDb({
      // Tick 1 claims page A and breaks (work happened). Tick 2 claims page B, then empty.
      claims: [pageA, pageB, []],
      messages: { s1: two("s1"), s2: two("s2"), s3: two("s3") },
    });
    const deps = {
      db, ai: ai({ valence: 3, summary: "x", topics: [], confidence: 0.5 }),
      budgetUsd: 10, limit: 2,
    };

    const first = await runMoodSweep(deps);
    expect(first).toMatchObject({ processed: 2, failed: 0 });
    // One claim only. A tick that kept looping would have consumed page B here too.
    expect(state.claimCalls).toHaveLength(1);

    const second = await runMoodSweep(deps);
    expect(second).toMatchObject({ processed: 1, failed: 0 });

    // Every session resolved exactly once across the two ticks -- no page reprocessed.
    expect(state.upserts.map((u) => u.session_id)).toEqual(["s1", "s2", "s3"]);
    expect(state.updates).toHaveLength(3);
  });
});
