import { describe, expect, it } from "vitest";
import { createFakeAi } from "./fake.js";
import { EMBEDDING_DIM } from "@cortex/shared";

describe("createFakeAi", () => {
  it("returns one vector of the real width per input", async () => {
    const ai = createFakeAi();
    const { vectors, model } = await ai.embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIM);
    expect(model).toBe("fake-embed");
  });

  it("is deterministic, so a test can assert on similarity", async () => {
    const ai = createFakeAi();
    const [first] = (await ai.embed(["same text"])).vectors;
    const [second] = (await ai.embed(["same text"])).vectors;
    expect(first).toEqual(second);
  });

  // The real client (gemini.ts's normalizeEmbedding) guarantees unit length and documents it as
  // something downstream code may assume. A fake that violates the guarantee lets the first
  // inner-product or raw-L2 consumer pass its whole suite and be wrong only against real
  // vectors in production -- by which point the fix is re-embedding the corpus. Cosine ranking
  // is scale-invariant, so this assertion is the ONLY thing that would catch a regression here.
  it("returns unit vectors, matching the real client's guarantee", async () => {
    const ai = createFakeAi();
    const { vectors } = await ai.embed(["alpha", "beta"]);
    for (const v of vectors) {
      expect(Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))).toBeCloseTo(1, 10);
    }
  });

  it("gives different texts different vectors", async () => {
    const ai = createFakeAi();
    const { vectors } = await ai.embed(["alpha", "beta"]);
    expect(vectors[0]).not.toEqual(vectors[1]);
  });

  it("lets a test script generateJson", async () => {
    const ai = createFakeAi({
      generateJson: async () => ({ value: { tags: ["x"] }, inputTokens: 1, outputTokens: 1, model: "fake" }),
    });
    const out = await ai.generateJson<{ tags: string[] }>({ prompt: "p", schema: {} });
    expect(out.value.tags).toEqual(["x"]);
  });

  it("throws by default on generateJson, so an unscripted call is a loud test failure", async () => {
    await expect(createFakeAi().generateJson({ prompt: "p", schema: {} })).rejects.toThrow(/not scripted/i);
  });
});
