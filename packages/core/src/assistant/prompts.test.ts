import { describe, expect, it } from "vitest";
import type { ThreadTurn } from "./context.js";
import { buildAcknowledgePrompt, buildAnswerPrompt } from "./prompts.js";
import type { Citation } from "./retrieve.js";

const cite = (over: Partial<Citation> = {}): Citation => ({
  type: "note", noteId: "n", title: null, snippet: "s", score: 1, matchedBy: "fts", ...over,
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
    // Paired with the heading, not asserted in isolation: `toContain("[1] first")` alone
    // survives deleting "The user's own notes:", and that heading is the only thing telling the
    // model the snippets below are the user's rather than the assistant's own.
    expect(p).toContain("The user's own notes:\n[1] first\n[2] second");
  });

  it("renders a note's title beside its snippet when it has one", () => {
    const p = buildAnswerPrompt({
      question: "q",
      citations: [cite({ title: "Giấc ngủ", snippet: "ngủ 5 tiếng" })],
      history: [],
    });
    expect(p).toContain("[1] Giấc ngủ: ngủ 5 tiếng");
  });

  it("tells the model there are no matching notes, and that it may answer from general knowledge instead", () => {
    const empty = buildAnswerPrompt({ question: "q", citations: [], history: [] });
    expect(empty).toMatch(/no notes matching/i);
    expect(empty).toMatch(/general knowledge/i);
    expect(empty).toMatch(/say plainly/i);
    // The other half of the branch. Without it, inverting the ternary in the renderer only
    // shows up as a missing citation, and a prompt that tells the model there is nothing to
    // read WHILE handing it notes is the harder failure to spot in an eval.
    const withNotes = buildAnswerPrompt({
      question: "q", citations: [cite({ snippet: "first" })], history: [],
    });
    expect(withNotes).not.toMatch(/no notes matching/i);
  });

  // The third citations state, distinct from both neighbours: "failed" means retrieval never
  // completed (the RPC or the embed call threw), which is a different fact from "ran and found
  // nothing" and must not be said with the same words -- the empty-corpus line is a claim the
  // server does not get to make when it never actually looked.
  it("says the search itself failed, distinct from finding nothing and from finding notes", () => {
    const failed = buildAnswerPrompt({ question: "q", citations: "failed", history: [] });
    expect(failed).toMatch(/could not be searched/i);
    expect(failed).not.toMatch(/no notes matching/i);

    const empty = buildAnswerPrompt({ question: "q", citations: [], history: [] });
    expect(empty).not.toMatch(/could not be searched/i);

    const withNotes = buildAnswerPrompt({
      question: "q", citations: [cite({ snippet: "first" })], history: [],
    });
    expect(withNotes).not.toMatch(/could not be searched/i);
  });

  // The single most important string in the prompt, and the one nothing else asserts: every
  // other test here passes with the question line deleted.
  it("carries the question itself", () => {
    expect(buildAnswerPrompt({ question: "tôi ngủ mấy tiếng?", citations: [], history: [] }))
      .toContain("Their question: tôi ngủ mấy tiếng?");
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

  it("tells the answer prompt when it may search and what it may never claim", () => {
    const p = buildAnswerPrompt({ question: "Dune 3 khi nào?", citations: [], history: [] });
    expect(p).toMatch(/time-sensitive/i);
    expect(p).toMatch(/never present web content as the user's own/i);
  });
});

describe("buildAcknowledgePrompt", () => {
  it("carries what was attached, so the reply can name it", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay tôi chạy bộ", domain: "health", tags: ["thể dục"], related: [], history: [],
    });
    // Each value paired with the label that claims it. Asserting mere presence cannot tell the
    // two apart: swap domain and tags in the renderer and the prompt reads "You filed it under:
    // thể dục. You tagged it: health." -- the assistant naming what it attached backwards --
    // and a bare toContain("health") passes anyway.
    expect(p).toContain("You filed it under: health");
    expect(p).toContain("You tagged it: thể dục");
    // The note itself, for the same reason the question is asserted above.
    expect(p).toContain("Their note: hôm nay tôi chạy bộ");
  });

  // `${a.domain}` with no fallback renders the string "null" into the prompt, and an empty tag
  // list renders a dangling "You tagged it: ." -- both are prompts the model has to interpret.
  it("names the absence of a domain and of tags in words", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [],
    });
    expect(p).toContain("You filed it under: no domain");
    expect(p).toContain("You tagged it: nothing");
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

  it("says the search itself failed, distinct from finding nothing and from finding notes", () => {
    const failed = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: "failed", history: [],
    });
    expect(failed).toMatch(/could not be searched/i);
    expect(failed).not.toMatch(/no notes matching/i);

    const empty = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [],
    });
    expect(empty).not.toMatch(/could not be searched/i);
  });

  it("numbers the related notes the same way the answer prompt does", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [cite({ snippet: "ghi chú cũ" })], history: [],
    });
    expect(p).toContain("The user's own notes:\n[1] ghi chú cũ");
  });

  it("renders the conversation history with each side labelled", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [],
      history: [turn("user", "câu hỏi cũ"), turn("assistant", "câu trả lời cũ")],
    });
    expect(p).toContain("User: câu hỏi cũ");
    expect(p).toContain("You: câu trả lời cũ");
  });

  // The acknowledge branch is not grounded (turn.ts passes `grounding: isQuestion`), so telling
  // it about searching would describe a capability it does not have.
  it("does not tell the acknowledge prompt about searching", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay mình ngủ 5 tiếng", domain: "health", tags: [], related: [], history: [],
    });
    expect(p).not.toMatch(/search/i);
  });
});
