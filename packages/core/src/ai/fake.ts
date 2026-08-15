import { EMBEDDING_DIM } from "@cortex/shared";
import type { AiClient, JsonResult } from "./client.js";
import { normalizeEmbedding } from "./gemini.js";

/** FNV-1a: a tiny, stable string hash. Only needs to be deterministic, not good. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// AiClient.generateJson is generic (`<T>(args) => Promise<JsonResult<T>>`) because each caller
// picks its own T. A test script never does -- it scripts one concrete shape per test -- and a
// concrete function is not structurally assignable to "works for every T" (TS2322: 'T' could be
// instantiated with an arbitrary type unrelated to the literal returned). So the script's
// generateJson is typed non-generically here and cast to AiClient["generateJson"] exactly once,
// at the point where it is wired into the returned client, rather than asking every test that
// scripts generateJson to write its own cast or an explicit `async <T,>()` signature.
export interface FakeAiScript {
  embed?: AiClient["embed"];
  generateJson?: (args: {
    prompt: string;
    schema: Record<string, unknown>;
  }) => Promise<JsonResult<unknown>>;
  generateStream?: AiClient["generateStream"];
}

/**
 * NO TEST MAY EVER CALL THE REAL GEMINI API. Every suite in this repo uses this fake --
 * a live call in CI would cost money, need a paid key on a runner, and make results depend on
 * a third party's uptime.
 *
 * Vectors are deterministic and text-dependent, so a test can assert that two similar inputs
 * rank above a dissimilar one without any real model.
 *
 * They are also UNIT LENGTH, via gemini.ts's own normalizeEmbedding rather than a second copy of
 * the math -- a fake that contradicts the real client's guarantee is a fake that lies. The raw
 * components below land in [-0.5, 0.5], so an un-normalized 1536-dim vector has ‖v‖ ≈ 11.3.
 * Nothing breaks TODAY: 00012 indexes with vector_cosine_ops and cosine divides out each
 * vector's own norm, so ranking is scale-invariant. But normalizeEmbedding's contract is
 * documented as something downstream code MAY assume, and every stored test vector contradicted
 * it -- so the first consumer to use inner product or raw L2 (a clustering step, a dot product
 * computed outside Postgres) would pass its entire suite against these vectors and be wrong only
 * in production, against real embeddings. Importing the real function is what keeps the two from
 * drifting apart again if the normalization ever changes.
 */
export function createFakeAi(script: FakeAiScript = {}): AiClient {
  return {
    embed:
      script.embed ??
      (async (texts: string[]) => {
        const vectors = texts.map((t) => {
          let s = seedOf(t);
          return normalizeEmbedding(
            Array.from({ length: EMBEDDING_DIM }, () => {
              s = (Math.imul(s, 1103515245) + 12345) >>> 0;
              return s / 0xffffffff - 0.5;
            }),
          );
        });
        return { vectors, inputTokens: texts.join(" ").length, model: "fake-embed" };
      }),
    generateJson:
      (script.generateJson as AiClient["generateJson"] | undefined) ??
      (async () => {
        throw new Error("createFakeAi: generateJson was called but not scripted for this test");
      }),
    generateStream:
      script.generateStream ??
      (async () => {
        throw new Error("createFakeAi: generateStream was called but not scripted for this test");
      }),
  };
}
