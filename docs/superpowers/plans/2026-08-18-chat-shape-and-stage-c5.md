# Chat Reply Shape and Stage C5: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A turn that both records something and asks something gets answered instead of silently filed; replies read like a person recalling a conversation rather than a database reporting a match; markdown actually renders; and the assistant can check a doubtful claim, offer to save what it contributed, and remember a refusal.

**Architecture:** Two parts in one file, and they merge separately. **Part A** (Tasks 1–8) reshapes the existing turn: one added classifier boolean turns the single `isQuestion` gate into an ordered routing chain, three prompt edits change what the replies say, and a markdown renderer lands on both clients before the rule about reply shape is written against it. **Part B** (Tasks 9–15) is stage C5 and builds on Part A's chain: a second classifier boolean adds a verification branch below `wantsAnswer`, and a new save-as-note path is reached two ways — a chip the user taps and an offer the model makes — which must produce the same row.

**Tech Stack:** TypeScript, pnpm/Turborepo, NestJS (`apps/api`), Next.js App Router (`apps/web`), Expo/React Native (`apps/mobile`), Supabase Postgres, Vitest, Playwright, Maestro.

**Specs:**
- `docs/superpowers/specs/2026-08-18-chat-dual-intent-and-tone-design.md` — Part A (all four items)
- `docs/superpowers/specs/2026-08-16-stage-c4-c5-conversation-design.md` §8–§15 — Part B

**Merge point:** Part A is a bug fix to something the user hits daily and should reach `main` on its own. Do not hold it for Part B.

---

## Spec corrections — read these before Task 1

Five statements across the two specs are wrong against the tree as of 2026-08-18. None reverses a design decision; all five change what the implementer will find.

**1. Line numbers in both specs are stale.** The temporal-context work (merged in `36a1238`) rewrote `prompts.ts`. `buildAnswerPrompt` is line 77, not 42. `buildAcknowledgePrompt` is line 110, not 72. The sentence C5 §9.3 quotes as `prompts.ts:79` — *"The user did not ask a question. Do not answer one, and do not invent one to answer."* — is **line 131**. It is still there verbatim. Search by text, not by line.

**2. Both prompt builders now take `timeZone` and `now`.** Every `buildAnswerPrompt` / `buildAcknowledgePrompt` call and every test fixture in this plan includes them. Neither spec mentions them, because both predate the temporal work.

**3. `memory_facts.category` is `not null` with an 8-value CHECK, and none of the eight fits.** C5 §12.1 says a declined offer is "a row at `status = 'rejected'`" and never mentions `category`. The column is `not null check (category in ('identity','preference','interest','project','habit','opinion','skill','relationship'))` (`00005_memory_feedback.sql`) — every one of those is a claim **about the user**. A declined offer is a claim about the world that the user did not want kept. Forcing it into `'interest'` or `'opinion'` writes a false statement about the user into the most trust-sensitive table in the system.

Task 13 therefore adds `'assistant_offer'` via migration `00033`, and **keys §12.2's carve-out on the category** in addition to the `evidence` marker the spec names. This is stricter than the spec, not looser: a jsonb marker can be forgotten by a query that filters on everything else, while a category cannot be — it is in the same `WHERE` clause every consumer already writes. Both are written; the exclusion is documented as keying on the category.

**4. The nightly `memory.update` does not exist.** There is no `packages/core/src/memory/`, and a grep for `memory_facts` across `packages/` and `apps/` finds only `packages/db/src/test/`. C5 §14's row *"a declined offer never reaches the nightly memory update — turns red when the `evidence` carve-out is dropped"* **cannot be written as a behavioural test**: there is no consumer to exclude the row from, so any test claiming to assert it would be asserting nothing.

This is the defect this repo has shipped repeatedly — a test that cannot fail. Task 13 writes the honest version instead and says so in the file: assert the row is **written** with the category and marker a future job will filter on, and assert the CHECK constraint accepts the new value. The behavioural test is listed as owed by whichever stage builds the nightly job. Do not write a test that mocks a pipeline that does not exist and call §14 covered.

**5. Retrieval does not carry the source type.** C5 §10 says *"retrieval carries the source type so chat cites such a note as something the user saved, never as their own thinking"*, and presents it alongside the 0.8 down-weight as *"already built"*. Only the down-weight is. `search_notes` returns `note_id, title, created_at, snippet, score, matched_by` and no `source_type` (`00032_search_notes_created_at.sql`), `retrieve.ts`'s `SearchRow` and `Citation` have no such field, and `renderCitations` therefore cannot tell the model that a note came from an earlier answer.

A saved answer is consequently ranked lower **and cited exactly like the user's own note**. Closing it means a new `search_notes` migration, a widened `Citation` on both sides of the wire, and a `renderCitations` change — a task of its own, not a step inside one. This plan does **not** do it; it is named in "What this plan does not deliver" so the next stage inherits it as a decision. Do not quietly widen Task 11 to cover it.

---

## Global Constraints

- **Run package tests through turbo, never through the package directly.** `pnpm turbo run test --filter=@cortex/core` — not `pnpm --filter @cortex/core test`. `@cortex/shared` and `@cortex/core` resolve as compiled `dist/`, so the direct form tests stale output.
- **A cached turbo run is not a run.** Read the `Cached:` line in turbo's summary. With Docker down the database-backed suites replay a previous green without executing. Use `--force` on any gate whose result you are about to report.
- **No test may ever call the real Gemini API.** Use `createFakeAi` (`packages/core/src/ai/fake.ts`) or `bootstrapTestApp({ ai: createFakeAi() })` in `apps/api`.
- **No note content, chat text, or model output in any log line or error message.** Master spec §15.6 rule 1. Report a length, never the payload.
- **Never print a line of `apps/api/.env`.** If a connection string must be redacted, split on the **last** `@`, not the first.
- **`supabase db push` targets the HOSTED project by default.** Use `pnpm supabase db push --local` while developing. The unflagged form is production.
- **Migration number: `00033`, and only Task 13 adds one.** The latest is `00032_search_notes_created_at.sql`. Part A adds no migration. C5's save-as-note, offer, and filter chip all add none either — `source_meta jsonb not null default '{}'` already exists (`00002_content.sql:10`) and `feedback_events.subject_type` already lists `'chat_answer'` (`00005`).
- **`enum-parity.test.ts` asserts ordered equality** (`toEqual`) between each zod enum and the live SQL CHECK. `'assistant_offer'` must be appended in the **same position** on both sides — last.
- **New test suites must be named in CI.** `.github/workflows/ci.yml`'s `checks` job filters per package: `@cortex/shared`, `@cortex/sync`, `@cortex/mobile`, `@cortex/web`, `@cortex/db`, `@cortex/api`, `@cortex/core`. Every package this plan touches is already named and every test lands in an existing file or a new file inside one of those packages, so no `ci.yml` change is required. Task 15 verifies this still holds.
- **`extractNote`'s defaults are comparisons, never casts.** Every boolean this plan adds to the classifier defaults to the value that spends no money and makes no claim — see `extract.ts:320-335`. A cast compiles, passes every other test, and lets a malformed model response through into a routing branch.
- **Out of scope, named so nobody adds it:** auto-saving anything; chat history or a transcript on mobile; verifying anything the user did not write; feeding offers or declines into a memory pipeline; buffering the stream to hide partial-markdown flicker; scrollback across earlier sessions.

---

## File Structure

**Created:**
- `apps/web/src/app/markdown.tsx` — the one place an assistant reply becomes elements, used by both the live bubble and a replayed turn (Task 5).
- `apps/mobile/src/components/markdown.tsx` — mobile's equivalent, behind the same one-prop interface (Task 7).
- `supabase/migrations/00033_memory_facts_assistant_offer.sql` — `'assistant_offer'` in `memory_facts_category_check` (Task 13).
- `packages/core/src/assistant/save-answer.ts` — builds the saved-answer note row. One function, because Task 12's offer and Task 15's chip must produce an identical row (Task 11).
- `packages/core/src/assistant/save-answer.test.ts` — its tests (Task 11).
- `packages/core/src/assistant/offer.ts` — decides whether to offer, including the semantic dedup against declined facts (Tasks 12, 14).
- `packages/core/src/assistant/offer.test.ts` — its tests (Tasks 12, 14).
- `packages/core/src/assistant/decline.ts` — writes the declined-offer row and the feedback event (Task 13).
- `packages/core/src/assistant/decline.test.ts` — its tests (Task 13).

**Modified:**
- `packages/core/src/index.ts` — the package barrel. **There is no `packages/core/src/assistant/index.ts`**; the barrel is one flat file listing each module explicitly (`export * from "./assistant/turn.js"`, …). Every module this plan creates needs a line added here or `apps/api` cannot import it (Tasks 11, 12, 13).
- `packages/core/src/enrich/extract.ts` — `alsoWantsAnswer` (Task 1) and `checkable_claim` (Task 9) on `Extraction`, `RESPONSE_SCHEMA`, the prompt rules, and the defaulted return.
- `packages/core/src/enrich/extract.test.ts` — both flags' rule and defaulting coverage (Tasks 1, 9).
- `packages/core/src/assistant/turn.ts` — the ordered routing chain (Tasks 2, 9); the offer event (Task 12).
- `packages/core/src/assistant/turn.test.ts` — routing, model choice, grounding and stamping per branch (Tasks 2, 9, 12).
- `packages/core/src/assistant/prompts.ts` — the recall-tone rules (Task 3), `FORMAT_RULE` (Task 8), the verification exception (Task 10).
- `packages/core/src/assistant/prompts.test.ts` — their tests (Tasks 3, 8, 10).
- `packages/shared/src/enums.ts` — `memoryCategory` gains `'assistant_offer'` (Task 13).
- `packages/shared/src/enums.test.ts` — its options assertion (Task 13).
- `packages/shared/src/dto/assistant.ts` — the `offer` event's payload type (Task 12); `saveAnswerInput` (Task 11).
- `packages/shared/src/notes/filters.ts` — the saved-external narrowing (Task 15).
- `packages/shared/src/notes/filters.test.ts` — its tests (Task 15).
- `apps/web/src/app/provenance.tsx` — the notes block is deleted (Task 4).
- `apps/web/src/app/assistant-box.tsx` — markdown (Task 5); the offer's UI and its two buttons (Tasks 12, 13).
- `apps/web/src/app/assistant-box.test.tsx` — the above (Tasks 4, 5, 12, 13).
- `apps/web/src/app/globals.css` — markdown element styles and the `pre-wrap` scoping fix (Task 5); the offer row (Task 12).
- `apps/web/src/app/note-list.tsx` — the saved-external chip (Task 15).
- `apps/web/package.json`, `apps/mobile/package.json` — the markdown dependencies (Tasks 5, 7).
- `apps/mobile/src/screens/assistant-box.tsx` — markdown on `box-answer` (Task 7).
- `apps/api/src/assistant.controller.ts` — **no change**. It relays every event generically (`const { type, ...data } = event`), so a new SSE event type needs nothing here. Verified 2026-08-18.
- `apps/api/src/notes.controller.ts` — `POST /notes/save-answer` (Task 11) and `POST /assistant/decline` (Task 13).

---

# Part A — the chat turn's shape

### Task 1: `alsoWantsAnswer` — the classifier learns that a turn can be both

The eye-fatigue turn — *"Các loại thực phẩm nào tốt cho mắt, dạo này hơi mỏi mắt"* — is a fact to record **and** a question, in one sentence. The classifier returns a single `intent`, so it picks `"statement"`, and `buildAcknowledgePrompt` then says, at `prompts.ts:131`, *"The user did not ask a question. Do not answer one, and do not invent one to answer."* The model obeys. The note is saved and the question is dropped.

This task adds the flag only. Task 2 makes it route.

**Files:**
- Modify: `packages/core/src/enrich/extract.ts` — `Extraction`, `RESPONSE_SCHEMA`, `buildPrompt`'s intent rules, the return object, the declared return type
- Test: `packages/core/src/enrich/extract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractNote(...)` returns `alsoWantsAnswer: boolean`, defaulted to `false`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/enrich/extract.test.ts`:

```ts
describe("alsoWantsAnswer", () => {
  // THE OBSERVED BUG. A turn can be a fact to file AND a question in one sentence; `intent`
  // holds one value and therefore cannot say so. Without a rule naming that shape explicitly,
  // the model has no reason to set a flag it was never told the purpose of.
  it("tells the model a turn can be both a statement and a question", () => {
    const prompt = buildPrompt("bất kỳ", []);
    expect(prompt).toContain("alsoWantsAnswer");
    // The rule must survive as a rule, not as a bare schema key echoed back.
    expect(prompt).toMatch(/both|vừa|đồng thời/i);
  });

  // intent STAYS "statement". The flag is additive precisely so tagging, domain and filing
  // tone keep working the way they do for any other recorded note -- widening `intent` to a
  // fourth value would have meant re-deciding all three.
  it("keeps intent at statement while asking for an answer", async () => {
    const out = await runExtract({ intent: "statement", alsoWantsAnswer: true });
    expect(out.intent).toBe("statement");
    expect(out.alsoWantsAnswer).toBe(true);
  });

  // THE DEFAULT, AND WHY IT IS A COMPARISON. `required` in a responseSchema is a request, not
  // a guarantee. `false` is the branch that keeps the turn on CLASSIFY_MODEL and off Google,
  // so it is the only safe landing place for a value the model omitted or sent wrong.
  // `value.alsoWantsAnswer as boolean` compiles and lets the string "true" -- or "no" --
  // through into turn.ts, where every non-empty string is truthy.
  it("defaults a missing alsoWantsAnswer to false", async () => {
    expect((await runExtract({ intent: "statement" })).alsoWantsAnswer).toBe(false);
  });

  it("defaults a non-boolean alsoWantsAnswer to false", async () => {
    expect((await runExtract({ intent: "statement", alsoWantsAnswer: "yes" })).alsoWantsAnswer)
      .toBe(false);
  });

  // A pure question does not need the flag: `intent: "question"` already routes to the answer
  // prompt. Asserted so nobody later makes the flag REQUIRED for an answer and breaks the
  // path that was always working.
  it("leaves a pure question's flag false without changing its routing", async () => {
    const out = await runExtract({ intent: "question" });
    expect(out.intent).toBe("question");
    expect(out.alsoWantsAnswer).toBe(false);
  });
});
```

`runExtract(partial)` is the file's existing shorthand for calling `extractNote` with a scripted model response. If no such helper exists in the file, inline the setup each test already uses rather than adding a second one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- extract`
Expected: FAIL — `alsoWantsAnswer` is not a property of the return value, and the prompt never mentions it.

- [ ] **Step 3: Widen the extraction shape and the schema**

In `packages/core/src/enrich/extract.ts`, add to the `Extraction` interface (after `intent`, line 22):

```ts
  alsoWantsAnswer?: unknown;
```

`unknown`, deliberately, and not `boolean`: this interface describes what the **model sent**, which is unvalidated. Typing it `boolean` would make the defaulting comparison below look redundant to a future reader and invite its removal.

Add to `RESPONSE_SCHEMA.properties`, after `intent`:

```ts
    // Narrowly scoped to the one case `intent` cannot express: a turn that is BOTH something
    // to record and a question. Not a fourth intent -- `intent` still drives tagging, domain,
    // filing tone and chitchat exclusion, and all three are correct at "statement" here.
    alsoWantsAnswer: { type: "boolean" },
```

Leave `required` alone. `alsoWantsAnswer` is deliberately **not** required, for the reason `intent` and `complexity` document at lines 320-322: the default is safe, and a required key the model omits is a malformed response rather than a missing flag.

- [ ] **Step 4: Teach the model what the flag means**

In `buildPrompt`, add to the `Rules:` list immediately after the `"statement"` line and before the "Every one of the three is still SAVED" line:

```ts
    "- alsoWantsAnswer is TRUE when the turn is BOTH something to record and a question they",
    "  want answered — \"Các loại thực phẩm nào tốt cho mắt, dạo này hơi mỏi mắt\" records the",
    "  eye strain and asks what to eat. Keep intent \"statement\" in that case; the flag is what",
    "  says an answer is also wanted. Leave it false for a pure question (intent already says",
    "  so) and for a statement with nothing being asked.",
```

The example is Vietnamese and is the real observed turn, for the same reason the intent rules' examples are: this classifier's input is overwhelmingly Vietnamese, and an English-only example set teaches the shape in the wrong language.

- [ ] **Step 5: Default it on the way out**

In the return object of `extractNote` (beside the existing `intent` line, ~line 334):

```ts
    // A COMPARISON, not a cast, and `=== true` rather than a truthiness check: the model can
    // return the STRING "true", or "no", and both are truthy. The false branch is the one that
    // keeps this turn on CLASSIFY_MODEL and off Google Search, so it is where an unreadable
    // value must land. See extract.test.ts's two default cases.
    alsoWantsAnswer: value.alsoWantsAnswer === true,
```

and add to the declared return type (beside `intent: Intent;`):

```ts
  alsoWantsAnswer: boolean;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- extract`
Expected: PASS.

- [ ] **Step 7: Run the whole package**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS. Nothing reads `alsoWantsAnswer` yet, so no existing behaviour moves.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/enrich/
git commit -m "feat(enrich): let the classifier say a turn is both a note and a question"
```

---

### Task 2: The routing chain — answer while filing

`turn.ts:262` derives `isQuestion` once and uses it for **four** decisions: which prompt runs, the `source_type` stamped on the note, which model answers, and whether Google Search grounding is enabled. That is why the eye-fatigue turn gets none of them.

This task replaces it with `wantsAnswer` and restructures the branch as an **ordered chain** rather than independent booleans. The chain shape is not cosmetic: Task 9 adds a third condition that can be true at the same time as this one, and two booleans read in separate `if`s is exactly how that collision would go unnoticed (design doc §1.1).

**Files:**
- Modify: `packages/core/src/assistant/turn.ts:262-298`
- Test: `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: `extractNote(...)`'s `alsoWantsAnswer: boolean` (Task 1).
- Produces: nothing importable. The chain's shape is what Task 9 extends.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/assistant/turn.test.ts`. `dbs()` returns `{ client, inserted, updated }` and `ai(value)` takes an extraction override — both already exist (added in the C4 plan's Tasks 1 and 4).

```ts
// THE TURN THIS WHOLE TASK EXISTS FOR: a note to file AND a question, in one sentence. From
// the routing point on it must be indistinguishable from a pure question -- same prompt, same
// model, same grounding, same stamp. Four assertions and not one, because the old `isQuestion`
// drove exactly these four things and a partial fix would leave the answer ungrounded or
// running on flash-lite with nothing to show that it had.
it("answers a statement that also asks something", async () => {
  const { client, updated } = dbs();
  const seen: { prompt?: string; model?: string; grounding?: boolean }[] = [];
  const recordingAi = createFakeAi({
    generateJson: async () => ({
      value: { intent: "statement", alsoWantsAnswer: true, complexity: "simple",
               domain: null, domain_meta: {}, tags: [], mood: null },
      inputTokens: 10, outputTokens: 5, model: "fake-classify",
    }),
    generateStream: async (a) => {
      seen.push(a);
      return {
        chunks: (async function* () { yield { text: "Cá hồi và rau xanh." }; })(),
        usage: () => ({ inputTokens: 5, outputTokens: 4, model: ANSWER_MODEL }),
      };
    },
  });

  await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));

  expect(seen[0]?.model, "must reach the answer model").toBe(ANSWER_MODEL);
  expect(seen[0]?.grounding, "must be allowed to search the web").toBe(true);
  expect(updated.notes ?? []).toContainEqual(expect.objectContaining({ source_type: "chat" }));
  // The acknowledge prompt's refusal is the sentence that swallowed the question. Its absence
  // is the only direct evidence the ANSWER prompt ran rather than a reworded acknowledge one.
  expect(seen[0]?.prompt).not.toMatch(/did not ask a question/i);
});

// Confirmed by the user: this branch must NOT announce a save. The property is bought by
// routing to buildAnswerPrompt, which has no filing language -- so this asserts the outcome,
// which stays green against a correct implementation and red against one that "helpfully"
// adds a filing line to the answer prompt.
it("does not announce the filing when it answers a statement", async () => {
  const { client } = dbs();
  const seen: { prompt?: string }[] = [];
  const recordingAi = createFakeAi({
    generateJson: async () => ({
      value: { intent: "statement", alsoWantsAnswer: true, complexity: "simple",
               domain: "health", domain_meta: {}, tags: [], mood: null },
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
  expect(seen[0]?.prompt).not.toMatch(/You filed it under/i);
  expect(seen[0]?.prompt).not.toMatch(/Mention what you attached/i);
});

// THE REGRESSION GUARD, and the one that makes the flag worth having rather than a blanket
// widening. An ordinary recorded note -- no question in it -- must stay on the cheap model,
// must not ground, and must keep the 'quick' source_type it was created with. Drop the
// `alsoWantsAnswer` condition and write `intent === "statement"` instead and this goes red.
it("leaves an ordinary statement on the cheap path", async () => {
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
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: CLASSIFY_MODEL }),
      };
    },
  });
  await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(seen[0]?.model).toBe(CLASSIFY_MODEL);
  expect(seen[0]?.grounding).toBeFalsy();
  expect((updated.notes ?? []).some((r) => "source_type" in r)).toBe(false);
});

// Chitchat must not be reachable through the new flag. "haha ok" with a spurious
// alsoWantsAnswer must stay small talk: grounding "haha ok" against Google is the single most
// wasteful thing this system can be made to do, and a flag the model sets is not trusted input.
it("never lets the flag promote chitchat", async () => {
  const { client } = dbs();
  const seen: { model?: string; grounding?: boolean }[] = [];
  const recordingAi = createFakeAi({
    generateJson: async () => ({
      value: { intent: "chitchat", alsoWantsAnswer: true, complexity: "simple",
               domain: null, domain_meta: {}, tags: [], mood: null },
      inputTokens: 10, outputTokens: 5, model: "fake-classify",
    }),
    generateStream: async (a) => {
      seen.push(a);
      return {
        chunks: (async function* () { yield { text: "hehe" }; })(),
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: CLASSIFY_MODEL }),
      };
    },
  });
  await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(seen[0]?.model).toBe(CLASSIFY_MODEL);
  expect(seen[0]?.grounding).toBeFalsy();
});
```

Import `ANSWER_MODEL` and `CLASSIFY_MODEL` from `@cortex/shared` at the top of the file if they are not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- assistant`
Expected: FAIL — the statement-with-question turn runs `CLASSIFY_MODEL` with `grounding: false` and stamps nothing.

- [ ] **Step 3: Replace the gate with an ordered chain**

In `packages/core/src/assistant/turn.ts`, replace lines 262-286 (from `const isQuestion` through `const model = ...`):

```ts
  // AN ORDERED CHAIN, not a set of independent booleans, and the order is the decision.
  //
  // `wantsAnswer` covers two shapes that behave identically from here on: a pure question, and
  // a statement the classifier flagged as also asking something (design doc §1). The second is
  // the eye-fatigue turn -- "Các loại thực phẩm nào tốt cho mắt, dạo này hơi mỏi mắt" -- which
  // was classified `statement`, routed to buildAcknowledgePrompt, and had its question dropped
  // by that prompt's "The user did not ask a question" rule.
  //
  // `intent` stays "statement" for that turn on purpose: it still drives tagging, domain and
  // the filing tone correctly. Only the reply branch was ever wrong.
  //
  // Chitchat is checked SECOND and can never be reached by the flag: grounding "haha ok"
  // against Google is the most wasteful thing this system can be told to do, and
  // `alsoWantsAnswer` is a value a model produced, not trusted input.
  const wantsAnswer = extracted?.intent === "question"
    || (extracted?.intent === "statement" && extracted?.alsoWantsAnswer === true);
  const isChitchat = extracted?.intent === "chitchat";

  // A note that already exists, restamped after classification -- the shape 'chat' has used
  // since C1. An ordinary statement is the default branch and writes nothing: every plain
  // capture keeps the 'quick' the row was created with.
  if (wantsAnswer || isChitchat) {
    await userDb.from("notes")
      .update({ source_type: wantsAnswer ? "chat" : "chitchat" })
      .eq("id", args.noteId);
  }
  // Resolved once per turn, not per prompt: two calls could not disagree today, but the point
  // of a single resolution is that they cannot start to.
  const timeZone = resolveTimeZone(args.timeZone);
  const now = new Date();
  const prompt = wantsAnswer
    // The FULL turn text, both shapes. "Các loại thực phẩm nào tốt cho mắt, dạo này hơi mỏi
    // mắt" answers better with the eye strain still in it than with the question carved out,
    // and carving it out would need a second model call to decide where the seam is.
    ? buildAnswerPrompt({ question: text, citations: citationsForPrompt, history, timeZone, now })
    : isChitchat
      ? buildChitchatPrompt({ text, history })
      : buildAcknowledgePrompt({
          note: text, domain: extracted?.domain ?? null, tags: extracted?.tagNames ?? [],
          related: citationsForPrompt, history, timeZone, now,
        });
  // Only a turn that wants an answer reaches ANSWER_MODEL, and only it grounds. That ceiling
  // is what keeps the flag cheap: an ordinary capture is untouched by this task.
  const model = wantsAnswer ? ANSWER_MODEL : CLASSIFY_MODEL;
```

- [ ] **Step 4: Move the two remaining `isQuestion` reads**

`isQuestion` is also read at line 292 (`mark(...)`) and line 297 (`grounding: isQuestion`). Both become `wantsAnswer`:

```ts
  mark(`model stream requested (${model}, grounding=${wantsAnswer})`);
```

```ts
      // The whole enablement decision. Never unconditional: see the acknowledge-path test.
      grounding: wantsAnswer,
```

After this the identifier `isQuestion` does not appear in the file. Let the linter confirm — a surviving read is a fifth decision still on the old gate.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- assistant`
Expected: PASS, including every pre-existing turn test — a pure question's four behaviours are unchanged because `wantsAnswer` is true for it by the first clause.

- [ ] **Step 6: Run the whole package**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/assistant/
git commit -m "fix(assistant): answer the question in a turn that is also a note"
```

---

### Task 3: Replies that recall rather than report

Two reply shapes read as machine output, both from the same missing instruction: the prompts ask for a citation and say nothing about how to introduce one.

- *"Đã lưu ghi chú của bạn vào mục không phân loại... nó hoàn toàn trùng khớp với ghi chú trước đó của bạn [1]"*
- *"Trong các ghi chú của bạn [1, 3] có nhắc đến việc bạn đang thắc mắc..."*

`buildAcknowledgePrompt`'s only citation instruction is *"If any of their earlier notes below are genuinely related, say so and cite them like [1]"* and `buildAnswerPrompt`'s is *"Cite the notes you used by their bracketed number, like [1]"*. Neither says anything about phrasing, so the robotic tone is the model's own unconstrained choice — not a hardcoded template.

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts` — a new `RECALL_RULE` const; the two citation instructions
- Test: `packages/core/src/assistant/prompts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing exported. `RECALL_RULE` is module-private, like `LANGUAGE_RULE`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/assistant/prompts.test.ts`. `cite()` is the file's existing citation helper (it has a default `createdAt` since `605d073`).

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`
Expected: FAIL — neither prompt mentions recall or names a forbidden phrasing.

- [ ] **Step 3: Write the rule**

In `packages/core/src/assistant/prompts.ts`, after `LANGUAGE_RULE`:

```ts
/**
 * How a past note gets brought up. On BOTH prompts that read the user's own material, because
 * both produced the reported tone.
 *
 * The observed replies -- "Đã lưu ghi chú của bạn vào mục không phân loại... nó hoàn toàn
 * trùng khớp với ghi chú trước đó của bạn [1]" and "Trong các ghi chú của bạn [1, 3] có nhắc
 * đến việc bạn đang thắc mắc..." -- are not a template this file emits. Nothing here asked for
 * that shape; the prompts said "cite them like [1]" and nothing about phrasing, so the model
 * chose a match report. The fix is an instruction, not a template.
 *
 * The second half is load-bearing and is the half a later edit will drop: "do not sound
 * mechanical" on its own reads as "stop citing", and a model that stops emitting [1] takes
 * every link between a claim and the note behind it. The bracket is required in the same
 * sentence that forbids the framing.
 *
 * Vietnamese examples, matching LANGUAGE_RULE's reasoning: the phrasings being ruled out are
 * Vietnamese phrasings, and an English paraphrase of them is not the thing to avoid.
 */
const RECALL_RULE =
  "When one of their past notes is relevant, bring it up the way a person would recall " +
  "something you told them -- \"bạn có nhắc chuyện này rồi\", \"lần trước bạn có hỏi...\" -- " +
  "inline, in the middle of what you are saying. Do not report a database match: never " +
  "\"Trong các ghi chú của bạn [1, 3] có nhắc đến...\", never \"Đã lưu ghi chú của bạn vào " +
  "mục...\", and never state that a match was found or that something is identical to an " +
  "earlier note. Still carry the bracket, like [1], so they can trace it -- change how you " +
  "introduce the note, not whether you cite it.";
```

- [ ] **Step 4: Use it on both prompts**

In `buildAnswerPrompt`, replace the line `"Cite the notes you used by their bracketed number, like [1].",` with:

```ts
    "Cite the notes you used by their bracketed number, like [1].",
    RECALL_RULE,
```

In `buildAcknowledgePrompt`, replace `"Mention what you attached, briefly. If any of their earlier notes below are genuinely " + "related, say so and cite them like [1].",` with:

```ts
    // The filing confirmation STAYS. The complaint was about phrasing, not about the
    // acknowledgement telling the user what was attached -- that is the content this branch
    // exists to deliver (parent spec §6, obligation 3).
    "Mention what you attached, briefly. If any of their earlier notes below are genuinely " +
      "related, say so and cite them like [1].",
    RECALL_RULE,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`
Expected: PASS.

- [ ] **Step 6: Run the whole package**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/assistant/
git commit -m "feat(assistant): recall a past note instead of reporting a match"
```

---

### Task 4: Drop the notes provenance box

`Provenance` renders a `Từ notes của bạn` section under every reply, bullet-listing each matched note. A matched note is usually the user's own chat message echoed back at them, so the box repeats what they just typed.

**The web block stays, and this is not a preference.** `provenance.tsx:60-68` renders Google's Search Suggestions entry point, and the comment records why: Google's grounding terms require the returned entry point to be displayed (life-domains §6.2). Removing the web half is out of scope regardless of how it looks.

**Files:**
- Modify: `apps/web/src/app/provenance.tsx:34, 39-46`
- Test: `apps/web/src/app/assistant-box.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `Provenance` keeps its exact signature — `{ citations: AnyCitation[]; entryPoint?: string }`. No call site changes.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/app/assistant-box.test.tsx`:

```ts
describe("provenance", () => {
  const noteCitation = {
    type: "note" as const, noteId: "n1", title: null, createdAt: "2026-08-18T02:00:00.000Z",
    snippet: "dạo này hơi mỏi mắt", score: 0.9, matchedBy: "fts",
  };
  const webCitation = { type: "web" as const, url: "https://e.com/a", title: "Eye health" };

  // The box being removed. Asserted on the HEADING, not on the snippet text: the snippet is
  // the user's own message, which also appears in their own bubble in the transcript, so a
  // snippet-based assertion would stay red for the wrong reason.
  it("does not render a notes section", () => {
    render(<Provenance citations={[noteCitation]} />);
    expect(screen.queryByText(/Từ notes của bạn/i)).toBeNull();
  });

  // THE ONE THAT MATTERS MORE THAN THE REMOVAL. The web block is a Google terms-of-service
  // obligation, not a design choice, and it is rendered by the same component from the same
  // array -- so the natural way to break it is to delete one filter too many.
  it("still renders the web section", () => {
    render(<Provenance citations={[noteCitation, webCitation]} />);
    expect(screen.getByText("Từ web")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Eye health" })).toHaveAttribute("href", webCitation.url);
  });

  // Same obligation, the other half: the entry-point widget must survive on a grounded turn.
  it("still renders the grounding entry point", () => {
    const { container } = render(
      <Provenance citations={[webCitation]} entryPoint='<div id="gse">chips</div>' />,
    );
    expect(container.querySelector("#gse")).not.toBeNull();
  });

  // A turn whose only citations are notes must now render NOTHING at all -- not an empty
  // <section> with a heading and no list, which is what a half-deletion leaves behind.
  it("renders nothing when the only citations are notes", () => {
    const { container } = render(<Provenance citations={[noteCitation]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

Import `Provenance` from `./provenance` at the top of the file if it is not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/web -- assistant-box`
Expected: FAIL — the heading renders and the container is not empty.

- [ ] **Step 3: Delete the notes block**

In `apps/web/src/app/provenance.tsx`, delete the whole `{notes.length > 0 && (...)}` expression (lines 39-46) and the now-unused binding on line 34:

```ts
  const notes = citations.filter((c) => c.type === "note");
```

TypeScript will flag `label` as unused once that block is gone. Delete `label` too (lines 20-29) and its doc comment, and drop the now-unused `formatNoteDate` from the import on line 2. `AnyCitation` stays — it is the prop's type.

Update the component's doc comment so it does not describe a block that no longer exists:

```tsx
/**
 * The web half of a turn's provenance, for BOTH the turn that is streaming right now and every
 * turn read back out of chat_messages. One component on purpose: stage C4 §3.1 requires a turn
 * to look the same after a reload as it did while it streamed.
 *
 * There WAS a "Từ notes của bạn" block here listing every matched note. It was removed on
 * 2026-08-18: a matched note is usually the user's own chat message echoed back, so the box
 * repeated what they had just typed, one bubble higher up the same thread.
 *
 * What remains is not a design choice and must not be removed for looking sparse. Google's
 * grounding terms require the returned Search Suggestions entry point to be displayed whenever
 * grounding was used (life-domains spec §6.2); the source list is the other half of that
 * obligation. The `citations` prop still carries note entries -- they feed the PROMPT server-side
 * through renderCitations, which is a separate path from this component and is unaffected.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/web -- assistant-box`
Expected: PASS.

- [ ] **Step 5: Run the whole package**

Run: `pnpm turbo run test --filter=@cortex/web`
Expected: PASS. If an existing test asserted on the notes heading, delete that test — it asserted the behaviour this task removes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/provenance.tsx apps/web/src/app/assistant-box.test.tsx
git commit -m "feat(web): drop the notes provenance box, keep the web one"
```

---

### Task 5: Markdown on web

`apps/web/src/app/globals.css:200` is `.bubble p { margin: 0; white-space: pre-wrap; }` and the answer renders as `<p className="answer">{t.content}</p>`. There is no markdown pipeline anywhere. So `**Cá hồi**` in the model's output reaches the user **as two literal asterisks**.

**Files:**
- Create: `apps/web/src/app/markdown.tsx`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/app/assistant-box.tsx` — both answer render sites
- Modify: `apps/web/src/app/globals.css:200` and the styles below it
- Test: `apps/web/src/app/assistant-box.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function Markdown({ children }: { children: string }): JSX.Element` — one prop, a raw markdown string. Task 7 gives mobile the same one-prop shape so the two clients' call sites read alike.

- [ ] **Step 1: Install the dependencies**

```bash
pnpm --filter @cortex/web add react-markdown@^10.1.0 remark-gfm@^4.0.1
```

`react-markdown@10` declares `react >=18` as a peer, so React 19 satisfies it. `remark-gfm` supplies tables and strikethrough, which the model emits without being asked.

- [ ] **Step 2: Write the failing tests**

Add to `apps/web/src/app/assistant-box.test.tsx`:

```ts
describe("Markdown", () => {
  it("renders emphasis as elements rather than literal asterisks", () => {
    const { container } = render(<Markdown>{"**Cá hồi** tốt cho mắt."}</Markdown>);
    expect(container.querySelector("strong")).toHaveTextContent("Cá hồi");
    expect(container.textContent).not.toContain("**");
  });

  it("renders a list as a list", () => {
    const { container } = render(<Markdown>{"- cá hồi\n- rau xanh"}</Markdown>);
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  // NOT DECORATION. These URLs are chosen by the MODEL, from grounding results we did not vet
  // -- exactly the case provenance.tsx:53 already hardens for. A rendered link without these
  // hands the opener a window reference back into this tab.
  it("hardens links the model produced", () => {
    render(<Markdown>{"xem [ở đây](https://example.com/x)"}</Markdown>);
    const link = screen.getByRole("link", { name: "ở đây" });
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    expect(link).toHaveAttribute("target", "_blank");
  });

  // Raw HTML must NOT be rendered. react-markdown is safe by default (no rehype-raw), and this
  // asserts that nobody adds it later for "richer" output -- model output is untrusted text and
  // this component is the only place it becomes DOM.
  it("does not render raw html from model output", () => {
    const { container } = render(<Markdown>{"<img src=x onerror=alert(1)>"}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
  });

  // A half-written bold marker mid-stream must render as text, not swallow the rest of the
  // answer. This is what every token between "**" and its closing pair looks like.
  it("renders an unterminated marker as text while streaming", () => {
    const { container } = render(<Markdown>{"**Cá h"}</Markdown>);
    expect(container.textContent).toContain("Cá h");
  });
});
```

Import `Markdown` from `./markdown`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/web -- assistant-box`
Expected: FAIL — `./markdown` does not exist.

- [ ] **Step 4: Write the component**

Create `apps/web/src/app/markdown.tsx`:

```tsx
"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * THE one place an assistant reply becomes DOM -- the live streaming bubble and a turn replayed
 * from chat_messages both come through here, so a reply cannot render two ways.
 *
 * Until 2026-08-18 nothing rendered markdown at all: globals.css set `white-space: pre-wrap` on
 * the answer paragraph and the model's `**bold**` reached the user as two literal asterisks.
 *
 * Raw HTML is NOT enabled and must not be. This string is model output, and model output is
 * untrusted -- adding `rehype-raw` here would turn a grounded answer quoting a web page into an
 * injection vector. react-markdown's default is to drop HTML, which is the behaviour we want,
 * so the safety is the absence of a plugin rather than the presence of a sanitiser.
 *
 * Partial markdown is expected. Mid-stream the string is routinely "**Cá h", which renders as
 * those literal characters until the closing pair arrives and then snaps to bold. Accepted:
 * the alternative is buffering the answer until the stream ends, which trades a brief flicker
 * for the loss of streaming.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // The model chose these URLs, out of grounding results nobody vetted. Same hardening
          // provenance.tsx already applies to web sources, for the same reason.
          a: ({ href, children: kids }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{kids}</a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 5: Fix the CSS before wiring it up**

In `apps/web/src/app/globals.css`, line 200 is:

```css
.bubble p { margin: 0; white-space: pre-wrap; }
```

`pre-wrap` must stop applying inside `.markdown`, or every newline is honoured twice — once by the markdown block structure and once by the whitespace rule. Replace that line and add the element styles:

```css
/* pre-wrap is still right for a USER bubble, which is raw text with real newlines in it.
   Inside .markdown the block structure already carries the newlines, so keeping it there
   renders every paragraph break twice. */
.bubble p { margin: 0; white-space: pre-wrap; }
.bubble .markdown p { white-space: normal; margin: 0 0 0.6em; }
.bubble .markdown p:last-child { margin-bottom: 0; }
.bubble .markdown ul,
.bubble .markdown ol { margin: 0 0 0.6em; padding-left: 1.25em; }
.bubble .markdown li { margin: 0.15em 0; }
/* Deliberately small. A reply is a chat message, not a document -- an h1 the size of the page
   title is exactly the "structured writeup" shape FORMAT_RULE (Task 8) exists to discourage. */
.bubble .markdown h1,
.bubble .markdown h2,
.bubble .markdown h3 { font-size: 1em; font-weight: 600; margin: 0.8em 0 0.3em; }
.bubble .markdown h1:first-child,
.bubble .markdown h2:first-child,
.bubble .markdown h3:first-child { margin-top: 0; }
.bubble .markdown code { font-size: 0.9em; padding: 0.1em 0.3em; border-radius: 3px;
  background: rgba(0, 0, 0, 0.06); }
.bubble .markdown pre { overflow-x: auto; padding: 0.6em; border-radius: 4px;
  background: rgba(0, 0, 0, 0.06); }
.bubble .markdown pre code { background: none; padding: 0; }
/* A table is the one thing that can overflow a bubble on a phone. It scrolls inside itself
   rather than widening the thread. */
.bubble .markdown table { display: block; overflow-x: auto; border-collapse: collapse; }
.bubble .markdown th,
.bubble .markdown td { border: 1px solid rgba(0, 0, 0, 0.12); padding: 0.25em 0.5em; }
```

- [ ] **Step 6: Wire both render sites**

In `apps/web/src/app/assistant-box.tsx`, add the import:

```ts
import { Markdown } from "./markdown";
```

The replayed-turn branch (~line 316) becomes:

```tsx
              {t.content && <div className="answer"><Markdown>{t.content}</Markdown></div>}
```

`<div>`, not `<p>`: react-markdown emits block elements, and a `<p>` containing a `<ul>` is invalid HTML that React will warn about and browsers will silently restructure.

Find the live streaming bubble's equivalent render of `answer` further down and apply the same change. **The user bubble at line 312 stays exactly as it is** — `<p>{t.content}</p>`. That is the user's own typed text, not model output; running it through a markdown renderer would reinterpret an asterisk they typed on purpose.

- [ ] **Step 7: Run the tests**

Run: `pnpm turbo run test --filter=@cortex/web`
Expected: PASS for the new tests. **Some pre-existing assertions will fail** and this is expected, not a regression: react-markdown splits text across elements, so a whole-string `getByText("Cá hồi tốt cho mắt.")` no longer matches a single node. Fix each by matching on a substring within one element, or by asserting on `container.textContent`. Do not "fix" one by reverting the render site.

- [ ] **Step 8: Verify by eye**

```bash
pnpm --filter @cortex/web dev
```

Ask something that produces a list. Confirm no literal `**` or `#` on screen, no doubled blank lines between paragraphs, and that a link opens in a new tab. Report what you saw — this step has no automated equivalent.

- [ ] **Step 9: Commit**

```bash
git add apps/web/package.json apps/web/src/app/markdown.tsx apps/web/src/app/assistant-box.tsx \
  apps/web/src/app/assistant-box.test.tsx apps/web/src/app/globals.css pnpm-lock.yaml
git commit -m "feat(web): render assistant replies as markdown"
```

---

### Task 6: Mobile markdown — the spike

**This task's deliverable is an answer, not code.** The original `react-native-markdown-display` has not been published since 2023-12-11. The maintained fork `@ronradtke/react-native-markdown-display@9.0.3` was last published 2026-06-29. Its peer range is `react-native >=0.50.4, react >=16.2.0`, which is permissive enough to install cleanly — that proves npm will not object, **not** that it runs on this app's RN 0.86 / React 19.2 / Expo 57.

Do not skip to Task 7. If this fails, Task 7 is cancelled and mobile keeps plain text; `FORMAT_RULE` (Task 8) is correct either way because it never mentions markdown syntax.

**Files:**
- Modify (temporarily): `apps/mobile/package.json`, `apps/mobile/src/screens/assistant-box.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a go/no-go answer recorded in the commit message or the task report.

- [ ] **Step 1: Install into mobile**

```bash
pnpm --filter @cortex/mobile add @ronradtke/react-native-markdown-display@^9.0.3
```

Record any peer-dependency warning verbatim. A warning is not a failure — it is the thing to check at runtime.

- [ ] **Step 2: Render one string in the real app**

Temporarily replace `apps/mobile/src/screens/assistant-box.tsx:211`:

```tsx
      {answer ? <Text testID="box-answer">{answer}</Text> : null}
```

with:

```tsx
      {answer ? (
        <View testID="box-answer">
          <Markdown>{"**đậm** và:\n\n- một\n- hai\n\n[link](https://example.com)"}</Markdown>
        </View>
      ) : null}
```

and `import Markdown from "@ronradtke/react-native-markdown-display";` at the top. A hardcoded string, not `answer`: this step is testing the library, and using real model output would make a rendering bug and a content problem look the same.

- [ ] **Step 3: Run it on a device**

```bash
pnpm --filter @cortex/mobile android
```

Send any message so `answer` becomes non-empty. Check three things and write down which fail:
1. The app does not redbox on render.
2. Bold shows as bold and the two list items appear as two rows.
3. Metro logs no `react-native-renderer` or `useSyncExternalStore` warning about an incompatible React version.

- [ ] **Step 4: Check the typecheck and the test run**

```bash
pnpm turbo run typecheck --filter=@cortex/mobile
pnpm turbo run test --filter=@cortex/mobile
```

The mobile suite runs under Vitest, not a device. A library reaching for a native module at import time breaks the suite even when the device render worked — that is a real failure and it blocks Task 7 just as much as a redbox.

- [ ] **Step 5: Revert the probe and record the verdict**

```bash
git checkout apps/mobile/src/screens/assistant-box.tsx
```

- **If all four steps passed:** keep the dependency, commit it alone, and proceed to Task 7.

```bash
git add apps/mobile/package.json pnpm-lock.yaml
git commit -m "chore(mobile): add markdown renderer, verified on RN 0.86 / React 19.2"
```

- **If anything failed:** remove the dependency and stop.

```bash
pnpm --filter @cortex/mobile remove @ronradtke/react-native-markdown-display
git checkout apps/mobile/package.json pnpm-lock.yaml
```

Report exactly what failed. **Skip Task 7 and go to Task 8.** Do not substitute another library, hand-roll a renderer, or work around a native-module error — the spec's out-of-scope list names all three.

---

### Task 7: Markdown on mobile

**Gated on Task 6 passing.** If it did not, skip to Task 8.

Mobile's surface is one string: C4 left the transcript off mobile, so `box-answer` at `assistant-box.tsx:211` is the only place an answer is rendered.

**Files:**
- Create: `apps/mobile/src/components/markdown.tsx`
- Modify: `apps/mobile/src/screens/assistant-box.tsx:211`
- Test: `apps/mobile/src/screens/assistant-box.test.tsx` (or the file that currently covers this screen)

**Interfaces:**
- Consumes: `@ronradtke/react-native-markdown-display` (Task 6).
- Produces: `export function Markdown({ children }: { children: string })` — the same one-prop shape as web's, so the two call sites read alike.

- [ ] **Step 1: Write the failing test**

Add to the mobile screen's test file:

```ts
// `box-answer` is the testID the Maestro flows and the existing unit tests both key on. It
// MUST survive the change from <Text> to a wrapper: an e2e flow that can no longer find the
// answer looks exactly like an answer that never arrived.
it("keeps the box-answer testID when rendering markdown", () => {
  const { getByTestId } = render(<Markdown testID="box-answer">{"**đậm**"}</Markdown>);
  expect(getByTestId("box-answer")).toBeTruthy();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile -- assistant-box`
Expected: FAIL — `../components/markdown` does not exist.

- [ ] **Step 3: Write the component**

Create `apps/mobile/src/components/markdown.tsx`:

```tsx
import { View } from "react-native";
import MarkdownDisplay from "@ronradtke/react-native-markdown-display";

/**
 * Mobile's markdown renderer, deliberately given the same one-prop shape as
 * apps/web/src/app/markdown.tsx so both call sites read alike. The libraries underneath are
 * unrelated -- React Native has no DOM, so react-markdown cannot be shared -- and that is
 * exactly why the seam is worth keeping identical.
 *
 * `testID` is threaded through rather than hardcoded: `box-answer` is what the Maestro flows
 * key on, and an e2e flow that cannot find the answer is indistinguishable from an answer that
 * never arrived.
 *
 * The library is pinned to the MAINTAINED fork. The original react-native-markdown-display has
 * not been published since 2023-12-11; this fork's compatibility with RN 0.86 / React 19.2 /
 * Expo 57 was verified on a device before this file was written, not inferred from its peer
 * range, which accepts almost anything.
 */
export function Markdown({ children, testID }: { children: string; testID?: string }) {
  return (
    <View testID={testID}>
      {/* Model output. The library renders no raw HTML, matching web's deliberate omission of
          rehype-raw -- the safety on both clients is the absence of a plugin. */}
      <MarkdownDisplay>{children}</MarkdownDisplay>
    </View>
  );
}
```

- [ ] **Step 4: Wire the screen**

In `apps/mobile/src/screens/assistant-box.tsx`, replace line 211:

```tsx
      {answer ? <Markdown testID="box-answer">{answer}</Markdown> : null}
```

with `import { Markdown } from "../components/markdown";` at the top. Every other `<Text>` on the screen is unchanged — they render our own copy, not model output.

- [ ] **Step 5: Run the tests and the typecheck**

```bash
pnpm turbo run test --filter=@cortex/mobile
pnpm turbo run typecheck --filter=@cortex/mobile
```

Expected: PASS.

- [ ] **Step 6: Check the Maestro flows still find the answer**

```bash
grep -rn "box-answer" apps/mobile/.maestro/ e2e/ 2>/dev/null
```

Any flow asserting on `box-answer` must still pass. Text-based Maestro selectors are already fragile on this app — a header taller than the viewport and the keyboard covering rows have both broken flows before — so if one fails, read the run artifacts before assuming this task caused it.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/components/markdown.tsx apps/mobile/src/screens/assistant-box.tsx \
  apps/mobile/src/screens/assistant-box.test.tsx
git commit -m "feat(mobile): render assistant replies as markdown"
```

---

### Task 8: `FORMAT_RULE` — structure is the exception

`buildAnswerPrompt` carries no length or shape guidance at all, so a casual *"mỏi mắt ăn gì"* comes back as a sectioned writeup with bold category headers — the same shape as a question that explicitly asked to list things out.

**This task runs after markdown rendering, not before.** Written first, the rule would have had to forbid markdown syntax outright and then be unwritten once the renderer landed (design doc §4.1).

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts` — a `FORMAT_RULE` const, used in `buildAnswerPrompt` only
- Test: `packages/core/src/assistant/prompts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing exported. `FORMAT_RULE` is module-private.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/assistant/prompts.test.ts`:

```ts
describe("FORMAT_RULE", () => {
  const answer = () => buildAnswerPrompt({
    question: "mỏi mắt ăn gì", citations: [], history: [],
    timeZone: "Asia/Ho_Chi_Minh", now: new Date("2026-08-18T03:00:00.000Z"),
  });

  it("asks for short conversational prose by default", () => {
    expect(answer()).toMatch(/conversational|prose/i);
    expect(answer()).toMatch(/short/i);
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

  // SCOPING. The natural mistake with a good rule is to apply it everywhere. Both other
  // prompts already cap their own length -- "one or two sentences" and "one short, natural
  // line" -- and a second, differently worded rule gives the model two constraints to
  // reconcile where it currently has one.
  it("stays off the acknowledge and chitchat prompts", () => {
    const ack = buildAcknowledgePrompt({
      note: "dạo này mỏi mắt", domain: null, tags: [], related: [], history: [],
      timeZone: "Asia/Ho_Chi_Minh", now: new Date("2026-08-18T03:00:00.000Z"),
    });
    expect(ack).not.toContain("liệt kê");
    expect(buildChitchatPrompt({ text: "haha ok", history: [] })).not.toContain("liệt kê");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`
Expected: FAIL — `buildAnswerPrompt` says nothing about shape.

- [ ] **Step 3: Write the rule**

In `packages/core/src/assistant/prompts.ts`, after `RECALL_RULE`:

```ts
/**
 * How long a reply should be and what shape it takes. On buildAnswerPrompt ONLY.
 *
 * Observed: a casual "mỏi mắt ăn gì" came back as a multi-section writeup with bolded category
 * headers -- the same shape as a question that had explicitly asked to list things out. The
 * prompt carried no shape guidance at all, so that was the model's default, not a template.
 *
 * BOTH halves are load-bearing and the second is the one a later edit will drop. A bare "keep
 * it short, avoid lists" cap degrades the turn that genuinely asked to enumerate, so the
 * exception is written into the same constant as the default rather than left to judgment.
 * prompts.test.ts asserts each half separately for exactly that reason.
 *
 * It says nothing about markdown syntax. Both clients render markdown as of 2026-08-18, so
 * `**bold**` is no longer literal punctuation on screen -- and a rule phrased around syntax
 * would have to be rewritten the next time a client's rendering changes. The rule is about the
 * SHAPE of the answer, which is stable.
 *
 * Not on buildAcknowledgePrompt ("one or two sentences") or buildChitchatPrompt ("one short,
 * natural line"): both already cap themselves, and a second differently-worded length rule
 * gives the model two constraints to reconcile where it has one.
 */
const FORMAT_RULE =
  "Match the shape of the reply to the weight of the question. A short, casual question " +
  "gets a short, conversational answer -- two or three sentences of prose, no headings and " +
  "no list. Reach for headings or a numbered list only when the user actually asked to " +
  "enumerate or compare (\"liệt kê\", \"các bước\", \"so sánh\", \"list out\"), or when the " +
  "answer genuinely is a set of parallel items that prose would obscure. Structure is the " +
  "exception, not the default shape of an answer.";
```

- [ ] **Step 4: Use it in `buildAnswerPrompt` only**

Add `FORMAT_RULE,` to `buildAnswerPrompt`'s array, immediately after `LANGUAGE_RULE`. Do not add it to the other two builders.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`
Expected: PASS.

- [ ] **Step 6: Run the whole package**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS.

- [ ] **Step 7: Verify by hand — and report it as manual**

**No test in this suite proves the model obeys the rule.** The tests above assert the prompt's content and its scoping, which is the whole of what is mechanically checkable. Run both turns against a real model and report what came back:

1. *"Các loại thực phẩm nào tốt cho mắt, dạo này hơi mỏi mắt"* → expect two or three sentences of prose, no bold headers.
2. *"Liệt kê giúp mình các thực phẩm giàu omega-3"* → expect a list, still.

Check **both**. Checking only the first is how the exception clause gets deleted in a later cleanup as "unused". Do not report these as covered by a green test run.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/assistant/
git commit -m "feat(assistant): scale the reply's shape to the weight of the question"
```

---

### Part A is complete and independently shippable

Run the full gate before opening the PR:

```bash
docker ps
pnpm turbo run test typecheck lint --force
```

Read the `Cached:` line. `--force` is there because a cached replay is not a run.

Part A closes the four items in `2026-08-18-chat-dual-intent-and-tone-design.md`. Open the PR for it now rather than holding it behind Part B — it fixes a turn the user hits daily.

---

# Part B — Stage C5: verification, and the offer to save

### Task 9: `checkable_claim` — the third link in the chain

C5 §9 wants the assistant to push back on a factual claim the user wrote down. The acknowledge branch runs `CLASSIFY_MODEL` (flash-lite), and asking the weakest model in the system to adjudicate truth is asking it to do the task with the most asymmetric failure mode: *"your note is wrong"* when the note is right is far more damaging than silence.

So the flag routes a flagged statement to `ANSWER_MODEL`, and **only** a flagged statement. Ordinary statements stay on flash-lite; the cost has a visible ceiling.

**`alsoWantsAnswer` wins when both fire** (design doc §1.1). *"Omega-3 chữa được cận thị, có đúng không?"* is a recordable statement, a question, and a doubtful claim at once. If the user asked something, they get an answer — being corrected instead of answered is the same silent drop Part A exists to fix, arriving through a different branch.

**Files:**
- Modify: `packages/core/src/enrich/extract.ts` — `Extraction`, `RESPONSE_SCHEMA`, `buildPrompt`, the return
- Modify: `packages/core/src/assistant/turn.ts` — the chain gains its third link
- Test: `packages/core/src/enrich/extract.test.ts`, `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: the ordered chain and `wantsAnswer` (Task 2).
- Produces: `extractNote(...)` returns `checkableClaim: boolean`, defaulted to `false`. `turn.ts` exposes no new export; the chain's third branch is what Task 10 writes a prompt for.

- [ ] **Step 1: Write the failing classifier tests**

Add to `packages/core/src/enrich/extract.test.ts`:

```ts
describe("checkableClaim", () => {
  it("defines the flag in the classification prompt", () => {
    const prompt = buildPrompt("bất kỳ", []);
    expect(prompt).toContain("checkable_claim");
    // A flag with no threshold gets set on everything, and every flagged statement costs the
    // reasoning model. The prompt has to say "doubtful", not merely "factual".
    expect(prompt).toMatch(/doubt|sai|nghi ngờ/i);
  });

  it("passes a flagged statement through", async () => {
    expect((await runExtract({ intent: "statement", checkable_claim: true })).checkableClaim)
      .toBe(true);
  });

  // THE COST CEILING, defaulted the same way and for the same reason as intent and
  // alsoWantsAnswer: false is the branch that never spends ANSWER_MODEL. One schema miss must
  // not silently promote every capture in the corpus onto the reasoning model.
  it("defaults a missing checkable_claim to false", async () => {
    expect((await runExtract({ intent: "statement" })).checkableClaim).toBe(false);
  });

  it("defaults a non-boolean checkable_claim to false", async () => {
    expect((await runExtract({ intent: "statement", checkable_claim: "true" })).checkableClaim)
      .toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- extract`
Expected: FAIL — `checkableClaim` is not on the return value.

- [ ] **Step 3: Add the flag**

In `packages/core/src/enrich/extract.ts`, add to `Extraction` (after `alsoWantsAnswer`):

```ts
  checkable_claim?: unknown;
```

Snake case here and camel case on the way out, matching the model-facing schema key — this interface describes the model's JSON, not our return shape.

Add to `RESPONSE_SCHEMA.properties`:

```ts
    // Stage C5 §9.2. A couple of output tokens on a call that is already happening, and unlike
    // `complexity` this one is acted on: a flagged statement is the only statement that reaches
    // ANSWER_MODEL. Not in `required`, for the reason the defaults below document.
    checkable_claim: { type: "boolean" },
```

Add to `buildPrompt`'s `Rules:` list, after the `alsoWantsAnswer` rule:

```ts
    "- checkable_claim is TRUE only when the note asserts something factual about the world",
    "  that you have real reason to DOUBT — \"omega-3 chữa được cận thị\", \"uống nước đá gây",
    "  ung thư\". Not for anything merely factual, and never for something about their own",
    "  life, their plans, or how they feel: those are theirs to state and not yours to check.",
    "  Leave it false when you are unsure. A false flag costs them a correction they did not",
    "  need on something that was right.",
```

Add to the return object:

```ts
    // Defaulted like every other flag: `false` is the branch that never spends ANSWER_MODEL.
    // See extract.test.ts -- `as boolean` compiles and lets the string "false" through, which
    // is truthy and would promote the turn it was meant to keep cheap.
    checkableClaim: value.checkable_claim === true,
```

and to the declared return type:

```ts
  checkableClaim: boolean;
```

- [ ] **Step 4: Write the failing routing tests**

Add to `packages/core/src/assistant/turn.test.ts`. Define a local helper first, since three of these differ only in the extraction:

```ts
// One recorder for the whole describe: each of these cases cares about the same three
// outputs -- which prompt ran, on which model, with grounding on or off.
const recordTurn = async (extraction: Record<string, unknown>) => {
  const { client, updated } = dbs();
  const seen: { prompt?: string; model?: string; grounding?: boolean }[] = [];
  const ai = createFakeAi({
    generateJson: async () => ({
      value: { intent: "statement", complexity: "simple", domain: null,
               domain_meta: {}, tags: [], mood: null, ...extraction },
      inputTokens: 10, outputTokens: 5, model: "fake-classify",
    }),
    generateStream: async (a) => {
      seen.push(a);
      return {
        chunks: (async function* () { yield { text: "ok" }; })(),
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: "fake" }),
      };
    },
  });
  await collect(runTurn({ userDb: client, serviceDb: client, ai },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  return { seen, updated };
};

describe("the routing chain", () => {
  it("sends a flagged statement to the reasoning model", async () => {
    const { seen } = await recordTurn({ checkable_claim: true });
    expect(seen[0]?.model).toBe(ANSWER_MODEL);
  });

  // THE CEILING. Without this the flag is indistinguishable from "route every statement to
  // the expensive model", which is the one outcome §9.2 was written to prevent.
  it("leaves an unflagged statement on the cheap model", async () => {
    const { seen } = await recordTurn({ checkable_claim: false });
    expect(seen[0]?.model).toBe(CLASSIFY_MODEL);
  });

  // A flagged statement is still a FILING. It keeps the acknowledge prompt -- it just runs it
  // on a model capable of the judgment -- so the "You filed it under" line must survive.
  it("keeps a flagged statement on the acknowledge prompt", async () => {
    const { seen } = await recordTurn({ checkable_claim: true });
    expect(seen[0]?.prompt).toMatch(/You filed it under/i);
  });

  // THE COLLISION, decided in design doc §1.1. Both flags fire on "Omega-3 chữa được cận thị,
  // có đúng không?" -- a recordable statement, a question, and a doubtful claim in one
  // sentence. The user asked, so the user gets an answer; being corrected INSTEAD of answered
  // is the same silent drop Part A exists to fix, reached through a different branch. Two
  // independent `if`s is how this would have gone unnoticed, which is why the chain is ordered.
  it("answers rather than corrects when the turn asks a question too", async () => {
    const { seen, updated } = await recordTurn({ alsoWantsAnswer: true, checkable_claim: true });
    expect(seen[0]?.prompt).not.toMatch(/You filed it under/i);
    expect(seen[0]?.grounding).toBe(true);
    expect(updated.notes ?? []).toContainEqual(expect.objectContaining({ source_type: "chat" }));
  });

  // A flagged statement grounds, so the check has a second source rather than only the model's
  // own memory (C5 §9.3's last paragraph). Separate from the model assertion: they are set on
  // two different lines and a partial edit moves one without the other.
  it("grounds a flagged statement", async () => {
    const { seen } = await recordTurn({ checkable_claim: true });
    expect(seen[0]?.grounding).toBe(true);
  });

  // Chitchat is checked before the claim flag and is never promoted by it.
  it("never promotes chitchat", async () => {
    const { seen } = await recordTurn({ intent: "chitchat", checkable_claim: true });
    expect(seen[0]?.model).toBe(CLASSIFY_MODEL);
    expect(seen[0]?.grounding).toBeFalsy();
  });
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- assistant`
Expected: FAIL — a flagged statement runs `CLASSIFY_MODEL` without grounding.

- [ ] **Step 6: Extend the chain**

In `packages/core/src/assistant/turn.ts`, add the third derivation beside the other two and thread it through the three decisions it touches:

```ts
  const wantsAnswer = extracted?.intent === "question"
    || (extracted?.intent === "statement" && extracted?.alsoWantsAnswer === true);
  const isChitchat = extracted?.intent === "chitchat";
  // THE THIRD LINK, and its position in the chain is the decision (design doc §1.1). Read only
  // when `wantsAnswer` is already false: a turn that asks a question gets ANSWERED, and the
  // correction rides inside that answer rather than replacing it. Written as `!wantsAnswer &&`
  // rather than as a separate `if` further down, because two booleans that can both be true and
  // are read in different places is exactly how this collision was created.
  const verifies = !wantsAnswer && !isChitchat && extracted?.checkableClaim === true;
```

Change the model line:

```ts
  // Two ways onto the reasoning model and no third. `verifies` is capped by the classifier's
  // own threshold ("only when you have real reason to doubt"), so an ordinary capture is
  // untouched -- see turn.test.ts's cheap-model assertion.
  const model = wantsAnswer || verifies ? ANSWER_MODEL : CLASSIFY_MODEL;
```

and the grounding line, in both the `mark` and the call:

```ts
  // A verification checks against a second source rather than the model's own memory alone
  // (C5 §9.3). Where grounding is unavailable it degrades to that memory, which the prompt
  // does not need to know about.
  const grounds = wantsAnswer || verifies;
  mark(`model stream requested (${model}, grounding=${grounds})`);
```

```ts
      grounding: grounds,
```

The `prompt` ternary is **unchanged**: a flagged statement still routes to `buildAcknowledgePrompt`. Only the model and grounding move. Task 10 gives that prompt the exception it needs.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS, including every Part A test — `verifies` is false on all of them.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/enrich/ packages/core/src/assistant/
git commit -m "feat(assistant): route a doubtful claim to the reasoning model"
```

---

### Task 10: The verification prompt, and the rule that silence is not confirmation

`prompts.ts` (search for the text, the spec's line number is stale) says:

> The user did not ask a question. Do not answer one, and do not invent one to answer.

This is in direct conflict with volunteering a correction, and it cannot simply be deleted — it is what stops every acknowledgement from turning into a conversation. It is replaced by the same prohibition **plus one named exception**.

And one addition with no exception: **silence is not confirmation.** The model only looked at the claims it flagged, and the user cannot tell which those were. Any phrasing implying a claim was checked and found correct — "đúng rồi", "chính xác", "xác nhận" — is a claim the system cannot back.

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts` — `buildAcknowledgePrompt` gains a `verify` flag
- Modify: `packages/core/src/assistant/turn.ts` — passes it
- Test: `packages/core/src/assistant/prompts.test.ts`

**Interfaces:**
- Consumes: `verifies` (Task 9).
- Produces: `buildAcknowledgePrompt` takes one added field — `verify: boolean`. Required, not optional: an optional flag defaulting to `false` lets a call site forget it and silently lose the branch.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/assistant/prompts.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`
Expected: FAIL — `buildAcknowledgePrompt` takes no `verify` field.

- [ ] **Step 3: Write the rule**

In `packages/core/src/assistant/prompts.ts`, after `FORMAT_RULE`:

```ts
/**
 * Stage C5 §9.3. Added to buildAcknowledgePrompt only when the classifier flagged the note as
 * carrying a factual claim it has real reason to doubt, and only on the reasoning model --
 * asking flash-lite to adjudicate truth is asking the weakest model in the system to do the
 * task with the most asymmetric failure mode.
 *
 * The first sentence is a CARVE-OUT of the acknowledge prompt's standing "do not answer a
 * question" rule, not a replacement for it. That rule stays on both paths: without it, an
 * acknowledgement becomes a conversation, and this branch would become a debate.
 *
 * The second half has no exception and is the more important of the two. The model looked only
 * at the claim it flagged, and the user cannot tell which claims those were -- so "đúng rồi" on
 * a sentence nothing examined is the system asserting a verification it never performed.
 * Silence has to mean "no basis to doubt", never "checked and confirmed". A system that
 * sometimes confirms is one whose silence starts reading as confirmation too.
 */
const VERIFY_RULE =
  "One exception to the rule above: if something they stated is factually wrong, say so once, " +
  "briefly, in the same breath as the acknowledgement. Name the discrepancy and stop -- do " +
  "not ask a follow-up, do not invite a reply, and do not explain at length. " +
  "Never do the opposite: do not say \"đúng rồi\", \"chính xác\", \"xác nhận\" or anything " +
  "else implying you checked their note and found it correct. You looked at one claim, and " +
  "they cannot tell which. Silence means you had no reason to doubt them, not that you " +
  "confirmed them.";
```

- [ ] **Step 4: Take the flag**

Change `buildAcknowledgePrompt`'s parameter type to include:

```ts
  /**
   * Required rather than optional, deliberately. An optional flag defaulting to false lets a
   * call site forget it, and the symptom -- verification silently never happening -- looks
   * exactly like a classifier that stopped setting the flag.
   */
  verify: boolean;
```

and add to the array, immediately after the `"The user did not ask a question..."` line:

```ts
    "The user did not ask a question. Do not answer one, and do not invent one to answer.",
    // Spread-in rather than an empty string: an ordinary acknowledgement must carry no
    // instruction about verification at all, not a blank line where one used to be.
    ...(a.verify ? [VERIFY_RULE] : []),
```

- [ ] **Step 5: Pass it from the turn**

In `packages/core/src/assistant/turn.ts`, the acknowledge branch gains one field:

```ts
      : buildAcknowledgePrompt({
          note: text, domain: extracted?.domain ?? null, tags: extracted?.tagNames ?? [],
          related: citationsForPrompt, history, timeZone, now,
          // The same boolean that put this turn on ANSWER_MODEL and enabled grounding. One
          // derivation, three uses -- a second condition here could disagree with the model
          // choice and produce a verification prompt running on flash-lite.
          verify: verifies,
        });
```

- [ ] **Step 6: Run the tests**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS. Every existing `buildAcknowledgePrompt` fixture now needs `verify: false` — TypeScript will name each one, which is why the field is required.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/assistant/
git commit -m "feat(assistant): let an acknowledgement correct one claim, and never confirm one"
```

---

### Task 11: Save-as-note — one builder, because two paths must produce one row

Life-domains §6.3 gives the *user* an action: save the model's answer as a note. C5 §11 gives the *model* an opening move toward the same action. **They are the same write reached two ways, and they must produce the same row — by construction, not by care** (§13).

So the row is built by one function that both call. No migration: `source_meta jsonb not null default '{}'` already exists (`00002_content.sql:10`), and `search_notes` already down-weights `'assistant'` and `'web_search'` by 0.8 (`00022:92`, `00024:127`), which is how corpus pollution is handled — by provenance, not prohibition.

**Files:**
- Create: `packages/core/src/assistant/save-answer.ts`
- Create: `packages/core/src/assistant/save-answer.test.ts`
- Modify: `packages/shared/src/dto/assistant.ts` — `saveAnswerInput`
- Modify: `apps/api/src/notes.controller.ts` — `POST /notes/save-answer`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface SaveAnswerArgs { userId: string; statement: string; sourceUrl?: string }`
  - `export function buildSavedAnswerRow(a: SaveAnswerArgs): Record<string, unknown>`
  - `export async function saveAnswer(db: SupabaseClient, a: SaveAnswerArgs): Promise<{ id: string }>`
  - `saveAnswerInput` — a zod schema exported from `@cortex/shared`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/assistant/save-answer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSavedAnswerRow } from "./save-answer.js";

describe("buildSavedAnswerRow", () => {
  // The source type carries the provenance the retrieval ranking keys on. search_notes
  // down-weights 'web_search' and 'assistant' by 0.8 (00022:92); written as 'quick' the saved
  // answer would rank as the user's OWN thinking and be cited back to them as such.
  it("marks a web-cited answer as web_search", () => {
    const row = buildSavedAnswerRow({
      userId: "u1", statement: "Omega-3 có trong cá hồi.", sourceUrl: "https://e.com/a",
    });
    expect(row.source_type).toBe("web_search");
    expect(row.source_meta).toEqual({ url: "https://e.com/a" });
  });

  it("marks an ungrounded answer as assistant", () => {
    const row = buildSavedAnswerRow({ userId: "u1", statement: "Omega-3 có trong cá hồi." });
    expect(row.source_type).toBe("assistant");
    // {} and not { url: undefined }: source_meta is `not null default '{}'`, and a key whose
    // value is undefined survives JSON.stringify as an absent key on some paths and as null on
    // others. An empty object has one meaning.
    expect(row.source_meta).toEqual({});
  });

  // §6.3: it lands in the inbox like any other capture, for the user to file or discard. It is
  // not pre-filed as something they already decided to keep.
  it("lands in the inbox", () => {
    expect(buildSavedAnswerRow({ userId: "u1", statement: "x" }).lifecycle).toBe("inbox");
  });

  // §13, AND THE KEY SET IS THE ASSERTION. `buildSavedAnswerRow(args) === buildSavedAnswerRow(args)`
  // would be a test that cannot fail -- a pure function called twice with one object. Pinning the
  // exact key set is what goes red: the way the two paths stop matching is somebody adding a
  // discriminating field (`via: "offer"`, an `offered_at`, a nondeterministic id) to tell them
  // apart later, and a new key breaks this line the moment it is written.
  it("writes exactly these columns and no discriminator", () => {
    const row = buildSavedAnswerRow({ userId: "u1", statement: "s", sourceUrl: "https://e.com/a" });
    expect(Object.keys(row).sort()).toEqual(
      ["content_text", "lifecycle", "source_meta", "source_type", "user_id"],
    );
  });
});
```

**§14's fifth row is already covered and must not be rewritten.** *"a saved answer is down-weighted in retrieval | db"* is asserted today by `packages/db/src/test/search-notes.test.ts:219-246`, against the real `search_notes` — including the case where only down-weighting **both** `assistant` and `web_search` produces the expected order. That test predates this plan and needs no change; it is what makes `source_type` above load-bearing rather than decorative. Do not add a second copy of it in `@cortex/core` against a stub.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- save-answer`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

Create `packages/core/src/assistant/save-answer.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPostgrestError } from "../errors.js";

export interface SaveAnswerArgs {
  userId: string;
  /** What is being saved: the model's contribution, not the whole reply. */
  statement: string;
  /** The web source it came from, when grounding produced one. Absent means general knowledge. */
  sourceUrl?: string;
}

/**
 * THE row for a saved answer, built in one place because it is reached two ways: the user taps
 * the saved-external chip's save action (life-domains §6.3), or they accept an offer the model
 * made (C5 §11). C5 §13 requires the two to be indistinguishable afterwards -- and the only way
 * to get that by construction rather than by discipline is for there to be one builder.
 *
 * The source type is the load-bearing field. search_notes down-weights 'web_search' and
 * 'assistant' by 0.8 (00022:92, 00024:127), which is how §6.3 handles corpus pollution: by
 * provenance rather than prohibition. Written as 'quick', this note would rank as the user's own
 * thinking and be cited back to them as something they wrote.
 *
 * No migration is needed for any of this. source_meta is `jsonb not null default '{}'` since
 * 00002, and both source types have been in notes_source_type_check since 00020.
 */
export function buildSavedAnswerRow(a: SaveAnswerArgs): Record<string, unknown> {
  return {
    user_id: a.userId,
    content_text: a.statement,
    // The inbox, like any other capture. Not pre-filed: saving is a deliberate act (§6.3), and
    // deciding where it belongs is a second one the user has not made yet.
    lifecycle: "inbox",
    // Grounded or not -- the distinction the user sees when this note is later cited.
    source_type: a.sourceUrl ? "web_search" : "assistant",
    // Spread-if, not `{ url: a.sourceUrl }`: an undefined value round-trips to an absent key on
    // one path and a null on another, and source_meta is a column two readers already parse.
    source_meta: a.sourceUrl ? { url: a.sourceUrl } : {},
  };
}

/**
 * Writes it. Takes the USER's client, so RLS is what proves ownership -- this is a note in the
 * user's own corpus and there is no reason for it to go through the service role.
 */
export async function saveAnswer(
  db: SupabaseClient,
  a: SaveAnswerArgs,
): Promise<{ id: string }> {
  const { data, error } = await db
    .from("notes").insert(buildSavedAnswerRow(a)).select("id").single();
  // Mapped, not rethrown raw: this runs on the HTTP path, and a raw PostgrestError has no
  // `status` and logs as "[object Object]" through CoreErrorFilter (errors.ts:9-13).
  if (error) throw mapPostgrestError(error);
  return { id: (data as { id: string }).id };
}
```

Then add the barrel line. **There is no `packages/core/src/assistant/index.ts`** — `packages/core/src/index.ts` lists each assistant module by hand:

```ts
export * from "./assistant/save-answer.js";
```

beside the existing `./assistant/retrieve.js` line. Without it `apps/api` cannot import `saveAnswer`, and the failure is a module-resolution error at Step 6, not here.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- save-answer`
Expected: PASS.

- [ ] **Step 5: Add the wire schema**

In `packages/shared/src/dto/assistant.ts`:

```ts
/**
 * `.strict()`, matching assistantInput: a body carrying a userId must be a 400, not a value the
 * server quietly drops. The user id comes from the verified JWT and nowhere else.
 *
 * The statement cap matches createNoteInput's 100_000 rather than restating a smaller number --
 * a value acceptable through POST /notes and rejected here would be the same note failing for
 * no reason the user can see.
 */
export const saveAnswerInput = z
  .object({
    statement: z.string().min(1).max(100_000),
    sourceUrl: z.string().url().max(2048).optional(),
  })
  .strict();

export type SaveAnswerInput = z.infer<typeof saveAnswerInput>;
```

- [ ] **Step 6: Add the endpoint**

In `apps/api/src/notes.controller.ts`, following the file's existing handler shape (guard, `@CurrentUser()`, `ZodValidationPipe`, `createUserClient(user.token)`):

```ts
  /**
   * The saved-answer write, reached from the chat box's offer (C5 §11) and from the
   * saved-external chip (§6.3). Both send the same body to the same route, which is half of
   * why the two produce the same row; buildSavedAnswerRow is the other half.
   */
  @Post("save-answer")
  async saveAnswer(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(saveAnswerInput)) body: SaveAnswerInput,
  ): Promise<{ id: string }> {
    return saveAnswer(createUserClient(user.token), {
      userId: user.id,
      statement: body.statement,
      ...(body.sourceUrl !== undefined ? { sourceUrl: body.sourceUrl } : {}),
    });
  }
```

- [ ] **Step 7: Add the e2e test**

Add to `apps/api/test/` in the suite covering notes (follow the existing `bootstrapTestApp({ ai: createFakeAi() })` setup):

```ts
it("saves an answer as a down-weighted inbox note", async () => {
  const res = await request(app.getHttpServer())
    .post("/notes/save-answer")
    .set("authorization", `Bearer ${token}`)
    .send({ statement: "Omega-3 có trong cá hồi.", sourceUrl: "https://e.com/a" })
    .expect(201);

  const { data } = await admin.from("notes")
    .select("lifecycle, source_type, source_meta").eq("id", res.body.id).single();
  expect(data).toMatchObject({
    lifecycle: "inbox", source_type: "web_search", source_meta: { url: "https://e.com/a" },
  });
});

// .strict() doing its job: a body naming a user must be rejected, not silently ignored.
it("rejects a body that tries to name a user", async () => {
  await request(app.getHttpServer())
    .post("/notes/save-answer")
    .set("authorization", `Bearer ${token}`)
    .send({ statement: "x", userId: "00000000-0000-4000-8000-000000000000" })
    .expect(400);
});
```

- [ ] **Step 8: Run both suites**

```bash
docker ps
pnpm turbo run test --filter=@cortex/core --filter=@cortex/api --force
```

Expected: PASS. `--force` because a cached replay of the api suite is not a run.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/assistant/save-answer.ts packages/core/src/assistant/save-answer.test.ts \
  packages/core/src/assistant/index.ts packages/shared/src/dto/assistant.ts \
  apps/api/src/notes.controller.ts apps/api/test/
git commit -m "feat(assistant): save an answer as a provenance-marked inbox note"
```

---

### Task 12: The offer

When the model fills a gap from grounding or from its own knowledge, it offers to save that: one line, one tap, easy to ignore. Carried as its own SSE event, the way `web` is (C3).

**Auto-saving stays rejected.** §6.3: saving is always a deliberate act. The offer is that act's entry point, not a replacement — a distinction that only holds if declining is free, which is Task 13.

**The proposed statement needs a source, and the spec does not name one.** The answer stream is prose; the offer is one saveable sentence. This plan makes one `CLASSIFY_MODEL` call after the stream completes, **gated on the turn having actually searched** (`searched === true`, already computed at `turn.ts:335`). That gate is the cost ceiling: an ungrounded turn makes no extra call. Task 14 adds the dedup step in front of it.

**Files:**
- Create: `packages/core/src/assistant/offer.ts`
- Create: `packages/core/src/assistant/offer.test.ts`
- Modify: `packages/core/src/assistant/turn.ts` — the `offer` event
- Modify: `packages/shared/src/dto/assistant.ts` — the payload type
- Modify: `apps/web/src/app/assistant-box.tsx`, `globals.css`
- Test: `packages/core/src/assistant/turn.test.ts`, `apps/web/src/app/assistant-box.test.tsx`

**Interfaces:**
- Consumes: `saveAnswerInput` and `POST /notes/save-answer` (Task 11).
- Produces:
  - `export interface Offer { statement: string; sourceUrl?: string }` — declared **twice on purpose**, once in `offer.ts` (server-internal) and once in `@cortex/shared`'s `dto/assistant.ts` (the wire type `apps/web` reads). Same split, same reasoning, as the `Citation` pair that file already documents; `apps/web` does not depend on `@cortex/core`.
  - `export async function proposeOffer(deps: { db: SupabaseClient; ai: AiClient }, a: { userId: string; question: string; answer: string; sourceUrl?: string; requestId: string }): Promise<Offer | null>`
  - `AssistantEvent` gains `| { type: "offer"; statement: string; sourceUrl?: string }`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/assistant/offer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeAi } from "../ai/fake.js";
import { proposeOffer } from "./offer.js";

// Both halves matter. `insert` is recordUsage's ledger write; the `select` chain is the dedup
// read Task 14 adds INSIDE this same function. Stub it now, returning no facts, so these tests
// keep exercising the real path once Task 14 lands -- a double missing `select` would throw into
// proposeOffer's dedup catch, and every test in this describe would pass through an error branch
// while still going green.
const db = () => ({
  from: () => ({
    insert: async () => ({ data: null, error: null }),
    select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }),
  }),
}) as never;

const ai = (statement: unknown) => createFakeAi({
  generateJson: async () => ({
    value: { statement },
    inputTokens: 10, outputTokens: 5, model: "fake-classify",
  }),
});

describe("proposeOffer", () => {
  it("proposes the statement the model condensed", async () => {
    const out = await proposeOffer({ db: db(), ai: ai("Omega-3 có trong cá hồi.") },
      { userId: "u1", question: "omega-3 ở đâu", answer: "...", sourceUrl: "https://e.com/a",
        requestId: "r1" });
    expect(out).toEqual({ statement: "Omega-3 có trong cá hồi.", sourceUrl: "https://e.com/a" });
  });

  // THE SILENT PATH, and the one that matters most. An offer on every turn is nagging, and
  // nagging is what makes a user stop reading offers -- at which point the mechanism is worse
  // than not having it. `null` must be a first-class outcome, not an error case.
  it("proposes nothing when the model returns nothing worth saving", async () => {
    for (const empty of [null, "", "   ", 42]) {
      const out = await proposeOffer({ db: db(), ai: ai(empty) },
        { userId: "u1", question: "q", answer: "a", requestId: "r1" });
      expect(out, `statement=${JSON.stringify(empty)}`).toBeNull();
    }
  });

  // An offer whose text is the whole answer is not an offer, it is a save button. The prompt
  // must ask for ONE statement, and the cap is what makes that assertable.
  it("declines a statement too long to be one statement", async () => {
    const out = await proposeOffer({ db: db(), ai: ai("x".repeat(1000)) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" });
    expect(out).toBeNull();
  });

  // A model failure must cost the user nothing. The answer has already streamed; an offer is a
  // bonus on top of it, and a thrown embed or a dead classify call must not turn a completed
  // turn into a failed one.
  it("returns null rather than throwing when the model fails", async () => {
    const failing = createFakeAi({ generateJson: async () => { throw new Error("boom"); } });
    await expect(proposeOffer({ db: db(), ai: failing },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- offer`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

Create `packages/core/src/assistant/offer.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiClient } from "../ai/client.js";
import { recordUsage } from "../enrich/budget.js";
import { errorMessage } from "../errors.js";

/**
 * Structurally identical to @cortex/shared's `Offer`, and deliberately not imported from it --
 * the same split dto/assistant.ts already documents for `Citation`: that one is the WIRE type,
 * which apps/web reads without depending on @cortex/core, and this one is server-internal.
 * TypeScript's structural typing makes them interchangeable across the HTTP boundary, which is
 * the only place they meet.
 */
export interface Offer {
  statement: string;
  sourceUrl?: string;
}

/**
 * A cap, not a preference. An "offer" whose text is the whole answer is not an offer, it is a
 * save button with extra steps -- and it would write the model's entire reply into the user's
 * corpus as a single note. One statement is what §11 asks for and this is what makes that
 * assertable rather than aspirational.
 */
export const OFFER_MAX_CHARS = 400;

const PROMPT =
  "The assistant just answered a question using knowledge that was NOT in the user's own " +
  "notes. Condense the single most useful fact it contributed into ONE standalone sentence " +
  "the user would want kept -- something that stays true and useful a month from now.\n" +
  "Return null if there is no such fact: if the answer was entirely from their own notes, if " +
  "it was purely conversational, or if the only content was ephemeral (today's weather, a " +
  "one-off number). Returning null is the normal case and is always better than a weak offer.\n" +
  "Write it in the same language the user wrote in. Return JSON only.";

const SCHEMA = {
  type: "object",
  properties: { statement: { type: "string", nullable: true } },
  required: ["statement"],
};

/**
 * Decides whether there is anything worth offering to save (C5 §11).
 *
 * A SECOND model call, on CLASSIFY_MODEL, and the caller gates it on the turn having actually
 * searched -- an ungrounded turn contributed nothing external and makes no call at all. That
 * gate is the cost ceiling, and it lives at the call site rather than here because turn.ts is
 * where `searched` is already computed.
 *
 * NEVER THROWS. The answer has already streamed by the time this runs; an offer is a bonus on
 * top of a turn that already succeeded, and a dead classify call must not retroactively fail
 * it. Every failure path returns null, which the caller reads as "no offer" -- the same outcome
 * as the model declining, which is the normal case.
 */
export async function proposeOffer(
  deps: { db: SupabaseClient; ai: AiClient },
  a: { userId: string; question: string; answer: string; sourceUrl?: string; requestId: string },
): Promise<Offer | null> {
  try {
    // NO `model` ARGUMENT. `AiClient.generateJson` takes `{ prompt, schema }` and nothing else
    // (ai/client.ts) -- the model is fixed inside the Gemini implementation, which posts to
    // `models/${CLASSIFY_MODEL}:generateContent` (gemini.ts:328). Passing one here is a type
    // error, not a no-op. `model` comes BACK in the result and is what the ledger records.
    const { value, inputTokens, outputTokens, model } = await deps.ai.generateJson<{
      statement?: unknown;
    }>({
      prompt: `${PROMPT}\n\nTheir question: ${a.question}\n\nThe answer given: ${a.answer}`,
      schema: SCHEMA,
    });

    // Metered, never fatal -- the same trade retrieve.ts documents. Never log the statement or
    // the answer: both are model output about the user's own material (§15.6 rule 1).
    try {
      await recordUsage(deps.db, {
        userId: a.userId, kind: "tag", model, inputTokens, outputTokens,
        source: "assistant", requestId: a.requestId, contentChars: a.answer.length,
      });
    } catch (err) {
      console.error(`[assistant] offer ledger write failed (request ${a.requestId}): ${errorMessage(err)}`);
    }

    const statement = typeof value.statement === "string" ? value.statement.trim() : "";
    if (statement === "" || statement.length > OFFER_MAX_CHARS) return null;
    return { statement, ...(a.sourceUrl !== undefined ? { sourceUrl: a.sourceUrl } : {}) };
  } catch (err) {
    console.error(`[assistant] offer failed (request ${a.requestId}): ${errorMessage(err)}`);
    return null;
  }
}
```

- [ ] **Step 4: Emit it from the turn**

In `packages/core/src/assistant/turn.ts`, add to the `AssistantEvent` union:

```ts
  | { type: "offer"; statement: string; sourceUrl?: string }
```

and, after the two `recordUsage` blocks and **before** the `chat_messages` insert:

```ts
  // C5 §11. Gated on `searched`, which is the cost ceiling: a turn that answered from the
  // user's own notes contributed nothing external and makes no extra model call at all.
  // `incomplete` is checked too -- offering to save a fact out of an answer that was cut off
  // mid-sentence proposes a statement nobody, including this process, ever saw whole.
  if (searched && !incomplete && answer !== "") {
    const offer = await proposeOffer({ db: serviceDb, ai }, {
      userId: args.userId, question: text, answer,
      ...(webCitations[0]?.url !== undefined ? { sourceUrl: webCitations[0].url } : {}),
      requestId,
    });
    if (offer) {
      yield {
        type: "offer",
        statement: offer.statement,
        ...(offer.sourceUrl !== undefined ? { sourceUrl: offer.sourceUrl } : {}),
      };
    }
    mark("offer resolved");
  }
```

with `import { proposeOffer } from "./offer.js";`, and `export * from "./assistant/offer.js";` in `packages/core/src/index.ts` beside the other assistant lines.

**`apps/api/src/assistant.controller.ts` needs no change** — it relays every event generically via `const { type, ...data } = event` (verified 2026-08-18, line 86).

- [ ] **Step 5: Write the turn-level tests**

Add to `packages/core/src/assistant/turn.test.ts`:

```ts
// THE CEILING, and the assertion that keeps this from becoming a second model call on every
// turn in the system. An ungrounded answer contributed nothing external, so proposeOffer must
// not run at all -- asserted on the absence of the event AND on the classify-call count,
// because an offer that ran and returned null is invisible in the event stream alone.
it("makes no offer call on an ungrounded turn", async () => {
  const { client } = dbs();
  let jsonCalls = 0;
  const ai = createFakeAi({
    generateJson: async () => {
      jsonCalls += 1;
      return {
        value: { intent: "question", complexity: "simple", domain: null,
                 domain_meta: {}, tags: [], mood: null },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      };
    },
    generateStream: async () => ({
      chunks: (async function* () { yield { text: "từ note của bạn thôi" }; })(),
      usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
      // No grounding() -- nothing was searched.
    }),
  });
  const events = await collect(runTurn({ userDb: client, serviceDb: client, ai },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(events.some((e) => e.type === "offer")).toBe(false);
  expect(jsonCalls, "classification only, no offer call").toBe(1);
});

// An interrupted answer must not produce an offer: the statement would be condensed out of a
// reply that was cut off mid-sentence, so nobody -- including this process -- saw it whole.
it("makes no offer when the answer was interrupted", async () => {
  const { client } = dbs();
  const ai = createFakeAi({
    generateJson: async () => ({
      value: { intent: "question", complexity: "simple", domain: null,
               domain_meta: {}, tags: [], mood: null },
      inputTokens: 10, outputTokens: 5, model: "fake-classify",
    }),
    generateStream: async () => ({
      chunks: (async function* () { yield { text: "một nử" }; throw new Error("cut"); })(),
      usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
      grounding: () => ({ queries: ["omega 3"], sources: [{ url: "https://e.com/a", title: "A" }] }),
    }),
  });
  const events = await collect(runTurn({ userDb: client, serviceDb: client, ai },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(events.some((e) => e.type === "offer")).toBe(false);
});
```

- [ ] **Step 6: Render the offer on web**

In `packages/shared/src/dto/assistant.ts`, export the payload type so the client is not casting a bare object:

```ts
/** The `offer` SSE event's payload (C5 §11). `sourceUrl` is absent for general knowledge. */
export interface Offer {
  statement: string;
  sourceUrl?: string;
}
```

In `apps/web/src/app/assistant-box.tsx`, add state beside the others, reset it in the same place `attached`/`answer`/`citations`/`web` are reset, and handle the event in the SSE loop next to the `web` branch:

```ts
  const [offer, setOffer] = useState<Offer | null>(null);
```

```ts
        } else if (ev.type === "offer") {
          mark("event: offer");
          const d = ev.data as { statement?: unknown; sourceUrl?: unknown };
          if (typeof d.statement === "string" && d.statement !== "") {
            setOffer({
              statement: d.statement,
              ...(typeof d.sourceUrl === "string" ? { sourceUrl: d.sourceUrl } : {}),
            });
          }
        }
```

and render it below the reply bubble:

```tsx
        {offer && (
          // One line, two buttons, easy to ignore (§11). Not a modal and not a blocking step:
          // an offer that interrupts is a nag, and a nag is what makes a user stop reading them.
          <div className="offer" role="group" aria-label="Lưu vào notes?">
            <p>{offer.statement}</p>
            <button type="button" onClick={() => void acceptOffer(offer)}>Lưu</button>
            <button type="button" onClick={() => void declineOffer(offer)}>Bỏ qua</button>
          </div>
        )}
```

`acceptOffer` posts to `/notes/save-answer` with `{ statement, sourceUrl }` and clears the offer. `declineOffer` is written in Task 13; for now, have it clear the offer only — the write lands in the next task and the button must not be dead in the meantime.

Add a minimal `.offer` block to `globals.css` matching the file's existing bubble styling.

- [ ] **Step 7: Write the web tests**

Add to `apps/web/src/app/assistant-box.test.tsx`:

```ts
it("shows the offer and saves it on accept", async () => {
  // Drive the box through a scripted SSE stream ending in an `offer` event -- follow the
  // existing stream-stubbing helper in this file rather than adding a second one.
  await streamTurn([
    { type: "token", data: { text: "Cá hồi giàu omega-3." } },
    { type: "offer", data: { statement: "Cá hồi giàu omega-3.", sourceUrl: "https://e.com/a" } },
    { type: "done", data: { messageId: "m1", sessionId: "s1" } },
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Lưu" }));
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/notes/save-answer"),
    expect.objectContaining({ method: "POST" }),
  );
});

// §11's "easy to ignore" is only true if it is genuinely optional. A turn with no offer must
// render no row at all -- not an empty one waiting to be filled.
it("renders nothing when no offer arrives", async () => {
  await streamTurn([
    { type: "token", data: { text: "ok" } },
    { type: "done", data: { messageId: "m1", sessionId: "s1" } },
  ]);
  expect(screen.queryByRole("group", { name: "Lưu vào notes?" })).toBeNull();
});
```

- [ ] **Step 8: Run the suites**

```bash
pnpm turbo run test --filter=@cortex/core --filter=@cortex/shared --filter=@cortex/web
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/assistant/offer.ts packages/core/src/assistant/offer.test.ts \
  packages/core/src/assistant/turn.ts packages/core/src/assistant/turn.test.ts \
  packages/shared/src/dto/assistant.ts apps/web/src/app/
git commit -m "feat(assistant): offer to save what the model contributed"
```

---

### Task 13: Declining, and not being asked twice

A declined offer becomes a `memory_facts` row at `status = 'rejected'`, and the act of declining becomes a `feedback_events` row. Both tables are server-only for writes (`00005:52-65` grants `authenticated` nothing but `select` on `memory_facts`), so this runs through the API under the service role.

**Read spec correction 3 and 4 before starting.** `category` is `not null` with an 8-value CHECK and none of the eight fits, so this task adds `'assistant_offer'` via migration `00033`. And the nightly `memory.update` **does not exist** — the carve-out is asserted as a written row shape, not as a pipeline exclusion, because there is no pipeline.

**Files:**
- Create: `supabase/migrations/00033_memory_facts_assistant_offer.sql`
- Create: `packages/core/src/assistant/decline.ts`, `packages/core/src/assistant/decline.test.ts`
- Modify: `packages/shared/src/enums.ts`, `packages/shared/src/enums.test.ts`
- Modify: `apps/api/src/notes.controller.ts`, `apps/web/src/app/assistant-box.tsx`

**Interfaces:**
- Consumes: `Offer` (Task 12).
- Produces: `export async function declineOffer(db: SupabaseClient, a: { userId: string; statement: string; embedding: number[] }): Promise<void>` — takes the service-role client.

- [ ] **Step 1: Write the failing enum test**

In `packages/shared/src/enums.test.ts`, extend the `memoryCategory` options assertion:

```ts
  it("memoryCategory covers what we know about a person, plus an assistant's own offer", () => {
    expect(memoryCategory.options).toEqual([
      "identity", "preference", "interest", "project",
      "habit", "opinion", "skill", "relationship", "assistant_offer",
    ]);
  });
```

Read the existing assertion first and preserve its exact ordering — `enum-parity.test.ts` compares with `toEqual`, which is order-sensitive, and `'assistant_offer'` goes **last** on both sides.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/shared -- enums`
Expected: FAIL — the array is one element short.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00033_memory_facts_assistant_offer.sql`:

```sql
-- packages/db's enum-parity test reads memory_facts_category_check out of pg_constraint and
-- asserts it matches @cortex/shared's memoryCategory exactly, IN ORDER, so these two move
-- together or the suite fails. 'assistant_offer' is appended LAST on both sides.
--
-- WHY A NEW CATEGORY RATHER THAN REUSING ONE. Stage C5 §12.1 stores a declined offer as a
-- memory_facts row at status='rejected' so the same offer is not made twice, and never mentions
-- category -- which is `not null`. Every one of the eight existing values is a claim ABOUT THE
-- USER ('preference', 'opinion', 'habit', ...). A declined offer is a claim about the world that
-- the user did not want kept. Filing it as 'opinion' would write a false statement about the
-- person into the most trust-sensitive table in the system.
--
-- IT IS ALSO THE FENCE. Life-domains §6.4 explicitly REJECTED feeding web-search signal into the
-- memory layer: "a dedicated search-signal pipeline would add a weak-evidence source to the most
-- trust-sensitive subsystem." Reusing memory_facts without a fence is that rejected pipeline
-- arriving through a side door. §12.2 names an `evidence` marker as the fence; this category is a
-- stronger one, because a jsonb marker can be forgotten by a query that filters on everything
-- else, while a category is in the same WHERE clause every consumer already writes. Both are
-- written. The nightly memory update -- WHEN IT IS BUILT, it does not exist as of 00033 -- must
-- exclude category = 'assistant_offer'. These rows exist for deduplication and nothing else.
alter table public.memory_facts drop constraint memory_facts_category_check;
alter table public.memory_facts add constraint memory_facts_category_check
  check (category in (
    'identity','preference','interest','project',
    'habit','opinion','skill','relationship','assistant_offer'
  ));
```

- [ ] **Step 4: Move the enum with it**

In `packages/shared/src/enums.ts`, append to `memoryCategory` and extend the comment block above it:

```ts
// 'assistant_offer' -- NOT a fact about the person. A statement the assistant offered to save
//                      and the user declined, kept only so the same offer is not made twice
//                      (stage C5 §12). Excluded from the nightly memory update by category;
//                      see 00033's header for why this is a category and not a jsonb marker.
```

- [ ] **Step 5: Apply the migration and check parity**

```bash
docker ps
pnpm supabase db push --local
pnpm turbo run test --filter=@cortex/shared -- enums
pnpm turbo run test --filter=@cortex/db --force -- enum-parity
```

Expected: PASS, including `memory_facts.memory_facts_category_check matches its zod enum exactly`.

`--local` is not optional: the unflagged `db push` targets the hosted project. `--force` bypasses turbo's cache — with Docker down this suite replays a previous green without executing.

- [ ] **Step 6: Write the failing decline tests**

Create `packages/core/src/assistant/decline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { declineOffer } from "./decline.js";

const recordingDb = () => {
  const rows: Record<string, Record<string, unknown>[]> = {};
  const client = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        (rows[table] ??= []).push(row);
        return { data: null, error: null };
      },
    }),
  } as never;
  return { client, rows };
};

describe("declineOffer", () => {
  const args = { userId: "u1", statement: "Cá hồi giàu omega-3.", embedding: [0.1, 0.2] };

  it("records the fact as rejected so it is not offered again", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.memory_facts?.[0]).toMatchObject({
      user_id: "u1", statement: args.statement, status: "rejected",
    });
  });

  // THE FENCE (§12.2), and spec correction 3. Every existing category is a claim about the
  // USER; a declined offer is not one. Filing it as 'opinion' would write a false statement
  // about the person into the table the whole memory layer is built on.
  it("files it under assistant_offer, not under a claim about the user", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.memory_facts?.[0]?.category).toBe("assistant_offer");
  });

  // §12.2's named requirement, written BOTH ways. The category is what a query filters on; the
  // evidence marker is what the spec asked for and what survives if someone later widens the
  // category filter without reading 00033's header.
  it("marks the evidence as assistant-originated", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.memory_facts?.[0]?.evidence).toMatchObject({ source: "assistant_offer" });
  });

  // The embedding is what makes Task 14's dedup semantic rather than textual. A row written
  // without one is a row the next offer cannot be compared against -- the decline silently
  // fails to stick, and it looks like the dedup threshold being wrong.
  it("stores the embedding the dedup will compare against", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.memory_facts?.[0]?.embedding).toEqual(args.embedding);
  });

  // The ACT of declining, separate from the fact. feedback_events.subject_type already lists
  // 'chat_answer' (00005) -- no migration needed for this half.
  it("records the decline as a feedback event", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.feedback_events?.[0]).toMatchObject({
      user_id: "u1", subject_type: "chat_answer", action: "reject",
    });
  });

  // §11: "declining costs nothing". A decline must never write a note -- that is the accept
  // path, and reaching it here would save exactly the thing the user just refused.
  it("writes no note", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.notes).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- decline`
Expected: FAIL — the module does not exist.

- [ ] **Step 8: Write the module**

Create `packages/core/src/assistant/decline.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPostgrestError } from "../errors.js";

/**
 * Records that the user turned down an offer, so the same one is not made twice (C5 §12).
 *
 * `db` MUST be the service-role client. memory_facts grants `authenticated` `select` and nothing
 * else, deliberately (00005:52-65), and feedback_events grants it no DML at all -- both are
 * server-only for writes by design, so this runs through the API under the service role.
 *
 * Two rows, because they are two different things: the FACT (what was declined, kept for
 * deduplication) and the ACT (that a decline happened, kept as feedback signal).
 *
 * The category is the fence. Life-domains §6.4 rejected feeding search signal into the memory
 * layer; reusing memory_facts without a fence is that rejected pipeline through a side door.
 * See 00033's header for why 'assistant_offer' is a category rather than only the jsonb marker
 * §12.2 names -- both are written, and the exclusion keys on the category.
 */
export async function declineOffer(
  db: SupabaseClient,
  a: { userId: string; statement: string; embedding: number[] },
): Promise<void> {
  const { error: factErr } = await db.from("memory_facts").insert({
    user_id: a.userId,
    category: "assistant_offer",
    statement: a.statement,
    // Not a fact we believe. It is a fact we were told not to raise again, and the confidence
    // column is `not null check (>= 0 and <= 1)` -- zero is the honest value.
    confidence: 0,
    status: "rejected",
    evidence: { source: "assistant_offer", declinedAt: new Date().toISOString() },
    // Without this, the next offer has nothing to compare against: the decline silently fails
    // to stick, and the symptom looks like a badly chosen dedup threshold (Task 14).
    embedding: a.embedding,
  });
  if (factErr) throw mapPostgrestError(factErr);

  const { error: evErr } = await db.from("feedback_events").insert({
    user_id: a.userId,
    // Already in the CHECK since 00005 -- no migration needed for this half.
    subject_type: "chat_answer",
    action: "reject",
    payload: { kind: "assistant_offer" },
  });
  if (evErr) throw mapPostgrestError(evErr);
}
```

- [ ] **Step 9: Add the endpoint and wire the button**

**`apps/api/src/assistant.controller.ts`, not `notes.controller.ts`.** That controller already holds the two things this endpoint needs and the notes one holds neither: `private readonly serviceDb = createServiceClient()` (line 19) and the injected `@Inject(AI_CLIENT) private readonly ai: AiClient` (line 21). Putting it in `notes.controller.ts` means constructing a second service client for one route.

Add `POST /assistant/decline` taking `{ statement: string }`, embedding it with `this.ai`, and calling `declineOffer(this.serviceDb, { userId: user.id, statement, embedding })`.

```ts
  // @HttpCode, like the streaming handler above it: Nest's RouterExecutionContext sets 201 on a
  // POST before the handler runs. A decline creates nothing the caller can address, so 204 is
  // the honest status -- and the web client keys on it.
  @Post("decline")
  @HttpCode(204)
```

`declineOffer` needs `export * from "./assistant/decline.js";` in `packages/core/src/index.ts` before the controller can import it.

Then, in `apps/web/src/app/assistant-box.tsx`, replace Task 12's placeholder `declineOffer` with a `POST` to that route followed by `setOffer(null)`.

**The UI clears the offer immediately, before the request settles** — `setOffer(null)` runs first and the `fetch` is not awaited ahead of it. §11's "declining costs nothing" means it must not block or spin; if the write fails, the user has still declined and the worst case is being asked once more later. That ordering is what the web test in Step 10b asserts.

- [ ] **Step 10: Add the e2e test**

```ts
it("records a decline without writing a note", async () => {
  await request(app.getHttpServer())
    .post("/assistant/decline")
    .set("authorization", `Bearer ${token}`)
    .send({ statement: "Cá hồi giàu omega-3." })
    .expect(204);

  const { data: facts } = await admin.from("memory_facts")
    .select("category, status").eq("user_id", userId);
  expect(facts).toEqual([{ category: "assistant_offer", status: "rejected" }]);

  const { data: notes } = await admin.from("notes").select("id").eq("user_id", userId);
  expect(notes, "declining must never write a note").toHaveLength(0);
});
```

- [ ] **Step 10b: The web half of §14's last row**

C5 §14's final row is *"declining costs nothing | **web** | the decline path writes a note, or blocks the turn."* Step 10 covers "writes a note" in `@cortex/api`. **"Blocks the turn" is a web assertion and has no other home** — add it to `apps/web/src/app/assistant-box.test.tsx`:

```ts
// "Costs nothing" is a claim about LATENCY as much as about writes. The offer must be gone
// before the request settles, so a slow or dead /assistant/decline is invisible to the user.
// A `fetch` awaited ahead of setOffer(null) passes every other test in this file and fails
// only this one -- which is the whole reason it is written.
it("clears the offer without waiting for the decline to land", async () => {
  let settle: (v: unknown) => void = () => {};
  fetchMock.mockImplementationOnce(() => new Promise((r) => { settle = r; }));

  await streamTurn([
    { type: "token", data: { text: "Cá hồi giàu omega-3." } },
    { type: "offer", data: { statement: "Cá hồi giàu omega-3." } },
    { type: "done", data: { messageId: "m1", sessionId: "s1" } },
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Bỏ qua" }));

  // The request is still in flight -- `settle` has not been called.
  expect(screen.queryByRole("group", { name: "Lưu vào notes?" })).toBeNull();
  settle({ ok: true, status: 204 });
});

// The other half of "costs nothing": no note, from the client's side. The accept path posts to
// /notes/save-answer, and the natural way to break this is one shared handler with a flag.
it("posts no save when the offer is declined", async () => {
  await streamTurn([
    { type: "token", data: { text: "ok" } },
    { type: "offer", data: { statement: "Cá hồi giàu omega-3." } },
    { type: "done", data: { messageId: "m1", sessionId: "s1" } },
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Bỏ qua" }));
  expect(fetchMock).not.toHaveBeenCalledWith(
    expect.stringContaining("/notes/save-answer"), expect.anything(),
  );
});
```

Follow this file's existing `fetchMock` / `streamTurn` helpers rather than adding new ones; the names above are placeholders for whatever Task 12's tests already used.

- [ ] **Step 11: What is NOT tested here, and why — write this down**

C5 §14 lists *"a declined offer never reaches the nightly memory update — turns red when the `evidence` carve-out is dropped."* **There is no nightly memory update.** No `packages/core/src/memory/` exists and nothing outside `packages/db/src/test/` touches `memory_facts` (verified 2026-08-18). A test asserting that exclusion would have to mock a pipeline that does not exist, and would assert nothing.

Add this comment above the decline tests rather than writing that test:

```ts
// C5 §14 asks for "a declined offer never reaches the nightly memory update". That job does not
// exist yet -- there is no packages/core/src/memory/ and nothing outside packages/db/src/test/
// reads memory_facts. A test for it here would mock a consumer that has never been written and
// would pass no matter what this file does.
//
// What IS asserted instead: the row is WRITTEN with the category and the evidence marker that
// consumer will filter on. The behavioural half is owed by whichever stage builds the nightly
// job, and 00033's header is where that requirement is recorded for it.
```

- [ ] **Step 12: Run the suites**

```bash
docker ps
pnpm turbo run test --filter=@cortex/shared --filter=@cortex/core --filter=@cortex/db --filter=@cortex/api --force
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add supabase/migrations/00033_memory_facts_assistant_offer.sql packages/shared/src/enums.ts \
  packages/shared/src/enums.test.ts packages/core/src/assistant/decline.ts \
  packages/core/src/assistant/decline.test.ts apps/api/src/ apps/api/test/ apps/web/src/app/
git commit -m "feat(assistant): make a declined offer stick"
```

---

### Task 14: Not asking twice — semantic dedup

A decline that does not prevent the next identical offer is not a decline. §12.3: **the comparison is semantic, not textual.** "The same fact" recurs in different words, which is the entire reason the row carries an embedding rather than a hash.

**The threshold is not fixed by the spec, deliberately.** §12.3: *"It has to be measured against real declines, and a number invented at design time would be a number nobody later dares to change because it looks decided."* This task picks a starting value, names it as provisional in the code, and says so.

**Files:**
- Modify: `packages/core/src/assistant/offer.ts` — the dedup step
- Test: `packages/core/src/assistant/offer.test.ts`

**Interfaces:**
- Consumes: rows written by `declineOffer` (Task 13).
- Produces: `export const OFFER_DEDUP_THRESHOLD: number`; `proposeOffer`'s signature gains nothing — the dedup runs inside it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/assistant/offer.test.ts`:

```ts
describe("dedup against declined facts", () => {
  // A db double whose memory_facts read returns whatever the test hands it, and an ai double
  // whose embed() returns a fixed vector -- the similarity is decided by the STORED row, which
  // is what the production code compares against.
  const dbWith = (facts: { statement: string; embedding: number[] }[]) => ({
    from: (t: string) => t === "memory_facts"
      ? { select: () => ({ eq: () => ({ in: async () => ({ data: facts, error: null }) }) }) }
      : { insert: async () => ({ data: null, error: null }) },
  }) as never;

  const aiWith = (statement: string, vector: number[]) => createFakeAi({
    generateJson: async () => ({
      value: { statement }, inputTokens: 10, outputTokens: 5, model: "fake-classify",
    }),
    embed: async () => ({ vectors: [vector], inputTokens: 5, model: "fake-embed" }),
  });

  // THE POINT OF THE WHOLE TASK. Same fact, different words -- a string comparison would miss
  // it entirely, and the user would be offered the thing they just refused, phrased slightly
  // differently. That is worse than never having built the decline path.
  it("does not re-offer a fact the user already declined", async () => {
    const out = await proposeOffer(
      { db: dbWith([{ statement: "Cá hồi giàu omega-3.", embedding: [1, 0] }]),
        ai: aiWith("Omega-3 có nhiều trong cá hồi.", [1, 0]) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" },
    );
    expect(out).toBeNull();
  });

  it("still offers an unrelated fact", async () => {
    const out = await proposeOffer(
      { db: dbWith([{ statement: "Cá hồi giàu omega-3.", embedding: [1, 0] }]),
        ai: aiWith("Vitamin A tốt cho mắt.", [0, 1]) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" },
    );
    expect(out?.statement).toBe("Vitamin A tốt cho mắt.");
  });

  // §12.3: "A string comparison here would not work." This is the test that turns red if
  // someone replaces the cosine with an equality check -- identical meaning, different string.
  it("compares meaning rather than text", async () => {
    const out = await proposeOffer(
      { db: dbWith([{ statement: "hoàn toàn khác về mặt chữ", embedding: [1, 0] }]),
        ai: aiWith("một câu không giống chút nào", [0.99, 0.14]) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" },
    );
    expect(out, "near-identical vectors, unrelated strings").toBeNull();
  });

  // A dedup that fails must not cost the user the offer OR the turn. The read is a convenience;
  // the worst case of skipping it is being asked once more, which is far better than an error.
  it("still offers when the dedup read fails", async () => {
    const broken = {
      from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: "boom" } }) }) }) }),
    } as never;
    const out = await proposeOffer({ db: broken, ai: aiWith("Vitamin A tốt cho mắt.", [0, 1]) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" });
    expect(out?.statement).toBe("Vitamin A tốt cho mắt.");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- offer`
Expected: FAIL — a declined fact is offered again.

- [ ] **Step 3: Implement the dedup**

In `packages/core/src/assistant/offer.ts`:

```ts
/**
 * PROVISIONAL, and deliberately not fixed by the spec (C5 §12.3): "a number invented at design
 * time would be a number nobody later dares to change because it looks decided."
 *
 * 0.88 is a starting value, not a measured one. It sits above the cosine similarity of two
 * merely related facts about the same topic and below that of two phrasings of one fact, on
 * this embedding model, by estimate rather than by experiment.
 *
 * WHICH DIRECTION TO MOVE IT. Too high and a declined offer comes back in different words,
 * which is the failure the decline path exists to prevent and is immediately visible to the
 * user. Too low and a genuinely new fact is silently suppressed, which nobody ever sees. The
 * asymmetry says to tune it DOWN from here against real declines, not up.
 */
export const OFFER_DEDUP_THRESHOLD = 0.88;

/**
 * Cosine similarity. Written out rather than pulled in: it is four lines, and the alternative
 * is a dependency in a package whose whole point is not having many.
 */
const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!;
  }
  // Zero-length vectors are not "identical", they are unusable. Returning 0 makes them fail to
  // suppress anything, which is the safe direction: the cost is one extra offer.
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
};
```

Then, inside `proposeOffer`, after the statement passes its length check and before returning:

```ts
  // §12.3. One embed call per offer, metered like every other. Compared against BOTH 'rejected'
  // and 'active' facts: a fact the user already keeps does not need offering either.
  //
  // Semantic, not textual, and that is the whole design. "The same fact" recurs in different
  // words -- which is precisely why the row carries an embedding rather than a hash. An
  // equality check here would let "Omega-3 có nhiều trong cá hồi" through against a declined
  // "Cá hồi giàu omega-3", and the user would be offered the thing they just refused.
  //
  // A failure here skips the dedup rather than failing the offer. The worst case of skipping is
  // being asked once more; the worst case of throwing is losing an offer to a transient read.
  try {
    const { vectors, inputTokens: embedIn, model: embedModel } = await deps.ai.embed([statement]);
    const vector = vectors[0];
    if (vector) {
      try {
        await recordUsage(deps.db, {
          userId: a.userId, kind: "embed", model: embedModel, inputTokens: embedIn,
          outputTokens: 0, source: "assistant", requestId: a.requestId,
          contentChars: statement.length,
        });
      } catch (err) {
        console.error(`[assistant] offer embed ledger failed (request ${a.requestId}): ${errorMessage(err)}`);
      }

      const { data: facts, error } = await deps.db
        .from("memory_facts").select("statement, embedding")
        .eq("user_id", a.userId).in("status", ["rejected", "active"]);
      if (error) throw error;

      for (const f of (facts ?? []) as { embedding: number[] | null }[]) {
        if (f.embedding && cosine(vector, f.embedding) >= OFFER_DEDUP_THRESHOLD) return null;
      }
    }
  } catch (err) {
    // Never log the statement -- it is model output about the user's material (§15.6 rule 1).
    console.error(`[assistant] offer dedup skipped (request ${a.requestId}): ${errorMessage(err)}`);
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS. Task 12's existing tests still pass **through the real dedup path** — their `db()` double answers the `memory_facts` read with `{ data: [], error: null }`, so the comparison runs and finds nothing to suppress.

Check that specifically. If Task 12's double was written without the `select` chain, those tests still go green — but by throwing into the dedup's catch, which means they no longer exercise what they claim to. Green through an error branch is the failure mode this step exists to catch.

- [ ] **Step 5: Record that the threshold is unmeasured**

Add to `docs/` wherever this project tracks open items (or to the plan's closing section if there is no such file):

> `OFFER_DEDUP_THRESHOLD` is 0.88 by estimate, not by measurement (C5 §12.3, §15). It needs real declines. Tune **down** from here: a re-offered decline is visible to the user, a suppressed new fact is not.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/assistant/offer.ts packages/core/src/assistant/offer.test.ts docs/
git commit -m "feat(assistant): stop offering a fact the user already declined"
```

---

### Task 15: The saved-external chip, and the closing gate

Life-domains §6.3's third bullet: a filter for notes that came from an answer rather than from the user. It lands here, next to the thing it filters.

**Files:**
- Modify: `packages/shared/src/notes/filters.ts` — `NoteFilters`, `parseNoteFilters`, `applyNoteFilters`, `matchesFilters`, `noteFiltersToSql`
- Modify: `packages/shared/src/notes/filters.test.ts`
- Modify: `apps/web/src/app/note-list.tsx` — the chip
- Test: `packages/core/src/notes/filters-equivalence.test.ts`

**Interfaces:**
- Consumes: notes written by `buildSavedAnswerRow` (Task 11).
- Produces: `NoteFilters` gains `saved?: boolean`. When true, the view narrows to `source_type in ('assistant','web_search')`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/notes/filters.test.ts`:

```ts
describe("the saved-external filter", () => {
  it("parses ?saved=1 and ignores anything else", () => {
    expect(parseNoteFilters({ saved: "1" }).saved).toBe(true);
    // Untrusted input: anything unrecognised is DROPPED, never passed on -- the promise
    // parseNoteFilters' docstring already makes for every other field.
    expect(parseNoteFilters({ saved: "yes" }).saved).toBeUndefined();
    expect(parseNoteFilters({}).saved).toBeUndefined();
  });

  it("narrows the query to saved answers", () => {
    const calls: [string, unknown][] = [];
    const q = new Proxy({}, {
      get: (_t, prop: string) => (...args: unknown[]) => { calls.push([prop, args]); return q; },
    });
    applyNoteFilters(q, { view: "inbox", saved: true });
    expect(calls).toContainEqual(["in", ["source_type", ["assistant", "web_search"]]]);
  });

  // Applier 3, and the half that has already burned this codebase (issue-log E5): SSR excludes
  // a row and the Realtime patch puts it straight back, because the predicate and the query
  // narrow on different fields.
  it("matchesFilters agrees with the query", () => {
    const saved = { lifecycle: "inbox", deleted_at: null, source_type: "web_search" };
    const own = { lifecycle: "inbox", deleted_at: null, source_type: "quick" };
    expect(matchesFilters(saved, { view: "inbox", saved: true })).toBe(true);
    expect(matchesFilters(own, { view: "inbox", saved: true })).toBe(false);
    // And without the filter, both are in. A chip that silently narrows the DEFAULT view would
    // hide every note the user actually wrote.
    expect(matchesFilters(own, { view: "inbox" })).toBe(true);
  });

  it("noteFiltersToSql narrows the same way", () => {
    const { where, params } = noteFiltersToSql({ view: "inbox", saved: true });
    expect(where).toContain("source_type");
    expect(params).toContain("web_search");
    expect(params).toContain("assistant");
  });

  // Chitchat stays excluded regardless. The two narrowings are independent and both apply --
  // the natural mistake is an if/else that makes the saved filter replace the chitchat one.
  it("still excludes chitchat when the saved filter is on", () => {
    const banter = { lifecycle: "inbox", deleted_at: null, source_type: "chitchat" };
    expect(matchesFilters(banter, { view: "inbox", saved: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/shared -- filters`
Expected: FAIL — `saved` is not a field.

- [ ] **Step 3: Implement it across all four appliers**

`packages/shared/src/notes/filters.ts`. Add to `NoteFilters`:

```ts
  /**
   * Life-domains §6.3's third bullet: show only notes that came from an ANSWER rather than
   * from the user. Both source types together, never one -- the difference between them is
   * whether grounding ran, which is not a distinction the user made or should have to.
   */
  saved?: boolean;
```

Add the constant beside it:

```ts
/** The two source types buildSavedAnswerRow writes. search_notes down-weights both by 0.8. */
export const SAVED_ANSWER_SOURCE_TYPES = ["assistant", "web_search"] as const;
```

In `parseNoteFilters`, after the `domain` block:

```ts
  // Strictly "1", matching how every other field here drops anything unrecognised rather than
  // coercing it. `Boolean(params.saved)` would make ?saved=0 mean true.
  const saved = one(params.saved) === "1" ? true : undefined;
```

and add `...(saved ? { saved } : {})` to the returned object.

In `applyNoteFilters`, after the chitchat `neq` and **not** in place of it:

```ts
  // Independent of the chitchat exclusion above, and applied after it: both narrowings hold at
  // once. An if/else here would let the chip show banter.
  if (f.saved) q = q.in("source_type", [...SAVED_ANSWER_SOURCE_TYPES]);
```

Apply the equivalent narrowing in `matchesFilters` and in `noteFiltersToSql`, following each function's existing shape. `filters-equivalence.test.ts` guards the query against the SQL; add a saved-answer row to its fixture corpus so the new clause is actually exercised on both sides.

**`requiresRefetch` is deliberately unchanged, and `noteSelect` too.** Both live in this same file and both key on `NoteFilters`, so both look like they need a line. `requiresRefetch` returns true only for `q` and `tag` — *"exactly the two fields `matchesFilters` ignores"* — and `saved` is not one of them: `source_type` arrives on the Realtime row and `matchesFilters` evaluates it directly, so a patch is correct and a refetch would be a round trip for nothing. `noteSelect` returns `"*"`. Adding `saved` to either is the plausible-looking change that quietly costs a query per row.

- [ ] **Step 4: Add the chip**

In `apps/web/src/app/note-list.tsx`, add a chip toggling `?saved=1` alongside the existing view links, following the file's existing nav-helper pattern. Label it `Từ trợ lý`.

- [ ] **Step 5: Run the suites**

```bash
pnpm turbo run test --filter=@cortex/shared --filter=@cortex/core --filter=@cortex/web
```

Expected: PASS.

- [ ] **Step 6: Verify CI still names every suite**

This plan adds test files in `packages/core`, `packages/shared`, `packages/db`, `apps/api`, `apps/web` and `apps/mobile` — every one already named in `.github/workflows/ci.yml`'s `checks` job. Confirm no new package appeared:

```bash
grep -n "cortex/" .github/workflows/ci.yml
```

Every filter this plan's test commands use must appear. A suite in a package CI does not name runs nowhere but on your machine.

- [ ] **Step 7: The closing gate**

```bash
docker ps
pnpm turbo run test typecheck lint --force
```

**Read the `Cached:` line.** `26/26 successful` can be 23 replays; with Docker down the database-backed suites replay a previous green without executing, and a gate that did not run did not pass.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/notes/ packages/core/src/notes/ apps/web/src/app/note-list.tsx
git commit -m "feat(notes): filter for what the assistant contributed"
```

---

## What this plan does not deliver

Stated so the next stage inherits it as a decision rather than discovering it as a gap.

- **A saved answer is still cited as if the user wrote it.** C5 §10 claims *"retrieval carries the source type"*; it does not (spec correction 5). `search_notes` returns no `source_type`, so `Citation` has none and `renderCitations` cannot tell the model that a note came from an earlier answer. The 0.8 down-weight is real and tested (`packages/db/src/test/search-notes.test.ts:219-246`), so a saved answer ranks lower — but once retrieved it is indistinguishable from the user's own thinking in the prompt. Closing it needs a `search_notes` migration, a widened `Citation` on both sides of the wire, and a `renderCitations` change: a task of its own, and the first thing to weigh for C6.
- **The nightly `memory.update` exclusion is unproven.** Task 13 writes the category and the marker; nothing consumes them, because the job does not exist. C5 §14's row for it is owed by whichever stage builds it. `00033`'s header carries the requirement forward.
- **`OFFER_DEDUP_THRESHOLD` is an estimate.** C5 §12.3 and §15 both say it must be measured against real declines. Tune down, not up (Task 14, Step 5).
- **Verification quality is unmeasured.** C5 §15 says this plainly and it is still true: no test can assert "the model correctly identified a false claim". Tasks 9 and 10 assert routing, prompting and cost. Whether the flagging is *useful* is a judgment over real use, and C5 ships a mechanism whose value is unproven.
- **`FORMAT_RULE` obedience is unmeasured** (Task 8, Step 7). The tests assert the prompt's content and scoping. Both manual checks — the casual question *and* the explicit list request — have to be run by a person.
- **Mobile markdown may not have shipped.** If Task 6's spike failed, Task 7 was skipped and mobile still renders plain text. That is a recorded outcome, not an oversight.
- **Scrollback across earlier sessions** and **chat history on mobile** remain out, unchanged from C4 §2.

