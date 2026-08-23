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
 *
 * COUPLED to @cortex/shared's `declineOfferInput.statement` cap (packages/shared/src/dto/
 * assistant.ts), which is 400 for exactly this reason: a decline's statement always originates
 * from an offer this server produced, so it can never legitimately exceed what an offer can
 * produce. `shared` cannot import from `core` (the dependency runs the other way), so that cap is
 * a plain number with a comment pointing back here rather than a shared import -- keep the two in
 * step by hand if this number ever moves.
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

/**
 * PostgREST serializes a `vector` column as its Postgres text output (e.g. "[1,2,3]"), not a
 * JSON array -- pgvector has no JSON cast. A raw `number[]` cast on the read below compiles and
 * passes every test whose fixture hands it a real array, but at runtime `embedding` is always a
 * string, and comparing it as a vector silently produces NaN on every row (each `a[i] * b[i]`
 * multiplies a number by a single CHARACTER of the string) -- the dedup never suppresses
 * anything, with no error and no log line, because `NaN >= OFFER_DEDUP_THRESHOLD` is false and
 * the zero-guard in `cosine` does not catch NaN either. This is what makes it real.
 */
const toEmbeddingVector = (raw: unknown): number[] | null => {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }
  return null;
};

export const OFFER_PROMPT =
  "The assistant just answered a question using knowledge that was NOT in the user's own " +
  "notes. Condense the single most useful fact it contributed into ONE standalone sentence " +
  "the user would want kept -- something that stays true and useful a month from now.\n" +
  "Return null if there is no such fact: if the answer was entirely from their own notes, if " +
  "it was purely conversational, or if the only content was ephemeral (today's weather, a " +
  "one-off number). Returning null is the normal case and is always better than a weak offer.\n" +
  "Write it in the same language the user wrote in. Return JSON only.";

/**
 * The user-initiated path's prompt (S1.5 §4). Deliberately NOT `OFFER_PROMPT`.
 *
 * Two things differ, and both are load-bearing. The offer's prompt opens with "knowledge that was
 * NOT in the user's own notes", which is simply false here -- the user may want to keep an answer
 * drawn entirely from their own notes, and a prompt that asserts otherwise makes the model hunt
 * for outside content that is not there. And the offer's "Returning null is the normal case and
 * is always better than a weak offer" must not appear: that sentence is right for a suggestion
 * nobody asked for and wrong for a button the user pressed, where null is a failure.
 *
 * There is still a null path -- the caller falls back to the verbatim reply -- but it is the
 * exception here, not the design.
 */
export const MANUAL_SAVE_PROMPT =
  "The user just asked to keep this answer in their own notes. Condense it into ONE standalone " +
  "sentence they would want kept -- the thing that stays true and useful a month from now, " +
  "readable on its own with no memory of this conversation.\n" +
  "Keep the substance, not the conversational framing. Only return null if the answer contains " +
  "no keepable content at all.\n" +
  "Write it in the same language the user wrote in. Return JSON only.";

const SCHEMA = {
  type: "object",
  properties: { statement: { type: "string", nullable: true } },
  required: ["statement"],
};

/**
 * One model call that turns an answer into a single keepable sentence, metered, capped, and
 * incapable of throwing.
 *
 * Shared by both save paths deliberately: `save-answer.ts` requires that the offer's accept and
 * the user's own save "come through this same function, which is what makes the two
 * indistinguishable BY CONSTRUCTION rather than by discipline". This is the upstream half of
 * that; `buildSavedAnswerRow` is the downstream half.
 *
 * NO DEDUP HERE. `proposeOffer` layers that on top, because it is only correct for the
 * assistant's own unsolicited suggestion. On the manual path, staying silent because the
 * statement resembles a previously declined fact is indistinguishable from a broken button.
 *
 * NEVER THROWS, same contract proposeOffer already had: every failure returns null, and every
 * caller treats null as "no statement" rather than as an error.
 */
export async function distill(
  deps: { db: SupabaseClient; ai: AiClient },
  a: { userId: string; prompt: string; question?: string; answer: string; requestId: string },
): Promise<string | null> {
  try {
    // NO `model` ARGUMENT. `AiClient.generateJson` takes `{ prompt, schema }` and nothing else
    // (ai/client.ts) -- the model is fixed inside the Gemini implementation, which posts to
    // `models/${CLASSIFY_MODEL}:generateContent` (gemini.ts:328). Passing one here is a type
    // error, not a no-op. `model` comes BACK in the result and is what the ledger records.
    const { value, inputTokens, outputTokens, model } = await deps.ai.generateJson<{
      statement?: unknown;
    }>({
      // The question is optional because the manual path can be invoked on a reply scrolled back
      // to, where the turn that produced it may not be on screen. Omitted rather than sent empty:
      // "Their question: " with nothing after it is a line the model has to interpret.
      prompt: `${a.prompt}${a.question ? `\n\nTheir question: ${a.question}` : ""}\n\nThe answer given: ${a.answer}`,
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
      console.error(`[assistant] distill ledger write failed (request ${a.requestId}): ${errorMessage(err)}`);
    }

    const statement = typeof value.statement === "string" ? value.statement.trim() : "";
    // Over the cap means the model echoed rather than distilled. Null, so the caller falls back
    // to something honestly labelled instead of writing a whole reply in under a distillation's
    // name.
    if (statement === "" || statement.length > OFFER_MAX_CHARS) return null;
    return statement;
  } catch (err) {
    console.error(`[assistant] distill failed (request ${a.requestId}): ${errorMessage(err)}`);
    return null;
  }
}

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
  const statement = await distill(deps, {
    userId: a.userId, prompt: OFFER_PROMPT, question: a.question,
    answer: a.answer, requestId: a.requestId,
  });
  if (statement === null) return null;

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

      for (const f of (facts ?? []) as { embedding: unknown }[]) {
        const stored = toEmbeddingVector(f.embedding);
        if (stored && cosine(vector, stored) >= OFFER_DEDUP_THRESHOLD) return null;
      }
    }
  } catch (err) {
    // Never log the statement -- it is model output about the user's material (§15.6 rule 1).
    console.error(`[assistant] offer dedup skipped (request ${a.requestId}): ${errorMessage(err)}`);
  }

  return { statement, ...(a.sourceUrl !== undefined ? { sourceUrl: a.sourceUrl } : {}) };
}
