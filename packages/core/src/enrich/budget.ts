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
export async function recordUsage(
  db: SupabaseClient,
  u: { userId: string; kind: "embed" | "tag"; model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  const { error } = await db.from("usage_ledger").insert({
    user_id: u.userId,
    kind: u.kind,
    model: u.model,
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cost_usd: priceUsd(u.model, u.inputTokens, u.outputTokens),
  });
  if (error) throw error;
}

/**
 * Sums usage_ledger.cost_usd (a Postgres `numeric`, i.e. exact decimal, chosen precisely so
 * money never carries float error at rest) for the caller's UTC calendar month to date.
 *
 * Anchored to UTC, not the user's local timezone: usage_ledger.created_at is a timestamptz
 * (stored/compared in UTC) and no per-user timezone is tracked anywhere in this schema, so
 * "this UTC month" is the only boundary available without inventing new state. The visible
 * consequence: a user east of UTC (e.g. Asia/Saigon, UTC+7) has their budget month roll over
 * up to several hours AFTER their local midnight on the 1st -- late, never early -- so this
 * never grants extra unbilled spend across the boundary, it can only be conservative by a few
 * hours. Rows are summed here (rather than left as `numeric` end-to-end) because supabase-js
 * decodes `numeric` into a JS `number`; the reduce below is therefore IEEE-754 double
 * arithmetic over already-double-rounded per-row values. At the token/price magnitudes this
 * pipeline produces (dollars, not fractions of a cent, and at most a few thousand rows a
 * month) that error is many orders of magnitude below a cent and cannot flip isOverBudget's
 * `>` comparison; it is not the same as doing the SUM in Postgres itself, and a future caller
 * who needs bit-for-bit exactness should sum server-side (e.g. an RPC) instead.
 */
export async function monthToDateUsd(db: SupabaseClient, userId: string): Promise<number> {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await db.from("usage_ledger")
    .select("cost_usd").eq("user_id", userId).gte("created_at", since);
  if (error) throw error;
  return (data ?? []).reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
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
export async function isOverBudget(db: SupabaseClient, userId: string, limitUsd: number): Promise<boolean> {
  return (await monthToDateUsd(db, userId)) > limitUsd;
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
