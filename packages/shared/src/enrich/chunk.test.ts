import { describe, expect, it } from "vitest";
import { chunkText, CHUNK_MAX_CHARS } from "./chunk.js";

describe("chunkText", () => {
  it("returns nothing for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps a short note as one chunk — the common case for quick capture", () => {
    expect(chunkText("a single thought")).toEqual([{ index: 0, content: "a single thought" }]);
  });

  it("splits on blank lines rather than mid-sentence", () => {
    const a = "x".repeat(1000);
    const b = "y".repeat(1000);
    const chunks = chunkText(`${a}\n\n${b}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe(a);
    expect(chunks[1].content).toBe(b);
  });

  it("packs several short paragraphs into one chunk", () => {
    const chunks = chunkText("one\n\ntwo\n\nthree");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("one\n\ntwo\n\nthree");
  });

  it("splits a single oversized paragraph, because it cannot be packed whole", () => {
    const chunks = chunkText("z".repeat(CHUNK_MAX_CHARS * 2 + 10));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it("numbers chunks from zero without gaps — note_chunks has unique(note_id, chunk_index)", () => {
    const chunks = chunkText(Array.from({ length: 12 }, () => "p".repeat(500)).join("\n\n"));
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("is deterministic", () => {
    const text = "alpha\n\nbeta\n\n" + "g".repeat(2500);
    expect(chunkText(text)).toEqual(chunkText(text));
  });

  it("normalises CRLF, so a Windows-authored note chunks like any other", () => {
    expect(chunkText("one\r\n\r\ntwo")).toEqual(chunkText("one\n\ntwo"));
  });
});
