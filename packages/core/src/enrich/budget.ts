import type { SupabaseClient } from "@supabase/supabase-js";
import { MODEL_PRICES_USD_PER_MTOK } from "@cortex/shared";

export function priceUsd(model: string, inputTokens: number, outputTokens: number): number {
  // An unknown model prices at zero rather than throwing: swapping a model id must never wedge
  // the whole pipeline, and a zero row is visible in the ledger as an obvious anomaly.
  const p = MODEL_PRICES_USD_PER_MTOK[model];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

/**
 * Writes one usage_ledger row per model call. `kind` is deliberately the fixed vocabulary
 * usage_ledger's CHECK constraint permits (00007_integrations_ops.sql:
 * `kind in ('embed','chat','tag','digest','memory','transcribe')`), not a richer pipeline-stage
 * label -- there is no 'extract' in that list, only 'tag' (extractNote's call also writes
 * domain/domain_meta from the same model output, but 'tag' is the closest fit the schema has).
 *
 * NOTE for whoever reads usage_ledger later: embedNote's inputTokens is a chars/4 ESTIMATE
 * (batchEmbedContents returns no usage metadata -- see ai/gemini.ts / Task 9's notes), while
 * extractNote's comes from generateJson's real usageMetadata. Rows of kind 'embed' are therefore
 * an estimate and rows of kind 'tag' are a measurement; monthToDateUsd sums both without
 * distinguishing them. That is an accepted approximation, not a bug, but it means the ledger's
 * dollar figure is not audit-grade for the 'embed' portion.
 */
/** Which part of the system spent this. See 00027 -- 'embed' alone cannot answer that. */
export type UsageSource = "sweep" | "assistant" | "search";

export async function recordUsage(
  db: SupabaseClient,
  u: {
    userId: string;
    kind: "embed" | "tag" | "chat";
    model: string;
    inputTokens: number;
    outputTokens: number;
    source: UsageSource;
    noteId?: string;
    requestId?: string;
    attempt?: number;
    latencyMs?: number;
    contentChars?: number;
  },
): Promise<void> {
  // `source` is REQUIRED, not optional with a default. A default would put every new call
  // site into whichever bucket the default names, which is exactly the ambiguity 00027
  // exists to remove -- and it would do it silently.
  //
  // Optional fields are OMITTED rather than written as null so a row's shape says which
  // facts were actually known. `undefined` would be serialised away by PostgREST anyway;
  // spelling it out means a reader of this function does not have to know that.
  const row: Record<string, unknown> = {
    user_id: u.userId,
    kind: u.kind,
    model: u.model,
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cost_usd: priceUsd(u.model, u.inputTokens, u.outputTokens),
    source: u.source,
  };
  if (u.noteId !== undefined) row.note_id = u.noteId;
  if (u.requestId !== undefined) row.request_id = u.requestId;
  if (u.attempt !== undefined) row.attempt = u.attempt;
  if (u.latencyMs !== undefined) row.latency_ms = u.latencyMs;
  if (u.contentChars !== undefined) row.content_chars = u.contentChars;

  const { error } = await db.from("usage_ledger").insert(row);
  if (error) throw error;
}

/**
 * Sums usage_ledger.cost_usd (a Postgres `numeric`, i.e. exact decimal) for the caller's UTC
 * calendar month to date, via the `usage_month_to_date_usd` SQL function
 * (00021_usage_month_to_date.sql) rather than a client-side `select` + reduce.
 *
 * This was NOT the original shape: the first version of this function did
 * `.select("cost_usd").eq(...).gte(...)` and summed the rows in JS. That silently broke past
 * 1000 rows -- config.toml's `max_rows = 1000` is PostgREST's `db-max-rows`, which truncates
 * any response at that row count with NO error and no signal short of reading Content-Range,
 * which the old code did not. recordUsage writes one row per model call, so an active user
 * crosses 1000 rows in a UTC month at roughly 34 processed notes a day; past that point the
 * old sum silently covered only the first 1000 rows, isOverBudget could return false for a
 * user who was genuinely over budget, and the sweep would never stop billing them -- the exact
 * "silently never stops" failure this gate exists to prevent. See budget.test.ts's
 * ">1000 rows" test, which pins this at a scale that actually crosses the truncation boundary.
 *
 * Doing the SUM in Postgres also dissolves a second, smaller issue the old code carried: it
 * decoded every row's `numeric` into a JS `number` and reduced with IEEE-754 double arithmetic.
 * `numeric + numeric` inside Postgres stays exact; only the single returned total now passes
 * through a JS `number` at all.
 *
 * Anchored to UTC, not the user's local timezone: usage_ledger.created_at is a timestamptz
 * (stored/compared in UTC) and no per-user timezone is tracked anywhere in this schema, so
 * "this UTC month" is the only boundary available without inventing new state. The visible
 * consequence: a user east of UTC (e.g. Asia/Saigon, UTC+7) has their budget month roll over
 * up to several hours AFTER their local midnight on the 1st -- late, never early -- so this
 * never grants extra unbilled spend across the boundary, it can only be conservative by a few
 * hours. The SQL function implements the identical UTC-month boundary the original TS version
 * used (`Date.UTC(year, month, 1)`), just computed server-side now.
 */
export async function monthToDateUsd(
  db: SupabaseClient,
  userId: string,
  source?: UsageSource,
): Promise<number> {
  const { data, error } = await db.rpc("usage_month_to_date_usd", {
    p_user_id: userId,
    // Explicit null rather than an omitted key: PostgREST resolves an overload by the argument
    // NAMES it is given, and omitting this would look for a one-argument function that 00028
    // drops.
    p_source: source ?? null,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * `> limitUsd`, not `>=`: the gate trips once the limit is PASSED, matching the brief and the
 * test "reports over budget only once the limit is passed" -- spending exactly the budget is
 * still allowed, the next dollar over it is not.
 *
 * Failure mode: monthToDateUsd throws (rather than swallowing a DB error into 0), so this
 * function throws too instead of ever returning `false` on a failed read. That is fail-CLOSED:
 * a caller (Task 13's sweep) that does not explicitly catch this will stop rather than proceed
 * unbilled. The alternative -- treating a failed budget read as "not over budget" -- would let
 * an outage in exactly the query that enforces the spending cap turn into unlimited spend
 * during that outage, which is the more dangerous failure to hide.
 */
export async function isOverBudget(
  db: SupabaseClient,
  userId: string,
  limitUsd: number,
  source?: UsageSource,
): Promise<boolean> {
  return (await monthToDateUsd(db, userId, source)) > limitUsd;
}

/**
 * Parent spec §15.6 rule 2 -- "paid AI tier only, verified before phase 2 ships" -- made
 * enforceable rather than documented.
 *
 * Google's API terms: free-tier content is used to "provide, improve, and develop Google
 * products", human reviewers may read inputs and outputs, and the terms themselves say not to
 * submit sensitive or personal information to the unpaid services. Cortex carries mood, health
 * and finance notes. A free key stays legitimate against a local stack full of seed data,
 * which is the only case this allows.
 */
export function assertTierAllowsRealData(tier: "free" | "paid", supabaseUrl: string): void {
  if (tier === "paid") return;
  const host = new URL(supabaseUrl).hostname;
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return;
  throw new Error(
    "GEMINI_TIER=free may not process hosted data: free-tier prompts are used for training " +
      "and may be read by human reviewers, and this database holds mood, health and finance " +
      "notes. Switch to a paid tier by setting GEMINI_TIER=paid (spec §15.6 rule 2).",
  );
}
