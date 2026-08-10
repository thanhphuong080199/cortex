import { beforeEach, describe, expect, it } from "vitest";
import { createServiceClient } from "../supabase.js";
import { assertTierAllowsRealData, isOverBudget, monthToDateUsd, recordUsage } from "./budget.js";

const db = createServiceClient();
let userId: string;

async function makeUser(prefix: string): Promise<string> {
  // 00008_invite_gate.sql fires on every auth.users insert, including through the admin API,
  // so createUser fails with "Signup not allowed" unless the email is allow-listed first --
  // the same step embed.test.ts / extract.test.ts perform.
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { error: upsertErr } = await db.from("allowed_emails").upsert({ email });
  if (upsertErr) throw upsertErr;
  const { data, error } = await db.auth.admin.createUser({
    email, password: "x".repeat(16), email_confirm: true,
  });
  if (error) throw error;
  return data.user!.id;
}

describe("usage and budget", () => {
  beforeEach(async () => {
    userId = await makeUser("budget");
  });

  it("prices a call from the model's constants and stores the model with it", async () => {
    await recordUsage(db, {
      userId, kind: "tag", model: "gemini-3.5-flash-lite", inputTokens: 1_000_000, outputTokens: 1_000_000,
    });
    const { data } = await db.from("usage_ledger").select("*").eq("user_id", userId).single();
    expect(data!.model).toBe("gemini-3.5-flash-lite");
    // gemini-3.5-flash-lite is $0.30 input / $2.50 output per 1M tokens (packages/shared/src/enums.ts's
    // MODEL_PRICES_USD_PER_MTOK, live-verified against ai.google.dev on 2026-08-10). The plan's
    // original brief for this test used the plan's stale $0.10/$0.40 figures (0.5 total); Task 9
    // already corrected that price and this test must consume the same constant, not a second
    // copy of it -- so 1M in + 1M out prices at 0.30 + 2.50 = 2.80.
    expect(Number(data!.cost_usd)).toBeCloseTo(2.8, 6); // 0.30 in + 2.50 out
  });

  it("sums only this user's rows", async () => {
    const otherId = await makeUser("budget-other");
    await recordUsage(db, { userId, kind: "embed", model: "gemini-embedding-001", inputTokens: 1_000_000, outputTokens: 0 });
    await recordUsage(db, { userId: otherId, kind: "embed", model: "gemini-embedding-001", inputTokens: 10_000_000, outputTokens: 0 });
    expect(await monthToDateUsd(db, userId)).toBeCloseTo(0.15, 6);
  });

  // Review finding: the original monthToDateUsd did a plain `select("cost_usd")` with no
  // `.limit()`. config.toml's `max_rows = 1000` (PostgREST's db-max-rows) silently truncates any
  // response past 1000 rows -- no error, nothing to catch, unless the caller reads
  // Content-Range, which the old code did not. recordUsage writes one row per model call, so an
  // active user crosses 1000 rows in a UTC month at roughly 34 processed notes a day; past that
  // point the old sum covered only the first 1000 rows and isOverBudget could return false for a
  // user who was genuinely over budget. 1200 rows is comfortably past the 1000-row boundary
  // while staying a single cheap bulk insert (well under a second locally).
  it("sums correctly past PostgREST's 1000-row response cap", async () => {
    const ROWS = 1200;
    const rows = Array.from({ length: ROWS }, () => ({
      user_id: userId, kind: "tag" as const, cost_usd: 0.01,
    }));
    const { error } = await db.from("usage_ledger").insert(rows);
    if (error) throw error;
    expect(await monthToDateUsd(db, userId)).toBeCloseTo(ROWS * 0.01, 6); // $12.00
  }, 30_000);

  it("ignores rows from a previous month", async () => {
    await recordUsage(db, { userId, kind: "embed", model: "gemini-embedding-001", inputTokens: 1_000_000, outputTokens: 0 });
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    await db.from("usage_ledger").update({ created_at: lastMonth.toISOString() }).eq("user_id", userId);
    expect(await monthToDateUsd(db, userId)).toBe(0);
  });

  it("reports over budget only once the limit is passed", async () => {
    expect(await isOverBudget(db, userId, 1)).toBe(false);
    await recordUsage(db, { userId, kind: "tag", model: "gemini-3.5-flash-lite", inputTokens: 20_000_000, outputTokens: 0 });
    expect(await isOverBudget(db, userId, 1)).toBe(true);
  });

  it("prices an unknown model at zero rather than throwing, so a model swap cannot wedge the pipeline", async () => {
    await recordUsage(db, { userId, kind: "tag", model: "gemini-99-future", inputTokens: 1000, outputTokens: 1000 });
    const { data } = await db.from("usage_ledger").select("cost_usd").eq("user_id", userId).single();
    expect(Number(data!.cost_usd)).toBe(0);
  });

  describe("assertTierAllowsRealData", () => {
    it("allows a free key against a local stack", () => {
      expect(() => assertTierAllowsRealData("free", "http://127.0.0.1:54321")).not.toThrow();
    });
    it("allows a paid key anywhere", () => {
      expect(() => assertTierAllowsRealData("paid", "https://wilssluxogpdrbgffmzc.supabase.co")).not.toThrow();
    });
    // §15.6 rule 2, made enforceable instead of documented.
    it("refuses a free key against hosted data", () => {
      expect(() => assertTierAllowsRealData("free", "https://wilssluxogpdrbgffmzc.supabase.co"))
        .toThrow(/paid tier/i);
    });
  });
});
