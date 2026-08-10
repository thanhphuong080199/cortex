import { describe, expect, it } from "vitest";
import { normalizeEmbedding } from "./gemini.js";

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
