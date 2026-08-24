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
  createdAt: null, authoredBy: "user", ...over,
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
    expect(p).toContain("The user's own notes:\n- first\n- second");
  });

  it("renders a note's title beside its snippet when it has one", () => {
    const p = buildAnswerPrompt({
      question: "q",
      citations: [cite({ title: "Giấc ngủ", snippet: "ngủ 5 tiếng" })],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("- Giấc ngủ: ngủ 5 tiếng");
  });

  // Reported 2026-08-22: "đa phần tình huống tôi chat với AI là không có note sẵn, cứ nghe câu
  // này suốt cũng phiền". The disclaimer was a STANDING instruction, so it fired on every turn --
  // including the majority where retrieval returned nothing and there was therefore nothing for
  // outside material to be confused WITH. It now lives in the branch where it does work.
  it("does not ask the model to disclaim anything when there are no notes at all", () => {
    const empty = buildAnswerPrompt({
      question: "q", citations: [], history: [], timeZone: TZ, now: NOW,
    });
    expect(empty).toMatch(/general knowledge/i);
    expect(empty).not.toMatch(/not from their notes/i);
    expect(empty).not.toMatch(/say plainly/i);
    // The empty branch's own text used to read "The user has no notes matching this.", which is
    // an invitation to report the absence. It must now tell the model not to.
    expect(empty).toMatch(/do not announce|no need to mention|đừng nói/i);
  });

  // THE BRANCH WHERE IT EARNS ITS PLACE. The reply mixes the user's material with outside
  // material, and in a second brain a false "bạn từng viết..." costs more than a redundant hedge.
  it("keeps the disclaimer when notes were found", () => {
    const withNotes = buildAnswerPrompt({
      question: "q", citations: [cite({ snippet: "first" })], history: [], timeZone: TZ, now: NOW,
    });
    expect(withNotes).toMatch(/not from their notes/i);
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
    // NOT NEGOTIABLE. This branch exists so the model never says "bạn không có note nào về
    // chuyện này" on a turn where the search never ran -- dropping the disclaimer here would
    // convert a technical failure into a false assertion about the user's corpus.
    expect(failed).toMatch(/not claim they have no notes/i);

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

  // Reported 2026-08-24: a web-grounded answer defaulted to US context (prices, availability)
  // for a user who never said they were in the US -- because nothing in the prompt gave the
  // model any location signal at all. The resolved IANA zone is already computed for the
  // temporal rule; this is what turns it into a location signal too, rather than leaving the
  // model to answer around a blank.
  it("tells the model to localize using the time zone rather than default to the US", () => {
    const p = buildAnswerPrompt({
      question: "giá vé xem phim bao nhiêu", citations: [], history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain(TZ);
    expect(p).toMatch(/đừng mặc định.*Mỹ/i);
  });

  // A different zone must produce a different signal -- pinning only the Vietnam case would
  // pass even if the rule hardcoded "Asia/Ho_Chi_Minh" instead of reading the parameter.
  it("uses whatever time zone it is given, not a hardcoded one", () => {
    const p = buildAnswerPrompt({
      question: "q", citations: [], history: [], timeZone: "Europe/Berlin", now: NOW,
    });
    expect(p).toContain("Europe/Berlin");
    expect(p).not.toContain(TZ);
  });
});

describe("buildAcknowledgePrompt", () => {
  it("carries what was attached, so the reply can name it", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay tôi chạy bộ", domain: "health", tags: ["thể dục"], related: [], history: [],
      timeZone: TZ, now: NOW, verify: false,
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
      note: "n", domain: null, tags: [], related: [], history: [], timeZone: TZ, now: NOW, verify: false,
    });
    expect(p).toContain("You filed it under: no domain");
    expect(p).toContain("You tagged it: nothing");
    expect(p).not.toContain("null");
  });

  it("forbids inventing a question that was not asked", () => {
    expect(buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [], timeZone: TZ, now: NOW, verify: false,
    })).toMatch(/did not ask/i);
  });

  // The rule lives in a shared constant, so testing it on one builder does not test it on the
  // other: dropping the constant from this call site alone is a one-line change.
  it("carries the language rule too", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [], timeZone: TZ, now: NOW, verify: false,
    });
    expect(p).toMatch(/same language/i);
    expect(p).toMatch(/do not translate/i);
  });

  it("says the search itself failed, distinct from finding nothing and from finding notes", () => {
    const failed = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: "failed", history: [], timeZone: TZ, now: NOW,
      verify: false,
    });
    expect(failed).toMatch(/could not be searched/i);
    expect(failed).not.toMatch(/no notes matching/i);

    const empty = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [], timeZone: TZ, now: NOW, verify: false,
    });
    expect(empty).not.toMatch(/could not be searched/i);
  });

  it("numbers the related notes the same way the answer prompt does", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [cite({ snippet: "ghi chú cũ" })], history: [],
      timeZone: TZ, now: NOW, verify: false,
    });
    expect(p).toContain("The user's own notes:\n- ghi chú cũ");
  });

  it("renders the conversation history with each side labelled", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [],
      history: [turn("user", "câu hỏi cũ"), turn("assistant", "câu trả lời cũ")],
      timeZone: TZ, now: NOW, verify: false,
    });
    expect(p).toContain("User: câu hỏi cũ");
    expect(p).toContain("You: câu trả lời cũ");
  });

  // The acknowledge branch is not grounded (turn.ts passes `grounding: isQuestion`), so telling
  // it about searching would describe a capability it does not have.
  it("does not tell the acknowledge prompt about searching", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay mình ngủ 5 tiếng", domain: "health", tags: [], related: [], history: [],
      timeZone: TZ, now: NOW, verify: false,
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
        related: args.citations, history: [], timeZone: args.timeZone, now: args.now,
        verify: false }),
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

  // The bracket is gone from ALL FOUR sites, which is why this asserts on the built prompt rather
  // than on any one instruction line. Removing three of the four leaves the model still modelling
  // brackets off renderCitations' numbering, and every per-site assertion would still be green.
  it("emits no bracket citation anywhere in the answer prompt", () => {
    const p = buildAnswerPrompt({
      question: "q",
      citations: [cite({ snippet: "first" }), cite({ snippet: "second" })],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).not.toMatch(/\[\d/);
  });

  it("emits no bracket citation anywhere in the acknowledge prompt", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [cite({ snippet: "ghi chú cũ" })],
      history: [], timeZone: TZ, now: NOW, verify: false,
    });
    expect(p).not.toMatch(/\[\d/);
  });

  // What REPLACES the bracket, and the reason it is a date: a wrong `[2]` is invisible to every
  // party including the user, because nothing reads it back. A wrong date is visible immediately.
  // Both prompts, because RECALL_RULE is on both.
  it("tells the model to anchor a recall to when the note was written", () => {
    const p = buildAnswerPrompt({
      question: "q", citations: [cite({ snippet: "s", createdAt: "2026-08-18T02:00:00Z" })],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toMatch(/ngày|khi nào|when they wrote/i);
    expect(p).toMatch(/do not invent|đừng đoán|no anchor/i);
  });

  // THE HALF THAT MUST SURVIVE. RECALL_RULE's first clause forbids the database-match framing
  // the user complained about in the first place; an edit that removes the bracket and takes
  // this with it re-opens a bug that was already closed.
  it("still forbids reporting a database match", () => {
    const p = buildAnswerPrompt({
      question: "q", citations: [cite({ snippet: "s" })], history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("Trong các ghi chú của bạn");
    expect(p).toMatch(/never state that a match was found/i);
  });

  // Chitchat has no citations and no filing to talk about. Adding the rule there would be a
  // paragraph of instruction about a situation that cannot arise on that branch.
  it("stays off the chitchat prompt", () => {
    expect(buildChitchatPrompt({ text: "haha ok", history: [] }))
      .not.toMatch(/Trong các ghi chú của bạn/);
  });
});

describe("a saved answer is labelled as the assistant's own words", () => {
  // enums.ts has promised this since 00020 -- 'assistant' notes are "cited as something you
  // saved, never as your own thinking" -- and until now there was no mechanism, because
  // search_notes read source_type for the 0.8 down-weight and did not return it.
  //
  // The user's corpus holds approximately zero 'assistant' notes (saving one has required the
  // automatic offer to fire, which is gated on a web-grounded answer), so this MUST be seeded.
  // A test reading real data would assert nothing.
  it("marks a saved answer as the assistant's own words, and leaves the user's notes unmarked", () => {
    const p = buildAnswerPrompt({
      question: "q",
      citations: [
        cite({ snippet: "tôi ngủ 5 tiếng", authoredBy: "user" }),
        cite({ snippet: "omega-3 tốt cho mắt", authoredBy: "assistant" }),
      ],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("- omega-3 tốt cho mắt (câu trả lời của mình mà họ đã lưu)");
    // The negative half: a label on every row would satisfy the assertion above and destroy the
    // distinction the row exists to draw.
    expect(p).toContain("- tôi ngủ 5 tiếng\n");
  });

  it("forbids recalling its own past words as the user's thinking", () => {
    const p = buildAnswerPrompt({
      question: "q", citations: [cite({ snippet: "s", authoredBy: "assistant" })],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toMatch(/your own (earlier )?(answer|words)/i);
    expect(p).toMatch(/not.*something they thought|never as their own/i);
  });
});

const dated = (createdAt: string | null): Citation => ({
  type: "note", noteId: "n1", title: null,
  snippet: "Ngày mai có hẹn đi xem spiderman lúc 8h sáng",
  score: 1, matchedBy: "fts", createdAt, authoredBy: "user",
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
      history: [], timeZone: TZ, now: NOW, verify: false,
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
      history: [], timeZone: TZ, now: NOW, verify: false,
    });
    expect(p).toMatch(/HÔM NAY/);
  });
});

describe("FORMAT_RULE", () => {
  const answer = () => buildAnswerPrompt({
    question: "mỏi mắt ăn gì", citations: [], history: [],
    timeZone: "Asia/Ho_Chi_Minh", now: new Date("2026-08-18T03:00:00.000Z"),
  });

  // The defect this replaces: FORMAT_RULE bound LENGTH to STRUCTURE (short<->prose,
  // long<->headings), so the missing cell was LONG PROSE -- a substantive question that deserves
  // depth and is not a list. With no cell for it, such a question fell into the casual branch and
  // was capped at "two or three sentences". The fixed number compounded it: a model latches onto
  // a number before it latches onto the word "casual". Reported by the user on 2026-08-22.
  it("scales depth to the question instead of capping it at a sentence count", () => {
    expect(answer()).toMatch(/conversational|prose/i);
    // The number is the thing that had to go. Any digit-plus-"sentence" phrasing reintroduces it.
    expect(answer()).not.toMatch(/(two|three|\d)\s+(or\s+\w+\s+)?sentences/i);
  });

  // THE HALF THAT GETS DROPPED, and the reason this is two assertions rather than one. A
  // blanket "keep it short, no lists" degrades the turn that explicitly ASKED to enumerate --
  // the omega-3 screenshot -- so the exception lives in the same constant as the default and
  // must be greppable. Delete the exception clause and this goes red while the assertion above
  // stays green, which is precisely the failure being guarded.
  it("carries the explicit-request exception", () => {
    expect(answer()).toContain("liệt kê");
    expect(answer()).toMatch(/only when|exception/i);
  });

  // Both other prompts were capped by a COUNT too, and the user's complaint was about replies in
  // general. Each is loosened inside its own sentence rather than by extending FORMAT_RULE to
  // cover it -- a second, differently worded length rule gives the model two constraints to
  // reconcile where it currently has one.
  it("drops the sentence count from the acknowledge and chitchat prompts", () => {
    const ack = buildAcknowledgePrompt({
      note: "dạo này mỏi mắt", domain: null, tags: [], related: [], history: [],
      timeZone: TZ, now: NOW, verify: false,
    });
    expect(ack).not.toMatch(/one or two sentences/i);
    expect(buildChitchatPrompt({ text: "haha ok", history: [] })).not.toMatch(/one short, natural line/i);
  });

  // The PURPOSE clause is what each of them keeps. Dropping the count must not turn an
  // acknowledgement into an answer or chitchat into an essay.
  it("keeps each prompt's purpose clause after the count is dropped", () => {
    const ack = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [],
      timeZone: TZ, now: NOW, verify: false,
    });
    expect(ack).toMatch(/did not ask a question/i);
    expect(ack).toMatch(/acknowledge/i);
    expect(buildChitchatPrompt({ text: "haha ok", history: [] }))
      .toMatch(/do not ask a follow-up|do not start a topic/i);
  });

  // SCOPING. The natural mistake with a good rule is to apply it everywhere. Both other
  // prompts already cap their own length -- "one or two sentences" and "one short, natural
  // line" -- and a second, differently worded rule gives the model two constraints to
  // reconcile where it currently has one.
  it("stays off the acknowledge and chitchat prompts", () => {
    const ack = buildAcknowledgePrompt({
      note: "dạo này mỏi mắt", domain: null, tags: [], related: [], history: [],
      timeZone: "Asia/Ho_Chi_Minh", now: new Date("2026-08-18T03:00:00.000Z"), verify: false,
    });
    expect(ack).not.toContain("liệt kê");
    expect(buildChitchatPrompt({ text: "haha ok", history: [] })).not.toContain("liệt kê");
  });
});

describe("the verification exception", () => {
  const base = {
    note: "omega-3 chữa được cận thị", domain: null, tags: [], related: [], history: [],
    timeZone: "Asia/Ho_Chi_Minh", now: new Date("2026-08-18T03:00:00.000Z"),
  };
  const plain = () => buildAcknowledgePrompt({ ...base, verify: false });
  const checking = () => buildAcknowledgePrompt({ ...base, verify: true });

  // The prohibition SURVIVES on the ordinary path. It is what stops every acknowledgement
  // becoming a conversation, and deleting it to make room for the exception is the obvious
  // wrong move.
  it("keeps the no-question rule on an ordinary statement", () => {
    expect(plain()).toMatch(/did not ask a question/i);
  });

  // AND on the verifying path. The exception is one named carve-out, not a licence to
  // converse: the model may note a discrepancy, not open a dialogue about it.
  it("keeps the no-question rule while verifying", () => {
    expect(checking()).toMatch(/did not ask a question/i);
    expect(checking()).toMatch(/do not ask|no follow-up|without asking/i);
  });

  it("permits one brief correction only when verifying", () => {
    expect(checking()).toMatch(/wrong|incorrect|discrepancy|sai/i);
    expect(plain()).not.toMatch(/discrepancy/i);
  });

  // THE ASYMMETRIC ONE. The model looked only at the claim it flagged, and the user cannot
  // tell which claims those were -- so "đúng rồi" on an unchecked sentence is the system
  // asserting a verification it never performed. Silence has to mean "no basis to doubt",
  // never "confirmed".
  it("forbids implying a claim was checked and found correct", () => {
    const p = checking();
    expect(p).toMatch(/đúng rồi/);
    expect(p).toMatch(/chính xác/);
    expect(p).toMatch(/xác nhận/);
    expect(p).toMatch(/silence|not confirm/i);
  });

  // Scoping: an ordinary statement must not carry a paragraph about verification it will never
  // do. That is instruction the model has to interpret on every capture in the corpus.
  it("stays out of an ordinary acknowledgement entirely", () => {
    expect(plain()).not.toMatch(/silence/i);
    expect(plain()).not.toMatch(/đúng rồi/);
  });
});

describe("Stage S2 follow-up rule", () => {
  it("asks for the missing thing, once, when given something to ask about", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay tôi mới đi xem phim", domain: "media", tags: [], related: [], history: [],
      timeZone: TZ, now: NOW, verify: false, askAbout: "which film, series or book it was",
    });
    expect(p).toContain("which film, series or book it was");
    expect(p).toMatch(/ONE short/);
    expect(p).toMatch(/do not ask two things/i);
  });

  it("carries no follow-up rule at all when there is nothing to ask about", () => {
    const p = buildAcknowledgePrompt({
      note: "n", domain: null, tags: [], related: [], history: [], timeZone: TZ, now: NOW,
      verify: false,
    });
    expect(p).not.toMatch(/ONE short/);
  });

  // THE EXCLUSION. VERIFY_RULE says "do not ask a follow-up"; the S2 rule says to ask one.
  // Rendering both puts two contradictory instructions in one prompt and the model will
  // sometimes obey the wrong one -- so correcting a false claim wins and the question is dropped.
  //
  // This test MUST pass both flags. Asserting on a verify-only call would pass for the wrong
  // reason: there is no askAbout in that call, so of course no rule appears.
  it("drops the follow-up when it would collide with the verification rule", () => {
    const p = buildAcknowledgePrompt({
      note: "omega-3 chữa được cận thị", domain: "media", tags: [], related: [], history: [],
      timeZone: TZ, now: NOW, verify: true, askAbout: "which film, series or book it was",
    });
    expect(p).toMatch(/do not ask a follow-up/i);   // VERIFY_RULE is present
    expect(p).not.toMatch(/ONE short/);              // and the S2 rule is not
    expect(p).not.toContain("which film, series or book it was");
  });
});
