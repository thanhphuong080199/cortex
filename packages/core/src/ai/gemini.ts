import { CLASSIFY_MODEL, EMBEDDING_DIM, EMBEDDING_MODEL } from "@cortex/shared";
import type { AiClient, EmbedResult, JsonResult } from "./client.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export function createGeminiAi(apiKey: string): AiClient {
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Status is carried in the message so the caller can distinguish a 429/5xx (retry) from
      // a 400 (a bug in our request, which retrying will never fix). No prompt text is
      // logged -- spec §15.6 rule 1.
      throw new Error(`gemini ${res.status}`);
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
        vectors: embeddings.map((e) => e.values),
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
