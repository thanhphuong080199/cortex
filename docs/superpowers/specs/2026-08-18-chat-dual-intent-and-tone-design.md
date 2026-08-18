# Chat: answer-while-filing, human tone, and dropping the notes provenance box

Status: all four items approved by user, not yet implemented. Item 4 was brainstormed on
2026-08-18 and its design is now §4 below (it was a bare requirement when this doc was first
written). Implemented together with stage C5 in one plan, items 1-4 first so they can merge
ahead of C5's larger surface.

## Problem

User testing on the current `main` branch (post stage-C4 chitchat merge) surfaced four issues
in the chat turn:

1. A message that is both note-worthy AND a question (e.g. "Các loại thực phẩm nào tốt cho mắt,
   dạo này hơi mỏi mắt" — "What foods are good for the eyes, my eyes have been tired lately")
   gets classified as `intent: "statement"`. `buildAcknowledgePrompt` (prompts.ts) explicitly
   instructs the model *"The user did not ask a question. Do not answer one, and do not invent
   one to answer."* — so the user's actual question is silently dropped. The note is still
   saved, but the user gets no answer until they repeat the question as a separate message.
2. Replies that reference the user's own past notes read as mechanical/system-generated —
   e.g. "Đã lưu ghi chú của bạn vào mục không phân loại... nó hoàn toàn trùng khớp với ghi chú
   trước đó của bạn [1]" or "Trong các ghi chú của bạn [1, 3] có nhắc đến việc bạn đang thắc
   mắc...". The user wants this to read like a person recalling something you told them, not a
   database match report.
3. `apps/web/src/app/provenance.tsx` renders a `TỪ NOTES CỦA BẠN` box under every reply,
   bullet-listing every matched note verbatim. Since a matched note is usually just the user's
   own chat message echoed back, this box is redundant and the user wants it gone.
4. Replies default to heavy markdown — bold headers, numbered sections, bullet lists — regardless
   of how small the question is. Both screenshots show this: a short, casual "mỏi mắt ăn gì"-style
   question gets back a structured multi-section writeup with bolded category headers, the same
   shape as a query that explicitly asked to "list out" foods. Compared to how ChatGPT/Gemini/
   Claude's own chat surfaces read, this is a second, independent driver of the "feels robotic"
   complaint beyond the citation phrasing in item 2 — it's about default reply *shape*, not
   wording.

## Current architecture (as of this commit)

- **Classification**: `packages/core/src/enrich/extract.ts`. `extractNote()` calls the
  classifier LLM once per turn and returns a single `intent: "question" | "statement" |
  "chitchat"` (the `INTENTS` const, line 18). The prompt (`buildPrompt`, line 97) frames these
  as mutually exclusive: *"question — they want an answer... statement — anything else:
  something they are recording."* Domain/tags/mood extraction happens unconditionally and does
  not depend on `intent`; only the reply branch does.
- **Note saving is unconditional and independent of intent.** The note row is created
  client-side (via PowerSync sync) before the assistant is ever called; `intent` never gates
  whether a note is saved, only which reply prompt runs and how it's tagged afterward
  (`source_type`). Even `chitchat` turns are saved as notes, tagged `source_type: "chitchat"`,
  and excluded only from `search_notes` (`apps/api/test/search.e2e.test.ts:114-127`).
- **Routing**: `packages/core/src/assistant/turn.ts:258-290`.
  ```ts
  const isQuestion = extracted?.intent === "question";
  const isChitchat = extracted?.intent === "chitchat";
  if (isQuestion || isChitchat) {
    await userDb.from("notes").update({ source_type: isQuestion ? "chat" : "chitchat" }).eq("id", args.noteId);
  }
  const prompt = isQuestion
    ? buildAnswerPrompt({ question: text, citations: citationsForPrompt, history })
    : isChitchat
      ? buildChitchatPrompt({ text, history })
      : buildAcknowledgePrompt({ note: text, domain: ..., tags: ..., related: citationsForPrompt, history });
  const model = isQuestion ? ANSWER_MODEL : CLASSIFY_MODEL;
  ...
  grounding: isQuestion, // web search only runs for the question branch
  ```
  `isQuestion` is a single hard gate controlling four things at once: which prompt runs, the
  `source_type` stamped on the note, which model answers (`ANSWER_MODEL` vs the cheaper
  `CLASSIFY_MODEL`), and whether Google Search grounding is enabled. This is why the eye-fatigue
  example gets no answer: it isn't classified `"question"`, so none of the four fire.
- **Prompts**: `packages/core/src/assistant/prompts.ts`.
  - `buildAnswerPrompt` (line 42) has no filing/saving language at all — it only answers.
  - `buildAcknowledgePrompt` (line 72) tells the model to acknowledge the save in 1-2 sentences,
    say what domain/tags were attached, and cite genuinely related past notes with `[1]`. It does
    not forbid mechanical phrasing; the robotic tone in the screenshots is the model's own
    unconstrained style choice, not a hardcoded template.
  - `renderCitations` (line 25) feeds the model raw note snippets as context (`"The user's own
    notes:\n[1] ..."`) — this is separate from and invisible to the `TỪ NOTES CỦA BẠN` UI box;
    the model is expected to weave `[1]`-style citations into its own prose.
- **UI box**: `apps/web/src/app/provenance.tsx`. The `Provenance` component renders two
  independent sections: a notes list (`notes.length > 0`, lines 34-41 — the one being removed)
  and a web-sources list (`web.length > 0`, lines 43-65). The web section additionally renders
  Google's Search Suggestions entry point HTML (`dangerouslySetInnerHTML`) when grounding ran —
  the code comment cites this as a **Google grounding terms-of-service requirement** (life-domains
  spec §6.2), not a design choice. `Provenance` is used identically for the live streaming turn
  and for turns replayed from `chat_messages.citations` (`apps/web/src/app/assistant-box.tsx:309,
  332-335`) — one component so a turn renders the same after reload as it did live.

## Design

### 1. Answer while filing (routing fix)

Add one new boolean to the classifier's output, scoped narrowly to the one case that's broken —
do not redesign the three-way `intent` enum, which still correctly drives chitchat exclusion and
filing tone.

**`packages/core/src/enrich/extract.ts`**:
- Add `alsoWantsAnswer?: boolean` to `Extraction` and to `RESPONSE_SCHEMA` (not required — same
  "request, not a guarantee" treatment `intent`/`complexity` already get, defaulted to `false` if
  absent/invalid).
- In `buildPrompt`'s intent rules, add: when `intent` would be `"statement"` but the turn *also*
  contains a question the user wants answered (the eye-fatigue example is exactly this — a fact
  to record AND a question in the same sentence), set `alsoWantsAnswer: true`. Keep `intent`
  itself `"statement"` in that case — it still correctly drives tagging/domain/filing tone.
- In `extractNote`'s return value, add `alsoWantsAnswer: value.alsoWantsAnswer === true` next to
  the existing defaulted `intent`/`complexity` fields.

**`packages/core/src/assistant/turn.ts`**: replace the single `isQuestion` gate with a derived
`wantsAnswer`:
```ts
const wantsAnswer = extracted?.intent === "question"
  || (extracted?.intent === "statement" && extracted?.alsoWantsAnswer === true);
const isChitchat = extracted?.intent === "chitchat";
if (wantsAnswer || isChitchat) {
  await userDb.from("notes")
    .update({ source_type: wantsAnswer ? "chat" : "chitchat" })
    .eq("id", args.noteId);
}
const prompt = wantsAnswer
  ? buildAnswerPrompt({ question: text, citations: citationsForPrompt, history })
  : isChitchat
    ? buildChitchatPrompt({ text, history })
    : buildAcknowledgePrompt({ ... });
const model = wantsAnswer ? ANSWER_MODEL : CLASSIFY_MODEL;
...
grounding: wantsAnswer,
```
Every other use of `isQuestion` downstream in `turn.ts` (mark logging, grounding gate) switches
to `wantsAnswer` the same way. `text` passed to `buildAnswerPrompt` is the full turn content in
both cases (pure question or statement-with-embedded-question) — no special-casing needed there.

Confirmed by the user: when `wantsAnswer` is true via the `alsoWantsAnswer` path (not a pure
question), the reply must **not** announce that a note was saved — just answer, the way
`buildAnswerPrompt` already behaves for pure questions. No prompt change needed for this part;
it falls out of routing straight to `buildAnswerPrompt`, which has no filing language.

#### 1.1 Precedence against stage C5's `checkable_claim`

`alsoWantsAnswer` and C5 §9's `checkable_claim` (`2026-08-16-stage-c4-c5-conversation-design.md`)
are two booleans doing the same mechanical thing: each promotes a `statement` off `CLASSIFY_MODEL`
onto `ANSWER_MODEL` with grounding enabled. They route to **different prompts** —
`alsoWantsAnswer` to `buildAnswerPrompt`, `checkable_claim` to `buildAcknowledgePrompt` with C5's
one-correction exception — and neither spec said what happens when both fire.

They do fire together, routinely: *"Omega-3 chữa được cận thị, có đúng không?"* is a recordable
statement, a question, and a false claim in one sentence.

**Decided (user, 2026-08-18): `alsoWantsAnswer` wins.** If the user asked something, they get an
answer; being corrected instead of answered is the same silent-drop this whole document exists to
fix, arriving through a different branch. `buildAnswerPrompt` takes one added clause so the
correction is not lost with the branch — say briefly when something the user stated is wrong,
inside the answer, without turning the reply into a verification notice.

`checkable_claim` therefore only reaches C5's acknowledge-with-verification branch when
`alsoWantsAnswer` is false — a statement carrying a doubtful claim and **no** question. C5 §9's
"silence is not confirmation" rule is unaffected and still belongs on that branch.

The routing gate becomes, in order: `wantsAnswer` → `chitchat` → `checkable_claim` → plain
acknowledge. Written as an ordered chain rather than independent booleans, because two booleans
that can both be true and are read in separate `if`s is how this collision got created.

### 2. Conversational tone for notes references

Applies to `buildAcknowledgePrompt` (the pure-statement path, no embedded question) and to
`buildAnswerPrompt`'s citation-referencing instruction. Add explicit style guidance to both,
replacing the current bare "cite them like [1]" instruction:

- Forbid mechanical/report phrasing — no "Đã lưu ghi chú của bạn vào mục...", no "Trong các ghi
  chú của bạn [1, 3] có nhắc đến việc...", no restating that a match was found.
- Instruct the model to bring up a related past note the way a person would recall a prior
  conversation ("bạn có nhắc chuyện này rồi" / "lần trước bạn có hỏi..."), inline in prose, still
  carrying the `[1]`-style bracket citation for traceability — just not framed as a system
  notice.
- `buildAcknowledgePrompt`'s "Mention what you attached, briefly" instruction (domain/tags) stays
  — the tone fix is about *phrasing*, not about removing the filing-confirmation content itself
  for the pure-statement (no question) case.

`buildChitchatPrompt` is unaffected — it has no filing/citation language to begin with.

### 3. Drop the notes provenance box

**`apps/web/src/app/provenance.tsx`**: delete the `notes.length > 0 && (...)` block (lines
34-41, the `TỪ NOTES CỦA BẠN` section) only. **Keep the `web.length > 0` block (lines 43-65)
intact**, including the `dangerouslySetInnerHTML` entry-point widget — that section exists to
satisfy Google's grounding terms of service, not user preference, and removing it is out of
scope for this change regardless of how it looks.

No changes needed to `assistant-box.tsx`'s call sites (`<Provenance citations={...} />` for both
live and replayed turns) — they keep passing the same citations array; `Provenance` itself simply
stops rendering the notes half of it. The `citations` SSE event / `chat_messages.citations`
column keep flowing unchanged; they still feed `buildAnswerPrompt`'s/`buildAcknowledgePrompt`'s
`renderCitations` server-side, which is unrelated to this UI box.

### 4. Format/length calibration

**Requirement**: the default reply shape should scale to the weight of the turn, the way
ChatGPT/Gemini/Claude's own chat surfaces do. A short, casual question should get a short,
conversational answer — not an automatic bold-header-plus-bullet-list writeup. Structure
(headers, numbered lists) should be reserved for turns that actually call for it.

#### 4.1 A finding that reframed this item: nothing renders markdown today

`apps/web/src/app/globals.css:200` is `.bubble p { margin: 0; white-space: pre-wrap; }`, and
`apps/web/src/app/assistant-box.tsx` renders the answer as `<p className="answer">{t.content}</p>`.
There is no `react-markdown`, no `dangerouslySetInnerHTML` on the answer, no markdown pipeline
of any kind. Mobile is the same, more so: `apps/mobile/src/screens/assistant-box.tsx:211` is
`<Text testID="box-answer">{answer}</Text>`.

So the `**Cá hồi**` in the original screenshot is reaching the user **as two literal asterisks**.
The complaint that started this item was framed as tone; underneath it, half of what was on
screen was broken output.

This ruled out the first instinct — a prompt rule forbidding markdown outright. Markdown
rendering is wanted on both clients regardless (user, 2026-08-18), and a "never emit markdown"
rule would have to be written and then unwritten. **Rendering lands first, and the format rule is
written once against the finished rendering behaviour.**

#### 4.2 Markdown rendering

**Web — `react-markdown@10.1.0` + `remark-gfm@4.0.1`.** Peer `react >=18`, so React 19 is fine.
Two call sites: the replayed-turn branch and the live streaming bubble. The library is the easy
part; three things around it are not:

- `.bubble p { white-space: pre-wrap }` must stop applying to markdown-generated paragraphs, or
  every newline renders twice — once by the markdown block structure and once by `pre-wrap`.
- Links in the output are URLs **the model chose**, not ones we vetted. They need
  `rel="noopener noreferrer"`, the same standard `provenance.tsx:55` already applies to web
  sources for exactly this reason.
- `assistant-box.test.tsx` asserts on rendered text. react-markdown splits text across elements,
  so whole-string `getByText` queries break — a test failure caused by the renderer, not by a
  regression, and worth expecting rather than debugging.

Streaming renders partial markdown: `**Cá h` shows as literal characters until the closing `**`
arrives, then snaps to bold. Accepted — it is a brief visual artifact, and the alternative
(buffering the answer until the stream ends) trades it for the loss of streaming entirely.

**Mobile — a spike before a task.** The original `react-native-markdown-display` has not been
published since 2023-12-11. The maintained fork `@ronradtke/react-native-markdown-display@9.0.3`
was last published 2026-06-29. Its peer range (`react-native >=0.50.4`, `react >=16.2.0`) is
permissive enough to install cleanly, which proves npm will not object — **not** that it runs on
this app's RN 0.86 / React 19.2 / Expo 57. That gets verified in a dev client before any plan
task depends on it. If it fails, mobile keeps plain text and web keeps markdown; the format rule
in §4.3 is correct either way, because it never mentions markdown syntax.

Mobile's surface is one string: C4 left the transcript off mobile, so `box-answer` is the only
place an answer is rendered.

#### 4.3 The rule

A module-level `FORMAT_RULE` in `prompts.ts`, beside `LANGUAGE_RULE`:

```ts
const FORMAT_RULE =
  "Match the shape of the reply to the weight of the question. A short, casual question " +
  "gets a short, conversational answer -- two or three sentences of prose, no headings and " +
  "no list. Reach for headings or a numbered list only when the user actually asked to " +
  "enumerate or compare (\"liệt kê\", \"các bước\", \"so sánh\", \"list out\"), or when the " +
  "answer genuinely is a set of parallel items that prose would obscure. Structure is the " +
  "exception, not the default shape of an answer.";
```

Both halves are load-bearing and the second one is the one that gets dropped. The trade-off
raised when this item was first written stands: a bare "keep it short, avoid markdown" cap
degrades the turn that *did* ask for a list (the omega-3 example). The exception is therefore
written into the same constant as the default, not left to the model's judgment.

**`buildAnswerPrompt` only.** `buildAcknowledgePrompt` already caps itself at "one or two
sentences" and `buildChitchatPrompt` at "one short, natural line"; adding a second,
differently-worded length rule to either gives the model two constraints to reconcile where it
currently has one. This scoping is asserted in a test, because the natural mistake is to apply a
good rule everywhere.

#### 4.4 What the tests can and cannot prove

The real failure mode is someone writing the blanket version and dropping the exception clause.
Tests:

- `buildAnswerPrompt` contains both the default-shape half and the explicit-request exception —
  deleting either half turns it red.
- `buildAcknowledgePrompt` and `buildChitchatPrompt` do **not** contain `FORMAT_RULE` — pasting
  it everywhere turns it red.

**Stated limit: no test asserts the model obeys the rule.** These assert the prompt's content and
its scoping, which is the whole of what is mechanically checkable here. Whether replies actually
get shorter is a manual check against the two original screenshots, and the plan says so rather
than implying the suite covers it.

## Out of scope

- No changes to note saving, enrichment, embedding, dedupe, or the 60-second sweep.
- No changes to `search_notes` / chitchat exclusion from search.
- No changes to the web-sources half of `Provenance` or the Google grounding entry-point widget.
- No changes to `buildChitchatPrompt`.
- No redesign of the `intent` enum or `INTENTS` const — `alsoWantsAnswer` is additive.
- No markdown renderer on mobile unless §4.2's spike passes on RN 0.86 / React 19.2 / Expo 57.
  A failed spike stops there; it does not become a hand-written renderer or a library port.
- No buffering of the stream to avoid partial-markdown flicker (§4.2).
- No chat transcript on mobile — still out, unchanged from C4 §2. §4.2's mobile work is the one
  `box-answer` string and nothing else.

## Testing notes for the implementer

- `packages/core/src/enrich/extract.test.ts` has "default cases" asserting an unrecognized/absent
  `intent` safely falls back to `"statement"` (referenced in extract.ts:332-334) — add the same
  defaulting coverage for `alsoWantsAnswer` (absent/non-boolean → `false`).
- Add a case exercising the eye-fatigue-shaped example: `intent: "statement"`,
  `alsoWantsAnswer: true` → `turn.ts` must route to `buildAnswerPrompt`, stamp
  `source_type: "chat"`, pick `ANSWER_MODEL`, and enable grounding — i.e. behave identically to
  a pure `"question"` turn from that point on.
- Manually re-run the two flows from the original screenshots (a statement+question turn, and a
  follow-up whose notes duplicate an earlier one) to confirm: (a) an answer is produced in the
  same turn as the save, (b) no "Đã lưu ghi chú..." style preamble appears, (c) no `TỪ NOTES CỦA
  BẠN` box renders, (d) the `TỪ web` box and grounding entry point still render unchanged on a
  grounded turn, (e) the casual "mỏi mắt ăn gì" question comes back as prose rather than a
  sectioned writeup, and (f) a turn that *does* ask to enumerate still gets a list — (e) and (f)
  are the pair, and checking only (e) is how the exception clause gets deleted later.
- §4.4 states the limit: nothing in the suite proves the model obeys `FORMAT_RULE`. The tests
  cover the prompt's content and its scoping. Do not report the manual checks above as covered
  by a green run.
