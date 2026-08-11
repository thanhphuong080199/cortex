import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type AiClient, embedNote, errorMessage, extractNote, isOverBudget,
} from "@cortex/core";

export interface SweepDeps {
  db: SupabaseClient;
  ai: AiClient;
  budgetUsd: number;
  limit: number;
}

export interface SweepResult {
  processed: number;
  failed: number;
  skippedOverBudget: number;
}

/**
 * How many times one sweep will re-claim past users it just found over budget.
 *
 * The claim is global and ordered `updated_at asc` (00018:58), so an over-budget user's
 * un-enriched notes sit permanently at the head of it -- skipping a note increments nothing and
 * writes nothing to `notes`, so its updated_at never advances. Before this loop existed, a single
 * user crossing ENRICH_MONTHLY_BUDGET_USD while holding the oldest 20+ un-enriched notes stopped
 * enrichment for EVERY user until the UTC month rolled over, with the cron still firing and one
 * warning still printing -- alive-looking and completely dead.
 *
 * Bounded, and cheaply so. Each round can only run if EVERY note the previous round claimed was
 * skipped for budget, which means every one of their owners is now in the exclusion set, which
 * means the next claim is strictly narrower -- the loop is already self-terminating and this is
 * the belt to that braces. What the bound actually buys is a cap on WORK: five rounds is at most
 * 5 claims and 5 budget reads before the sweep gives up and lets the next 60-second tick continue.
 * More than four users simultaneously over budget and holding the oldest notes in the system is
 * not a case worth spending an unbounded tick on -- the sweep makes progress on the next tick,
 * and the skippedOverBudget warning says why.
 */
const MAX_CLAIM_ROUNDS = 5;

/**
 * Claims eligible notes and runs the two steps.
 *
 * The claim predicate lives in SQL (00018) rather than here, and nothing enqueues from a
 * controller. That is deliberate: notes arrive by two write paths today (POST /notes and
 * POST /sync/upload) with four more in phase 4, and phase 1b missed the second write path
 * three times -- 9f7088d, 445139d, 867d3b1. A sweep's source of truth is the notes table, so
 * there is no path for it to miss.
 *
 * The budget stays HERE rather than being joined into that predicate. usage_month_to_date_usd
 * (00021) is a volatile aggregate over usage_ledger, so Postgres would evaluate it once per
 * candidate row -- every un-enriched note in the system, before the LIMIT cuts it to 20 -- and
 * the skippedOverBudget signal would disappear along with the TypeScript check. 00023's
 * p_exclude_user_ids is what lets the budget live here without letting one user block the rest.
 */
export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const { db, ai, budgetUsd, limit } = deps;

  const result: SweepResult = { processed: 0, failed: 0, skippedOverBudget: 0 };
  // Cached across rounds as well as within one: monthToDateUsd is a full aggregate and a user
  // found over budget in round 1 is exactly the user round 2 must not pay to re-check.
  const budgetChecked = new Map<string, boolean>();
  const overBudgetUsers = new Set<string>();

  for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
    const { data, error } = await db.rpc("claim_notes_for_enrichment", {
      p_limit: limit,
      p_exclude_user_ids: [...overBudgetUsers],
    });
    if (error) throw error;

    const claimed = (data ?? []) as {
      note_id: string; user_id: string; content_text: string; content_hash: string;
    }[];
    if (claimed.length === 0) break;

    // "Did this round reach the actual work, for anybody?" A failure counts: it increments
    // attempts, which advances the note's state and lets the 5-attempt cap eventually retire it.
    // Only a budget skip leaves the world exactly as it found it, and only that is worth
    // re-claiming past.
    let attemptedAny = false;

    for (const row of claimed) {
      let over = budgetChecked.get(row.user_id);
      if (over === undefined) {
        over = await isOverBudget(db, row.user_id, budgetUsd);
        budgetChecked.set(row.user_id, over);
      }
      if (over) {
        result.skippedOverBudget += 1;
        overBudgetUsers.add(row.user_id);
        continue;
      }
      attemptedAny = true;

      const note = {
        noteId: row.note_id, userId: row.user_id,
        contentText: row.content_text, contentHash: row.content_hash,
      };
      try {
        // Two independent steps, each skipping itself when its own hash already matches. If
        // extraction throws, the embedding work above it is already committed.
        await embedNote({ db, ai }, note);
        await extractNote({ db, ai }, note);
        const { error: resetErr } = await db.from("note_enrichment")
          // attempts_hash goes back to null with the count (00023). Not strictly required -- a
          // row at attempts 0 satisfies the claim's `attempts < 5` disjunct whatever hash sits
          // beside it -- but the column's meaning is "the text these attempts were counted
          // against", and leaving a hash next to a count of zero makes that a lie for the next
          // reader.
          .update({ attempts: 0, attempts_hash: null, last_error: null }).eq("note_id", row.note_id);
        // The enrichment itself succeeded (embedNote/extractNote already committed their work);
        // only the attempts/last_error reset failed. Logged, not thrown -- a stale attempts
        // count self-corrects on the note's next genuine failure or success, so this is not
        // worth discarding a real success over.
        if (resetErr) {
          console.error(`[enrich] note ${row.note_id} bookkeeping failed: ${resetErr.message}`);
        }
        result.processed += 1;
      } catch (err) {
        result.failed += 1;
        // errorMessage, not `err instanceof Error ? err.message : String(err)`. Every throw site
        // in embed.ts and extract.ts rethrows the RAW PostgREST error, which is a plain object,
        // not an Error -- `PostgrestError extends Error` is only constructed under
        // shouldThrowOnError, which this repo never sets. String() on it is the literal
        // "[object Object]", which is what this log line and last_error below held for every
        // database-side failure in the pipeline: a note tombstoned after five upsert failures
        // recorded nothing about any of them. search.controller.ts:50 documents the same fact and
        // fixes it there with mapPostgrestError; this is the pipeline's half.
        //
        // Truncated for the LOG too, not just for last_error. An error message here is derived
        // from model output in at least one path, and an unbounded console.error is how a
        // 50,000-character body ends up in a log aggregator. (The specific §15.6 rule 1 leak --
        // V8 quoting ~30 characters of the model's response inside a JSON.parse SyntaxError --
        // is closed at its source in gemini.ts's parseModelJson, because truncation alone would
        // not have removed it: the quoted text is at the FRONT of that message.)
        const message = errorMessage(err).slice(0, 500);
        // Never log note text (spec §15.6 rule 1) -- the id and the message only.
        console.error(`[enrich] note ${row.note_id} failed: ${message}`);

        // Read-modify-write, not an RPC: single-process execution serializes this (pg-boss's
        // default work() concurrency -- see enrich.module.ts's comment), so it is correct today.
        // The multi-process gap this would otherwise be exposed to is the same one Task 4's
        // review parked and enrich.module.ts's comment documents; closing it here would split
        // that decision across two places instead of leaving it in one.
        const { data: existing, error: readErr } = await db.from("note_enrichment")
          .select("attempts, attempts_hash").eq("note_id", row.note_id).maybeSingle();
        if (readErr) {
          // Do NOT guess: existing would read undefined here, and (existing?.attempts ?? 0) + 1
          // would write attempts=1 regardless of the note's real count -- silently resetting a
          // note that had already failed 4 times back to 1, so the 5-attempt cap (00018) never
          // arrives and a broken note gets a real Gemini call every 60s forever. Skipping the
          // write leaves the count exactly where it was; the next sweep retries the read.
          console.error(`[enrich] note ${row.note_id} bookkeeping failed: ${readErr.message}`);
        } else {
          // The count belongs to the TEXT it was counted against (00023). If the stored hash is
          // not this note's current hash, those failures were against text the user has since
          // replaced, and resuming from them would give the rewritten note a fraction of a fresh
          // budget -- one attempt, if the old text had already failed four times -- before being
          // tombstoned again for reasons that no longer exist. Restarting at 1 is what makes
          // "rewrite the note" a real remedy rather than a thing that looks like one.
          const sameText = existing?.attempts_hash === row.content_hash;
          const { error: upsertErr } = await db.from("note_enrichment").upsert(
            {
              note_id: row.note_id, user_id: row.user_id,
              attempts: sameText ? (existing?.attempts ?? 0) + 1 : 1,
              attempts_hash: row.content_hash,
              last_error: message,
            },
            { onConflict: "note_id" },
          );
          if (upsertErr) {
            // The failure counter itself failed to write -- the exact "retried forever" failure
            // this whole bookkeeping path exists to prevent, just reached through an unchecked
            // write instead of a missing predicate. Logged so it is at least visible.
            console.error(`[enrich] note ${row.note_id} bookkeeping failed: ${upsertErr.message}`);
          }
        }
      }
    }

    // Work happened (or was at least attempted), so this tick has done its job and the rest of
    // the backlog is the next tick's. Only a round that was ENTIRELY budget skips is worth
    // re-claiming past, and only then are there guaranteed to be new exclusions to re-claim with.
    if (attemptedAny) break;
  }

  if (result.skippedOverBudget > 0) {
    // Logged deliberately: a sweep that silently stops forever is indistinguishable from a bug.
    console.warn(`[enrich] ${result.skippedOverBudget} note(s) skipped -- monthly budget exceeded`);
  }
  return result;
}
