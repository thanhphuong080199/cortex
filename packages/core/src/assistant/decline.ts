import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPostgrestError } from "../errors.js";

/**
 * Records that the user turned down an offer, so the same one is not made twice (C5 §12).
 *
 * `db` MUST be the service-role client. memory_facts grants `authenticated` `select` and nothing
 * else, deliberately (00005:52-65), and feedback_events grants it no DML at all -- both are
 * server-only for writes by design, so this runs through the API under the service role.
 *
 * Two rows, because they are two different things: the FACT (what was declined, kept for
 * deduplication) and the ACT (that a decline happened, kept as feedback signal).
 *
 * The category is the fence. Life-domains §6.4 rejected feeding search signal into the memory
 * layer; reusing memory_facts without a fence is that rejected pipeline through a side door.
 * See 00033's header for why 'assistant_offer' is a category rather than only the jsonb marker
 * §12.2 names -- both are written, and the exclusion keys on the category.
 */
export async function declineOffer(
  db: SupabaseClient,
  a: { userId: string; statement: string; embedding: number[] },
): Promise<void> {
  const { error: factErr } = await db.from("memory_facts").insert({
    user_id: a.userId,
    category: "assistant_offer",
    statement: a.statement,
    // Not a fact we believe. It is a fact we were told not to raise again, and the confidence
    // column is `not null check (>= 0 and <= 1)` -- zero is the honest value.
    confidence: 0,
    status: "rejected",
    evidence: { source: "assistant_offer", declinedAt: new Date().toISOString() },
    // Without this, the next offer has nothing to compare against: the decline silently fails
    // to stick, and the symptom looks like a badly chosen dedup threshold (Task 14).
    embedding: a.embedding,
  });
  if (factErr) throw mapPostgrestError(factErr);

  const { error: evErr } = await db.from("feedback_events").insert({
    user_id: a.userId,
    // Already in the CHECK since 00005 -- no migration needed for this half.
    subject_type: "chat_answer",
    action: "reject",
    payload: { kind: "assistant_offer" },
  });
  if (evErr) throw mapPostgrestError(evErr);
}
