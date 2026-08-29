# One Prompt, One Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the classification gate from the chat turn so every message gets one prompt on one model, started as soon as retrieval lands, with classification running concurrently for its own outputs and read after the answer has streamed.

**Architecture:** `runTurn` currently awaits `extractNote` and `retrieve` together, then picks one of three prompts and one of two models from `extracted.intent`. After this change there is one prompt (`buildTurnPrompt`) and one model (`ANSWER_MODEL`), chosen unconditionally. `extractNote` still runs on the same turn, concurrently, but nothing waits on it before the model call — it is read after the stream to emit `attached`, write the mood check-in, stamp `source_type`, record the S2 `asked` pointer and gate the offer. `attached` is emitted mid-stream the moment classification settles, so the instant-attachment UX is preserved.

**Tech Stack:** TypeScript, pnpm + turbo monorepo, Vitest, Supabase (supabase-js), Gemini via `packages/core/src/ai/gemini.ts`.

**Spec:** `docs/superpowers/specs/2026-08-29-one-prompt-turn-design.md` — read it first. Every task below argues from a numbered section of it.

## Global Constraints

- **Run package tests through turbo only:** `pnpm turbo run test --filter=@cortex/core`. Never `pnpm --filter @cortex/core test` — `@cortex/shared` and `@cortex/core` resolve as compiled `dist/`, and the direct form silently tests stale output.
- **Full gate before any commit that touches more than tests:** `pnpm turbo run lint typecheck test`.
- **Docker/Supabase must be up for the DB-dependent suites.** If `turbo` reports `26/26 successful`, read the `Cached:` line before believing it — a cached replay is not a run.
- **No test may call the real Gemini API.** Every suite uses `createFakeAi` from `packages/core/src/ai/fake.ts`.
- **No migration.** Nothing in this plan changes the database schema.
- **No client change.** `apps/web` and `apps/mobile` are not touched by any task.
- **Prompt rules are English; their examples are Vietnamese.** `LANGUAGE_RULE` decides the reply's language; an English paraphrase of a Vietnamese phrasing being forbidden is not the thing to forbid.
- **Every test must be able to fail.** For each one, ask what one-line change to the implementation turns it red. If there isn't one, the test is wrong.

---

### Task 1: Price the new model, and swap to it

**Why first:** `priceUsd` returns `0` for a model absent from `MODEL_PRICES_USD_PER_MTOK`, deliberately (`budget.ts:5-8`). Swapping `ANSWER_MODEL` without adding its price books every chat row free, `monthToDateUsd` sums to nothing, and `isOverBudget` never trips — the circuit breaker is silently disarmed. Spec §7.

**Files:**
- Modify: `packages/shared/src/enums.ts:108` (`ANSWER_MODEL`) and `:115-119` (`MODEL_PRICES_USD_PER_MTOK`)
- Test: `packages/core/src/enrich/budget.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ANSWER_MODEL = "gemini-3.5-flash"`, priced in `MODEL_PRICES_USD_PER_MTOK`. Tasks 3 and 4 import `ANSWER_MODEL` from `@cortex/shared`.

- [ ] **Step 1: Discard the superseded working-tree fix**

The uncommitted `ENDS_WITH_KHONG` / `BARE_NAO` changes patch `looksLikeQuestion`, which Task 3 deletes outright. Confirmed with the user: this plan supersedes them.

```bash
git checkout -- packages/core/src/assistant/turn.ts packages/core/src/assistant/turn.test.ts
git status --short
```

Expected: no modified files listed.

- [ ] **Step 2: Write the failing test**

Add to `packages/core/src/enrich/budget.test.ts`. Import `CLASSIFY_MODEL` and `MODEL_PRICES_USD_PER_MTOK` alongside the existing `ANSWER_MODEL` import at the top of the file.

```ts
// priceUsd returns 0 for an unknown model deliberately -- "swapping a model id must never wedge
// the whole pipeline" (budget.ts:5-8). That trade is right, and it is exactly why a missing price
// is invisible: nothing throws, nothing logs, every chat row books free, and isOverBudget stops
// being a circuit breaker at all. This is the only thing standing between a one-line model swap
// and a silently disarmed budget.
it("prices every model the assistant actually calls", () => {
  for (const model of [ANSWER_MODEL, CLASSIFY_MODEL]) {
    expect(MODEL_PRICES_USD_PER_MTOK[model], `${model} has no price`).toBeDefined();
  }
});

it("prices a real answer-model call above zero", () => {
  expect(priceUsd(ANSWER_MODEL, 1_000_000, 1_000_000)).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run it and watch it pass (it must, before the swap)**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS. `gemini-3.1-pro-preview` is currently in the map. This test only becomes load-bearing at the next step — run it now to prove it is wired up, then break it deliberately.

- [ ] **Step 4: Swap the model WITHOUT the price, and watch the test go red**

Edit `packages/shared/src/enums.ts:108` only:

```ts
export const ANSWER_MODEL = "gemini-3.5-flash";
```

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: FAIL — `gemini-3.5-flash has no price`. This is the proof the test can fail. Do not skip it.

- [ ] **Step 5: Add the price and the reasoning**

Replace the `ANSWER_MODEL` declaration and the price map in `packages/shared/src/enums.ts`:

```ts
// Reasoning: answering anything the user types into the box. Moved off the Pro tier on
// 2026-08-29 after a live 4-case benchmark against real prompt shapes from prompts.ts (health
// Q&A, a grounded current-events question, a wrong-claim correction, chitchat): 3.5-flash was
// faster than gemini-3.1-pro-preview on all four, cheaper on three, and read as comparable in
// quality. One caveat recorded rather than hidden -- it produced a garbled term ("cơ bắp tay
// trinit") in the health answer, a single occurrence, which is why health-domain replies are a
// named manual check in this stage's plan.
//
// gemini-3.7-flash is cheaper still on paper ($0.75/$3.75 promo) and was NOT taken: it 503'd on
// two of four calls and its two successes were the slowest of every model tested. Revisit when it
// leaves capacity-constrained preview.
export const ANSWER_MODEL = "gemini-3.5-flash";
export const MODEL_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gemini-embedding-001": { input: 0.15, output: 0 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  // Verified against ai.google.dev/gemini-api/docs/pricing on 2026-08-29, standard (non-batch)
  // tier. gemini-3.1-pro-preview's entry ($2.00/$12.00) is deliberately KEPT: usage_ledger rows
  // written before the swap carry that model id, and monthToDateUsd prices from this map at read
  // time -- deleting the entry would retroactively rewrite historical spend to zero.
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
};
```

- [ ] **Step 6: Run the full gate**

Run: `pnpm turbo run lint typecheck test`
Expected: PASS. Some `turn.test.ts` assertions reference `ANSWER_MODEL` by constant rather than by literal, so they follow the swap automatically.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/enums.ts packages/core/src/enrich/budget.test.ts
git commit -m "feat(assistant): move the answer tier to gemini-3.5-flash, priced

A model absent from MODEL_PRICES_USD_PER_MTOK books zero, so the swap and its
price have to land together or the circuit breaker goes quiet. The new test is
what makes that impossible to forget next time."
```

---

### Task 2: `buildTurnPrompt` — one prompt for every kind of turn

**Why:** Spec §5. The three builders exist only because a classifier told the turn which to use. One prompt on the restored rule stack replaces all three. This task adds it alongside the existing three, which keeps `turn.ts` compiling and green; Task 5 deletes the old ones once nothing calls them.

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts`
- Test: `packages/core/src/assistant/prompts.test.ts`

**Interfaces:**
- Consumes: `Citation` from `./retrieve.js`, `ThreadTurn` from `./context.js` — both already imported by this file.
- Produces:
  ```ts
  export function buildTurnPrompt(a: {
    text: string;
    citations: Citation[] | "failed";
    history: ThreadTurn[];
    timeZone: string;
    now: Date;
    justAsked: boolean;
  }): string
  ```
  Task 3 calls exactly this. `justAsked` is required, not optional — an optional flag defaulting to `false` lets a call site forget it, and the symptom (the S2 ceiling silently never firing) looks exactly like a classifier that stopped setting something.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/assistant/prompts.test.ts`. Reuse the module-level `NOW`, `TZ`, `cite` and `turn` helpers already at the top of the file.

```ts
describe("buildTurnPrompt", () => {
  const build = (over: Partial<Parameters<typeof buildTurnPrompt>[0]> = {}) =>
    buildTurnPrompt({
      text: "hôm nay tôi chạy bộ ở công viên",
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

  it("localizes from the time zone rather than defaulting to the US", () => {
    expect(build({ timeZone: "Europe/Berlin" })).toContain("Europe/Berlin");
    expect(build()).toMatch(/Đừng mặc định họ đang ở Mỹ/);
  });

  it("forbids the database-match framing and requires a dated anchor", () => {
    const p = build();
    expect(p).toMatch(/Trong các ghi chú của bạn/);
    expect(p).toMatch(/hôm 18\/8 bạn có nhắc/);
    expect(p).toMatch(/Never use a bracketed number/i);
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

  it("keeps the gap-filling disclaimer when notes were found", () => {
    const p = build({ citations: [cite({ snippet: "chạy 5km" })] });
    expect(p).toContain("chạy 5km");
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

  it("dates each turn of the conversation", () => {
    const p = build({ history: [turn("user", "mai tôi đi khám")] });
    expect(p).toMatch(/\(12 thg 8\) User: mai tôi đi khám/);
  });

  it("puts the user's message last", () => {
    expect(build({ text: "xin chào" }).trimEnd()).toMatch(/Their message: xin chào$/);
  });
});
```

Add `buildTurnPrompt` to the import at line 3 and `formatToday` to a new `@cortex/shared` import:

```ts
import { formatToday } from "@cortex/shared";
import { buildAcknowledgePrompt, buildAnswerPrompt, buildChitchatPrompt, buildTurnPrompt } from "./prompts.js";
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: FAIL — `buildTurnPrompt is not exported` / typecheck error.

- [ ] **Step 3: Restore the two rules `fd65f16` deleted**

Add back to `packages/core/src/assistant/prompts.ts`, above `VERIFY_RULE`. These are verbatim from `fd65f16^` — recover them with `git show fd65f16^:packages/core/src/assistant/prompts.ts` rather than retyping, then keep the doc comments.

```ts
/**
 * Observed: a casual "mỏi mắt ăn gì" came back as a multi-section writeup with bolded category
 * headers -- the same shape as a question that had explicitly asked to list things out. The
 * prompt carried no shape guidance at all, so that was the model's default, not a template.
 *
 * BOTH halves are load-bearing and they are INDEPENDENT. The rule used to tie length to
 * structure ("two or three sentences of prose"), which left no cell for LONG PROSE: a
 * substantive question that deserves depth and is not a list. The user's verdict was that
 * replies were too short; depth follows the question, structure stays the exception.
 *
 * The exception clause is still the half a later edit will drop, and prompts.test.ts still
 * asserts each half separately for exactly that reason.
 */
const FORMAT_RULE =
  "Match the shape and the depth of the reply to the weight of the question. A short, casual " +
  "question gets a short, conversational answer. A question that genuinely asks for something " +
  "gets as much as it actually needs -- several paragraphs is fine, and prose is still the " +
  "default shape at any length. Reach for headings or a numbered list only when the user " +
  "actually asked to enumerate or compare (\"liệt kê\", \"các bước\", \"so sánh\", \"list " +
  "out\"), or when the answer genuinely is a set of parallel items that prose would obscure. " +
  "Structure is the exception, not the default shape of an answer.";

/**
 * Reported 2026-08-24: a web-grounded reply defaulted to US context (prices, availability, "in
 * the US") for a user who never said they were in the US -- because nothing in the prompt gave
 * the model any location signal at all. `timeZone` was already resolved for the temporal rule
 * (and defaults to Asia/Ho_Chi_Minh, this corpus's actual users), so this is what turns that
 * value into a location signal too, rather than leaving grounding to answer around a blank.
 *
 * On every turn now, not only on the answer branch: since 2026-08-29 there is one prompt, and a
 * statement can ground just as a question can.
 */
const locationRule = (timeZone: string) =>
  `Múi giờ của người dùng là ${timeZone}. Suy ra khu vực hoặc quốc gia của họ từ đó (và từ ngôn ` +
  "ngữ họ dùng), và dùng nó khi câu trả lời phụ thuộc vào vị trí -- giá cả, đơn vị tiền tệ, thời " +
  "tiết, giờ mở cửa, luật lệ, tin tức địa phương. Đừng mặc định họ đang ở Mỹ.";
```

- [ ] **Step 4: Add the four new rules**

Add to `packages/core/src/assistant/prompts.ts`, after `ENGAGE_RULE`:

```ts
/**
 * What `buildChitchatPrompt` used to buy with a whole branch, as one instruction. "hello",
 * "haha ok", "1111" have nothing to file and no question in them, and the old acknowledge prompt
 * announced bookkeeping at them while the old answer prompt searched the corpus for an answer to
 * "what?". Neither branch exists now, so the rule has to carry the distinction itself.
 *
 * Named examples rather than a description of the category: "small talk" is a label the model has
 * to interpret, and "1111" is not obviously inside it.
 */
const WEIGHT_RULE =
  "Match what you give back to what they gave you. A greeting, a reaction, or noise -- " +
  "\"hello\", \"haha ok\", \"1111\" -- gets one light line back and nothing more: do not start " +
  "a topic and do not ask a follow-up. Something they are recording gets a brief, natural " +
  "acknowledgement. A real question gets a real answer.";

/**
 * Stage C5 §9.3, rewritten 2026-08-29 when the classify-gate was removed (see that stage's spec
 * §8). It used to be rendered only when the classifier flagged `checkable_claim` AND the turn had
 * been promoted to the reasoning model, because C5 §9.1 judged flash-lite unfit to adjudicate
 * truth -- "the weakest model in the system doing the task with the most asymmetric failure
 * mode". With no gate the model never learns a claim was flagged, so the SCOPE has to live in the
 * wording rather than in a branch.
 *
 * It is written to no-op where it should. A pure question contains no stated claim, so nothing
 * fires; the three exclusions cover the cases where a correction would be an intrusion rather
 * than a service.
 *
 * The second half has no exception and is the more important of the two. The model examined
 * whatever it happened to examine, and the user cannot tell which -- so "đúng rồi" on a sentence
 * nothing looked at is the system asserting a verification it never performed. Silence has to
 * mean "no basis to doubt", never "checked and confirmed"; a system that sometimes confirms is
 * one whose silence starts reading as confirmation too.
 */
const CORRECTION_RULE =
  "If something they STATED as a fact about the world is wrong, say so once, in one short " +
  "sentence, and move on -- no elaboration, no follow-up question, no lecture. This applies only " +
  "to claims about the world: never to their own life, their plans, their memories or how they " +
  "feel, which are theirs to state and not yours to check, and never to something you yourself " +
  "said earlier in this conversation. " +
  "Never do the opposite: do not say \"đúng rồi\", \"chính xác\", \"xác nhận\" or anything else " +
  "implying you checked what they wrote and found it correct. Silence means you had no reason to " +
  "doubt them, not that you confirmed them.";

/**
 * The only control on grounding spend once the gate is gone (stage spec §7).
 *
 * Grounding is billed per QUERY at $0.014 -- roughly four times the entire token cost of the turn
 * it rides on -- so one unnecessary search on a journaling capture costs more than the model swap
 * saves. There is no deterministic pre-filter available: that is `looksLikeQuestion`, which
 * misrouted a real question twice, and a tool cannot be attached to an already-streaming reply, so
 * the settled classification cannot gate it either. An instruction is the whole mechanism.
 *
 * The forbidden case is named with a real example rather than described, for WEIGHT_RULE's reason.
 */
const GROUNDING_RULE =
  "You may search the web, but only when they are asking about something you would genuinely " +
  "need to look up -- a fact you are not sure of, or something time-sensitive. Never search for " +
  "something they are simply recording about their own life (\"hôm nay tôi chạy bộ ở công " +
  "viên\"), and never for small talk. When their own notes below already answer it, answer from " +
  "those first.";

/**
 * Stage S2 §7's ceiling -- "the turn after a question never asks another" -- which survives the
 * gate's removal only because of where its input comes from. `pendingAsk` is read out of
 * `chat_messages` history at the top of the turn and needs no classification at all, so turn.ts
 * still knows this before the prompt is built. The ceiling stays a code guarantee with no number
 * in it, exactly as S2 designed it; only the mechanism moved from selecting a branch to rendering
 * a rule.
 */
const NO_SECOND_QUESTION_RULE =
  "You asked them a question in your last reply and this message is their answer to it. Do not " +
  "ask another question this turn -- take what they gave you and let the subject rest.";
```

Reword `ENGAGE_RULE`'s opening, which assumed an acknowledgement had just been rendered above it:

```ts
const ENGAGE_RULE =
  "When they are recording something rather than asking, add ONE brief, natural line that " +
  "responds to what they actually wrote -- ask something specific about it, react to it, or " +
  "suggest something small and concrete that fits it. Tie it to their note, never a generic " +
  "\"cố lên nhé\". One line, then stop -- do not turn it into an interview.";
```

- [ ] **Step 5: Write `buildTurnPrompt`**

Add to `packages/core/src/assistant/prompts.ts`, above `buildAnswerPrompt`:

```ts
/**
 * ONE prompt for every kind of turn (stage spec §5). Replaces buildAnswerPrompt,
 * buildAcknowledgePrompt and buildChitchatPrompt, which existed only because a separate
 * classification call told turn.ts which of the three to use -- a gate that misrouted a real
 * question into "note filed" twice, on 2026-08-24 and 2026-08-29, whenever it timed out.
 *
 * The framing sentence does the work the three branches used to do: it says a message may be any
 * of the three kinds and to read it rather than be told. WEIGHT_RULE then handles the small-talk
 * end and ENGAGE_RULE the recorded end.
 *
 * It deliberately does NOT say what was filed. Classification has not settled when this is built,
 * so "You filed it under: X" would be a claim about data that does not exist yet -- see §5.1. The
 * `attached` SSE event carries that, on both clients, on the same turn.
 *
 * `justAsked` is required rather than optional for the reason buildAcknowledgePrompt's `verify`
 * was: an optional flag defaulting to false lets a call site forget it, and the symptom -- the S2
 * ceiling silently never firing -- looks exactly like a classifier that stopped setting something.
 */
export function buildTurnPrompt(a: {
  text: string;
  citations: Citation[] | "failed";
  history: ThreadTurn[];
  timeZone: string;
  now: Date;
  justAsked: boolean;
}): string {
  return [
    "You are the user's second brain and conversational assistant. They have just written you " +
      "one message. It might be a question, something they are recording, or just a passing " +
      "remark -- read it and respond to what it actually is. Every message is saved as a note " +
      "either way, and that is not something you need to mention.",
    LANGUAGE_RULE,
    WEIGHT_RULE,
    FORMAT_RULE,
    temporalRule(a.now, a.timeZone),
    locationRule(a.timeZone),
    RECALL_RULE,
    ENGAGE_RULE,
    CORRECTION_RULE,
    GROUNDING_RULE,
    "Never present web content as the user's own thinking. Say where something came from.",
    // Spread-in rather than an empty string: a turn with no outstanding question must carry no
    // instruction about follow-ups at all, not a blank line where one used to be.
    ...(a.justAsked ? [NO_SECOND_QUESTION_RULE] : []),
    renderCitations(a.citations, a.timeZone),
    renderHistory(a.history, a.timeZone),
    `\n\nTheir message: ${a.text}`,
  ].join("\n");
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS, including every pre-existing test — `turn.ts` still calls the three old builders and is untouched by this task.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/assistant/prompts.ts packages/core/src/assistant/prompts.test.ts
git commit -m "feat(assistant): one prompt for every kind of turn

buildTurnPrompt, on the rule stack fd65f16 stripped while chasing a bug the
classify-gate turned out to explain. Restores FORMAT_RULE and locationRule
verbatim, adds the four rules that replace what a branch used to decide:
weight-matching, scoped correction, scoped grounding, and S2's ceiling.

Nothing calls it yet."
```

---

### Task 3: One model, one prompt — delete the gate

**Why:** Spec §6. This task changes *what* the reply is, without touching *when* it happens: classification is still awaited before the model call, exactly as today. Splitting it this way means a reviewer can accept or reject "every turn answers" independently of "the reply no longer waits."

**Files:**
- Modify: `packages/core/src/assistant/turn.ts` — delete `:54-95`, rewrite `:358-469`, adjust `:581`
- Test: `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: `buildTurnPrompt` (Task 2), `ANSWER_MODEL` (Task 1).
- Produces: `runTurn`'s observable behaviour — every turn calls `ai.generateStream` with `model: ANSWER_MODEL` and `grounding: true`. Task 4 relies on nothing new here beyond that.

- [ ] **Step 1: Rewrite the five inverted assertions**

`turn.test.ts:1036, 1131, 1158, 1595, 1630` assert `CLASSIFY_MODEL`. They are correct today and wrong after this task. **Rewrite them in place with their new reasoning — do not delete them.** Their comments record why a cheap path existed, and that history is the thing a future reader needs in order to reintroduce one deliberately rather than by accident.

Replace the body of `it("leaves an ordinary statement on the cheap path", ...)` with:

```ts
  // Was "leaves an ordinary statement on the cheap path" until 2026-08-29. The cheap path is
  // gone: it existed because a classifier told turn.ts which of three prompts to use, and that
  // gate misrouted real questions into "note filed" whenever it timed out (2026-08-24 and
  // 2026-08-29). An ordinary recorded note now reaches the same model and the same prompt as
  // everything else, and the cost of that is stated and accepted in the stage spec §11.2.
  //
  // What is still asserted is the half that was never about the model: a plain capture keeps the
  // 'quick' source_type it was created with. Stamp it 'chat' here and 00039 makes it unrecallable.
  it("answers an ordinary statement on the answer model and leaves its source_type alone", async () => {
    const { client, updated } = dbs();
    const seen: { model?: string; grounding?: boolean }[] = [];
    const recordingAi = createFakeAi({
      generateJson: async () => ({
        value: { intent: "statement", alsoWantsAnswer: false, complexity: "simple",
                 domain: null, domain_meta: {}, tags: [], mood: null },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      }),
      generateStream: async (a) => {
        seen.push(a);
        return {
          chunks: (async function* () { yield { text: "Đã lưu." }; })(),
          usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
        };
      },
    });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(seen[0]?.model).toBe(ANSWER_MODEL);
    expect(seen[0]?.grounding).toBe(true);
    expect((updated.notes ?? []).some((r) => "source_type" in r)).toBe(false);
  });
```

Apply the same treatment to the other four: keep the test, keep its comment as history with a dated note explaining the inversion, flip `CLASSIFY_MODEL` → `ANSWER_MODEL` and `grounding` `toBeFalsy()` → `toBe(true)`. The chitchat test at `:1595` keeps its `source_type: 'chitchat'` assertion, which is unaffected.

- [ ] **Step 2: Write the new failing test**

Add to `packages/core/src/assistant/turn.test.ts`:

```ts
// THE POINT OF THE STAGE. All three intents reach the same model with grounding offered -- there
// is no branch left for a classification to pick. Three cases rather than one: a single
// statement case would still pass against an implementation that kept the question branch and
// merely widened the statement one.
//
// Red when: any `intent`-conditional model or grounding choice is reintroduced in turn.ts.
it.each(["question", "statement", "chitchat"] as const)(
  "answers a %s turn on the answer model with grounding offered",
  async (intent) => {
    const { client } = dbs();
    const seen: { model?: string; grounding?: boolean; prompt?: string }[] = [];
    const recordingAi = createFakeAi({
      generateJson: async () => ({
        value: { intent, alsoWantsAnswer: false, complexity: "simple",
                 domain: null, domain_meta: {}, tags: [], mood: null },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      }),
      generateStream: async (a) => {
        seen.push(a);
        return {
          chunks: (async function* () { yield { text: "ok" }; })(),
          usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
        };
      },
    });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(seen[0]?.model).toBe(ANSWER_MODEL);
    expect(seen[0]?.grounding).toBe(true);
    // One prompt, and the two sentences that identified the two branches it replaced are gone.
    expect(seen[0]?.prompt).toMatch(/Their message:/);
    expect(seen[0]?.prompt).not.toMatch(/did not ask a question/i);
    expect(seen[0]?.prompt).not.toMatch(/Their question:/);
  },
);

// The S2 ceiling, asserted on the PROMPT rather than on what got recorded. Asserting only that
// `asked` was not re-recorded passes for the wrong reason -- the model would still be nagging,
// and the recording would just be missing.
//
// Red when: `justAsked` stops being derived from pendingAsk in turn.ts.
it("tells the model not to ask again when a question is outstanding", async () => {
  const { client } = dbs({
    history: [{
      role: "assistant", content: "Phim gì vậy bạn?", created_at: "2026-08-14T01:00:00.000Z",
      retrieval_meta: { asked: { noteId: "n0", field: "pending_item.title" } },
    }],
    lastMessage: { session_id: "s1", created_at: "2026-08-14T01:00:00.000Z" },
  });
  const seen: { prompt?: string }[] = [];
  const recordingAi = createFakeAi({
    generateJson: async () => ({
      value: { intent: "statement", complexity: "simple", domain: null,
               domain_meta: {}, tags: [], mood: null },
      inputTokens: 1, outputTokens: 1, model: "fake-classify",
    }),
    generateStream: async (a) => {
      seen.push(a);
      return {
        chunks: (async function* () { yield { text: "ok" }; })(),
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
      };
    },
  });
  await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(seen[0]?.prompt).toMatch(/Do not\s+ask another question this turn/i);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: FAIL — the chitchat and statement cases get `CLASSIFY_MODEL`, and the prompt still contains "did not ask a question".

- [ ] **Step 4: Delete the gate**

In `packages/core/src/assistant/turn.ts`:

Delete lines 54-95 entirely — the `QUESTION_PHRASES` doc comment, `QUESTION_PHRASES`, `ENDS_WITH_KHONG`, `BARE_NAO` and `looksLikeQuestion`. Nothing replaces them; there is no branch left for a fallback to feed.

Replace the block at `:377-402` (from `const wantsAnswer =` through the `gap` assignment) with:

```ts
  // NO ORDERED CHAIN, and its absence is the change. `wantsAnswer`, `isChitchat` and `verifies`
  // used to select one of three prompts and one of two models from `extracted.intent`, with a
  // deterministic keyword fallback for when classification never ran. That gate misrouted a real
  // question into the acknowledge branch twice -- "Cung điện ký ức là gì?" (2026-08-24) and "Bơi
  // lội có giúp phát triển cơ bắp không" (2026-08-29) -- both times because extraction timed out,
  // and both times on a message the live classifier reads correctly every time it actually runs.
  // One prompt and one model remove the branch rather than widening the fallback again.
  //
  // These two survive as ANNOTATION only. Neither picks a prompt or a model; they decide what the
  // note is stamped as, which is a different question and one the classifier answers well.
  const isPureQuestion = extracted?.intent === "question";
  const isChitchat = extracted?.intent === "chitchat";

  // S2 §2/§4. Now gates only the RECORDING of `asked`, never a prompt rule -- nothing instructs
  // the model to ask, so there is nothing to exclude. `pendingAsk === null` survives because it is
  // the ceiling on the recording: two chained asks would let a backfill walk backwards through the
  // thread. `extracted &&` survives because a degraded extraction knows of no domain and no gap.
  const gap = extracted && pendingAsk === null
    ? detectEntityGap(extracted.domain, extracted.domainMeta)
    : null;
```

Replace the prompt selection at `:426-441` and the model line at `:445` with:

```ts
  const prompt = buildTurnPrompt({
    text, citations: citationsForPrompt, history, timeZone, now,
    // Read from chat_messages history at the top of this turn, NOT from the classification --
    // which is what lets S2 §7's ceiling survive the gate's removal intact. See
    // NO_SECOND_QUESTION_RULE in prompts.ts.
    justAsked: pendingAsk !== null,
  });
  const model = ANSWER_MODEL;
```

Replace `:462` (`const grounds = ...`) and the `mark` beneath it:

```ts
  // Unconditional. The cost of that decision, and the prompt rule that is now the only thing
  // controlling it, are both in the stage spec §7 -- grounding is billed per query at roughly
  // four times a turn's whole token cost, so GROUNDING_RULE is doing real work here.
  mark(`model stream requested (${model}, grounding=true)`);
```

and the `generateStream` call's `grounding: grounds` becomes `grounding: true`.

At `:581`, replace `wantsAnswer` in the offer gate:

```ts
  // `answersAQuestion`, not `searched`. proposeOffer's prompt is hardcoded to "The assistant just
  // answered a question", and Finding 4 of the whole-branch review recorded that `searched` alone
  // is not that -- a turn can ground without having answered anything. This is the same derivation
  // `wantsAnswer` was, read from the classification purely to gate the offer, never to pick a
  // prompt. A degraded extraction produces no offer, which is the safe direction.
  const answersAQuestion = extracted !== null
    && (extracted.intent === "question" || extracted.alsoWantsAnswer === true);
  if (answersAQuestion && searched && !incomplete && answer !== "") {
```

Update the imports at `:4` and `:16`:

```ts
import {
  ANSWER_MODEL, GROUNDING_USD_PER_QUERY, resolveTimeZone, type WebCitation,
} from "@cortex/shared";
...
import { buildTurnPrompt } from "./prompts.js";
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm turbo run lint typecheck test`
Expected: PASS. `lint` catches any now-unused import (`CLASSIFY_MODEL`, `buildAcknowledgePrompt`, `buildAnswerPrompt`, `buildChitchatPrompt`).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/assistant/turn.ts packages/core/src/assistant/turn.test.ts
git commit -m "feat(assistant): one model and one prompt, chosen unconditionally

Deletes wantsAnswer/isChitchat/verifies and the looksLikeQuestion fallback they
needed. The classifier's judgment was never wrong -- it was right on both
misrouted questions every time it ran -- so this removes the gate rather than
adding a third keyword to the list guarding it.

intent survives as annotation: it still stamps source_type and gates the offer.

Five turn.test.ts assertions invert and are rewritten in place with their new
reasoning, not deleted; their comments are why a cheap path existed."
```

---

### Task 4: Decouple classification from the reply

**Why:** Spec §1-§4. Task 3 made every turn answer; this makes the answer stop waiting. The reply now starts as soon as retrieval lands, and classification is read after the stream.

**Files:**
- Modify: `packages/core/src/assistant/turn.ts:37` (deadline), `:216-334` (the concurrency block), and the post-stream region
- Test: `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: everything from Task 3.
- Produces: no new exports. `EXTRACT_DEADLINE_MS` changes value from `4000` to `15000` and stays exported (`turn.test.ts` imports it).

- [ ] **Step 1: Write the failing tests**

```ts
// THE REGRESSION TEST FOR THE REPORTED BUG, and the most important assertion in this file. A
// classification that never returns must cost the user their tags, and nothing else. Before
// 2026-08-29 it cost them the answer: `extracted` was null, wantsAnswer fell through to a keyword
// list, and "Bơi lội có giúp phát triển cơ bắp không" came back as an acknowledgement of a filed
// note.
//
// Red when: an `await` on the classification is reintroduced anywhere above the generateStream
// call.
it("answers in full while classification is still hanging", async () => {
  const { client } = dbs();
  const seen: { prompt?: string }[] = [];
  const hanging = createFakeAi({
    // Never resolves. Not a rejection and not a slow resolve -- the turn must not depend on this
    // promise settling at all before it answers.
    generateJson: () => new Promise(() => {}),
    generateStream: async (a) => {
      seen.push(a);
      return {
        chunks: (async function* () { yield { text: "Bơi lội " }; yield { text: "có." }; })(),
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
      };
    },
  });
  const events = await collect(runTurn({ userDb: client, serviceDb: client, ai: hanging },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));

  const answer = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
  expect(answer).toBe("Bơi lội có.");
  expect(seen).toHaveLength(1);
  // The turn still completes, and still reports the classification honestly rather than silently.
  expect(events.find((e) => e.type === "attached")).toMatchObject({ degraded: true });
  expect(events.at(-1)?.type).toBe("done");
}, 20_000);

// The above passes against an implementation that awaits classification but happens to get a fast
// fake. This one does not: the stream is only opened once the test has PROVEN the classification
// is still outstanding.
//
// Red when: the classification is awaited before the prompt is built, however briefly.
it("opens the model stream before classification has settled", async () => {
  const { client } = dbs();
  let classifySettled = false;
  let streamOpenedWhileClassifying = false;
  let releaseClassify: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseClassify = r; });

  const slow = createFakeAi({
    generateJson: async () => {
      await gate;
      classifySettled = true;
      return {
        value: { intent: "statement", complexity: "simple", domain: null,
                 domain_meta: {}, tags: ["chạy-bộ"], mood: null },
        inputTokens: 1, outputTokens: 1, model: "fake-classify",
      };
    },
    generateStream: async () => {
      streamOpenedWhileClassifying = !classifySettled;
      // Let classification finish now, so the turn can complete and emit `attached`.
      releaseClassify();
      return {
        chunks: (async function* () { yield { text: "ok" }; })(),
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
      };
    },
  });

  const events = await collect(runTurn({ userDb: client, serviceDb: client, ai: slow },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(streamOpenedWhileClassifying, "the reply must not wait on classification").toBe(true);
  // And it is still delivered, late rather than never.
  expect(events.find((e) => e.type === "attached")).toMatchObject({ tags: ["chạy-bộ"] });
});

// §2. The receipt is a stated core product feature and must not slide to after the answer when it
// does not have to. Ordering is asserted by index, not by presence.
//
// Red when: the mid-stream emission is dropped and `attached` is only yielded after the loop.
it("emits attached during the stream once classification has landed", async () => {
  const { client } = dbs();
  const fast = createFakeAi({
    generateJson: async () => ({
      value: { intent: "statement", complexity: "simple", domain: "health",
               domain_meta: {}, tags: ["sức-khỏe"], mood: null },
      inputTokens: 1, outputTokens: 1, model: "fake-classify",
    }),
    generateStream: async () => ({
      // Several chunks with a tick between them, so classification has somewhere to land.
      chunks: (async function* () {
        for (const t of ["a", "b", "c", "d"]) { await new Promise((r) => setTimeout(r, 5)); yield { text: t }; }
      })(),
      usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
    }),
  });
  const types = (await collect(runTurn({ userDb: client, serviceDb: client, ai: fast },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }))).map((e) => e.type);
  const attachedAt = types.indexOf("attached");
  const lastTokenAt = types.lastIndexOf("token");
  expect(attachedAt).toBeGreaterThan(-1);
  expect(attachedAt, "attached must not wait for the answer to finish").toBeLessThan(lastTokenAt);
});

// §4. `asked` is now written from what the reply actually SAID, after the fact. S2 §5 already
// conceded the `?` test was "the honest approximation" of an instruction we could not verify;
// post-hoc it is an observation of text the turn is holding.
//
// Red when: `asked` is written unconditionally, which would let a backfill fire off a reply that
// asked nothing.
it.each([
  ["Bạn xem phim gì vậy?", true],
  ["Đã lưu nhé.", false],
])("records asked only when the reply actually contains a question (%s)", async (reply, expected) => {
  const { client, inserted } = dbs();
  const mediaAi = createFakeAi({
    generateJson: async () => ({
      value: { intent: "statement", complexity: "simple", domain: "media",
               domain_meta: {}, tags: [], mood: null },
      inputTokens: 1, outputTokens: 1, model: "fake-classify",
    }),
    generateStream: async () => ({
      chunks: (async function* () { yield { text: reply }; })(),
      usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
    }),
  });
  await collect(runTurn({ userDb: client, serviceDb: client, ai: mediaAi },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  const assistantRow = (inserted.chat_messages ?? []).find((r) => r.role === "assistant");
  const meta = assistantRow?.retrieval_meta as { asked?: unknown } | undefined;
  expect(meta?.asked !== undefined).toBe(expected);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: FAIL — the hanging-classification test times out or produces no tokens; the ordering test finds `attached` before the first token, not during.

- [ ] **Step 3: Raise the deadline**

Replace `packages/core/src/assistant/turn.ts:31-37`:

```ts
/**
 * How long the turn will wait for classification before giving up on it and going degraded.
 *
 * 4000 until 2026-08-29, when the deadline sat IN FRONT of the reply: a hung Flash call would
 * otherwise have held the SSE connection open with nothing on screen at all. That is no longer
 * where it sits. Classification now runs beside the answer, so this bounds only how long the turn
 * holds `done` open AFTER the answer has already streamed -- and the answer's own duration
 * (3-15s) dominates it. At 4000 the deadline would routinely fire mid-answer and mark `attached`
 * degraded for no benefit whatsoever, because the connection was staying open regardless.
 *
 * 15000 is chosen so the deadline effectively never extends a turn -- the answer stream overtakes
 * it -- while making `degraded: true` rare instead of routine. Fewer degraded turns also means
 * fewer notes deferred to the 60-second sweep for enrichment that could have been instant. It is
 * an invented number and the stage spec §3 says so; it is not tuned against data.
 */
export const EXTRACT_DEADLINE_MS = 15000;
```

- [ ] **Step 4: Restructure the concurrency**

Replace `packages/core/src/assistant/turn.ts:216-349` — from the `// CONCURRENT` comment through the `citations` yield — with:

```ts
  // NOT AWAITED. This is the change: classification is started here and read after the answer has
  // streamed (below), so a slow or hung extraction costs the user their tags and nothing else.
  // Until 2026-08-29 the turn awaited it before choosing a prompt, and a timeout therefore
  // misrouted a real question into "note filed" -- twice.
  const classifyStarted = Date.now();
  // The REAL content hash, not a placeholder. extractNote stamps note_enrichment.extracted_hash
  // with whatever it is given; an empty string would never equal md5(content_text), so the sweep
  // would re-extract this note 60 seconds later and pay for the same call twice.
  const contentHash = createHash("md5").update(text, "utf8").digest("hex");
  const timed = <T,>(label: string, p: Promise<T>): Promise<T> =>
    p.finally(() => mark(`${label} settled`));

  // Set by the chain below the instant it settles. `undefined` means still running, `null` means
  // it failed or timed out, an object means it worked -- three states, because the token loop has
  // to tell "not yet" from "never" without awaiting anything.
  let annotation: Annotation | null | undefined;
  // Both failure branches are logged, and they are logged DIFFERENTLY on purpose: a rejection and
  // a timeout give different diagnostics, and a run of degraded `attached` events has to be
  // traceable rather than silent.
  const classifyOnce = async (): Promise<Classification | null> => {
    try {
      const e = await withDeadline(
        extractNote({ db: serviceDb, ai }, {
          noteId: args.noteId, userId: args.userId, contentText: text, contentHash,
          // This call is the assistant's own classification spend, not the 60-second sweep's.
          source: "assistant", requestId,
          // buildPrompt takes the last CLASSIFIER_HISTORY_TURNS. Without this the classifier sees
          // "ok còn gì khác không" as an isolated sentence.
          history,
        }),
        EXTRACT_DEADLINE_MS,
      );
      if (e === null) {
        console.error(`[assistant] extraction timed out after ${EXTRACT_DEADLINE_MS}ms (request ${requestId})`);
      }
      return e;
    } catch (err) {
      console.error(`[assistant] extraction failed (request ${requestId}): ${errorMessage(err)}`);
      return null;
    }
  };

  // The media resolve is chained here rather than awaited later so that `attached` can carry
  // `mediaTitle` in ONE event -- a second, later event for the title would be a new wire concept
  // for a receipt that already works. It is deliberately OUTSIDE withDeadline (which wraps only
  // extractNote, above): a slow findOrCreate inside the deadline would trade the whole
  // classification for a link. A throw is logged and swallowed; the note and its tags are already
  // the deliverable, and media_unresolved exists for the sync path, not for this one.
  const classification: Promise<Annotation | null> = timed("classify", classifyOnce())
    .then(async (e) => {
      if (e === null) return null;
      let mediaTitle: string | undefined;
      let mediaItemId: string | undefined;
      if (e.domain === "media") {
        try {
          const item = await new MediaService(userDb, args.userId)
            .resolveNoteMediaLink(args.noteId, e.domainMeta);
          if (item) { mediaTitle = item.title; mediaItemId = item.id; }
        } catch (err) {
          console.error(`[assistant] media link failed (request ${requestId}): ${errorMessage(err)}`);
        }
        mark("media link resolved");
      }
      return { ...e, mediaTitle, mediaItemId };
    })
    .then((a) => (annotation = a));

  // AWAITED, and now the only thing between the user pressing send and the model being called.
  // Retrieval stays on the critical path because the merged prompt needs citations for RECALL_RULE
  // to have anything to recall, and one embed call plus one RPC is not the long pole that a JSON
  // classification call racing a clock was.
  //
  // A rejected retrieval must not be reported to the model as an empty corpus: "no notes matched"
  // and "the search failed" are different facts, and only the first is safe to answer around.
  let citations: Citation[] = [];
  let citationsForPrompt: Citation[] | "failed" = [];
  try {
    citations = await timed("retrieve", retrieve({ db: serviceDb, ai }, {
      userId: args.userId, text, requestId,
    }));
    citationsForPrompt = citations;
    yield { type: "citations", citations };
  } catch (err) {
    console.error(`[assistant] retrieval failed (request ${requestId}): ${errorMessage(err)}`);
    citationsForPrompt = "failed";
    yield { type: "citations", citations: [], degraded: true };
  }
  mark("retrieve settled");
```

Add the two type aliases and the annotation emitter just above `runTurn`:

```ts
/** What `extractNote` returns, named so the annotation chain in `runTurn` can be typed without
 *  exporting extract.ts's internal interface. */
type Classification = Awaited<ReturnType<typeof extractNote>>;
/** A classification plus what resolving its media entity produced, which `attached` carries. */
type Annotation = Classification & { mediaTitle?: string; mediaItemId?: string };

/** The `attached` event's shape, in one place: it is emitted from two call sites (mid-stream and
 *  after the stream) and a degraded turn must produce the same event type as a successful one. */
const attachedEvent = (a: Annotation | null): AssistantEvent =>
  a
    ? { type: "attached", domain: a.domain, domainMeta: a.domainMeta, tags: a.tagNames,
        ...(a.mediaTitle !== undefined ? { mediaTitle: a.mediaTitle } : {}) }
    : { type: "attached", domain: null, domainMeta: {}, tags: [], degraded: true };
```

- [ ] **Step 5: Emit `attached` mid-stream, and read the classification after**

Inside `runTurn`, add a nested generator above the budget check — nested so it closes over
`userDb`, `args`, `requestId` and `noteCreatedAt`:

```ts
  // `yield*`-delegated so the normal path and the budget-declined early return emit exactly the
  // same events from one place. The check-in write is HERE and not in extractNote, and the
  // distinction matters: the 60-second sweep runs extractNote too, and a sweep that wrote
  // check-ins would manufacture mood history for old notes at arbitrary times, with no screen to
  // undo it on.
  async function* annotationEvents(
    a: Annotation | null,
    alreadySentAttached = false,
  ): AsyncGenerator<AssistantEvent> {
    if (!alreadySentAttached) yield attachedEvent(a);
    if (a?.mood != null) {
      const checkinId = randomUUID();
      try {
        await new CheckinService(userDb, args.userId).createWithId(checkinId, {
          mood: a.mood,
          // The note's timestamp, not now(): offline, the thought can be hours older than the
          // turn that finally reached the server.
          createdAt: noteCreatedAt,
        });
        yield { type: "mood", checkinId, mood: a.mood };
      } catch (err) {
        // A failed check-in must not cost the user their answer.
        console.error(`[assistant] check-in write failed (request ${requestId}): ${errorMessage(err)}`);
      }
    }
  }
```

Change the budget check so a declined turn still emits the classification's own outputs — the
existing "declines the answer when over budget, after still attaching and retrieving" test asserts
`attached`, and a declined turn's mood check-in was written before this change too:

```ts
  // A circuit breaker, not a budget: it bounds a runaway, and it never costs the user the note or
  // the context around it. The classification's outputs are not the thing being rationed, so they
  // are awaited and emitted here rather than skipped.
  if (await isOverBudget(serviceDb, args.userId, args.budgetUsd, "assistant")) {
    yield* annotationEvents(await classification);
    yield { type: "declined", reason: "budget" };
    return;
  }
```

In the token loop, add the mid-stream emission:

```ts
      let sawFirstToken = false;
      for await (const chunk of stream.chunks) {
        if (!sawFirstToken) { sawFirstToken = true; mark("first token"); }
        // §2. The receipt lands DURING the answer rather than after it, which is what keeps the
        // instant-attachment UX at roughly the wall-clock moment it had before the decoupling.
        // A plain flag read, never an await: awaiting here would stall the token loop.
        if (!sentAttached && annotation !== undefined) {
          sentAttached = true;
          mark("attached emitted mid-stream");
          yield attachedEvent(annotation);
        }
        answer += chunk.text;
        yield { type: "token", text: chunk.text };
      }
```

with `let sentAttached = false;` declared beside `let answer = ""`.

After the stream's `try/catch` completes, before the `searched` computation:

```ts
  // The classification is read HERE, and this is the only point at which this design can add
  // latency to a turn -- bounded by EXTRACT_DEADLINE_MS, and in practice already overtaken by the
  // answer that just finished streaming.
  const extracted = await classification;
  yield* annotationEvents(extracted, sentAttached);
  mark("classification read");
```

- [ ] **Step 6: Move the post-hoc writes below the stream**

`source_type` stamping, the S2 gap and the backfill all read `extracted` and must now sit after
it is read. Move them, unchanged in logic, to just below Step 5's block:

```ts
  const isPureQuestion = extracted?.intent === "question";
  const isChitchat = extracted?.intent === "chitchat";
  if (isPureQuestion || isChitchat) {
    await userDb.from("notes")
      .update({ source_type: isPureQuestion ? "chat" : "chitchat" })
      .eq("id", args.noteId);
  }

  const gap = extracted && pendingAsk === null
    ? detectEntityGap(extracted.domain, extracted.domainMeta)
    : null;

  // S2 §6. THE BACKFILL. The note the question was about gets the entity link the answer just
  // produced -- and nothing else. Not domain_meta, not content_text: the original note said
  // nothing about a rating, and writing one into it would be putting words in the user's mouth.
  // `userDb`, so RLS proves ownership: pendingAsk.noteId comes out of a jsonb column and is
  // validated nowhere else. Failure is logged and swallowed -- the answer has already streamed.
  let backfilled = false;
  if (pendingAsk !== null && extracted?.mediaItemId !== undefined && pendingAsk.noteId !== args.noteId) {
    const { data, error } = await userDb.from("notes")
      .update({ media_item_id: extracted.mediaItemId })
      .eq("id", pendingAsk.noteId)
      .is("deleted_at", null)      // a note trashed mid-conversation must not be linked
      .is("media_item_id", null)   // and an existing link is never overwritten
      .select("id").maybeSingle();
    if (error) {
      console.error(`[assistant] follow-up backfill failed (request ${requestId}): ${error.message}`);
    } else if (data !== null) {
      backfilled = true;
    }
    mark("follow-up backfilled");
  }
```

Delete the now-duplicated originals: the old media-resolve block at `:266-279`, the old backfill at
`:290-310`, the old `attached` yield at `:312-315`, the old mood block at `:320-334`, and the old
`isPureQuestion`/`source_type` block at `:416-421`. The `prompt`/`model` block from Task 3 must
also move above the budget check if it is not already there — it depends only on `citations`,
`history` and `pendingAsk`, none of which involve the classification.

The `answersAQuestion` derivation from Task 3 stays where it is, below the stream: `extracted` is
in scope there.

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm turbo run lint typecheck test`
Expected: PASS, including the pre-existing over-budget test and every S2 test.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/assistant/turn.ts packages/core/src/assistant/turn.test.ts
git commit -m "feat(assistant): stop the reply waiting on classification

The reply now starts as soon as retrieval lands. extractNote still runs on this
turn, concurrently, and is read after the answer has streamed -- where every one
of its consumers already lived.

attached is emitted mid-stream the moment it settles, so the receipt does not
slide to after the answer. EXTRACT_DEADLINE_MS goes 4s -> 15s: it no longer sits
in front of the reply, so the old value only bought needless degraded turns."
```

---

### Task 5: Delete what the gate was holding up

**Why:** Three prompt builders, two rules and one interface field now have no callers. Dead prompt
code is worse than dead application code — it reads as something the model might still be seeing.

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts`, `packages/core/src/assistant/prompts.test.ts`, `packages/core/src/assistant/follow-up.ts`, `packages/core/src/assistant/follow-up.test.ts`, `packages/core/src/enrich/extract.ts`

**Interfaces:**
- Consumes: nothing — this task only removes.
- Produces: `EntityGap` loses `wants` and keeps `{ domain, field }`.

- [ ] **Step 1: Delete the three old builders and the two dead rules**

From `packages/core/src/assistant/prompts.ts`, delete `buildAnswerPrompt`, `buildAcknowledgePrompt`, `buildChitchatPrompt`, `VERIFY_RULE` and `followUpRule`, with their doc comments. Leave a single breadcrumb where they were:

```ts
// buildAnswerPrompt / buildAcknowledgePrompt / buildChitchatPrompt lived here, selected by
// turn.ts from a classification, along with VERIFY_RULE (rendered only on a classifier-flagged
// claim) and followUpRule (rendered only when detectEntityGap named a missing field). All five
// were removed on 2026-08-29 with the gate that chose between them -- see buildTurnPrompt above,
// CORRECTION_RULE for what replaced VERIFY_RULE, and ENGAGE_RULE for what replaced followUpRule.
// Recoverable from git history.
```

- [ ] **Step 2: Retarget the skipped tests, and delete the ones that no longer describe anything**

`prompts.test.ts` holds 24 `it.skip`'d tests, skipped by `fd65f16` when the rule stack was stripped. Task 2 rewrote every rule they covered as a `buildTurnPrompt` assertion. Delete the `describe("buildAnswerPrompt")`, `describe("buildAcknowledgePrompt")` and `describe("buildChitchatPrompt")` blocks entirely, along with the temporary comment at `:21-26` explaining the skips.

Before deleting, read each skipped test and confirm Task 2's suite covers its behaviour. Two need explicit checks because they assert on things `buildTurnPrompt`'s tests do not name directly:

- `"numbers the citations so the answer can refer to them"` (`:43`) — obsolete. S1.5 §3.1 removed bracketed numbers deliberately; this test was already asserting behaviour the product no longer wants. Delete without replacement.
- `"renders a note's title beside its snippet when it has one"` (`:55`) — not covered by Task 2. Port it:

```ts
it("renders a note's title beside its snippet when it has one", () => {
  const p = buildTurnPrompt({
    text: "q", citations: [cite({ title: "Ngủ", snippet: "7 tiếng" })],
    history: [], timeZone: TZ, now: NOW, justAsked: false,
  });
  expect(p).toContain("Ngủ: 7 tiếng");
});
```

Run `grep -n "it.skip" packages/core/src/assistant/prompts.test.ts` afterwards. Expected: no matches. A surviving `it.skip` in this file means a behaviour was dropped without a decision.

- [ ] **Step 3: Delete `EntityGap.wants`**

In `packages/core/src/assistant/follow-up.ts`, remove the `wants` field from the interface and from the returned object, and update the doc comment:

```ts
export interface EntityGap {
  domain: "media";
  /**
   * The dotted path of what is missing. Stored in `chat_messages.retrieval_meta.asked.field`, so
   * a later read can say what was asked for without re-deriving it from the note.
   */
  field: string;
  // `wants` -- the English phrase handed to followUpRule -- lived here until 2026-08-29. The
  // prompt no longer receives the gap at all: the reply is generated before classification
  // settles, and ENGAGE_RULE draws the question out generically. This interface now records only
  // what is written down, never what is asked for. Recoverable from git history.
}
```

Update this file's header comment, which describes a mechanism that has changed: `detectEntityGap` no longer decides whether the assistant *asks*, only whether the turn *records* that it did.

In `follow-up.test.ts`, delete any assertion on `wants` and keep every assertion on `field` and on the null cases — those five tests are the whole value of the file and none of them depended on `wants`.

- [ ] **Step 4: Correct extract.ts's now-stale comment**

`checkable_claim`'s comment at `packages/core/src/enrich/extract.ts:42-45` says it "is acted on" and that "a flagged statement is the only statement that reaches ANSWER_MODEL". Both are now false. Replace:

```ts
    // Stage C5 §9.2. RECORDED, NOT ACTED ON since 2026-08-29 -- it joins `complexity`. It used to
    // be the only thing that promoted a statement to the reasoning model; every turn reaches that
    // model now, and the correction rule carries its own scope in words instead (prompts.ts's
    // CORRECTION_RULE). Kept because it costs a couple of output tokens on a call that is already
    // happening and it keeps the flag RATE measurable, which is the only route to answering C5
    // §15's open question of whether the flagging was ever useful.
    checkable_claim: { type: "boolean" },
```

Correct the same claim in the `checkableClaim` return comment at `:378-381` and in `alsoWantsAnswer`'s at `:373-377` — `alsoWantsAnswer` now gates only the offer, not the model.

- [ ] **Step 5: Run the full gate**

Run: `pnpm turbo run lint typecheck test`
Expected: PASS. `lint` catches any import of a deleted builder.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/assistant/prompts.ts packages/core/src/assistant/prompts.test.ts \
        packages/core/src/assistant/follow-up.ts packages/core/src/assistant/follow-up.test.ts \
        packages/core/src/enrich/extract.ts
git commit -m "refactor(assistant): remove what the classify-gate was holding up

Three prompt builders, VERIFY_RULE, followUpRule and EntityGap.wants, none of
which have a caller now. Un-skips prompts.test.ts by retargeting its 24 skipped
assertions onto buildTurnPrompt rather than leaving them as permanent dead
weight, and corrects two extract.ts comments that still describe model routing
this stage deleted."
```

---

### Task 6: Verify, including what no test can assert

**Why:** Spec §10's last block. Four of this stage's claims are judgments over real Vietnamese replies, and a green suite implies none of them. This task exists so they are performed rather than assumed.

**Files:** none modified — this is verification.

- [ ] **Step 1: Prove the suite actually ran**

```bash
pnpm turbo run lint typecheck test
```

Read the `Cached:` line in turbo's summary. If tasks were replayed from cache rather than executed, the run proves nothing about this change:

```bash
pnpm turbo run lint typecheck test --force
```

- [ ] **Step 2: Prove the regression test can fail**

Temporarily add `await classification;` immediately above the `const prompt = buildTurnPrompt({` call in `turn.ts`, then:

```bash
pnpm turbo run test --filter=@cortex/core --force
```

Expected: FAIL on both "answers in full while classification is still hanging" and "opens the model stream before classification has settled". **Revert the line.** A regression test that stays green with the regression present is the defect this repo has shipped in every stage so far.

- [ ] **Step 3: Record the grounding baseline before deploying**

The rate this change puts at risk is measurable and a before-number only exists until the deploy. Against whichever database the real usage lives in:

```sql
select date_trunc('day', created_at) as day,
       count(*) filter (where kind = 'chat')      as chat_turns,
       count(*) filter (where kind = 'grounding') as grounded,
       round(sum(cost_usd)::numeric, 4)           as usd
from usage_ledger
where source = 'assistant' and created_at > now() - interval '14 days'
group by 1 order by 1;
```

Save the output into the PR description. After a day of real use, run it again: `grounded / chat_turns` is the number spec §7 says to tighten `GROUNDING_RULE` from, if it needs tightening.

- [ ] **Step 4: The manual checks, on a real device or the web client**

Not assertable by any test. Each has a stated failure to watch for:

| Type this | Watch for |
|---|---|
| `Bơi lội có giúp phát triển cơ bắp không` | A real answer. This is the reported bug. |
| `Kiểu bơi nào dễ cho người mới bắt đầu` | A real answer — the second half of the same report. |
| `hôm nay tôi chạy bộ ở công viên` | An acknowledgement plus one engaged line. **No web sources.** |
| `haha ok` | One light line. No topic started, no follow-up question. |
| `hôm nay tôi mới đi xem phim` | One natural question about which film — with `followUpRule` gone, ENGAGE_RULE has to produce this on its own. |
| …then `Interstellar, hay lắm` | The reply does not ask a second question (S2 ceiling), and both notes carry the same `media_item_id`. |
| A health question, e.g. `ăn gì tốt cho mắt` | Garbled or invented terms. The benchmark produced `"cơ bắp tay trinit"` once on this model, in this domain. |
| Anything at all | The reply never says what it filed the note under — that is now the `attached` receipt's job (§5.1). |

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/2026-08-29-one-prompt-turn
gh pr create --title "One prompt, one model: remove the classify-gate" --body "$(cat <<'EOF'
Implements `docs/superpowers/specs/2026-08-29-one-prompt-turn-design.md`.

Every chat turn used to ask a separate model what kind of message it was before
deciding how to reply. When that call timed out, a keyword fallback decided —
and it misrouted real Vietnamese questions into "note filed" twice, on
2026-08-24 and 2026-08-29. The classifier was right both times; it just wasn't
asked in time. This removes the gate rather than adding a third keyword to it.

- one prompt (`buildTurnPrompt`) and one model (`gemini-3.5-flash`), chosen unconditionally
- classification still runs on the same turn, concurrently, read after the answer streams
- `attached` emitted mid-stream, so the receipt does not slide to after the reply
- S2's ceiling survives: `pendingAsk` needs no classification, so it still renders a rule
- grounding is now offered on every turn, controlled by a prompt rule and measured

Overturns three documented decisions, each named at its site in the spec:
C4/parent §6 obligation 3, C5 §9.1, and the cheap model for statements.

## Grounding baseline
<!-- paste Task 6 Step 3's output -->

## Manual verification
<!-- Task 6 Step 4's table, with results -->
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec § | Task |
|---|---|
| §1 post-hoc annotator | 4 |
| §2 `attached` mid-answer | 4 |
| §3 deadline 4000→15000 | 4 |
| §4 ceiling + post-hoc `asked` | 2 (rule), 3 (wiring), 4 (recording) |
| §5 merged prompt | 2 |
| §5.1 no filing narration | 2 (test), 5 (deletion) |
| §6 turn.ts deletions, offer gate | 3 |
| §7 grounding + pricing | 1 (price), 2 (rule), 6 (measurement) |
| §8 correction scope | 2 |
| §9 no client change | none — asserted by omission; no task touches `apps/` |
| §10 testing | 1-4 (automated), 6 (manual) |
| §13 `EntityGap.wants` | 5 |

**Type consistency:** `buildTurnPrompt`'s parameter object is identical in Task 2's definition, Task 2's tests, Task 3's call site and Task 5's ported test. `Annotation` is defined once in Task 4 and consumed by `attachedEvent` and `annotationEvents` in the same task. `answersAQuestion` is introduced in Task 3 and relocated (not renamed) in Task 4.

**One thing deliberately left to the implementer:** Task 4 Step 6 says to move the `prompt`/`model` block above the budget check "if it is not already there". Its exact position depends on how Task 3's edit landed. The constraint is stated rather than the line number, because the line numbers will have moved.
