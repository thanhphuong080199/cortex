import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type AiClient, embedNote, extractNote, isOverBudget,
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
 * Claims eligible notes and runs the two steps.
 *
 * The claim predicate lives in SQL (00018) rather than here, and nothing enqueues from a
 * controller. That is deliberate: notes arrive by two write paths today (POST /notes and
 * POST /sync/upload) with four more in phase 4, and phase 1b missed the second write path
 * three times -- 9f7088d, 445139d, 867d3b1. A sweep's source of truth is the notes table, so
 * there is no path for it to miss.
 */
export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const { db, ai, budgetUsd, limit } = deps;
  const { data, error } = await db.rpc("claim_notes_for_enrichment", { p_limit: limit });
  if (error) throw error;

  const claimed = (data ?? []) as {
    note_id: string; user_id: string; content_text: string; content_hash: string;
  }[];

  const result: SweepResult = { processed: 0, failed: 0, skippedOverBudget: 0 };
  const budgetChecked = new Map<string, boolean>();

  for (const row of claimed) {
    let over = budgetChecked.get(row.user_id);
    if (over === undefined) {
      over = await isOverBudget(db, row.user_id, budgetUsd);
      budgetChecked.set(row.user_id, over);
    }
    if (over) {
      result.skippedOverBudget += 1;
      continue;
    }

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
        .update({ attempts: 0, last_error: null }).eq("note_id", row.note_id);
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
      const message = err instanceof Error ? err.message : String(err);
      // Never log note text (spec §15.6 rule 1) -- the id and the message only.
      console.error(`[enrich] note ${row.note_id} failed: ${message}`);

      // Read-modify-write, not an RPC: single-process execution serializes this (pg-boss's
      // default work() concurrency -- see enrich.module.ts's comment), so it is correct today.
      // The multi-process gap this would otherwise be exposed to is the same one Task 4's
      // review parked and enrich.module.ts's comment documents; closing it here would split
      // that decision across two places instead of leaving it in one.
      const { data: existing, error: readErr } = await db.from("note_enrichment")
        .select("attempts").eq("note_id", row.note_id).maybeSingle();
      if (readErr) {
        // Do NOT guess: existing would read undefined here, and (existing?.attempts ?? 0) + 1
        // would write attempts=1 regardless of the note's real count -- silently resetting a
        // note that had already failed 4 times back to 1, so the 5-attempt cap (00018) never
        // arrives and a broken note gets a real Gemini call every 60s forever. Skipping the
        // write leaves the count exactly where it was; the next sweep retries the read.
        console.error(`[enrich] note ${row.note_id} bookkeeping failed: ${readErr.message}`);
      } else {
        const { error: upsertErr } = await db.from("note_enrichment").upsert(
          {
            note_id: row.note_id, user_id: row.user_id,
            attempts: (existing?.attempts ?? 0) + 1,
            last_error: message.slice(0, 500),
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

  if (result.skippedOverBudget > 0) {
    // Logged deliberately: a sweep that silently stops forever is indistinguishable from a bug.
    console.warn(`[enrich] ${result.skippedOverBudget} note(s) skipped -- monthly budget exceeded`);
  }
  return result;
}
