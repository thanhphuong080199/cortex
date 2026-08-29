import { formatToday } from "@cortex/shared";
import { describe, expect, it } from "vitest";
import type { ThreadTurn } from "./context.js";
import { buildTurnPrompt } from "./prompts.js";
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

describe("buildTurnPrompt", () => {
  // NOT "hôm nay tôi chạy bộ ở công viên" -- GROUNDING_RULE (prompts.ts) uses that exact
  // sentence, verbatim, as its own worked example of something not worth searching for. A default
  // `text` equal to it would render the string twice (once as the rule's own example, once via
  // "Their message: ${text}" at the end of every prompt), so a test asserting on that string alone
  // cannot tell "GROUNDING_RULE rendered" from "the message line always renders" -- the same
  // collision turn.test.ts documents at its own NOTE fixture (search "GROUNDING_RULE" there).
  const build = (over: Partial<Parameters<typeof buildTurnPrompt>[0]> = {}) =>
    buildTurnPrompt({
      text: "buổi sáng nay mình chạy 5km ở công viên gần nhà",
      citations: [], history: [], timeZone: TZ, now: NOW, justAsked: false, ...over,
    });

  // One assertion per rule. The stack is ten rules deep and the failure mode is a later edit
  // dropping exactly one of them -- which no single "the prompt is non-empty" test can catch.
  it("carries the language rule, both clauses", () => {
    expect(build()).toMatch(/same language/i);
    expect(build()).toMatch(/do not translate/i);
  });

  it("scales depth to the question instead of capping it at a sentence count", () => {
    const p = build();
    expect(p).toMatch(/as much as it actually needs/i);
    expect(p).not.toMatch(/two or three sentences/i);
  });

  it("carries the format rule's explicit-request exception", () => {
    // The half a length-loosening edit silently drops. Asserted separately for that reason.
    expect(build()).toMatch(/liệt kê/);
    expect(build()).toMatch(/Structure is the exception/i);
  });

  it("tells the model what today is, and to anchor relative time to each note's own date", () => {
    const p = build();
    expect(p).toContain(formatToday(NOW, TZ));
    expect(p).toMatch(/KHÔNG phải từ hôm nay/);
  });

  // Task 5: temporalRule has a second, independent clause -- the trailing message itself carries
  // no createdAt of its own (it's live input, not a row), so the model must be told it is from
  // today rather than left to treat it as undated. Ported from the retired acknowledge-prompt
  // suite's "tells the acknowledge prompt the trailing note itself is from today" test: it exists
  // because deleting only this sentence from temporalRule (while keeping the note-dating half)
  // would pass the test above and still be a real regression -- FORMAT_RULE gets the same
  // two-test split for the same reason.
  it("tells the model the trailing message itself is from today, not merely undated", () => {
    expect(build({ text: "Ngày mai có hẹn đi xem spiderman" })).toMatch(/HÔM NAY/);
  });

  it("localizes from the time zone rather than defaulting to the US", () => {
    expect(build({ timeZone: "Europe/Berlin" })).toContain("Europe/Berlin");
    expect(build()).toMatch(/Đừng mặc định họ đang ở Mỹ/);
  });

  it("forbids the database-match framing and requires a dated anchor", () => {
    const p = build();
    expect(p).toMatch(/Trong các ghi chú của bạn/);
    expect(p).toMatch(/hôm 18\/8 bạn có nhắc/);
    expect(p).toMatch(/Never use a bracketed number/i);
    // The third disjunct in RECALL_RULE's "never" clause, distinct from the two Vietnamese
    // phrasings above -- a rewrite that drops only this one would pass the other two asserts.
    expect(p).toMatch(/never state that a match was found/i);
  });

  // RECALL_RULE's second load-bearing clause, independent of the database-match framing above:
  // an assistant-authored note a user chose to keep must be recalled as an earlier answer, never
  // as something the user themselves thought or wrote. Ported from the retired "forbids recalling
  // its own past words as the user's thinking" test -- that clause is a distinct sentence in
  // RECALL_RULE and a later edit could drop it while leaving the database-match framing intact.
  it("forbids recalling one of its own saved answers as something the user thought", () => {
    const p = build();
    expect(p).toMatch(/your own earlier answers/i);
    expect(p).toMatch(/say it came from an answer you gave them before/i);
  });

  it("matches what it gives back to what it got", () => {
    const p = build();
    expect(p).toMatch(/haha ok/);
    expect(p).toMatch(/A real question gets a real answer/i);
  });

  it("asks for one line of engagement on something recorded, and forbids an interview", () => {
    const p = build();
    expect(p).toMatch(/ONE brief, natural line/i);
    expect(p).toMatch(/do not turn it into an interview/i);
  });

  // §8. The permission and the prohibition are asserted separately: the prohibition is the more
  // important of the two and is the one an edit loosening the permission would take with it.
  it("permits a one-sentence correction, scoped to claims about the world", () => {
    const p = build();
    expect(p).toMatch(/STATED as a fact about the world/);
    expect(p).toMatch(/one short\s+sentence/i);
    expect(p).toMatch(/never to their own life/i);
    expect(p).toMatch(/never to something you\s+yourself said/i);
  });

  it("never lets silence read as confirmation", () => {
    const p = build();
    expect(p).toMatch(/đúng rồi/);
    expect(p).toMatch(/Silence means you had no reason to doubt them/i);
  });

  // §7. This rule is the only control on grounding spend once the gate is gone.
  //
  // The example below is GROUNDING_RULE's OWN worked example, distinct from build()'s default
  // `text` (which is deliberately a different sentence -- see the comment on `build` above) so
  // this assertion can only pass because GROUNDING_RULE rendered, not because the trailing
  // "Their message: ${text}" line happens to contain the same words.
  it("scopes when the web may be searched, and names what must never trigger one", () => {
    const p = build();
    expect(p).toMatch(/genuinely\s+need to look up/i);
    expect(p).toMatch(/hôm nay tôi chạy bộ ở công viên/);
    expect(p).toMatch(/never for small talk/i);
  });

  it("never presents web content as the user's own thinking", () => {
    expect(build()).toMatch(/Never present web content as the user's own thinking/i);
  });

  // §4. The S2 ceiling, and the only reason it survives the gate's removal.
  it("suppresses a second question when one was just asked, and only then", () => {
    expect(build({ justAsked: true })).toMatch(/Do not\s+ask another question this turn/i);
    expect(build({ justAsked: false })).not.toMatch(/Do not\s+ask another question this turn/i);
  });

  // §5.1. The prompt cannot know the domain or the tags -- classification has not settled when it
  // is built -- so it must not claim to. The `attached` receipt carries this instead.
  it("never claims to have filed anything", () => {
    const p = build();
    expect(p).not.toMatch(/You filed it under/i);
    expect(p).not.toMatch(/Mention what you attached/i);
    expect(p).not.toMatch(/did not ask a question/i);
  });

  // renderCitations has three branches and they say three different things. One test each: the
  // "failed" branch exists so the model never says "bạn không có note nào về chuyện này" on a
  // turn where the search never ran, which is a false claim rather than a hedge.
  it("does not narrate the absence when there are no notes", () => {
    const p = build({ citations: [] });
    expect(p).toMatch(/do not announce that their notes had nothing/i);
    expect(p).not.toMatch(/could not be searched/i);
  });

  // Snippet is deliberately NOT a substring of build()'s default `text` ("...chạy 5km ở công
  // viên gần nhà") -- it used to be "chạy 5km" alone, which the new default text also contains,
  // so the assertion below would have passed even if the citation never rendered.
  it("keeps the gap-filling disclaimer when notes were found", () => {
    const p = build({ citations: [cite({ snippet: "leo núi Bà Đen cuối tuần" })] });
    expect(p).toContain("leo núi Bà Đen cuối tuần");
    expect(p).toMatch(/say plainly which part is not from/i);
  });

  it("says the search failed, distinct from finding nothing", () => {
    const p = build({ citations: "failed" });
    expect(p).toMatch(/could not be searched/i);
    expect(p).not.toMatch(/no notes on this/i);
  });

  it("marks a saved answer as the assistant's own words and leaves the user's unmarked", () => {
    const p = build({
      citations: [cite({ snippet: "mine", authoredBy: "assistant" }), cite({ snippet: "theirs" })],
    });
    expect(p).toMatch(/mine \(câu trả lời của mình mà họ đã lưu\)/);
    expect(p).toMatch(/- theirs$/m);
  });

  // Ported from the retired answer-prompt suite's "renders a note's title beside its
  // snippet when it has one" -- not covered elsewhere in this suite, since every other citation
  // test here uses the default title-less `cite()`.
  it("renders a note's title beside its snippet when it has one", () => {
    const p = build({ citations: [cite({ title: "Ngủ", snippet: "7 tiếng" })] });
    expect(p).toContain("Ngủ: 7 tiếng");
  });

  // Task 5: renderCitations date-stamps each citation from `c.createdAt` when present, and this
  // suite's own `cite()` helper defaults `createdAt: null` -- so until this test, that branch had
  // zero coverage against live code. Ported from the retired "dates each cited note" test, which
  // was pinned against exactly this defect: a note written 12-08 saying "sáng mai" was reported
  // as an appointment for tomorrow, on 16-08, because nothing dated the citation it came from.
  it("dates each cited note", () => {
    const p = build({ citations: [cite({ snippet: "s", createdAt: "2026-08-12T03:00:00.000Z" })] });
    expect(p).toContain("(12-08-2026)");
  });

  // The other half of the same gap: an undated citation must render with no parenthesis at all,
  // never a dangling "()" or a literal "(null)" -- both are things the model would then reason
  // from as if they were real. Ported from the retired "renders an undated citation with no date
  // at all" test.
  it("renders an undated citation with no date at all", () => {
    const p = build({ citations: [cite({ snippet: "Ngày mai có hẹn đi xem spiderman" })] });
    expect(p).toContain("Ngày mai có hẹn");
    expect(p).not.toContain("(null)");
    expect(p).not.toContain("()");
  });

  // NOTE: corrected from the task brief's literal `/\(12 thg 8\) .../` regex, which used the
  // vi-VN short-month format daySeparatorLabel produces for UI day separators. buildTurnPrompt's
  // Step 5 code reuses the existing, unmodified `renderHistory`, which dates every turn through
  // `formatNoteDate` (dd-mm-yyyy, as citations already are) -- so the correct anchor for
  // "2026-08-12T08:00:00Z" in Asia/Ho_Chi_Minh is "(12-08-2026)", confirmed directly against
  // Intl.DateTimeFormat. See task-2-report.md for the divergence writeup.
  it("dates each turn of the conversation", () => {
    const p = build({ history: [turn("user", "mai tôi đi khám")] });
    expect(p).toMatch(/\(12-08-2026\) User: mai tôi đi khám/);
  });

  // Task 5: renderHistory labels each side differently ("User"/"You"), and no test in this suite
  // exercised an assistant-authored turn until now -- the line above only ever passes a user
  // turn. Ported from the retired answer-prompt/acknowledge-prompt suites' "renders the
  // conversation history with each side labelled" test.
  it("labels each side of the conversation, not just the user's", () => {
    const p = build({ history: [turn("user", "câu hỏi cũ"), turn("assistant", "câu trả lời cũ")] });
    expect(p).toContain("User: câu hỏi cũ");
    expect(p).toContain("You: câu trả lời cũ");
  });

  // Task 5: no test in this suite pinned the negative -- that an empty history renders no
  // heading at all, not a heading with nothing under it. Ported from the retired answer-prompt
  // suite's "adds no history section at all on the first turn" test.
  //
  // The regex is anchored on the literal heading, not on the looser phrase the original test
  // used: CORRECTION_RULE's own text ends "...never to something you yourself said earlier in
  // this conversation", which is present on every build() call and false-matches a bare
  // /earlier in this conversation/i -- caught by this test itself going red for the wrong reason
  // on the first run.
  it("adds no history section at all on the first turn", () => {
    expect(build()).not.toMatch(/Earlier in this conversation:/);
  });

  it("puts the user's message last", () => {
    expect(build({ text: "xin chào" }).trimEnd()).toMatch(/Their message: xin chào$/);
  });
});
