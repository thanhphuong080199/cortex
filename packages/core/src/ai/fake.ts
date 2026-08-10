import { EMBEDDING_DIM } from "@cortex/shared";
import type { AiClient, JsonResult } from "./client.js";

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
interface FakeAiScript {
  embed?: AiClient["embed"];
  generateJson?: (args: {
    prompt: string;
    schema: Record<string, unknown>;
  }) => Promise<JsonResult<unknown>>;
}

/**
 * NO TEST MAY EVER CALL THE REAL GEMINI API. Every suite in this repo uses this fake --
 * a live call in CI would cost money, need a paid key on a runner, and make results depend on
 * a third party's uptime.
 *
 * Vectors are deterministic and text-dependent, so a test can assert that two similar inputs
 * rank above a dissimilar one without any real model.
 */
export function createFakeAi(script: FakeAiScript = {}): AiClient {
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
      (script.generateJson as AiClient["generateJson"] | undefined) ??
      (async () => {
        throw new Error("createFakeAi: generateJson was called but not scripted for this test");
      }),
  };
}
