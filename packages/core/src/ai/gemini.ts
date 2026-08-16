import { CLASSIFY_MODEL, EMBEDDING_DIM, EMBEDDING_MODEL } from "@cortex/shared";
import type { AiClient, EmbedResult, JsonResult, StreamChunk, StreamResult, StreamUsage } from "./client.js";

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

/**
 * Turns a batchEmbedContents body into exactly `expectedCount` normalized vectors, or throws.
 *
 * The old form was `const embeddings = (json.embeddings ?? []) as { values: number[] }[]`, and
 * that `?? []` is precisely what converts a loud failure into a silent one. When Gemini renames
 * or empties `embeddings` on a soft error, `vectors` becomes `[]`; embedNote's `embedding:
 * vectors[i]` is then `undefined` on EVERY row, uniformly, so JSON.stringify drops the key from
 * all of them, PostgREST accepts the batch because the keys are uniform, recordUsage bills the
 * call, embedded_hash gets stamped, and the sweep reports processed=N. Meanwhile search_notes
 * filters on `c.embedding is not null` (00022:40), so none of those chunks can ever be found by
 * meaning -- and the hash predicate guarantees the note is never claimed again, so they are never
 * re-embedded either. Semantic search drops to zero across the whole corpus with a green log.
 *
 * Throwing instead costs one failed sweep step and a retry, which is what the pipeline's whole
 * attempts/last_error apparatus exists to absorb. It matches normalizeEmbedding's zero-vector
 * throw above and generateJson's "no text in response" below: this file's convention is that a
 * response shape the caller cannot safely relay is an error, not a default.
 *
 * Exported so a test can pin it with no fetch, no mock and -- per this repo's standing rule --
 * no construction of a real Gemini client.
 */
export function extractVectors(json: Record<string, unknown>, expectedCount: number): number[][] {
  const embeddings = json.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== expectedCount) {
    // Counts only. The request body is the note's text and must not reach a log or an error
    // message (spec §15.6 rule 1).
    throw new Error(
      `gemini: embedding API returned ${Array.isArray(embeddings) ? embeddings.length : "no"} ` +
        `embeddings for ${expectedCount} input(s)`,
    );
  }
  return embeddings.map((e, i) => {
    const values = (e as { values?: unknown } | null)?.values;
    // A `values`-less entry would reach normalizeEmbedding as undefined and throw there anyway,
    // but as a TypeError about reading a property -- which says nothing about what actually went
    // wrong. Pairing input i with output i is the entire contract of a BATCH call; naming the
    // index is what makes a partial-response bug diagnosable from note_enrichment.last_error.
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`gemini: embedding ${i} carried no values`);
    }
    return normalizeEmbedding(values as number[]);
  });
}

/**
 * JSON.parse for MODEL OUTPUT, which is derived from the user's note text.
 *
 * V8's SyntaxError quotes roughly thirty characters of the offending input verbatim
 * (`Unexpected token 'x', "...<the text>..." is not valid JSON`). enrich.service.ts writes the
 * thrown message into note_enrichment.last_error and prints it with console.error, so an
 * unwrapped parse failure puts a fragment of the note into the log -- spec §15.6 rule 1 says it
 * must not. The fix belongs here rather than in a sanitiser downstream: this is the only place
 * that knows the string being parsed is note-derived, and a downstream filter would have to
 * recognise V8's message format to strip it.
 *
 * The failure itself is not softened -- a malformed body must throw, not degrade to a default,
 * so the caller records a failed step and the sweep retries. Only the quoted text is dropped.
 */
export function parseModelJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`gemini: response was not valid JSON (${text.length} chars)`);
  }
}

/**
 * The streaming request body, as a pure function so it can be asserted without a mocked fetch
 * -- the same reason extractVectors and parseModelJson are exported. `google_search` is
 * Gemini's built-in grounding tool (life-domains spec §6.1); the model decides per turn whether
 * to use it, so declaring the tool is a permission, not an instruction.
 */
export function buildStreamBody(
  args: { prompt: string; grounding?: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = { contents: [{ parts: [{ text: args.prompt }] }] };
  // Spread-if rather than assigning undefined: `tools: undefined` survives into JSON.stringify
  // as an absent key here, but the shape a test compares against would still differ.
  if (args.grounding) body.tools = [{ google_search: {} }];
  return body;
}

/**
 * `streamGenerateContent?alt=sse` returns Server-Sent Events. Each `data:` line is a full
 * GenerateContentResponse; text arrives incrementally and `usageMetadata` arrives on the LAST
 * one. Answer generation is the largest line item in this system's spend, so dropping that
 * final object means the ledger cannot see ~75% of the money.
 */
async function openStream(
  apiKey: string,
  args: { prompt: string; model: string; signal?: AbortSignal; grounding?: boolean },
): Promise<StreamResult> {
  const res = await fetch(
    `${BASE}/models/${args.model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(buildStreamBody(args)),
      signal: args.signal,
    },
  );
  if (!res.ok) {
    // Same shape as the non-streaming path: status in the message for logs, and attached as a
    // property so a caller can branch on 429/5xx (retry) vs 400 (a bug in our request).
    throw Object.assign(new Error(`gemini ${res.status}`), { status: res.status });
  }
  if (!res.body) {
    // Distinct from the branch above: this is a 2xx with no body to read, which is not a status
    // a caller's 429/5xx-vs-400 retry logic can classify. `!res.ok || !res.body` used to fold
    // this into `throw ... gemini 200 ... { status: 200 }`, which looks retryable and is not.
    throw new Error("gemini: streaming response had no body");
  }

  let usage: StreamUsage | null = null;

  /**
   * Parses one SSE event's `data:` line and yields a chunk if it carried text, capturing
   * `usage` (the outer closure variable) if it carried usageMetadata. A plain (non-async)
   * generator so both the read loop and the post-loop flush below can delegate into it with
   * `yield*` instead of duplicating this block.
   */
  function* handleEvent(event: string): Generator<StreamChunk> {
    const line = event.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      // Never quote the payload: it is model output, and spec §15.6 rule 1 forbids user
      // content reaching a log. Length is enough to diagnose a truncation.
      throw new Error(`gemini: stream chunk was not valid JSON (${payload.length} chars)`);
    }
    const meta = obj.usageMetadata as Record<string, number> | undefined;
    if (meta) {
      usage = {
        inputTokens: meta.promptTokenCount ?? 0,
        outputTokens: meta.candidatesTokenCount ?? 0,
        model: args.model,
      };
    }
    const candidates = obj.candidates as
      | { content?: { parts?: { text?: string }[] } }[]
      | undefined;
    const text = candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (text !== "") yield { text };
  }

  async function* iterate(): AsyncIterable<StreamChunk> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Normalise CRLF to LF before splitting: some endpoints emit CRLF line endings, and a
        // split on "\n\n" alone would never match one, growing `buffer` for the rest of the
        // response and turning the whole stream into zero yielded chunks and null usage --
        // silently, since nothing here throws on that.
        buffer = buffer.replace(/\r\n/g, "\n");
        // SSE events are separated by a blank line. Hold the tail: a chunk boundary can land
        // mid-event, and parsing half a JSON object throws.
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) yield* handleEvent(event);
      }
      // The read loop only processes events already terminated by a blank line, so anything
      // still in `buffer` when the stream ends -- including a final event with no trailing
      // blank line at all -- would otherwise be silently discarded. That final event is exactly
      // the one carrying usageMetadata: answer generation is ~75% of this system's spend, so
      // this flush is what stands between an ordinary response shape and a missing ledger row.
      //
      // decoder.decode() with no argument flushes any bytes withheld for an incomplete
      // multi-byte UTF-8 sequence at the very end of the response -- concretely reachable here
      // since the corpus is Vietnamese.
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, "\n");
      for (const event of buffer.split("\n\n")) yield* handleEvent(event);
    } finally {
      // cancel(), not releaseLock(): releaseLock() only detaches this reader, leaving the
      // underlying stream (and its connection) unconsumed and open. cancel() is what actually
      // tells the server and the connection pool the request is abandoned -- the path that
      // matters here is a caller breaking out of `for await` with no AbortSignal at all.
      await reader.cancel().catch(() => {
        // A caller reading to completion has already been cancel()'d by the platform; a second
        // cancel() on an exhausted stream can reject, and that rejection must not shadow
        // whatever error (or clean return) got the generator here in the first place.
      });
    }
  }

  return { chunks: iterate(), usage: () => usage };
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
      return {
        vectors: extractVectors(json, texts.length),
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
        // enriched with nothing attached. parseModelJson does the throwing without quoting the
        // model's output back into the error -- see its comment.
        value: parseModelJson<T>(text),
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        model: CLASSIFY_MODEL,
      };
    },

    generateStream: (args) => openStream(apiKey, args),
  };
}
