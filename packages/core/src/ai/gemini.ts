import { CLASSIFY_MODEL, EMBEDDING_DIM, EMBEDDING_MODEL } from "@cortex/shared";
import type { AiClient, EmbedResult, JsonResult } from "./client.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * gemini-embedding-001 only guarantees a unit vector at its native 3072-dim output; any
 * truncated width -- including EMBEDDING_DIM, requested via outputDimensionality below -- is
 * NOT pre-normalized by the API. Confirmed by a one-off live call during review (never
 * committed): a 1536-dim response for the string "dimension probe" had L2 norm 0.6986, not 1.
 *
 * Normalizing here changes nothing about today's search results -- migration 00012 builds the
 * HNSW index with vector_cosine_ops, and cosine distance divides by each vector's own norm
 * internally, so ranking is identical either way. It's done anyway because leaving vectors
 * unnormalized is a landmine for the first consumer that assumes unit vectors -- an
 * inner-product or L2 query, a clustering step, a dot product computed outside Postgres -- and
 * by the time that surfaces, the fix is re-embedding the whole corpus instead of editing this
 * function. Exported so a test can pin the math without a network call.
 */
export function normalizeEmbedding(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  // A zero vector has no direction: dividing by it would emit NaN in every component, which
  // would poison note_chunks.embedding silently and corrupt cosine-similarity search for every
  // row compared against it. Throwing instead matches this file's convention (see
  // generateJson below) of failing loudly on a response shape a caller cannot safely relay,
  // so the pipeline records a failed step and retries rather than persisting garbage.
  if (norm === 0) {
    throw new Error("gemini: embedding API returned a zero vector");
  }
  return vector.map((v) => v / norm);
}

export function createGeminiAi(apiKey: string): AiClient {
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Status is both in the message (for logs) and attached as a `status` property (so a
      // caller can branch on a 429/5xx (retry) vs. a 400 (a bug in our request, which retrying
      // will never fix) without parsing the message string). No prompt text or body is
      // logged -- spec §15.6 rule 1.
      throw Object.assign(new Error(`gemini ${res.status}`), { status: res.status });
    }
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    async embed(texts: string[]): Promise<EmbedResult> {
      const json = await post(`models/${EMBEDDING_MODEL}:batchEmbedContents`, {
        requests: texts.map((text) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          // MRL truncation to the width 00012 sized the column for. Omitting this returns the
          // full 3072-dim vector, which pgvector rejects against a vector(1536) column.
          outputDimensionality: EMBEDDING_DIM,
        })),
      });
      const embeddings = (json.embeddings ?? []) as { values: number[] }[];
      return {
        vectors: embeddings.map((e) => normalizeEmbedding(e.values)),
        // batchEmbedContents returns no usage metadata (unlike generateContent's
        // usageMetadata below), so this is a chars/4 estimate, not an API-reported count.
        // usage_ledger rows for embeddings carry this estimate, not a measured value.
        inputTokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
        model: EMBEDDING_MODEL,
      };
    },

    async generateJson<T>(args: { prompt: string; schema: Record<string, unknown> }): Promise<JsonResult<T>> {
      const json = await post(`models/${CLASSIFY_MODEL}:generateContent`, {
        contents: [{ role: "user", parts: [{ text: args.prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: args.schema,
          temperature: 0,
        },
      });
      const candidates = (json.candidates ?? []) as {
        content?: { parts?: { text?: string }[] };
      }[];
      const text = candidates[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string") throw new Error("gemini: no text in response");
      const usage = (json.usageMetadata ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number };
      return {
        // A malformed body must throw, not degrade to a default: the caller records this as a
        // failed step and the sweep retries it. Silently returning {} would mark the note
        // enriched with nothing attached.
        value: JSON.parse(text) as T,
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        model: CLASSIFY_MODEL,
      };
    },
  };
}
