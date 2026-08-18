import { describe, expect, it } from "vitest";
import type { ThreadTurn } from "./context.js";
import { buildAcknowledgePrompt, buildAnswerPrompt, buildChitchatPrompt } from "./prompts.js";
import type { Citation } from "./retrieve.js";

// Module-level so every pre-existing call site below can pass the now-required `timeZone`/`now`
// without each test inventing its own clock -- only the temporal-anchoring tests below care
// about the actual values.
const NOW = new Date("2026-08-16T04:00:00.000Z");
const TZ = "Asia/Ho_Chi_Minh";

const cite = (over: Partial<Citation> = {}): Citation => ({
  type: "note", noteId: "n", title: null, snippet: "s", score: 1, matchedBy: "fts",
  createdAt: null, ...over,
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
    const p = buildAnswerPrompt({
      question: "tôi ngủ mấy tiếng?", citations: [], history: [], timeZone: TZ, now: NOW,
    });
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
      history: [], timeZone: TZ, now: NOW,
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
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("[1] Giấc ngủ: ngủ 5 tiếng");
  });

  it("tells the model there are no matching notes, and that it may answer from general knowledge instead", () => {
    const empty = buildAnswerPrompt({
      question: "q", citations: [], history: [], timeZone: TZ, now: NOW,
    });
    expect(empty).toMatch(/no notes matching/i);
    expect(empty).toMatch(/general knowledge/i);
    expect(empty).toMatch(/say plainly/i);
    // The other half of the branch. Without it, inverting the ternary in the renderer only
    // shows up as a missing citation, and a prompt that tells the model there is nothing to
    // read WHILE handing it notes is the harder failure to spot in an eval.
    const withNotes = buildAnswerPrompt({
      question: "q", citations: [cite({ snippet: "first" })], history: [], timeZone: TZ, now: NOW,
    });
    expect(withNotes).not.toMatch(/no notes matching/i);
  });

  // The third citations state, distinct from both neighbours: "failed" means retrieval never
  // completed (the RPC or the embed call threw), which is a different fact from "ran and found
  // nothing" and must not be said with the same words -- the empty-corpus line is a claim the
  // server does not get to make when it never actually looked.
  it("says the search itself failed, distinct from finding nothing and from finding notes", () => {
    const failed = buildAnswerPrompt({
      question: "q", citations: "failed", history: [], timeZone: TZ, now: NOW,
    });
    expect(failed).toMatch(/could not be searched/i);
    expect(failed).not.toMatch(/no notes matching/i);

    const empty = buildAnswerPrompt({
      question: "q", citations: [], history: [], timeZone: TZ, now: NOW,
    });
    expect(empty).not.toMatch(/could not be searched/i);

    const withNotes = buildAnswerPrompt({
      question: "q", citations: [cite({ snippet: "first" })], history: [], timeZone: TZ, now: NOW,
    });
    expect(withNotes).not.toMatch(/could not be searched/i);
  });

  // The single most important string in the prompt, and the one nothing else asserts: every
  // other test here passes with the question line deleted.
  it("carries the question itself", () => {
    expect(buildAnswerPrompt({
      question: "tôi ngủ mấy tiếng?", citations: [], history: [], timeZone: TZ, now: NOW,
    })).toContain("Their question: tôi ngủ mấy tiếng?");
  });

  // Task 5 built the rolling window; this is the only thing that proves it is rendered. The
  // roles are labelled distinctly because an unlabelled transcript reads as one voice.
  it("renders the conversation history with each side labelled", () => {
    const p = buildAnswerPrompt({
      question: "q",
      citations: [],
      history: [turn("user", "câu hỏi cũ"), turn("assistant", "câu trả lời cũ")],
      timeZone: TZ, now: NOW,
    });
    expect(p).toContain("User: câu hỏi cũ");
    expect(p).toContain("You: câu trả lời cũ");
  });

  it("adds no history section at all on the first turn", () => {
    expect(buildAnswerPrompt({ question: "q", citations: [], history: [], timeZone: TZ, now: NOW }))
      .not.toMatch(/earlier in this conversation/i);
  });

  it("tells the answer prompt when it may search and what it may never claim", () => {
    const p = buildAnswerPrompt({
      question: "Dune 3 khi nào?", citations: [], history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toMatch(/time-sensitive/i);
    expect(p).toMatch(/never present web content as the user's own/i);
  });
});

describe("buildAcknowledgePrompt", () => {
  it("carries what was attached, so the reply can name it", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay tôi chạy bộ", domain: "health", tags: ["thể dục"], related: [], history: [],
      timeZone: TZ, now: NOW,
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
      note: "n", domain: null, tags: [], related: [], history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("You filed it under: no domain");
    expect(p).toContain("You tagged it: nothing");
    expect(p).not.toContain("null");
  });

  it("forbids inventing a question that was not asked", () => {
    expect(buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [], timeZone: TZ, now: NOW,
    })).toMatch(/did not ask/i);
  });

  // The rule lives in a shared constant, so testing it on one builder does not test it on the
  // other: dropping the constant from this call site alone is a one-line change.
  it("carries the language rule too", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toMatch(/same language/i);
    expect(p).toMatch(/do not translate/i);
  });

  it("says the search itself failed, distinct from finding nothing and from finding notes", () => {
    const failed = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: "failed", history: [], timeZone: TZ, now: NOW,
    });
    expect(failed).toMatch(/could not be searched/i);
    expect(failed).not.toMatch(/no notes matching/i);

    const empty = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [], timeZone: TZ, now: NOW,
    });
    expect(empty).not.toMatch(/could not be searched/i);
  });

  it("numbers the related notes the same way the answer prompt does", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [cite({ snippet: "ghi chú cũ" })], history: [],
      timeZone: TZ, now: NOW,
    });
    expect(p).toContain("The user's own notes:\n[1] ghi chú cũ");
  });

  it("renders the conversation history with each side labelled", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [],
      history: [turn("user", "câu hỏi cũ"), turn("assistant", "câu trả lời cũ")],
      timeZone: TZ, now: NOW,
    });
    expect(p).toContain("User: câu hỏi cũ");
    expect(p).toContain("You: câu trả lời cũ");
  });

  // The acknowledge branch is not grounded (turn.ts passes `grounding: isQuestion`), so telling
  // it about searching would describe a capability it does not have.
  it("does not tell the acknowledge prompt about searching", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay mình ngủ 5 tiếng", domain: "health", tags: [], related: [], history: [],
      timeZone: TZ, now: NOW,
    });
    expect(p).not.toMatch(/search/i);
  });
});

describe("buildChitchatPrompt", () => {
  const history: ThreadTurn[] = [
    { role: "user", content: "hôm nay mình chạy bộ", createdAt: "2026-08-16T10:00:00Z" },
    { role: "assistant", content: "Đã lưu vào health.", createdAt: "2026-08-16T10:00:01Z" },
  ];

  it("carries the conversation so far", () => {
    expect(buildChitchatPrompt({ text: "haha ok", history })).toContain("hôm nay mình chạy bộ");
  });

  it("keeps the language rule", () => {
    expect(buildChitchatPrompt({ text: "haha ok", history: [] }))
      .toMatch(/same language the user wrote in/i);
  });

  // The whole reason this branch exists. The acknowledge prompt says "You filed it under ..."
  // and "Mention what you attached"; applied to "haha ok" the model announces a filing nobody
  // asked for. If either phrase appears here, the third intent bought nothing.
  it("does not file, tag, or announce what it attached", () => {
    const p = buildChitchatPrompt({ text: "haha ok", history: [] });
    expect(p).not.toMatch(/filed it under/i);
    expect(p).not.toMatch(/tagged/i);
    expect(p).not.toMatch(/attached/i);
  });

  // It is not the answer branch either: there are no citations to cite and nothing was searched.
  it("does not ask for citations", () => {
    expect(buildChitchatPrompt({ text: "hello", history: [] })).not.toMatch(/\[1\]/);
  });
});

describe("the recall rule", () => {
  const args = {
    citations: [cite({ snippet: "mắt mỏi khi đọc lâu" })],
    history: [],
    timeZone: "Asia/Ho_Chi_Minh",
    now: new Date("2026-08-18T03:00:00.000Z"),
  };

  // Both branches reference the user's own past notes, and both produced the reported tone.
  // Applying the rule to only one of them fixes half the complaint.
  it("reaches both prompts that cite the user's notes", () => {
    for (const p of [
      buildAnswerPrompt({ question: "mỏi mắt ăn gì", ...args }),
      buildAcknowledgePrompt({ note: "dạo này mỏi mắt", domain: null, tags: [],
        related: args.citations, history: [], timeZone: args.timeZone, now: args.now }),
    ]) {
      expect(p).toMatch(/recall|remember|nhắc/i);
    }
  });

  // The two phrasings actually observed, named in the prompt so the model has something
  // concrete to avoid. A rule that only says "be natural" is a rule with no failure mode.
  it("names the report phrasings it is forbidding", () => {
    const p = buildAnswerPrompt({ question: "mỏi mắt ăn gì", ...args });
    expect(p).toMatch(/Đã lưu ghi chú/);
    expect(p).toMatch(/Trong các ghi chú của bạn/);
  });

  // THE HALF THAT GETS DROPPED. "Do not sound mechanical" alone reads as "stop citing", and a
  // model that stops emitting [1] takes traceability with it -- the citations are still the
  // only link between a claim and the note behind it. The rule must forbid the FRAMING and
  // require the bracket in the same breath.
  it("keeps the bracket citation while changing how it is introduced", () => {
    const p = buildAnswerPrompt({ question: "mỏi mắt ăn gì", ...args });
    expect(p).toMatch(/\[1\]/);
  });

  // Chitchat has no citations and no filing to talk about. Adding the rule there would be a
  // paragraph of instruction about a situation that cannot arise on that branch.
  it("stays off the chitchat prompt", () => {
    expect(buildChitchatPrompt({ text: "haha ok", history: [] }))
      .not.toMatch(/Trong các ghi chú của bạn/);
  });
});

const dated = (createdAt: string | null): Citation => ({
  type: "note", noteId: "n1", title: null,
  snippet: "Ngày mai có hẹn đi xem spiderman lúc 8h sáng",
  score: 1, matchedBy: "fts", createdAt,
});

describe("temporal anchoring", () => {
  it("tells the answer prompt what today is", () => {
    const p = buildAnswerPrompt({
      question: "phim gì", citations: [], history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("16-08-2026");
  });

  it("tells the acknowledge prompt what today is", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay mình chạy bộ", domain: null, tags: [], related: [],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("16-08-2026");
  });

  // THE DEFECT, PINNED. A note written on 12-08 saying "sáng mai" was reported as an
  // appointment for tomorrow, on 16-08. The date beside the snippet is what makes 13-08
  // derivable at all.
  it("dates each cited note", () => {
    const p = buildAnswerPrompt({
      question: "phim gì", citations: [dated("2026-08-12T03:00:00.000Z")],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("(12-08-2026)");
  });

  // Half the fix. The date alone still lets the model read "mai" as tomorrow -- it has to be
  // told which anchor to measure from, and told that a past moment must be reported as past.
  it("says relative time inside a note is measured from that note's date", () => {
    const p = buildAnswerPrompt({
      question: "phim gì", citations: [dated("2026-08-12T03:00:00.000Z")],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toMatch(/ngày viết|written/i);
    expect(p).toMatch(/đã qua|already past/i);
  });

  // A pre-existing citation has no date, and the prompt must simply not date it. A rendered
  // "(null)" or a today-defaulted date would be an assertion the model then reasons from.
  it("renders an undated citation with no date at all", () => {
    const p = buildAnswerPrompt({
      question: "phim gì", citations: [dated(null)], history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("Ngày mai có hẹn");
    expect(p).not.toContain("(null)");
    expect(p).not.toContain("()");
  });

  // History has carried createdAt on every turn since C1 and renderHistory has always thrown
  // it away. "Mai" said three turns ago has the same problem as "mai" written in a note.
  it("dates each turn of the conversation", () => {
    const p = buildAnswerPrompt({
      question: "thế còn gì nữa", citations: [], timeZone: TZ, now: NOW,
      history: [{ role: "user", content: "mai đi xem phim nhé", createdAt: "2026-08-12T03:00:00.000Z" }],
    });
    expect(p).toContain("12-08-2026");
  });

  // Small talk needs no clock, and buildChitchatPrompt (stage C4) takes no timeZone at all.
  // Asserted so nobody "completes" the set later: every token in that prompt is paid for on
  // every "haha ok".
  it("leaves the chitchat prompt without a date header", () => {
    expect(buildChitchatPrompt({ text: "haha ok", history: [] })).not.toContain("16-08-2026");
  });

  // THE ORIGINAL DEFECT, ONE STEP EARLIER. "Ngày mai có hẹn đi xem spiderman" is not a citation
  // read back later -- it is the fresh capture itself, in the acknowledge branch, at the moment
  // it is written. It carries no createdAt of its own (it's live input, not a row), so read
  // literally, "note không có ngày thì đừng đoán ngày cho nó" would tell the model to leave ITS
  // date ambiguous too -- which is backwards: a note the user is submitting right now is, by
  // construction, from today.
  it("tells the acknowledge prompt the trailing note itself is from today", () => {
    const p = buildAcknowledgePrompt({
      note: "Ngày mai có hẹn đi xem spiderman", domain: null, tags: [], related: [],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toMatch(/HÔM NAY/);
  });
});
