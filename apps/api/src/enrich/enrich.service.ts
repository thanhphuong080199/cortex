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
      await db.from("note_enrichment")
        .update({ attempts: 0, last_error: null }).eq("note_id", row.note_id);
      result.processed += 1;
    } catch (err) {
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Never log note text (spec §15.6 rule 1) -- the id and the message only.
      console.error(`[enrich] note ${row.note_id} failed: ${message}`);
      const { data: existing } = await db.from("note_enrichment")
        .select("attempts").eq("note_id", row.note_id).maybeSingle();
      await db.from("note_enrichment").upsert(
        {
          note_id: row.note_id, user_id: row.user_id,
          attempts: (existing?.attempts ?? 0) + 1,
          last_error: message.slice(0, 500),
        },
        { onConflict: "note_id" },
      );
    }
  }

  if (result.skippedOverBudget > 0) {
    // Logged deliberately: a sweep that silently stops forever is indistinguishable from a bug.
    console.warn(`[enrich] ${result.skippedOverBudget} note(s) skipped -- monthly budget exceeded`);
  }
  return result;
}
