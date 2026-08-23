import type { SupabaseClient } from "@supabase/supabase-js";
import { SESSION_IDLE_RESET_MS } from "@cortex/shared";
import {
  type AiClient, errorMessage, hasReadableContent, isOverBudget, readSessionMood,
  type SessionMessage,
} from "@cortex/core";

export interface MoodSweepDeps {
  db: SupabaseClient;
  ai: AiClient;
  budgetUsd: number;
  limit: number;
}

export interface MoodSweepResult {
  processed: number;
  noReading: number;
  failed: number;
  skippedOverBudget: number;
}

/**
 * Same bound, and for the same reason, as enrich.service.ts's MAX_CLAIM_ROUNDS: the claim is
 * global and ordered `session_end asc`, so an over-budget user holding the oldest unread sessions
 * sits permanently at the head of it. Each round can only run if EVERY session the last round
 * claimed was skipped for budget, which puts all of their owners in the exclusion set, which makes
 * the next claim strictly narrower -- the loop self-terminates and this caps the WORK.
 */
const MAX_CLAIM_ROUNDS = 5;

interface ClaimedSession {
  user_id: string;
  session_id: string;
  session_start: string;
  session_end: string;
  message_count: number;
  prior_attempts: number;
}

/**
 * Reads every idle session that has no mood reading yet.
 *
 * The claim is a pure select (00038) and this function does all the writing, in two steps: a
 * `pending` row with the attempt counted, then a resolution to 'ok' or 'no_reading'. Splitting
 * them is what makes a crash recoverable -- the claim's stale-pending branch picks the row back
 * up ten minutes later -- and it is also why the budget check has to come FIRST: a skip must
 * leave the world exactly as it found it, attempts included (S3 spec §3).
 */
export async function runMoodSweep(deps: MoodSweepDeps): Promise<MoodSweepResult> {
  const { db, ai, budgetUsd, limit } = deps;

  const result: MoodSweepResult = { processed: 0, noReading: 0, failed: 0, skippedOverBudget: 0 };
  const budgetChecked = new Map<string, boolean>();
  const overBudgetUsers = new Set<string>();

  for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
    const { data, error } = await db.rpc("claim_sessions_for_mood", {
      p_limit: limit,
      // Derived, never a second literal: resolveCurrentSession decides a session has ended by
      // this same constant, and a job that disagreed with it would read sessions the app still
      // considers open.
      p_idle_ms: SESSION_IDLE_RESET_MS,
      p_exclude_user_ids: [...overBudgetUsers],
    });
    if (error) throw error;

    const claimed = (data ?? []) as ClaimedSession[];
    if (claimed.length === 0) break;

    let attemptedAny = false;

    for (const session of claimed) {
      let over = budgetChecked.get(session.user_id);
      if (over === undefined) {
        over = await isOverBudget(db, session.user_id, budgetUsd, "sweep");
        budgetChecked.set(session.user_id, over);
      }
      if (over) {
        result.skippedOverBudget += 1;
        overBudgetUsers.add(session.user_id);
        continue;
      }
      attemptedAny = true;

      // Claim the row before doing anything expensive, counting the attempt. prior_attempts comes
      // from the claim's left join, so this needs no second read.
      const { data: row, error: claimErr } = await db.from("mood_readings").upsert(
        {
          user_id: session.user_id,
          session_id: session.session_id,
          status: "pending",
          attempts: session.prior_attempts + 1,
          message_count: session.message_count,
          session_start: session.session_start,
          session_end: session.session_end,
        },
        { onConflict: "session_id" },
      ).select("id").single();
      if (claimErr || !row) {
        result.failed += 1;
        console.error(`[mood] session ${session.session_id} claim failed: ${errorMessage(claimErr)}`);
        continue;
      }

      try {
        const { data: messageRows, error: msgErr } = await db.from("chat_messages")
          .select("id, role, content")
          .eq("session_id", session.session_id)
          .order("created_at", { ascending: true });
        if (msgErr) throw msgErr;
        const messages = (messageRows ?? []) as SessionMessage[];

        // The floor is checked HERE rather than inside readSessionMood so a one-line session
        // resolves without a model call at all.
        const reading = hasReadableContent(messages)
          ? await readSessionMood({ db, ai }, { userId: session.user_id, messages })
          : { valence: null, summary: null, topics: [], confidence: null };

        // A null valence is a FINISHED session, not a failed one. This mapping is the whole
        // anti-fabrication guarantee: nothing anywhere turns "nothing to read" into a number.
        const status = reading.valence === null ? "no_reading" : "ok";
        const { error: resolveErr } = await db.from("mood_readings").update({
          status,
          valence: reading.valence,
          summary: reading.summary,
          topics: reading.topics,
          confidence: reading.confidence,
          evidence: messages.map((m) => m.id),
        }).eq("id", row.id);
        if (resolveErr) throw resolveErr;

        if (status === "ok") result.processed += 1;
        else result.noReading += 1;
      } catch (err) {
        result.failed += 1;
        // Deliberately left 'pending' rather than written 'failed'. The claim's `attempts < 3` is
        // what retires a poison session; marking it failed here would retire it after ONE
        // transient 429, and nothing would ever look at it again.
        //
        // Never log message text -- the session id and the message only.
        console.error(
          `[mood] session ${session.session_id} failed: ${errorMessage(err).slice(0, 500)}`,
        );
      }
    }

    if (attemptedAny) break;
  }

  if (result.skippedOverBudget > 0) {
    console.warn(`[mood] ${result.skippedOverBudget} session(s) skipped -- monthly budget exceeded`);
  }
  return result;
}
