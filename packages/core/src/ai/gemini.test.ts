import { describe, expect, it } from "vitest";
import { extractVectors, normalizeEmbedding, parseModelJson } from "./gemini.js";

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
