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
    const [first, second] = chunks;
    expect(first?.content).toBe(a);
    expect(second?.content).toBe(b);
  });

  it("packs several short paragraphs into one chunk", () => {
    const chunks = chunkText("one\n\ntwo\n\nthree");
    expect(chunks).toHaveLength(1);
    const [only] = chunks;
    expect(only?.content).toBe("one\n\ntwo\n\nthree");
  });

  it("splits a single oversized paragraph, because it cannot be packed whole", () => {
    // Also exercises the hard-split fallback that now sits under sentence packing: "z" repeated
    // has no ". ! ?" anywhere, so splitting on SENTENCE_BOUNDARY yields one "sentence" the same
    // length as the whole paragraph -- itself over budget, so it still falls back to the
    // fixed-offset slice this function always used before sentence packing existed.
    const chunks = chunkText("z".repeat(CHUNK_MAX_CHARS * 2 + 10));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it("packs an oversized paragraph sentence-by-sentence instead of at a fixed offset", () => {
    // One paragraph (no blank lines) of clearly delimited sentences, well over CHUNK_MAX_CHARS.
    // Every chunk but (possibly) the last should end at a sentence boundary rather than mid-word.
    const sentence = (n: number) => `This is sentence number ${n}, added to fill the budget.`;
    const prose = Array.from({ length: 90 }, (_, i) => sentence(i)).join(" ");
    expect(prose.length).toBeGreaterThan(CHUNK_MAX_CHARS * 2);

    const chunks = chunkText(prose);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    for (const c of chunks.slice(0, -1)) {
      expect(c.content.endsWith(".")).toBe(true);
    }
    // Rejoining every chunk (chunks are space-joined sentences) must reproduce the sentences
    // verbatim -- packing must not drop or duplicate a sentence at a boundary.
    expect(chunks.map((c) => c.content).join(" ")).toBe(prose);
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

  // THE RESYNCHRONISATION PROPERTY. notes.content_text (strip_markdown's output) collapses
  // every blank line to a single space, so a real note is one giant blank-line-free paragraph
  // from this function's point of view -- see embed.test.ts's "re-embeds only the changed
  // chunk" for where that was proven directly against the local stack. A length-CHANGING edit
  // (inserting a word, the common case, as opposed to a same-length substitution) shifts every
  // character after it, so a fixed-offset hard split -- what this function used to do
  // unconditionally -- turns every downstream chunk's window, and so every downstream hash.
  // Sentence-level packing resynchronises instead, because each group's packing decision
  // depends only on the sentence lengths from that group's start onward (see packUnits'
  // comment). This test pins concrete counts, not "some chunks survived": a regression that
  // silently reverts to fixed-offset packing would still produce the right final chunk *count*
  // and pass a looser assertion, while re-embedding the whole note on every edit.
  it("resynchronises after a length-changing edit: most later chunks stay byte-identical", () => {
    // Deliberately varied sentence lengths (short/medium/long, cycling) -- real prose, and the
    // reason resynchronisation happens quickly: uniform-length units would let a one-unit
    // offset persist forever (the same number of units always fills a chunk), the same failure
    // mode as the fixed-offset split this replaces.
    const templates = [
      "Short note.",
      "This sentence is a bit longer than the previous one.",
      "Here is a mid-length sentence for variety.",
      "This one is noticeably longer, adding several more words to change its length " +
        "meaningfully and give the packer something to chew on.",
      "Brief.",
      "Another sentence of medium length appears here for good measure.",
    ];
    const original = Array.from(
      { length: 150 },
      (_, i) => `Sentence ${i}: ${templates[i % templates.length]}`,
    ).join(" ");
    expect(original.length).toBeGreaterThan(9000); // "several thousand characters"

    // Insert one word at the first word boundary after position 20 -- a realistic "type a word"
    // edit near the start of the note.
    const insertAt = original.indexOf(" ", 20) + 1;
    const edited = `${original.slice(0, insertAt)}extra ${original.slice(insertAt)}`;

    const chunksOriginal = chunkText(original);
    const chunksEdited = chunkText(edited);
    expect(chunksOriginal).toHaveLength(6);
    expect(chunksEdited).toHaveLength(6);

    const sharedCount = (a: { content: string }[], b: { content: string }[]) => {
      let n = 0;
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i]?.content === b[i]?.content) n++;
      }
      return n;
    };
    // 5 of 6 chunks (all but the one the edit lands in) are byte-identical -- pinned, not
    // "greater than zero", so a regression to fixed-offset packing is caught by this exact
    // number changing.
    expect(sharedCount(chunksOriginal, chunksEdited)).toBe(5);

    // What the OLD (pre-sentence-packing) fixed-offset implementation would have produced for
    // the same input, reimplemented here standalone (not by calling chunkText) so this
    // comparison stays valid even as chunkText's internals change further.
    const hardSplitOnly = (text: string, maxChars: number): { content: string }[] => {
      const normalised = text.replace(/\r\n/g, "\n").trim();
      if (normalised === "") return [];
      const paragraphs = normalised.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== "");
      const out: string[] = [];
      let current = "";
      const flush = () => {
        if (current !== "") out.push(current);
        current = "";
      };
      for (const para of paragraphs) {
        if (para.length > maxChars) {
          flush();
          for (let i = 0; i < para.length; i += maxChars) out.push(para.slice(i, i + maxChars));
          continue;
        }
        const candidate = current === "" ? para : `${current}\n\n${para}`;
        if (candidate.length > maxChars) {
          flush();
          current = para;
        } else {
          current = candidate;
        }
      }
      flush();
      return out.map((content) => ({ content }));
    };
    const legacyOriginal = hardSplitOnly(original, CHUNK_MAX_CHARS);
    const legacyEdited = hardSplitOnly(edited, CHUNK_MAX_CHARS);
    // Zero: a one-word insertion shifts every later byte, so every later fixed-offset window
    // differs too. This is what "editing paragraph three re-embeds one, two and four" looked
    // like before sentence packing.
    expect(sharedCount(legacyOriginal, legacyEdited)).toBe(0);
  });
});
