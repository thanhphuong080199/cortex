import { EMBEDDING_DIM } from "@cortex/shared";
import type { AiClient } from "./client.js";

/** FNV-1a: a tiny, stable string hash. Only needs to be deterministic, not good. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * NO TEST MAY EVER CALL THE REAL GEMINI API. Every suite in this repo uses this fake --
 * a live call in CI would cost money, need a paid key on a runner, and make results depend on
 * a third party's uptime.
 *
 * Vectors are deterministic and text-dependent, so a test can assert that two similar inputs
 * rank above a dissimilar one without any real model.
 */
export function createFakeAi(script: Partial<AiClient> = {}): AiClient {
  return {
    embed:
      script.embed ??
      (async (texts: string[]) => {
        const vectors = texts.map((t) => {
          let s = seedOf(t);
          return Array.from({ length: EMBEDDING_DIM }, () => {
            s = (Math.imul(s, 1103515245) + 12345) >>> 0;
            return s / 0xffffffff - 0.5;
          });
        });
        return { vectors, inputTokens: texts.join(" ").length, model: "fake-embed" };
      }),
    generateJson:
      script.generateJson ??
      (async () => {
        throw new Error("createFakeAi: generateJson was called but not scripted for this test");
      }),
  };
}
