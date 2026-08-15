import { describe, expect, it } from "vitest";
import type { ThreadTurn } from "./context.js";
import { buildAcknowledgePrompt, buildAnswerPrompt } from "./prompts.js";
import type { Citation } from "./retrieve.js";

const cite = (over: Partial<Citation> = {}): Citation => ({
  noteId: "n", title: null, snippet: "s", score: 1, matchedBy: "fts", ...over,
});

const turn = (role: ThreadTurn["role"], content: string): ThreadTurn => ({
  role, content, createdAt: "2026-08-12T08:00:00Z",
});

describe("buildAnswerPrompt", () => {
  // Two clauses, not one. "same language" alone survives a rewrite that keeps the sentence and
  // drops the part that actually matters for this corpus: a model that answers in Vietnamese
  // but renders the user's own tag "thể dục" as "exercise" has rewritten their notes back at
  // them.
  it("tells the model to answer in the user's language and not to translate their words", () => {
    const p = buildAnswerPrompt({ question: "tôi ngủ mấy tiếng?", citations: [], history: [] });
    expect(p).toMatch(/same language/i);
    expect(p).toMatch(/do not translate/i);
  });

  // `toContain("[1]")` on its own is satisfied by the static instruction line, which contains
  // the literal "[1]" as its example -- so it passes even if no citation is rendered at all.
  // The snippet must be pinned to the number for the assertion to mean anything.
  it("numbers the citations so the answer can refer to them", () => {
    const p = buildAnswerPrompt({
      question: "q",
      citations: [cite({ noteId: "a", snippet: "first" }), cite({ noteId: "b", snippet: "second" })],
      history: [],
    });
    expect(p).toContain("[1] first");
    expect(p).toContain("[2] second");
  });

  it("renders a note's title beside its snippet when it has one", () => {
    const p = buildAnswerPrompt({
      question: "q",
      citations: [cite({ title: "Giấc ngủ", snippet: "ngủ 5 tiếng" })],
      history: [],
    });
    expect(p).toContain("[1] Giấc ngủ: ngủ 5 tiếng");
  });

  it("says plainly what to do when there is nothing to answer from", () => {
    const empty = buildAnswerPrompt({ question: "q", citations: [], history: [] });
    expect(empty).toMatch(/say so/i);
    expect(empty).toMatch(/no notes matching/i);
    // The other half of the branch. Without it, inverting the ternary in the renderer only
    // shows up as a missing citation, and a prompt that tells the model there is nothing to
    // read WHILE handing it notes is the harder failure to spot in an eval.
    const withNotes = buildAnswerPrompt({
      question: "q", citations: [cite({ snippet: "first" })], history: [],
    });
    expect(withNotes).not.toMatch(/no notes matching/i);
  });

  // The single most important string in the prompt, and the one nothing else asserts: every
  // other test here passes with the question line deleted.
  it("carries the question itself", () => {
    expect(buildAnswerPrompt({ question: "tôi ngủ mấy tiếng?", citations: [], history: [] }))
      .toContain("tôi ngủ mấy tiếng?");
  });

  // Task 5 built the rolling window; this is the only thing that proves it is rendered. The
  // roles are labelled distinctly because an unlabelled transcript reads as one voice.
  it("renders the conversation history with each side labelled", () => {
    const p = buildAnswerPrompt({
      question: "q",
      citations: [],
      history: [turn("user", "câu hỏi cũ"), turn("assistant", "câu trả lời cũ")],
    });
    expect(p).toContain("User: câu hỏi cũ");
    expect(p).toContain("You: câu trả lời cũ");
  });

  it("adds no history section at all on the first turn", () => {
    expect(buildAnswerPrompt({ question: "q", citations: [], history: [] }))
      .not.toMatch(/earlier in this conversation/i);
  });
});

describe("buildAcknowledgePrompt", () => {
  it("carries what was attached, so the reply can name it", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay tôi chạy bộ", domain: "health", tags: ["thể dục"], related: [], history: [],
    });
    expect(p).toContain("health");
    expect(p).toContain("thể dục");
    // The note itself, for the same reason the question is asserted above.
    expect(p).toContain("hôm nay tôi chạy bộ");
  });

  // `${a.domain}` with no fallback renders the string "null" into the prompt, and an empty tag
  // list renders a dangling "You tagged it: ." -- both are prompts the model has to interpret.
  it("names the absence of a domain and of tags in words", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [],
    });
    expect(p).toContain("no domain");
    expect(p).toContain("nothing");
    expect(p).not.toContain("null");
  });

  it("forbids inventing a question that was not asked", () => {
    expect(buildAcknowledgePrompt({ note: "n", domain: null, tags: [], related: [], history: [] }))
      .toMatch(/did not ask/i);
  });

  // The rule lives in a shared constant, so testing it on one builder does not test it on the
  // other: dropping the constant from this call site alone is a one-line change.
  it("carries the language rule too", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [],
    });
    expect(p).toMatch(/same language/i);
    expect(p).toMatch(/do not translate/i);
  });

  it("numbers the related notes the same way the answer prompt does", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [cite({ snippet: "ghi chú cũ" })], history: [],
    });
    expect(p).toContain("[1] ghi chú cũ");
  });

  it("renders the conversation history with each side labelled", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [],
      history: [turn("user", "câu hỏi cũ"), turn("assistant", "câu trả lời cũ")],
    });
    expect(p).toContain("User: câu hỏi cũ");
    expect(p).toContain("You: câu trả lời cũ");
  });
});
