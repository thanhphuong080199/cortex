import { afterEach, describe, expect, it } from "vitest";
import { createGeminiAi, extractVectors, normalizeEmbedding, parseModelJson } from "./gemini.js";

// Pins the normalization math in isolation, with no fetch and no network -- gemini.ts's HTTP
// shape stays untested per the brief (a mocked-fetch test would only assert the mock), but this
// pure helper is real logic worth covering directly.
describe("normalizeEmbedding", () => {
  it("scales a vector to unit L2 norm", () => {
    const out = normalizeEmbedding([3, 4]); // 3-4-5 triangle: norm is exactly 5
    expect(out).toEqual([0.6, 0.8]);
    const norm = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("preserves direction, only rescales magnitude", () => {
    const out = normalizeEmbedding([0, 5]);
    expect(out).toEqual([0, 1]);
  });

  it("throws on a zero vector rather than emitting NaN", () => {
    expect(() => normalizeEmbedding([0, 0, 0])).toThrow(/zero vector/i);
  });
});

// Same reason normalizeEmbedding is exported: these are the parts of createGeminiAi that are
// real logic rather than HTTP plumbing, and pinning them here needs no fetch, no mock and --
// per this repo's standing rule -- no construction of a real Gemini client in a test.
describe("extractVectors", () => {
  it("normalizes every returned vector", () => {
    expect(extractVectors({ embeddings: [{ values: [3, 4] }, { values: [0, 5] }] }, 2))
      .toEqual([[0.6, 0.8], [0, 1]]);
  });

  // THE SILENT-CORPUS-WIPE GUARD.
  //
  // The old code was `(json.embeddings ?? []) as {values:number[]}[]`. When Gemini renames or
  // empties that field on a soft error, `vectors` becomes [] and embedNote's `embedding:
  // vectors[i]` is `undefined` on EVERY row -- uniformly, so JSON.stringify drops the key,
  // PostgREST accepts the batch, recordUsage bills the call, embedded_hash is stamped and the
  // sweep logs `processed=N`. Meanwhile search_notes filters on `c.embedding is not null`
  // (00022:40), so those chunks are invisible to semantic search, and the hash predicate
  // guarantees they are never re-embedded. Semantic search drops to zero with a green log. The
  // `?? []` was precisely what turned a loud failure into a silent one.
  it("throws when the response carries fewer vectors than there were inputs", () => {
    expect(() => extractVectors({ embeddings: [{ values: [1, 2] }] }, 3)).toThrow(/1(.*)3|3(.*)1/);
  });

  it("throws when the embeddings field is missing entirely", () => {
    expect(() => extractVectors({}, 1)).toThrow();
    expect(() => extractVectors({ embeddings: null }, 1)).toThrow();
  });

  // Asserts the MESSAGE, not merely that it throws: a `values`-less entry reaches
  // normalizeEmbedding as undefined and throws there too, so `.toThrow()` alone would pass
  // against the unguarded version. What the guard buys is a diagnostic that names the offending
  // index instead of a TypeError about reading a property of undefined -- and last_error is the
  // only place a production partial-response bug would ever be visible.
  it("throws, naming the offending index, when an entry carries no values array", () => {
    expect(() => extractVectors({ embeddings: [{ values: [1] }, {}] }, 2)).toThrow(/embedding 1/);
    expect(() => extractVectors({ embeddings: [{ values: [] }] }, 1)).toThrow(/embedding 0/);
  });

  // A response LONGER than the request is just as wrong, and pairing chunk i with vector i is
  // only meaningful if the two sequences correspond exactly.
  it("throws when the response carries more vectors than there were inputs", () => {
    expect(() => extractVectors({ embeddings: [{ values: [1] }, { values: [1] }] }, 1)).toThrow();
  });
});

describe("parseModelJson", () => {
  it("returns the parsed value", () => {
    expect(parseModelJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  // Spec §15.6 rule 1: no note content in a log line or an error message. V8's JSON.parse
  // SyntaxError quotes ~30 characters of the offending text verbatim, and that text is model
  // output derived from the note -- which enrich.service.ts then writes into
  // note_enrichment.last_error and prints with console.error. The parse must fail loudly and
  // say nothing about what it was parsing.
  it("does not quote the model's output in the error it throws", () => {
    const leaky = 'biopsy results came back on the 4th, malignant {';
    expect(() => parseModelJson(leaky)).toThrow();
    let thrown = "";
    try { parseModelJson(leaky); } catch (e) { thrown = String(e); }
    expect(thrown).not.toContain("biopsy");
    expect(thrown).not.toContain("malignant");
  });
});

// createGeminiAi().generateStream is real HTTP-shape logic (the SSE tail-buffer, the
// last-chunk-only usageMetadata), unlike embed/generateJson above which stay untested per the
// brief. NO TEST MAY EVER CALL THE REAL GEMINI API (packages/core/src/ai/fake.ts) -- every case
// here stubs globalThis.fetch and restores the original afterwards so a stubbed fetch never
// leaks into another test file.
describe("createGeminiAi.generateStream", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const sseBody = (parts: string[], usage: Record<string, number> | null) => {
    const lines = parts.map((t) =>
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`);
    if (usage) {
      lines.push(`data: ${JSON.stringify({
        candidates: [{ content: { parts: [] } }],
        usageMetadata: usage,
      })}\n\n`);
    }
    return lines.join("");
  };

  it("yields text chunks and captures usage from the final chunk", async () => {
    globalThis.fetch = (async () => new Response(
      sseBody(["Xin ", "chào"], { promptTokenCount: 12, candidatesTokenCount: 4 }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;

    const ai = createGeminiAi("key");
    const res = await ai.generateStream({ prompt: "p", model: "m" });
    let out = "";
    for await (const c of res.chunks) out += c.text;

    expect(out).toBe("Xin chào");
    expect(res.usage()).toEqual({ inputTokens: 12, outputTokens: 4, model: "m" });
  });

  // An abandoned answer is still billed, so whatever was counted must remain readable.
  it("reports null usage when the stream ends without usageMetadata", async () => {
    globalThis.fetch = (async () => new Response(
      sseBody(["partial"], null),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;

    const ai = createGeminiAi("key");
    const res = await ai.generateStream({ prompt: "p", model: "m" });
    for await (const chunk of res.chunks) void chunk; // drain
    expect(res.usage()).toBeNull();
  });

  it("attaches the HTTP status so a caller can tell a 429 from a 400", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 429 })) as typeof fetch;
    const ai = createGeminiAi("key");
    await expect(ai.generateStream({ prompt: "p", model: "m" }))
      .rejects.toMatchObject({ status: 429 });
  });

  // THE TAIL-BUFFER GUARD. `new Response(aWholeString)` delivers the whole SSE body in one
  // `read()`, so every test above sees complete events on the first pass and can never exercise
  // a chunk boundary landing mid-event or a stream that ends without a trailing blank line. Both
  // happen on the real network, and the second one is exactly how usageMetadata -- which only
  // ever arrives on the LAST event -- gets silently dropped if the reader loop discards its tail
  // buffer at `done`. A real ReadableStream, fed one enqueue() at a time, is required to prove it.
  it("assembles an event split across a chunk boundary and flushes a final event with no trailing blank line", async () => {
    const event1 = JSON.stringify({ candidates: [{ content: { parts: [{ text: "chunk1" }] } }] });
    const event2 = JSON.stringify({ candidates: [{ content: { parts: [{ text: "chunk2" }] } }] });
    const event3 = JSON.stringify({
      candidates: [{ content: { parts: [] } }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 },
    });

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        // event1's `data:` line arrives, but the blank line that terminates it lands in the
        // NEXT network chunk -- a chunk boundary landing mid-event.
        controller.enqueue(enc.encode(`data: ${event1}\n`));
        // Completes event1's blank line, then delivers event2 whole, with its own trailing
        // blank line.
        controller.enqueue(enc.encode(`\ndata: ${event2}\n\n`));
        // event3 -- the one carrying usageMetadata -- arrives with NO trailing blank line at
        // all; the stream just ends. Only a post-loop flush can recover it.
        controller.enqueue(enc.encode(`data: ${event3}`));
        controller.close();
      },
    });

    globalThis.fetch = (async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

    const ai = createGeminiAi("key");
    const res = await ai.generateStream({ prompt: "p", model: "m" });
    let out = "";
    for await (const c of res.chunks) out += c.text;

    expect(out).toBe("chunk1chunk2");
    expect(res.usage()).toEqual({ inputTokens: 9, outputTokens: 3, model: "m" });
  });

  // The whole justification for usage() being a function rather than a promise: a caller can
  // abandon mid-stream (break out of `for await`, no AbortSignal even involved) and still read
  // synchronously whatever was captured before it left -- not gated behind the rest of the
  // stream, which an abandoning caller may never await.
  it("keeps whatever usage was captured even when the caller abandons the stream mid-read", async () => {
    const withUsage = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "first" }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
    });
    const later = JSON.stringify({ candidates: [{ content: { parts: [{ text: "second" }] } }] });

    globalThis.fetch = (async () => new Response(
      `data: ${withUsage}\n\ndata: ${later}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;

    const ai = createGeminiAi("key");
    const res = await ai.generateStream({ prompt: "p", model: "m" });

    for await (const c of res.chunks) {
      expect(c.text).toBe("first");
      break; // abandon before "second" is ever read
    }
    expect(res.usage()).toEqual({ inputTokens: 5, outputTokens: 1, model: "m" });
  });

  // The non-streaming path (parseModelJson, above) already pins this rule; the streaming path
  // parses model-derived JSON too and must follow it identically -- spec §15.6 rule 1.
  it("does not quote the payload in the error when a stream chunk is not valid JSON", async () => {
    const payload = "{not valid json, and this text must never reach a log";
    globalThis.fetch = (async () => new Response(
      `data: ${payload}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;

    const ai = createGeminiAi("key");
    const res = await ai.generateStream({ prompt: "p", model: "m" });

    let thrown = "";
    try {
      for await (const chunk of res.chunks) void chunk; // drain
    } catch (e) {
      thrown = String(e);
    }
    expect(thrown).toContain(`(${payload.length} chars)`);
    expect(thrown).not.toContain("this text must never reach a log");
  });

  // The stubs elsewhere in this describe block ignore everything about the request except the
  // response body. This pins the request side: the streaming endpoint and its `alt=sse` query
  // param, the API key header (the only auth this client sends), and -- separately from the
  // fetch-level `AbortSignal` unit -- that a caller's signal is actually forwarded rather than
  // silently dropped, which would break abort/cancellation for a real caller with no visible
  // symptom in any other test here.
  it("requests streamGenerateContent with alt=sse, the API key header, and the caller's signal", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(sseBody(["hi"], null), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const ai = createGeminiAi("secret-key");
    const res = await ai.generateStream({ prompt: "p", model: "m", signal: controller.signal });
    for await (const chunk of res.chunks) void chunk; // drain

    expect(capturedUrl).toContain("streamGenerateContent");
    expect(capturedUrl).toContain("alt=sse");
    expect((capturedInit?.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
    expect(capturedInit?.signal).toBe(controller.signal);
  });
});
