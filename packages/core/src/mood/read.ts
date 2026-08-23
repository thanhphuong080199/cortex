import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiClient } from "../ai/client.js";
import { recordUsage } from "../enrich/budget.js";

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface MoodReading {
  /** 1..5, the checkins.mood scale. Null means "not readable" -- see the S3 spec §1. */
  valence: number | null;
  summary: string | null;
  topics: string[];
  confidence: number | null;
}

/**
 * How many of the user's own messages a session needs before it is worth a model call.
 *
 * USER messages, not rows: an "ok" answered by a long assistant reply is still a session with
 * nothing to read, and counting rows would buy a Flash call for every one of them forever.
 */
export const MIN_USER_MESSAGES = 2;

/** At most this many topics survive, however many the model returns. */
const MAX_TOPICS = 5;

export function hasReadableContent(messages: SessionMessage[]): boolean {
  return messages.filter((m) => m.role === "user").length >= MIN_USER_MESSAGES;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    // Nullable and expected to BE null often. The prompt below only allows a number when the
    // session actually shows how the person felt.
    valence: { type: "integer", nullable: true },
    summary: { type: "string", nullable: true },
    topics: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: ["valence", "summary", "topics", "confidence"],
};

/** Exported for read.test.ts: the prompt's rules are the design, and drift in them is silent. */
export function buildMoodPrompt(messages: SessionMessage[]): string {
  return [
    "You read one person's chat session and report how THEY seemed. Return JSON only.",
    "",
    "Rules:",
    "- Score the USER's mood only. The assistant's replies are shown for context — so that a",
    "  short answer has something to refer back to — and are never evidence of how the user",
    "  feels.",
    "- valence is 1 to 5, and ONLY when the session shows how the person feels. A note about a difficult topic is not a bad mood.",
    "  Return null if you are inferring rather than reading: a session with nothing personal in",
    "  it has no reading, and that is a correct answer.",
    "- summary is one or two sentences in Vietnamese saying what you read and why.",
    "- topics are Vietnamese, at most " + MAX_TOPICS + ", naming what the session was about.",
    "- confidence is 0 to 1. When it is low, hedge the summary to match — do not write a",
    "  confident sentence beside a low number.",
    "",
    "The session:",
    ...messages.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.content}`),
  ].join("\n");
}

interface RawReading {
  valence?: unknown;
  summary?: unknown;
  topics?: unknown;
  confidence?: unknown;
}

/**
 * One Flash call per idle session, metered under its own ledger kind.
 *
 * Does NOT check the floor itself -- the caller does, before deciding whether to spend anything.
 * Keeping `hasReadableContent` separate is what lets the job write a `no_reading` row for a
 * one-line session without a model call at all.
 */
export async function readSessionMood(
  deps: { db: SupabaseClient; ai: AiClient },
  args: { userId: string; messages: SessionMessage[] },
): Promise<MoodReading> {
  const { db, ai } = deps;

  const { value, inputTokens, outputTokens, model } = await ai.generateJson<RawReading>({
    prompt: buildMoodPrompt(args.messages),
    schema: RESPONSE_SCHEMA,
  });

  await recordUsage(db, {
    userId: args.userId, kind: "mood", model, inputTokens, outputTokens,
    // "sweep", not a new source: usage_ledger.source (00027) answers "which part of the system
    // spent this", and this is a scheduled background job like the enrichment sweep. `kind`
    // already separates the two.
    source: "sweep",
  });

  // An out-of-range valence becomes null rather than being clamped into range. The model
  // returning 9 did not mean 5 -- it did not answer the question, and mood_readings.valence's
  // CHECK would reject the row outright, turning a bad reading into a FAILED session that gets
  // retried twice more for nothing.
  const rawValence = value.valence;
  const valence =
    typeof rawValence === "number" && Number.isInteger(rawValence) && rawValence >= 1 && rawValence <= 5
      ? rawValence
      : null;

  const rawConfidence = value.confidence;
  const confidence =
    typeof rawConfidence === "number" && rawConfidence >= 0 && rawConfidence <= 1
      ? rawConfidence
      : null;

  return {
    valence,
    summary: typeof value.summary === "string" && value.summary.trim() !== "" ? value.summary : null,
    topics: (Array.isArray(value.topics) ? value.topics : [])
      .filter((t): t is string => typeof t === "string" && t.trim() !== "")
      .slice(0, MAX_TOPICS),
    confidence,
  };
}
