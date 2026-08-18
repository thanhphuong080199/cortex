import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiClient } from "../ai/client.js";
import { recordUsage } from "../enrich/budget.js";
import { errorMessage } from "../errors.js";

/**
 * Structurally identical to @cortex/shared's `Offer`, and deliberately not imported from it --
 * the same split dto/assistant.ts already documents for `Citation`: that one is the WIRE type,
 * which apps/web reads without depending on @cortex/core, and this one is server-internal.
 * TypeScript's structural typing makes them interchangeable across the HTTP boundary, which is
 * the only place they meet.
 */
export interface Offer {
  statement: string;
  sourceUrl?: string;
}

/**
 * A cap, not a preference. An "offer" whose text is the whole answer is not an offer, it is a
 * save button with extra steps -- and it would write the model's entire reply into the user's
 * corpus as a single note. One statement is what §11 asks for and this is what makes that
 * assertable rather than aspirational.
 */
export const OFFER_MAX_CHARS = 400;

/**
 * PROVISIONAL, and deliberately not fixed by the spec (C5 §12.3): "a number invented at design
 * time would be a number nobody later dares to change because it looks decided."
 *
 * 0.88 is a starting value, not a measured one. It sits above the cosine similarity of two
 * merely related facts about the same topic and below that of two phrasings of one fact, on
 * this embedding model, by estimate rather than by experiment.
 *
 * WHICH DIRECTION TO MOVE IT. Too high and a declined offer comes back in different words,
 * which is the failure the decline path exists to prevent and is immediately visible to the
 * user. Too low and a genuinely new fact is silently suppressed, which nobody ever sees. The
 * asymmetry says to tune it DOWN from here against real declines, not up.
 */
export const OFFER_DEDUP_THRESHOLD = 0.88;

/**
 * Cosine similarity. Written out rather than pulled in: it is four lines, and the alternative
 * is a dependency in a package whose whole point is not having many.
 */
const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!;
  }
  // Zero-length vectors are not "identical", they are unusable. Returning 0 makes them fail to
  // suppress anything, which is the safe direction: the cost is one extra offer.
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const PROMPT =
  "The assistant just answered a question using knowledge that was NOT in the user's own " +
  "notes. Condense the single most useful fact it contributed into ONE standalone sentence " +
  "the user would want kept -- something that stays true and useful a month from now.\n" +
  "Return null if there is no such fact: if the answer was entirely from their own notes, if " +
  "it was purely conversational, or if the only content was ephemeral (today's weather, a " +
  "one-off number). Returning null is the normal case and is always better than a weak offer.\n" +
  "Write it in the same language the user wrote in. Return JSON only.";

const SCHEMA = {
  type: "object",
  properties: { statement: { type: "string", nullable: true } },
  required: ["statement"],
};

/**
 * Decides whether there is anything worth offering to save (C5 §11).
 *
 * A SECOND model call, on CLASSIFY_MODEL, and the caller gates it on the turn having actually
 * searched -- an ungrounded turn contributed nothing external and makes no call at all. That
 * gate is the cost ceiling, and it lives at the call site rather than here because turn.ts is
 * where `searched` is already computed.
 *
 * NEVER THROWS. The answer has already streamed by the time this runs; an offer is a bonus on
 * top of a turn that already succeeded, and a dead classify call must not retroactively fail
 * it. Every failure path returns null, which the caller reads as "no offer" -- the same outcome
 * as the model declining, which is the normal case.
 */
export async function proposeOffer(
  deps: { db: SupabaseClient; ai: AiClient },
  a: { userId: string; question: string; answer: string; sourceUrl?: string; requestId: string },
): Promise<Offer | null> {
  try {
    // NO `model` ARGUMENT. `AiClient.generateJson` takes `{ prompt, schema }` and nothing else
    // (ai/client.ts) -- the model is fixed inside the Gemini implementation, which posts to
    // `models/${CLASSIFY_MODEL}:generateContent` (gemini.ts:328). Passing one here is a type
    // error, not a no-op. `model` comes BACK in the result and is what the ledger records.
    const { value, inputTokens, outputTokens, model } = await deps.ai.generateJson<{
      statement?: unknown;
    }>({
      prompt: `${PROMPT}\n\nTheir question: ${a.question}\n\nThe answer given: ${a.answer}`,
      schema: SCHEMA,
    });

    // Metered, never fatal -- the same trade retrieve.ts documents. Never log the statement or
    // the answer: both are model output about the user's own material (§15.6 rule 1).
    try {
      await recordUsage(deps.db, {
        userId: a.userId, kind: "tag", model, inputTokens, outputTokens,
        source: "assistant", requestId: a.requestId, contentChars: a.answer.length,
      });
    } catch (err) {
      console.error(`[assistant] offer ledger write failed (request ${a.requestId}): ${errorMessage(err)}`);
    }

    const statement = typeof value.statement === "string" ? value.statement.trim() : "";
    if (statement === "" || statement.length > OFFER_MAX_CHARS) return null;

    // §12.3. One embed call per offer, metered like every other. Compared against BOTH 'rejected'
    // and 'active' facts: a fact the user already keeps does not need offering either.
    //
    // Semantic, not textual, and that is the whole design. "The same fact" recurs in different
    // words -- which is precisely why the row carries an embedding rather than a hash. An
    // equality check here would let "Omega-3 có nhiều trong cá hồi" through against a declined
    // "Cá hồi giàu omega-3", and the user would be offered the thing they just refused.
    //
    // A failure here skips the dedup rather than failing the offer. The worst case of skipping is
    // being asked once more; the worst case of throwing is losing an offer to a transient read.
    try {
      const { vectors, inputTokens: embedIn, model: embedModel } = await deps.ai.embed([statement]);
      const vector = vectors[0];
      if (vector) {
        try {
          await recordUsage(deps.db, {
            userId: a.userId, kind: "embed", model: embedModel, inputTokens: embedIn,
            outputTokens: 0, source: "assistant", requestId: a.requestId,
            contentChars: statement.length,
          });
        } catch (err) {
          console.error(`[assistant] offer embed ledger failed (request ${a.requestId}): ${errorMessage(err)}`);
        }

        const { data: facts, error } = await deps.db
          .from("memory_facts").select("statement, embedding")
          .eq("user_id", a.userId).in("status", ["rejected", "active"]);
        if (error) throw error;

        for (const f of (facts ?? []) as { embedding: number[] | null }[]) {
          if (f.embedding && cosine(vector, f.embedding) >= OFFER_DEDUP_THRESHOLD) return null;
        }
      }
    } catch (err) {
      // Never log the statement -- it is model output about the user's material (§15.6 rule 1).
      console.error(`[assistant] offer dedup skipped (request ${a.requestId}): ${errorMessage(err)}`);
    }

    return { statement, ...(a.sourceUrl !== undefined ? { sourceUrl: a.sourceUrl } : {}) };
  } catch (err) {
    console.error(`[assistant] offer failed (request ${a.requestId}): ${errorMessage(err)}`);
    return null;
  }
}
