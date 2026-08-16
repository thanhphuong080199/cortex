import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
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
      source: "sweep",
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
    await recordUsage(db, { userId, kind: "embed", model: "gemini-embedding-001", inputTokens: 1_000_000, outputTokens: 0, source: "sweep" });
    await recordUsage(db, { userId: otherId, kind: "embed", model: "gemini-embedding-001", inputTokens: 10_000_000, outputTokens: 0, source: "sweep" });
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

  // The anchor is built with Date.UTC and a FIXED day 15, never by subtracting a month from
  // today. `new Date(); d.setMonth(d.getMonth() - 1)` keeps today's day-of-month, and JS
  // normalises an out-of-range day forward instead of clamping it: run this on 31 May and
  // setMonth(3) asks for "April 31", which becomes 1 MAY -- the current month. monthToDateUsd
  // then sums the row it was supposed to exclude, returns 0.15, and this assertion goes red on
  // 31 Mar / 31 May / 31 Jul / 31 Oct / 31 Dec and nowhere else. Day 15 exists in every month,
  // so the construction cannot overflow; noon UTC keeps it clear of the month boundary that
  // usage_month_to_date_usd compares against (which is UTC, hence getUTC*, not local getters).
  // Month -1 in January is not a special case -- Date.UTC rolls the year back itself.
  it("ignores rows from a previous month", async () => {
    await recordUsage(db, { userId, kind: "embed", model: "gemini-embedding-001", inputTokens: 1_000_000, outputTokens: 0, source: "sweep" });
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12));
    await db.from("usage_ledger").update({ created_at: lastMonth.toISOString() }).eq("user_id", userId);
    expect(await monthToDateUsd(db, userId)).toBe(0);
  });

  it("reports over budget only once the limit is passed", async () => {
    expect(await isOverBudget(db, userId, 1)).toBe(false);
    await recordUsage(db, { userId, kind: "tag", model: "gemini-3.5-flash-lite", inputTokens: 20_000_000, outputTokens: 0, source: "sweep" });
    expect(await isOverBudget(db, userId, 1)).toBe(true);
  });

  /**
   * Red the moment the source filter is dropped from the RPC or from isOverBudget's call:
   * enrichment spend declines an assistant turn, and the user is told the assistant hit a
   * limit it never approached.
   */
  it("counts only the named source", async () => {
    await recordUsage(db, { userId, kind: "tag", model: "gemini-3.5-flash-lite",
      inputTokens: 1_000_000, outputTokens: 0, source: "sweep" });
    await recordUsage(db, { userId, kind: "chat", model: "gemini-3.1-pro-preview",
      inputTokens: 1000, outputTokens: 0, source: "assistant" });

    const sweep = await monthToDateUsd(db, userId, "sweep");
    const assistant = await monthToDateUsd(db, userId, "assistant");
    const total = await monthToDateUsd(db, userId);

    expect(sweep).toBeGreaterThan(0);
    expect(assistant).toBeGreaterThan(0);
    expect(assistant).not.toBeCloseTo(sweep, 10);
    // Omitting the source still means "everything", which is 00021's behaviour unchanged.
    expect(total).toBeCloseTo(sweep + assistant, 10);
  });

  it("does not decline the assistant for money the sweep spent", async () => {
    await recordUsage(db, { userId, kind: "tag", model: "gemini-3.5-flash-lite",
      inputTokens: 100_000_000, outputTokens: 0, source: "sweep" });

    expect(await isOverBudget(db, userId, 1, "assistant")).toBe(false);
    expect(await isOverBudget(db, userId, 1, "sweep")).toBe(true);
  });

  it("prices an unknown model at zero rather than throwing, so a model swap cannot wedge the pipeline", async () => {
    await recordUsage(db, { userId, kind: "tag", model: "gemini-99-future", inputTokens: 1000, outputTokens: 1000, source: "sweep" });
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

describe("recordUsage attribution", () => {
  it("writes every attribution field through to the row", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = {
      from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }),
    } as unknown as SupabaseClient;

    await recordUsage(db, {
      userId: "u1", kind: "chat", model: "m", inputTokens: 10, outputTokens: 5,
      source: "assistant", noteId: "n1", requestId: "r1", attempt: 2,
      latencyMs: 900, contentChars: 40,
    });

    expect(rows[0]).toMatchObject({
      user_id: "u1", kind: "chat", source: "assistant", note_id: "n1",
      request_id: "r1", attempt: 2, latency_ms: 900, content_chars: 40,
    });
  });

  it("omits absent optional fields rather than writing nulls", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = {
      from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }),
    } as unknown as SupabaseClient;

    await recordUsage(db, {
      userId: "u1", kind: "embed", model: "m", inputTokens: 1, outputTokens: 0, source: "sweep",
    });

    expect(rows[0]).not.toHaveProperty("note_id");
    expect(rows[0]).not.toHaveProperty("request_id");
    expect(rows[0]!.source).toBe("sweep");
  });
});
