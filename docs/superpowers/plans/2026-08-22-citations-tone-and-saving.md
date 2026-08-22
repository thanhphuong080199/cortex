# Stage S1.5 Implementation Plan — citations, tone, and keeping an answer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the assistant citing notes with unreadable brackets and mis-attributing its own saved answers to the user, let it answer at the length a question deserves, stop it announcing "not in your notes" on turns with no notes, and give the user a deliberate way to keep an answer on both clients.

**Architecture:** One migration widens `search_notes`'s output by one column so retrieval can tell the prompt who wrote a note. Four passes over `packages/core/src/assistant/prompts.ts` change what the model is told. `offer.ts` splits so its model call can be reached by a second, user-initiated path behind a new `POST /assistant/distill` route, which both clients call before showing a save confirmation that reuses the existing `POST /notes/save-answer`.

**Tech Stack:** TypeScript, NestJS (apps/api), Next.js App Router (apps/web), Expo/React Native + PowerSync (apps/mobile), Supabase/Postgres migrations, Vitest, Zod.

**Spec:** `docs/superpowers/specs/2026-08-22-citations-tone-and-saving-design.md`

## Global Constraints

- **Run package tests through turbo**: `pnpm turbo run test --filter=<pkg>`. Never `pnpm --filter <pkg> test` — `@cortex/shared` and `@cortex/core` resolve as compiled `dist/`, and the direct form runs against stale output.
- **Migrations must schema-qualify extension types**: `extensions.vector(1536)`, never bare `vector(1536)`. The unqualified form passes locally and fails against the hosted project.
- **`supabase db push` targets the HOSTED project by default.** Local application is `supabase db push --local`. Applying to hosted is a separate, deliberate deploy step (Task 11).
- **Never print any line of `apps/api/.env`**, and never echo a connection string. If one must be shown, redact on the LAST `@`.
- **No new test suite names.** Every test below lands in a file that an existing `checks` job already runs (`packages/db`, `packages/core`, `packages/shared`, `apps/api`, `apps/web`, `apps/mobile`). Task 9 creates `apps/mobile/src/lib/assistant/save.test.ts` inside the existing mobile suite — no `ci.yml` change is needed, and this is the only new test file.
- **Vietnamese is the product language.** User-facing copy in both clients is Vietnamese. Prompt instruction text stays English except where the existing file deliberately uses Vietnamese (`temporalRule`, `RECALL_RULE`'s examples), matching `LANGUAGE_RULE`'s reasoning.
- **Every prompt change is asserted on the built prompt string**, never on the diff. A test that checks one of several instruction sites passes while the model keeps the old behaviour.
- **Read the test file before writing into it.** Several tasks below show a test body that calls a stub helper — `dbReturningRows`, `aiReturningJson`, `dbStub`, `renderWithTurns`, `mockFetch`. Those names stand in for whatever the target file **already defines**; every one of these files has its own arrangement helpers. Open the file, find its equivalent, and use that name. Only if the file genuinely has none should you define one, and then define it once at the top of the new `describe` rather than per test. Adding a second helper that does what an existing one already does is how these files grow two ways to arrange the same fixture.
- **"Keep verbatim" means copy, not retype.** Two steps (Task 1's SQL body, Task 7's dedup block) instruct you to carry an existing block across unchanged. Copy it. These are tuned RRF SQL and a vector-comparison loop with a documented NaN trap; retyping either is how a transcription bug ships behind a green suite.

---

### Task 1: `search_notes` returns `source_type`

**Files:**
- Create: `supabase/migrations/00035_search_notes_source_type.sql`
- Modify: `packages/db/src/test/search-notes.test.ts:19-25` (the `search` helper's row type), and add one test
- Modify: `packages/db/src/test/default-grants.test.ts:56-63` (comment only — the assertions already cover this migration)

**Interfaces:**
- Consumes: nothing.
- Produces: `search_notes` returns one additional column, `source_type text`, positioned last. Full return shape after this task: `note_id uuid, title text, snippet text, created_at timestamptz, score real, matched_by text, source_type text`.

- [ ] **Step 1: Write the failing test**

Add to `packages/db/src/test/search-notes.test.ts`. First widen the `search` helper's return type at line 25 to include the new column:

```ts
  return data as {
    note_id: string; title: string | null; snippet: string; created_at: string;
    score: number; matched_by: string; source_type: string;
  }[];
```

Then add this test inside the `describe("search_notes", ...)` block:

```ts
  // 00035. The 0.8 provenance down-weight has read source_type since 00022, but the column never
  // left the function -- so nothing downstream could tell the model that a note it is about to
  // recall is the assistant's own earlier answer rather than the user's thinking (enums.ts has
  // promised exactly that since 00020). Two rows, not one: asserting only the 'assistant' row
  // passes against a function that hardcodes the string.
  it("returns each note's source_type so the caller can tell whose words a note is", async () => {
    const { id: prov } = await makeUser("search-provenance@example.com");
    const v = vec(21);
    const own = await seed(prov, "cá hồi giàu omega-3", { embedding: v, sourceType: "quick" });
    const saved = await seed(prov, "omega-3 tốt cho mắt", { embedding: nudge(v), sourceType: "assistant" });

    const rows = await search(prov, "omega-3", v);
    const ownRow = rows.find((r) => r.note_id === own);
    const savedRow = rows.find((r) => r.note_id === saved);

    expect(ownRow!.source_type).toBe("quick");
    expect(savedRow!.source_type).toBe("assistant");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/db`

Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined`, because the RPC does not return the column.

If the whole suite errors with a connection failure instead, Docker is down. Start Supabase (`pnpm supabase start`) and re-run — a turbo run reporting `26/26 successful` can be cache replays, so read the `Cached:` line before believing a pass.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00035_search_notes_source_type.sql`.

**Do not retype the function body.** Copy `supabase/migrations/00032_search_notes_created_at.sql` in full, then apply exactly the four edits below. The body is ~90 lines of tuned RRF/recency SQL and retyping it is how a subtle transcription error ships.

Edit 1 — replace 00032's header comment block (everything above the `drop function` line) with:

```sql
-- search_notes returns each note's source_type, so the assistant can say whose words it is
-- recalling. The function has read this column since 00022 to apply the 0.8 provenance
-- down-weight; it simply never returned it, which is why `enums.ts`'s promise about
-- 'assistant' notes -- "cited as something you saved, never as your own thinking" -- has had
-- no mechanism since 00020.
--
-- WHY THIS DROPS INSTEAD OF REPLACING, again. `create or replace function` cannot change a
-- function's return type ("cannot change return type of existing function") and this adds a
-- column to `returns table`. 00032 hit the same wall for the same reason; its header is the
-- long version.
--
-- DROPPING DISCARDS THE ACL. The revoke/grant pair at the bottom is load-bearing, not
-- ceremony: without it this function is recreated with PostgreSQL's default EXECUTE grant to
-- public, on a SECURITY DEFINER function that reads note_chunks -- a table with RLS enabled and
-- no policies precisely because nothing but this function should read it.
-- packages/db/src/test/default-grants.test.ts is the test that catches that, and it runs
-- against whatever signature is live, so it covers this migration with no edit.
--
-- The body is 00032 verbatim apart from the two added lines. See 00022's header for why this is
-- SECURITY DEFINER and why the parameter type stays written as `extensions.vector(1536)`;
-- 00024's for the recency clamp; 00031's for the chitchat exclusion; 00032's for created_at.
```

Edit 2 — in the `returns table (...)` clause, add the column last:

```sql
returns table (
  note_id uuid, title text, snippet text, created_at timestamptz, score real, matched_by text,
  source_type text
)
```

Edit 3 — in the final `select`, add the column after `fused.matched_by`:

```sql
         fused.matched_by,
         -- The addition. The `case` above already reads this column for the 0.8 down-weight;
         -- returning it is what lets retrieve.ts label a citation instead of only ranking it.
         n.source_type
```

Edit 4 — delete 00032's trailing `_test_has_function_privilege` block. That helper is created with `create or replace` in 00032 and still exists; recreating it here adds nothing.

Keep everything else byte-for-byte, including the `drop function if exists public.search_notes(uuid, text, extensions.vector(1536), int);` line and the `revoke`/`grant` pair at the bottom.

- [ ] **Step 4: Apply the migration locally and re-run the test**

Run: `pnpm supabase db push --local`

Then: `pnpm turbo run test --filter=@cortex/db`

Expected: PASS, including the pre-existing `search_notes execute grant` tests in `default-grants.test.ts` — those are what prove the drop did not leak the ACL. If `anon holds no EXECUTE on search_notes` goes red, the revoke/grant pair was lost in the copy.

- [ ] **Step 5: Update the grant test's comment to name this migration**

In `packages/db/src/test/default-grants.test.ts`, the `describe` title and the comment above it name 00032. Change the title to `"search_notes execute grant (00032, 00035)"` and add one line to the comment:

```ts
// 00035_search_notes_source_type.sql performed the same DROP for the same reason. This block
// needs no edit to cover it -- it asserts against the live signature, which is unchanged.
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00035_search_notes_source_type.sql packages/db/src/test/search-notes.test.ts packages/db/src/test/default-grants.test.ts
git commit -m "feat(db): search_notes returns whose words a note is"
```

---

### Task 2: `Citation` carries who authored the note

**Files:**
- Modify: `packages/core/src/assistant/retrieve.ts:6-30` (the `Citation` and `SearchRow` interfaces) and `:94-102` (the mapper)
- Test: `packages/core/src/assistant/retrieve.test.ts`

**Interfaces:**
- Consumes: Task 1's `source_type` column.
- Produces: `Citation` (the internal interface exported from `retrieve.ts`) gains `authoredBy: "user" | "assistant"`. `SearchRow` gains `source_type: string`. No change to `@cortex/shared`'s wire `Citation`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/assistant/retrieve.test.ts`. Follow the file's existing pattern for stubbing `db.rpc` and `ai.embed`; if the file has a shared `rpcReturning`-style helper, reuse it rather than inventing a second one.

```ts
  // The three source types that are the assistant's own words, and one that is not. Table-driven
  // because the mapping is a collapse, and a collapse tested on one value is satisfied by a
  // hardcoded return.
  it.each([
    ["quick", "user"],
    ["chat", "user"],
    ["web_clip", "user"],
    ["assistant", "assistant"],
    ["web_search", "assistant"],
  ])("maps source_type %s to authoredBy %s", async (sourceType, expected) => {
    const db = dbReturningRows([{
      note_id: "n1", title: null, created_at: null, snippet: "s",
      score: 1, matched_by: "fts", source_type: sourceType,
    }]);
    const out = await retrieve({ db, ai: aiEmbedding() }, {
      userId: "u", text: "q", requestId: "r",
    });
    expect(out[0]!.authoredBy).toBe(expected);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core -- retrieve`

Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined`.

- [ ] **Step 3: Implement**

In `packages/core/src/assistant/retrieve.ts`, add to the `Citation` interface after `matchedBy`:

```ts
  /**
   * Whose words this note is, collapsed from `notes.source_type` at the retrieval boundary.
   *
   * Binary rather than the raw nine-value enum on purpose: the only distinction the prompt needs
   * is "your words" vs "my words", and passing the enum through would make prompts.ts responsible
   * for a vocabulary it does not use -- so every future capture channel added to noteSourceType
   * would become a thing someone must remember to handle there.
   *
   * 'assistant' and 'web_search' are both answers the user chose to keep (save-answer.ts picks
   * between them on whether grounding produced a url). 'chitchat' never reaches here -- 00031
   * excludes it inside search_notes.
   */
  authoredBy: "user" | "assistant";
```

Add to `SearchRow`:

```ts
  source_type: string;
```

In the mapper, add the field:

```ts
    authoredBy: r.source_type === "assistant" || r.source_type === "web_search"
      ? ("assistant" as const)
      : ("user" as const),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/core -- retrieve`

Expected: PASS.

- [ ] **Step 5: Fix the type errors this surfaces**

Run: `pnpm turbo run typecheck`

`Citation` is constructed in test fixtures elsewhere (at minimum `packages/core/src/assistant/prompts.test.ts:12-15`'s `cite` helper). Add `authoredBy: "user"` to each fixture's defaults — `"user"` is the right default because it is what every pre-existing test means.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/assistant/retrieve.ts packages/core/src/assistant/retrieve.test.ts packages/core/src/assistant/prompts.test.ts
git commit -m "feat(assistant): carry whose words a cited note is"
```

---

### Task 3: the citation block loses the bracket and gains a date and a label

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts` — `RECALL_RULE` (`:32-39`), `renderCitations` (`:136-149`), `buildAnswerPrompt`'s cite line (`:171`), `buildAcknowledgePrompt`'s cite line (`:221-222`)
- Test: `packages/core/src/assistant/prompts.test.ts` — replace the two "keeps the bracket" tests (`:281`, `:291`) and the three `[1]`-shaped assertions (`:46`, `:55`, `:193`)

**Interfaces:**
- Consumes: Task 2's `Citation.authoredBy`.
- Produces: no new exports. The built prompt for a turn with citations contains no `[1]`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/assistant/prompts.test.ts`, **delete** the two tests titled `"keeps the bracket citation while changing how it is introduced (answer prompt)"` and `"...(acknowledge prompt)"`, and replace them with:

```ts
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
```

Then update the three pre-existing bracket-shaped assertions to the bullet form:

- `:46` → `expect(p).toContain("The user's own notes:\n- first\n- second");`
- `:55` → `expect(p).toContain("- Giấc ngủ: ngủ 5 tiếng");`
- `:193` → `expect(p).toContain("The user's own notes:\n- ghi chú cũ");`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`

Expected: FAIL on `expect(p).not.toMatch(/\[\d/)` (the prompt still contains `[1]`) and on the three `toContain` assertions.

- [ ] **Step 3: Implement**

In `packages/core/src/assistant/prompts.ts`:

Replace `RECALL_RULE`'s doc comment's third paragraph (the one beginning *"The second half is load-bearing"*) with:

```ts
 * The second half USED to require the bracket, on the reasoning that dropping it takes every
 * link between a claim and the note behind it. That reasoning described an intent the product
 * never realised: nothing ever read `[2]` back out -- Provenance renders web sources only, mobile
 * has no note-citation UI, and the citations sent to either client come from retrieval directly,
 * never from numbers parsed out of the reply. So a WRONG `[2]` was invisible to everyone,
 * including the user. Reported as unreadable on 2026-08-22 ("[1, 2] nhìn không biết gì hết").
 *
 * A date is the replacement, and it is a strictly better link for this product: the user can
 * check it with no UI at all, and a wrong one is visible immediately. It also preserves what the
 * bracket was actually doing -- forcing the model to point at a specific retrieved row instead of
 * producing a vague "bạn từng nói...".
```

Replace the `RECALL_RULE` constant's final sentence. The constant becomes:

```ts
const RECALL_RULE =
  "When one of their past notes is relevant, bring it up the way a person would recall " +
  "something you told them -- \"bạn có nhắc chuyện này rồi\", \"lần trước bạn có hỏi...\" -- " +
  "inline, in the middle of what you are saying. Do not report a database match: never " +
  "\"Trong các ghi chú của bạn [1, 3] có nhắc đến...\", never \"Đã lưu ghi chú của bạn vào " +
  "mục...\", and never state that a match was found or that something is identical to an " +
  "earlier note. Anchor the recall so they can place it: say WHEN they wrote it (\"hôm 18/8 " +
  "bạn có nhắc...\"), or name the note's title if it has one. Never use a bracketed number. " +
  "If a note below shows no date and no title, do not invent an anchor for it -- recall it " +
  "with no anchor at all.";
```

Note the literal `[1, 3]` inside the prohibition stays — it is an example of what NOT to write, and the test asserts on `"Trong các ghi chú của bạn"`, not on the bracket. Because the new tests assert `not.toMatch(/\[\d/)` on the built prompt, this example must be rewritten to avoid a digit inside brackets. Change it to:

```
  "\"Trong các ghi chú của bạn có nhắc đến...\", never \"Đã lưu ghi chú của bạn vào " +
```

Delete `buildAnswerPrompt`'s standalone line at `:171`:

```ts
    "Cite the notes you used by their bracketed number, like [1].",
```

Change `buildAcknowledgePrompt`'s line at `:221-222` to:

```ts
    "Mention what you attached, briefly. If any of their earlier notes below are genuinely " +
      "related, say so and say when they wrote it.",
```

In `renderCitations`, change the entry renderer from a numbered form to a bullet:

```ts
          .map((c) => {
            // Spread-if in string form: a citation with no date renders with no parenthesis at
            // all, never "()" or "(null)". Everything in this prompt is read as fact.
            const on = c.createdAt ? formatNoteDate(c.createdAt, timeZone) : null;
            // A bullet, not "[n]". Numbering the input while forbidding brackets in the output
            // is a prompt arguing with itself, and the model will occasionally echo the very
            // thing just banned.
            return `- ${on ? `(${on}) ` : ""}${c.title ? `${c.title}: ` : ""}${c.snippet}`;
          })
```

Note the `(c, i)` parameter list loses its index.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/assistant/prompts.ts packages/core/src/assistant/prompts.test.ts
git commit -m "feat(assistant): recall a note by its date, not by a bracket"
```

---

### Task 4: a saved answer is labelled as the assistant's own words

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts` — `renderCitations`, `RECALL_RULE`
- Test: `packages/core/src/assistant/prompts.test.ts`

**Interfaces:**
- Consumes: Task 2's `Citation.authoredBy`, Task 3's bullet renderer.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`

Expected: FAIL — the label string is absent.

- [ ] **Step 3: Implement**

In `renderCitations`, add the label:

```ts
          .map((c) => {
            const on = c.createdAt ? formatNoteDate(c.createdAt, timeZone) : null;
            // The label is a SUFFIX, after the snippet, so it reads as provenance rather than as
            // part of the note's content. "mình"/"họ" rather than "I"/"they": the surrounding
            // Vietnamese examples in RECALL_RULE set the register, and an English parenthetical
            // inside an otherwise Vietnamese recall nudges the reply toward English
            // (LANGUAGE_RULE's reasoning).
            const mine = c.authoredBy === "assistant" ? " (câu trả lời của mình mà họ đã lưu)" : "";
            return `- ${on ? `(${on}) ` : ""}${c.title ? `${c.title}: ` : ""}${c.snippet}${mine}`;
          })
```

Append one clause to `RECALL_RULE`:

```ts
  " Some notes below are marked as your own earlier answers that they chose to keep. Never " +
  "recall one of those as something they thought or wrote -- say it came from an answer you " +
  "gave them before.";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/assistant/prompts.ts packages/core/src/assistant/prompts.test.ts
git commit -m "feat(assistant): never recall a saved answer as the user's own thinking"
```

---

### Task 5: replies may be as long as the question deserves

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts` — `FORMAT_RULE` (`:62-69`), `buildAcknowledgePrompt`'s opening line (`:207`), `buildChitchatPrompt`'s opening line (`:249-250`)
- Test: `packages/core/src/assistant/prompts.test.ts` — the `describe("FORMAT_RULE")` block (`:396-428`)

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Replace the `it("asks for short conversational prose by default", ...)` test in the `FORMAT_RULE` describe with:

```ts
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
```

Keep `it("carries the explicit-request exception", ...)` **exactly as it is**. It is the test that goes red if a future length edit deletes the structure half, which is the failure this file already predicted.

Add:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`

Expected: FAIL — `not.toMatch(/(two|three|\d)\s+.../)` fails because `FORMAT_RULE` still says "two or three sentences", and `not.toMatch(/one or two sentences/i)` fails on the acknowledge prompt.

- [ ] **Step 3: Implement**

Replace `FORMAT_RULE`'s doc comment's second paragraph (beginning *"BOTH halves are load-bearing"*) with:

```ts
 * BOTH halves are load-bearing and they are now INDEPENDENT, which they were not before
 * 2026-08-22. The rule used to read "a short, casual question gets a short, conversational
 * answer -- two or three sentences of prose, no headings and no list", which tied length to
 * structure and left no cell for LONG PROSE: a substantive question that deserves depth and is
 * not a list. Such a question fell into the casual branch and came back capped. The user's
 * verdict was that replies were too short; the fix is to let depth follow the question while
 * keeping structure as the exception it already was.
 *
 * The exception clause is still the half a later edit will drop, and prompts.test.ts still
 * asserts each half separately for exactly that reason.
```

Replace the constant:

```ts
const FORMAT_RULE =
  "Match the shape and the depth of the reply to the weight of the question. A short, casual " +
  "question gets a short, conversational answer. A question that genuinely asks for something " +
  "gets as much as it actually needs -- several paragraphs is fine, and prose is still the " +
  "default shape at any length. Reach for headings or a numbered list only when the user " +
  "actually asked to enumerate or compare (\"liệt kê\", \"các bước\", \"so sánh\", \"list " +
  "out\"), or when the answer genuinely is a set of parallel items that prose would obscure. " +
  "Structure is the exception, not the default shape of an answer.";
```

Change `buildAcknowledgePrompt`'s first array element from `"The user just saved a note. Acknowledge it in one or two sentences."` to:

```ts
    "The user just saved a note. Acknowledge it briefly -- this is an acknowledgement, not an " +
      "answer, so keep it to what is worth saying and no more.",
```

Change `buildChitchatPrompt`'s first array element to:

```ts
    "The user said something conversational -- a greeting, a reaction, or noise. Reply naturally " +
      "and keep it light; this is small talk, not a topic. Do not ask a follow-up question and " +
      "do not start a topic.",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`

Expected: PASS, including the untouched `"carries the explicit-request exception"` and `"stays off the acknowledge and chitchat prompts"`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/assistant/prompts.ts packages/core/src/assistant/prompts.test.ts
git commit -m "feat(assistant): let a real question get a real answer"
```

---

### Task 6: the "not in your notes" disclaimer moves into the branch that needs it

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts` — `renderCitations` (all three branches), `buildAnswerPrompt`'s gap-filling line (`:173-175`)
- Test: `packages/core/src/assistant/prompts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Replace the existing `it("tells the model there are no matching notes, and that it may answer from general knowledge instead", ...)` with:

```ts
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
```

Extend the existing `it("says the search itself failed, ...")` test for `buildAnswerPrompt` with one assertion:

```ts
    // NOT NEGOTIABLE. This branch exists so the model never says "bạn không có note nào về
    // chuyện này" on a turn where the search never ran -- dropping the disclaimer here would
    // convert a technical failure into a false assertion about the user's corpus.
    expect(failed).toMatch(/not claim they have no notes/i);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`

Expected: FAIL — `expect(empty).not.toMatch(/not from their notes/i)` fails, because the gap-filling line is still a standing instruction.

- [ ] **Step 3: Implement**

Delete `buildAnswerPrompt`'s standing gap-filling line (`:173-175`):

```ts
    "If their notes do not fully answer the question, you may fill the gap -- from the web, or " +
      "from your own general knowledge -- but say plainly that it is not from their notes " +
      "(e.g. \"Trong note của bạn không có, nhưng theo mình biết...\").",
```

Keep `"Never present web content as the user's own thinking. Say where something came from."` exactly where it is — it concerns attribution of web material, not the absence of notes, and `Provenance` depends on that obligation.

Rewrite `renderCitations`'s three branches. Replace its doc comment's final paragraph with:

```ts
// The gap-filling disclaimer lives HERE, in the populated branch, and not in buildAnswerPrompt's
// standing rule list. As a standing instruction it fired on every turn, including the majority
// where retrieval returned nothing -- and with no citations there is nothing for outside material
// to be confused with, so the user heard "Trong note của bạn không có, nhưng theo mình biết..."
// on turn after turn for no information (reported 2026-08-22). The empty branch now says the
// opposite: answer, and do not narrate the absence.
```

The function body becomes:

```ts
const renderCitations = (citations: Citation[] | "failed", timeZone: string) =>
  citations === "failed"
    ? "\n\nThe user's notes could not be searched right now (a technical failure, not an empty " +
      "corpus). Say so plainly. Do not claim they have no notes on this."
    : citations.length === 0
      ? "\n\nThey have no notes on this. Just answer -- from the web or from your own general " +
        "knowledge -- and do not announce that their notes had nothing. There is nothing of " +
        "theirs to attribute here, so there is nothing to distinguish your answer from."
      : `\n\nThe user's own notes:\n${citations
          .map((c) => {
            const on = c.createdAt ? formatNoteDate(c.createdAt, timeZone) : null;
            const mine = c.authoredBy === "assistant" ? " (câu trả lời của mình mà họ đã lưu)" : "";
            return `- ${on ? `(${on}) ` : ""}${c.title ? `${c.title}: ` : ""}${c.snippet}${mine}`;
          })
          .join("\n")}\n\nIf these do not fully answer the question, you may fill the gap -- from ` +
        "the web, or from your own general knowledge -- but say plainly which part is not from " +
        "their notes.";
```

Note that `it("tells the model there are no matching notes...")`'s old assertion `toMatch(/no notes matching/i)` is replaced by the new tests; the phrase "no notes matching" no longer appears, which is why the populated-branch test asserts `not.toMatch(/no notes matching/i)` and still passes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`

Expected: PASS. Then run the whole core suite — `buildAcknowledgePrompt` shares `renderCitations` and has its own copies of the empty/failed tests at `:174-180`:

Run: `pnpm turbo run test --filter=@cortex/core`

Expected: PASS. If `buildAcknowledgePrompt`'s empty-branch test asserts `/no notes matching/i`, update it to the new wording — it is testing the same shared renderer.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/assistant/prompts.ts packages/core/src/assistant/prompts.test.ts
git commit -m "feat(assistant): stop narrating an empty search on every turn"
```

---

### Task 7: `offer.ts` splits so a second path can reach the model call

**Files:**
- Modify: `packages/core/src/assistant/offer.ts`
- Test: `packages/core/src/assistant/offer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const OFFER_PROMPT: string` — the existing `PROMPT`, renamed and exported.
  - `export const MANUAL_SAVE_PROMPT: string` — new.
  - `export async function distill(deps: { db: SupabaseClient; ai: AiClient }, a: { userId: string; prompt: string; question?: string; answer: string; requestId: string }): Promise<string | null>` — one model call, metered, capped at `OFFER_MAX_CHARS`, never throws. No dedup.
  - `proposeOffer` keeps its existing signature and return type exactly.

- [ ] **Step 1: Write the failing tests**

```ts
describe("distill", () => {
  // The manual path's prompt must NOT be the offer's. The offer's opens with "knowledge that was
  // NOT in the user's own notes", which is false on a path the user invoked deliberately -- they
  // may well want to keep an answer drawn from their own notes. And "Returning null is the normal
  // case" must not appear: on a path the user asked for, null is a failure, not modesty.
  it("uses a manual-save prompt that does not assume the answer came from outside their notes", () => {
    expect(MANUAL_SAVE_PROMPT).not.toMatch(/NOT in the user's own notes/i);
    expect(MANUAL_SAVE_PROMPT).not.toMatch(/null is the normal case/i);
    expect(OFFER_PROMPT).toMatch(/NOT in the user's own notes/i);
  });

  it("returns the condensed statement", async () => {
    const ai = aiReturningJson({ statement: "Cá hồi giàu omega-3." });
    const out = await distill({ db: dbStub(), ai }, {
      userId: "u", prompt: MANUAL_SAVE_PROMPT, answer: "a long answer", requestId: "r",
    });
    expect(out).toBe("Cá hồi giàu omega-3.");
  });

  // The caller's fallback depends on this being null rather than a throw: the client shows the
  // verbatim reply instead, so a failed distillation must never dead-end the user's request.
  it("returns null rather than throwing when the model call fails", async () => {
    const ai = aiThrowingJson(new Error("gemini down"));
    const out = await distill({ db: dbStub(), ai }, {
      userId: "u", prompt: MANUAL_SAVE_PROMPT, answer: "a", requestId: "r",
    });
    expect(out).toBeNull();
  });

  it("returns null when the model produced nothing usable", async () => {
    const ai = aiReturningJson({ statement: "   " });
    expect(await distill({ db: dbStub(), ai }, {
      userId: "u", prompt: MANUAL_SAVE_PROMPT, answer: "a", requestId: "r",
    })).toBeNull();
  });

  // A statement over the cap means the model did not distil -- it echoed. Null, so the caller
  // falls back to the verbatim reply, which is at least honestly labelled as such.
  it("returns null when the statement exceeds OFFER_MAX_CHARS", async () => {
    const ai = aiReturningJson({ statement: "x".repeat(OFFER_MAX_CHARS + 1) });
    expect(await distill({ db: dbStub(), ai }, {
      userId: "u", prompt: MANUAL_SAVE_PROMPT, answer: "a", requestId: "r",
    })).toBeNull();
  });

  // No dedup on this path, and the assertion is that a stored fact IDENTICAL to the statement
  // does not suppress it. Silence because the statement resembles something previously declined
  // would be indistinguishable from a broken button, with no way for the user to find out why.
  it("does not consult memory_facts", async () => {
    const db = dbStub();
    const ai = aiReturningJson({ statement: "Cá hồi giàu omega-3." });
    await distill({ db, ai }, {
      userId: "u", prompt: MANUAL_SAVE_PROMPT, answer: "a", requestId: "r",
    });
    expect(db.from).not.toHaveBeenCalledWith("memory_facts");
  });
});
```

Reuse whatever `ai`/`db` stub helpers `offer.test.ts` already defines; the names above (`aiReturningJson`, `aiThrowingJson`, `dbStub`) are placeholders for the file's existing equivalents. If the file has none that fit, define them once at the top of the new `describe` — do not duplicate an existing helper.

Also add one test proving the offer path still dedups, so the split did not quietly drop it:

```ts
  // The split must leave proposeOffer's behaviour identical. Dedup is the half that lives OUTSIDE
  // distill now, so it is the half a careless split loses.
  it("proposeOffer still suppresses a statement matching a stored fact", async () => {
    // ... existing dedup test's arrangement, unchanged ...
  });
```

If `offer.test.ts` already has such a test, leave it in place and do not add a second.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- offer`

Expected: FAIL — `distill`, `MANUAL_SAVE_PROMPT` and `OFFER_PROMPT` are not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/assistant/offer.ts`:

Rename `const PROMPT` to `export const OFFER_PROMPT` and update its one reference.

Add beside it:

```ts
/**
 * The user-initiated path's prompt (S1.5 §4). Deliberately NOT `OFFER_PROMPT`.
 *
 * Two things differ, and both are load-bearing. The offer's prompt opens with "knowledge that was
 * NOT in the user's own notes", which is simply false here -- the user may want to keep an answer
 * drawn entirely from their own notes, and a prompt that asserts otherwise makes the model hunt
 * for outside content that is not there. And the offer's "Returning null is the normal case and
 * is always better than a weak offer" must not appear: that sentence is right for a suggestion
 * nobody asked for and wrong for a button the user pressed, where null is a failure.
 *
 * There is still a null path -- the caller falls back to the verbatim reply -- but it is the
 * exception here, not the design.
 */
export const MANUAL_SAVE_PROMPT =
  "The user just asked to keep this answer in their own notes. Condense it into ONE standalone " +
  "sentence they would want kept -- the thing that stays true and useful a month from now, " +
  "readable on its own with no memory of this conversation.\n" +
  "Keep the substance, not the conversational framing. Only return null if the answer contains " +
  "no keepable content at all.\n" +
  "Write it in the same language the user wrote in. Return JSON only.";
```

Extract the model call. `distill` is everything `proposeOffer` did up to and including the cap check:

```ts
/**
 * One model call that turns an answer into a single keepable sentence, metered, capped, and
 * incapable of throwing.
 *
 * Shared by both save paths deliberately: `save-answer.ts` requires that the offer's accept and
 * the user's own save "come through this same function, which is what makes the two
 * indistinguishable BY CONSTRUCTION rather than by discipline". This is the upstream half of
 * that; `buildSavedAnswerRow` is the downstream half.
 *
 * NO DEDUP HERE. `proposeOffer` layers that on top, because it is only correct for the
 * assistant's own unsolicited suggestion. On the manual path, staying silent because the
 * statement resembles a previously declined fact is indistinguishable from a broken button.
 *
 * NEVER THROWS, same contract proposeOffer already had: every failure returns null, and every
 * caller treats null as "no statement" rather than as an error.
 */
export async function distill(
  deps: { db: SupabaseClient; ai: AiClient },
  a: { userId: string; prompt: string; question?: string; answer: string; requestId: string },
): Promise<string | null> {
  try {
    const { value, inputTokens, outputTokens, model } = await deps.ai.generateJson<{
      statement?: unknown;
    }>({
      // The question is optional because the manual path can be invoked on a reply scrolled back
      // to, where the turn that produced it may not be on screen. Omitted rather than sent empty:
      // "Their question: " with nothing after it is a line the model has to interpret.
      prompt: `${a.prompt}${a.question ? `\n\nTheir question: ${a.question}` : ""}\n\nThe answer given: ${a.answer}`,
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
      console.error(`[assistant] distill ledger write failed (request ${a.requestId}): ${errorMessage(err)}`);
    }

    const statement = typeof value.statement === "string" ? value.statement.trim() : "";
    // Over the cap means the model echoed rather than distilled. Null, so the caller falls back
    // to something honestly labelled instead of writing a whole reply in under a distillation's
    // name.
    if (statement === "" || statement.length > OFFER_MAX_CHARS) return null;
    return statement;
  } catch (err) {
    console.error(`[assistant] distill failed (request ${a.requestId}): ${errorMessage(err)}`);
    return null;
  }
}
```

Rewrite `proposeOffer` to call it, keeping the dedup block and the return shape byte-identical:

```ts
export async function proposeOffer(
  deps: { db: SupabaseClient; ai: AiClient },
  a: { userId: string; question: string; answer: string; sourceUrl?: string; requestId: string },
): Promise<Offer | null> {
  const statement = await distill(deps, {
    userId: a.userId, prompt: OFFER_PROMPT, question: a.question,
    answer: a.answer, requestId: a.requestId,
  });
  if (statement === null) return null;

  // §12.3. One embed call per offer, metered like every other. Compared against BOTH 'rejected'
  // and 'active' facts: a fact the user already keeps does not need offering either.
  //
  // ... keep the existing dedup block verbatim, including toEmbeddingVector, the cosine loop,
  // the recordUsage call and the catch that skips dedup rather than failing the offer ...

  return { statement, ...(a.sourceUrl !== undefined ? { sourceUrl: a.sourceUrl } : {}) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core`

Expected: PASS, including every pre-existing `offer.test.ts` and `turn.test.ts` test. `turn.ts` is not edited in this task and must not need editing — `proposeOffer`'s signature is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/assistant/offer.ts packages/core/src/assistant/offer.test.ts
git commit -m "refactor(assistant): split the distillation out of the offer"
```

---

### Task 8: `POST /assistant/distill`

**Files:**
- Modify: `packages/shared/src/dto/assistant.ts` (add `distillInput`)
- Modify: `packages/core/src/index.ts` (export `distill`, `MANUAL_SAVE_PROMPT`)
- Modify: `apps/api/src/assistant.controller.ts`
- Test: `packages/shared/src/dto/assistant.test.ts`, `apps/api/test/assistant.e2e.test.ts`

**Interfaces:**
- Consumes: Task 7's `distill` and `MANUAL_SAVE_PROMPT`.
- Produces:
  - `export const distillInput` / `export type DistillInput = { answer: string; question?: string }`
  - `POST /assistant/distill` → `200 { statement: string | null }`

- [ ] **Step 1: Write the failing DTO test**

In `packages/shared/src/dto/assistant.test.ts`:

```ts
describe("distillInput", () => {
  it("accepts an answer with an optional question", () => {
    expect(distillInput.parse({ answer: "a" })).toEqual({ answer: "a" });
    expect(distillInput.parse({ answer: "a", question: "q" }).question).toBe("q");
  });

  // Same cap as saveAnswerInput and createNoteInput, for the same reason that comment gives: a
  // value acceptable through POST /notes and rejected here would be the same note failing for no
  // reason the user can see.
  it("caps the answer at 100_000, matching saveAnswerInput", () => {
    expect(() => distillInput.parse({ answer: "x".repeat(100_001) })).toThrow();
    expect(distillInput.parse({ answer: "x".repeat(100_000) }).answer).toHaveLength(100_000);
  });

  // .strict(), matching every other body in this file: the user id comes from the verified JWT
  // and a body carrying one must be a 400, not a value the server quietly drops.
  it("rejects an unknown key", () => {
    expect(() => distillInput.parse({ answer: "a", userId: "u" })).toThrow();
  });

  // No sourceUrl. Distillation does not write a note -- the client sends the url to
  // POST /notes/save-answer afterwards -- so a url here would be an unused field the server
  // would have to be trusted not to act on.
  it("has no sourceUrl field", () => {
    expect(() => distillInput.parse({ answer: "a", sourceUrl: "https://example.com" })).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/shared`

Expected: FAIL — `distillInput` is not exported.

- [ ] **Step 3: Implement the DTO**

In `packages/shared/src/dto/assistant.ts`, after `saveAnswerInput`:

```ts
/**
 * `POST /assistant/distill`'s body (S1.5 §4). The user pressed "Lưu câu trả lời" and the server
 * condenses the reply into one keepable sentence before showing it back for confirmation.
 *
 * `question` is optional because the control sits on EVERY assistant reply, including ones
 * scrolled back to, where the turn that produced them may not be on screen. Absent is honest;
 * an empty string would be a line the model has to interpret.
 *
 * The `answer` cap matches saveAnswerInput's 100_000 rather than OFFER_MAX_CHARS: this is the
 * whole reply going IN, not the statement coming out. The statement is capped at
 * OFFER_MAX_CHARS inside `distill`.
 *
 * No `sourceUrl`: this endpoint writes nothing. The client carries the url to
 * POST /notes/save-answer itself, which is the request that actually creates the note.
 */
export const distillInput = z
  .object({
    answer: z.string().min(1).max(100_000),
    question: z.string().max(100_000).optional(),
  })
  .strict();

export type DistillInput = z.infer<typeof distillInput>;
```

Run `pnpm turbo run test --filter=@cortex/shared` — expect PASS.

- [ ] **Step 4: Write the failing e2e test**

In `apps/api/test/assistant.e2e.test.ts`, following the file's existing auth/harness pattern:

```ts
  // The happy path. The AI client is stubbed by the harness, so this asserts the route's shape
  // and its auth, not the model's judgement.
  it("condenses an answer into one statement", async () => {
    const res = await request(app.getHttpServer())
      .post("/assistant/distill")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: "Cá hồi có nhiều omega-3, tốt cho mắt và cho tim.", question: "ăn gì tốt cho mắt" });
    expect(res.status).toBe(200);
    expect(typeof res.body.statement === "string" || res.body.statement === null).toBe(true);
  });

  // The fallback contract the clients depend on: a failed distillation is a 200 with a null
  // statement, NOT an error. The client shows the verbatim reply instead, so turning this into a
  // 5xx would dead-end a request the user deliberately made.
  it("answers 200 with a null statement when distillation produces nothing", async () => {
    // Arrange the harness's AI stub to return { statement: null } for this call.
    const res = await request(app.getHttpServer())
      .post("/assistant/distill")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: "ok" });
    expect(res.status).toBe(200);
    expect(res.body.statement).toBeNull();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app.getHttpServer())
      .post("/assistant/distill")
      .send({ answer: "a" });
    expect(res.status).toBe(401);
  });

  it("rejects a body with an unknown key", async () => {
    const res = await request(app.getHttpServer())
      .post("/assistant/distill")
      .set("authorization", `Bearer ${token}`)
      .send({ answer: "a", userId: "someone-else" });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/api`

Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 6: Implement the route**

Export `distill` and `MANUAL_SAVE_PROMPT` from `packages/core/src/index.ts` alongside the existing `declineOffer` export.

In `apps/api/src/assistant.controller.ts`, add to the imports from `@cortex/core`: `distill`, `MANUAL_SAVE_PROMPT`. Add to the `@cortex/shared` import: `distillInput`, `type DistillInput`.

Add the handler:

```ts
  /**
   * S1.5 §4. The user pressed "Lưu câu trả lời"; this condenses the reply so they can confirm a
   * sentence rather than a transcript.
   *
   * 200 with `{ statement: null }` rather than an error status when distillation fails, and this
   * is a contract both clients depend on: they fall back to offering the verbatim reply, so a
   * 5xx here would dead-end a request the user deliberately made. `distill` never throws.
   *
   * Service-role db for the ledger only, matching every other metered call on this controller;
   * nothing user-owned is read or written here, because this endpoint creates no note. The note
   * is created by the client's follow-up POST /notes/save-answer, under the caller's own JWT.
   */
  @Post("distill")
  @HttpCode(200)
  async distill(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(distillInput)) body: DistillInput,
  ): Promise<{ statement: string | null }> {
    const statement = await distill({ db: this.serviceDb, ai: this.ai }, {
      userId: user.id,
      prompt: MANUAL_SAVE_PROMPT,
      answer: body.answer,
      ...(body.question !== undefined ? { question: body.question } : {}),
      requestId: randomUUID(),
    });
    return { statement };
  }
```

The method name `distill` shadows the imported function inside the class body. Import it aliased — `distill as distillStatement` — and call `distillStatement(...)`, so the recursion is impossible rather than merely unlikely.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/api`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/dto/assistant.ts packages/shared/src/dto/assistant.test.ts packages/core/src/index.ts apps/api/src/assistant.controller.ts apps/api/test/assistant.e2e.test.ts
git commit -m "feat(api): condense an answer on request"
```

---

### Task 9: web — "Lưu câu trả lời" on every reply

**Files:**
- Modify: `apps/web/src/app/assistant-box.tsx`
- Modify: `apps/web/src/app/globals.css` (one rule for `.save-proposal`)
- Test: `apps/web/src/app/assistant-box.test.tsx`

**Interfaces:**
- Consumes: Task 8's `POST /assistant/distill`, the existing `POST /notes/save-answer`.
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/app/assistant-box.test.tsx`, following the file's existing render/mock-fetch pattern:

```ts
  // The control the user went looking for on 2026-08-22 and could not find, because the automatic
  // offer is gated on a web-grounded answer (turn.ts:441) and most turns are not.
  it("offers to save every assistant reply, not only the grounded ones", async () => {
    renderWithTurns([
      { id: "1", role: "user", content: "ăn gì tốt cho mắt", citations: [], createdAt: ISO },
      { id: "2", role: "assistant", content: "Cá hồi.", citations: [], createdAt: ISO },
    ]);
    expect(await screen.findByRole("button", { name: "Lưu câu trả lời" })).toBeInTheDocument();
  });

  it("shows the condensed statement for confirmation before writing anything", async () => {
    const fetchMock = mockFetch({ "/assistant/distill": { statement: "Cá hồi giàu omega-3." } });
    renderWithTurns([{ id: "2", role: "assistant", content: "Cá hồi.", citations: [], createdAt: ISO }]);
    await userEvent.click(screen.getByRole("button", { name: "Lưu câu trả lời" }));
    expect(await screen.findByText("Cá hồi giàu omega-3.")).toBeInTheDocument();
    // Nothing is written until the user confirms. Asserting the absence of the write is the
    // point: a version that saved on the first click would pass a test that only looked for text.
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/notes/save-answer"), expect.anything(),
    );
  });

  it("writes the note only after the confirmation is pressed", async () => {
    const fetchMock = mockFetch({ "/assistant/distill": { statement: "Cá hồi giàu omega-3." } });
    renderWithTurns([{ id: "2", role: "assistant", content: "Cá hồi.", citations: [], createdAt: ISO }]);
    await userEvent.click(screen.getByRole("button", { name: "Lưu câu trả lời" }));
    await userEvent.click(await screen.findByRole("button", { name: "Lưu câu này" }));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/notes/save-answer"),
      expect.objectContaining({
        body: JSON.stringify({ statement: "Cá hồi giàu omega-3." }),
      }),
    );
  });

  // NO DEAD END. A failed distillation must still let the user keep the answer -- verbatim,
  // honestly. Returning nothing here would make the button look broken on exactly the turns
  // where the model is having a bad day.
  it("falls back to the verbatim reply when distillation returns null", async () => {
    mockFetch({ "/assistant/distill": { statement: null } });
    renderWithTurns([{ id: "2", role: "assistant", content: "Cá hồi.", citations: [], createdAt: ISO }]);
    await userEvent.click(screen.getByRole("button", { name: "Lưu câu trả lời" }));
    expect(await screen.findByText("Cá hồi.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Lưu câu này" })).toBeInTheDocument();
  });

  // Cancelling writes NOTHING -- specifically not a memory_facts decline. A decline exists to stop
  // the assistant re-offering something on its own initiative; recording one here would suppress
  // future offers about a fact the user merely changed their mind about keeping.
  it("writes nothing at all when the proposal is dismissed", async () => {
    const fetchMock = mockFetch({ "/assistant/distill": { statement: "Cá hồi giàu omega-3." } });
    renderWithTurns([{ id: "2", role: "assistant", content: "Cá hồi.", citations: [], createdAt: ISO }]);
    await userEvent.click(screen.getByRole("button", { name: "Lưu câu trả lời" }));
    await userEvent.click(await screen.findByRole("button", { name: "Thôi" }));
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/notes/save-answer"), expect.anything(),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/assistant/decline"), expect.anything(),
    );
  });

  // A reply carrying web sources is saved as 'web_search', not 'assistant' -- buildSavedAnswerRow
  // picks between them on the presence of a url, and dropping it here would silently relabel the
  // provenance of everything the user keeps from a grounded answer.
  it("carries the web source url so the note is filed as a web-sourced save", async () => {
    const fetchMock = mockFetch({ "/assistant/distill": { statement: "S." } });
    renderWithTurns([{
      id: "2", role: "assistant", content: "Cá hồi.", createdAt: ISO,
      citations: [{ type: "web", url: "https://example.com/a", title: "A" }],
    }]);
    await userEvent.click(screen.getByRole("button", { name: "Lưu câu trả lời" }));
    await userEvent.click(await screen.findByRole("button", { name: "Lưu câu này" }));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/notes/save-answer"),
      expect.objectContaining({
        body: JSON.stringify({ statement: "S.", sourceUrl: "https://example.com/a" }),
      }),
    );
  });
```

`renderWithTurns` and `mockFetch` are placeholders for the file's existing helpers; use whatever it already has rather than adding parallel ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/web`

Expected: FAIL — no button named "Lưu câu trả lời".

- [ ] **Step 3: Implement**

In `apps/web/src/app/assistant-box.tsx`, add state beside the existing `offer` state:

```ts
  // The MANUAL save, distinct from `offer` above in both direction and meaning: `offer` is the
  // assistant proposing something unasked, this is the user asking. They can be on screen at the
  // same time, on the same reply, which is why the two boxes are labelled differently rather than
  // being two identically-named buttons.
  const [proposal, setProposal] = useState<
    { forId: string; statement: string; sourceUrl?: string } | null
  >(null);
  const [proposing, setProposing] = useState<string | null>(null);
```

Add the two handlers next to `acceptOffer`/`declineOffer`:

```ts
  /**
   * Ask the server to condense a reply, then show it back for confirmation. Writes nothing.
   *
   * NEVER dead-ends: a null statement, a non-200, or a thrown fetch all fall through to the
   * verbatim reply. The user pressed a button and must get a box either way -- a silent no-op is
   * indistinguishable from a broken control.
   */
  async function proposeSave(forId: string, answerText: string, question?: string, sourceUrl?: string) {
    setProposal(null);
    setProposing(forId);
    let statement = answerText;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/assistant/distill`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ answer: answerText, ...(question ? { question } : {}) }),
      });
      if (res.ok) {
        const d = (await res.json()) as { statement: string | null };
        if (typeof d.statement === "string" && d.statement !== "") statement = d.statement;
      }
    } catch {
      // Fall through to the verbatim reply, deliberately silent: the box below IS the feedback.
    } finally {
      setProposing(null);
    }
    setProposal({ forId, statement, ...(sourceUrl !== undefined ? { sourceUrl } : {}) });
  }

  /**
   * The write. Same endpoint and same body shape the offer's accept uses, which is what makes the
   * two produce an identical row -- see save-answer.ts's buildSavedAnswerRow doc.
   *
   * Dismissing instead calls NOTHING. Not POST /assistant/decline: a decline records that the
   * ASSISTANT should stop offering a fact, and the user declining to keep an answer they asked
   * about is not that.
   */
  async function confirmSave(p: { statement: string; sourceUrl?: string }) {
    setProposal(null);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/notes/save-answer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          statement: p.statement,
          ...(p.sourceUrl !== undefined ? { sourceUrl: p.sourceUrl } : {}),
        }),
      });
    } catch {
      // Best-effort, same as acceptOffer: the box is already off screen.
    }
  }
```

Add a small helper above the component, so the same rule serves both the persisted rows and the live reply:

```ts
/** The first web source on a reply, which is what turns a save into a 'web_search' note. */
const webUrlOf = (citations: AnyCitation[]): string | undefined =>
  citations.find((c): c is WebCitation => c.type === "web")?.url;
```

In the persisted-turn branch (the `t.role === "user" ? ... : ...` assistant arm), after the
`t.incomplete` paragraph:

```ts
                  {t.content && (
                    <button
                      type="button"
                      className="save-answer"
                      disabled={proposing === t.id}
                      onClick={() => void proposeSave(
                        t.id,
                        t.content,
                        turns[i - 1]?.role === "user" ? turns[i - 1]!.content : undefined,
                        webUrlOf(t.citations),
                      )}
                    >
                      {proposing === t.id ? "Đang rút gọn…" : "Lưu câu trả lời"}
                    </button>
                  )}
```

In the live-reply block (`{hasReply && ...}`), after the `answer` div:

```ts
            {answer && (
              <button
                type="button"
                className="save-answer"
                disabled={proposing === "live"}
                onClick={() => void proposeSave("live", answer, undefined, web?.sources[0]?.url)}
              >
                {proposing === "live" ? "Đang rút gọn…" : "Lưu câu trả lời"}
              </button>
            )}
```

Add the confirmation box beside the existing `{offer && ...}` block, and **after** it so the
manual box never displaces an offer already on screen:

```ts
        {proposal && (
          // Deliberately worded differently from the offer box above. Both can be on screen at
          // once, on the same reply, and they mean different things: the offer's statement was
          // chosen by the assistant, this one by the user. Two buttons both saying "Lưu" would be
          // a coin flip.
          <div className="save-proposal" role="group" aria-label="Lưu câu trả lời này?">
            <p>{proposal.statement}</p>
            <button type="button" onClick={() => void confirmSave(proposal)}>Lưu câu này</button>
            <button type="button" onClick={() => setProposal(null)}>Thôi</button>
          </div>
        )}
```

Add `WebCitation` to the existing `@cortex/shared` import if it is not already there (it is, at `:3`).

In `apps/web/src/app/globals.css`, add beside the existing `.offer` rule:

```css
/* Same shape as .offer -- one line, two buttons, easy to ignore -- but visually distinguishable,
   because both can be on screen at once on the same reply (S1.5 §4). */
.save-proposal {
  display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
  margin: .5rem 0; padding: .5rem .75rem;
  border: 1px dashed var(--line); border-radius: 8px;
}
.save-proposal p { margin: 0; flex: 1 1 12rem; color: var(--muted); }
.save-answer {
  background: none; border: none; padding: 0; margin-top: .25rem;
  color: var(--muted); font-size: .85rem; text-decoration: underline; cursor: pointer;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/assistant-box.tsx apps/web/src/app/assistant-box.test.tsx apps/web/src/app/globals.css
git commit -m "feat(web): let the user keep an answer on purpose"
```

---

### Task 10: mobile — the same control, in the transcript

**Files:**
- Create: `apps/mobile/src/lib/assistant/save.ts`
- Create: `apps/mobile/src/lib/assistant/save.test.ts`
- Modify: `apps/mobile/src/screens/chat.tsx`

**Interfaces:**
- Consumes: Task 8's `POST /assistant/distill`, the existing `POST /notes/save-answer`.
- Produces:
  - `export async function proposeStatement(a: { apiUrl: string; token: string; answer: string; question?: string; fetchFn?: typeof fetch }): Promise<string>` — returns the condensed statement, or `answer` verbatim on any failure. Never throws.
  - `export async function saveStatement(a: { apiUrl: string; token: string; statement: string; sourceUrl?: string; fetchFn?: typeof fetch }): Promise<void>` — never throws.
  - `export function webUrlOf(citationsJson: string | null): string | undefined` — reads the first `type: "web"` url out of a replicated `chat_messages.citations` value, which arrives as a JSON **string** on the device.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/lib/assistant/save.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { proposeStatement, saveStatement, webUrlOf } from "./save";

const ok = (body: unknown) => vi.fn().mockResolvedValue({
  ok: true, json: async () => body,
} as unknown as Response);

describe("proposeStatement", () => {
  it("returns the condensed statement", async () => {
    const out = await proposeStatement({
      apiUrl: "http://api", token: "t", answer: "Cá hồi.", fetchFn: ok({ statement: "Cá hồi giàu omega-3." }),
    });
    expect(out).toBe("Cá hồi giàu omega-3.");
  });

  // NO DEAD END, and this is the whole reason this module exists as a testable unit: the screen
  // has no component-test harness, so this contract has to be provable here.
  it.each([
    ["a null statement", ok({ statement: null })],
    ["a non-200", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) } as unknown as Response)],
    ["a thrown fetch", vi.fn().mockRejectedValue(new Error("offline"))],
  ])("falls back to the verbatim answer on %s", async (_label, fetchFn) => {
    const out = await proposeStatement({
      apiUrl: "http://api", token: "t", answer: "Cá hồi.", fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(out).toBe("Cá hồi.");
  });

  it("omits the question key entirely when there is no question", async () => {
    const fetchFn = ok({ statement: "s" });
    await proposeStatement({ apiUrl: "http://api", token: "t", answer: "a", fetchFn });
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ answer: "a" });
  });
});

describe("saveStatement", () => {
  it("posts the statement and the source url", async () => {
    const fetchFn = ok({ id: "n1" });
    await saveStatement({
      apiUrl: "http://api", token: "t", statement: "s", sourceUrl: "https://e.com", fetchFn,
    });
    expect(fetchFn.mock.calls[0]![0]).toBe("http://api/notes/save-answer");
    expect(JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string))
      .toEqual({ statement: "s", sourceUrl: "https://e.com" });
  });

  it("does not throw when the write fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(saveStatement({
      apiUrl: "http://api", token: "t", statement: "s", fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBeUndefined();
  });
});

describe("webUrlOf", () => {
  // On the device, chat_messages.citations arrives as a JSON STRING -- jsonb replicates the same
  // way notes.domain_meta does. Parsing it is the whole job, and a version that treated it as an
  // array would silently return undefined for every grounded reply.
  it("reads the first web url out of the replicated JSON string", () => {
    const json = JSON.stringify([
      { type: "note", noteId: "n" },
      { type: "web", url: "https://e.com/a", title: "A" },
      { type: "web", url: "https://e.com/b", title: "B" },
    ]);
    expect(webUrlOf(json)).toBe("https://e.com/a");
  });

  it.each([[null], [""], ["not json"], ["[]"], [JSON.stringify([{ type: "note" }])]])(
    "returns undefined for %s", (input) => {
      expect(webUrlOf(input as string | null)).toBeUndefined();
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/mobile`

Expected: FAIL — `./save` does not exist.

- [ ] **Step 3: Implement the module**

Create `apps/mobile/src/lib/assistant/save.ts`:

```ts
import type { AnyCitation } from "@cortex/shared";

/**
 * The two network calls behind "Lưu câu trả lời" (S1.5 §4), as a module rather than inline in the
 * screen -- mobile's vitest environment is `node` and there is no component-test harness, so a
 * contract that lives in a component is a contract with no test.
 *
 * Both functions swallow every failure by design. The user pressed a button; a thrown promise
 * inside a screen handler is an unhandled rejection and a control that appears to do nothing.
 */

/**
 * Condense a reply into one keepable sentence, falling back to the reply itself.
 *
 * NEVER dead-ends. A null statement, a non-200, or a dead network all return `answer` unchanged,
 * so the confirmation box always has something honest to show. That fallback is the contract the
 * screen depends on and the reason this is tested in five shapes.
 */
export async function proposeStatement(a: {
  apiUrl: string; token: string; answer: string; question?: string; fetchFn?: typeof fetch;
}): Promise<string> {
  const f = a.fetchFn ?? fetch;
  try {
    const res = await f(`${a.apiUrl}/assistant/distill`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      // Spread-if, not `question: a.question`: an undefined value serialises to an absent key
      // here and the endpoint is `.strict()`, so an explicit `"question": undefined` would be a
      // 400 on some serialisers and a silently dropped key on others.
      body: JSON.stringify({ answer: a.answer, ...(a.question ? { question: a.question } : {}) }),
    });
    if (!res.ok) return a.answer;
    const d = (await res.json()) as { statement?: unknown };
    return typeof d.statement === "string" && d.statement !== "" ? d.statement : a.answer;
  } catch {
    return a.answer;
  }
}

/**
 * Write the note. Same endpoint and body the web client's accept path uses, which is half of what
 * makes the two produce an identical row -- `buildSavedAnswerRow` is the other half.
 *
 * NOT queued through PowerSync. `chat_messages` is read-only on the device and a saved answer is
 * a `notes` row the SERVER writes under the caller's JWT; routing it through the upload path
 * would need a local insert this client has no id contract for. Offline, this simply fails, and
 * the button is a no-op until there is a network -- acceptable because the answer being saved
 * came from the network in the first place.
 */
export async function saveStatement(a: {
  apiUrl: string; token: string; statement: string; sourceUrl?: string; fetchFn?: typeof fetch;
}): Promise<void> {
  const f = a.fetchFn ?? fetch;
  try {
    await f(`${a.apiUrl}/notes/save-answer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: JSON.stringify({
        statement: a.statement,
        ...(a.sourceUrl !== undefined ? { sourceUrl: a.sourceUrl } : {}),
      }),
    });
  } catch {
    // Best-effort, same as web's acceptOffer: the box is already off screen.
  }
}

/**
 * The first web source on a replicated reply, which is what makes a save a 'web_search' note
 * rather than an 'assistant' one.
 *
 * Takes a STRING because that is what the device gets: `chat_messages.citations` is jsonb, and
 * PowerSync delivers jsonb as a JSON string exactly as `notes.domain_meta` arrives. A version
 * that expected an array would return undefined for every grounded reply and quietly relabel the
 * provenance of everything the user keeps.
 */
export function webUrlOf(citationsJson: string | null): string | undefined {
  if (!citationsJson) return undefined;
  try {
    const parsed = JSON.parse(citationsJson) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const web = (parsed as AnyCitation[]).find((c) => c && c.type === "web");
    return web && "url" in web && typeof web.url === "string" ? web.url : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/mobile`

Expected: PASS.

- [ ] **Step 5: Wire it into the transcript**

In `apps/mobile/src/screens/chat.tsx`:

Add imports:

```ts
import { Pressable } from "react-native";
import { supabase } from "../lib/supabase";
import { proposeStatement, saveStatement, webUrlOf } from "../lib/assistant/save";
```

Add state and a handler in `Chat`:

```ts
  // The manual save, S1.5 §4. Lives in Chat rather than in AssistantBox because this screen owns
  // the replicated rows -- the control sits on every assistant reply, not only on the live turn.
  const [proposal, setProposal] = useState<
    { statement: string; sourceUrl?: string } | null
  >(null);
  const [proposing, setProposing] = useState<string | null>(null);

  async function onSave(id: string, answer: string, question: string | undefined, sourceUrl: string | undefined) {
    setProposal(null);
    setProposing(id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const statement = await proposeStatement({
        apiUrl: process.env.EXPO_PUBLIC_API_URL!,
        token: session.access_token,
        answer,
        ...(question ? { question } : {}),
      });
      setProposal({ statement, ...(sourceUrl !== undefined ? { sourceUrl } : {}) });
    } finally {
      setProposing(null);
    }
  }

  async function onConfirm(p: { statement: string; sourceUrl?: string }) {
    setProposal(null);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    await saveStatement({
      apiUrl: process.env.EXPO_PUBLIC_API_URL!,
      token: session.access_token,
      statement: p.statement,
      ...(p.sourceUrl !== undefined ? { sourceUrl: p.sourceUrl } : {}),
    });
  }
```

Pass them down. `renderItem` becomes:

```ts
        renderItem={({ item, index }) => (
          <Row
            item={item}
            proposing={proposing === item.id}
            // `inverted` holds items NEWEST FIRST, so the user's question is the NEXT index, not
            // the previous one. Getting this backwards attaches the wrong question to the reply,
            // which the model then answers around.
            question={
              inverted[index + 1]?.kind === "message" && inverted[index + 1]?.role === "user"
                ? inverted[index + 1]!.content
                : undefined
            }
            onSave={onSave}
          />
        )}
```

`Row` gains the props and, in the assistant branch, the button:

```ts
function Row({ item, proposing, question, onSave }: {
  item: Item;
  proposing: boolean;
  question: string | undefined;
  onSave: (id: string, answer: string, question: string | undefined, sourceUrl: string | undefined) => void;
}) {
```

and, after the `item.incomplete` block:

```tsx
      {item.content ? (
        <Pressable
          testID="save-answer"
          accessibilityRole="button"
          disabled={proposing}
          onPress={() => onSave(item.id, item.content, question, webUrlOf(item.citations ?? null))}
        >
          <Text style={{ color: theme.muted, fontSize: 13, textDecorationLine: "underline" }}>
            {proposing ? "Đang rút gọn…" : "Lưu câu trả lời"}
          </Text>
        </Pressable>
      ) : null}
```

If `Item` (from `../lib/transcript`) does not carry `citations`, add it there as `citations: string | null` and populate it from the `ChatRow` — the query at `:41` already selects the column.

Render the confirmation above the composer, inside the `KeyboardAvoidingView` and after the `FlatList`:

```tsx
      {proposal ? (
        <View testID="save-proposal" style={{
          gap: 8, margin: 12, padding: 12, borderRadius: 8,
          borderWidth: 1, borderStyle: "dashed", borderColor: theme.line,
        }}>
          <Text style={{ color: theme.muted }}>{proposal.statement}</Text>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <Pressable testID="save-confirm" accessibilityRole="button" onPress={() => void onConfirm(proposal)}>
              <Text style={{ color: theme.accent }}>Lưu câu này</Text>
            </Pressable>
            {/* Dismiss writes NOTHING -- specifically not a decline. See save.ts's module doc. */}
            <Pressable testID="save-dismiss" accessibilityRole="button" onPress={() => setProposal(null)}>
              <Text style={{ color: theme.muted }}>Thôi</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
```

- [ ] **Step 6: Typecheck and re-run**

Run: `pnpm turbo run typecheck && pnpm turbo run test --filter=@cortex/mobile`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/lib/assistant/save.ts apps/mobile/src/lib/assistant/save.test.ts apps/mobile/src/screens/chat.tsx apps/mobile/src/lib/transcript.ts
git commit -m "feat(mobile): let the user keep an answer on purpose"
```

---

### Task 11: mobile — receive the automatic offer

**Files:**
- Modify: `apps/mobile/src/lib/assistant/stream.ts` (the `BoxEvent` union and the event switch)
- Modify: `apps/mobile/src/lib/assistant/stream.test.ts`
- Modify: `apps/mobile/src/lib/assistant/save.ts` (add `declineStatement`)
- Modify: `apps/mobile/src/lib/assistant/save.test.ts`
- Modify: `apps/mobile/src/screens/assistant-box.tsx`

**Interfaces:**
- Consumes: the server's existing `offer` SSE event.
- Produces: `BoxEvent` gains `| { type: "offer"; statement: string; sourceUrl?: string }`. `save.ts` gains `export async function declineStatement(a: { apiUrl: string; token: string; statement: string; fetchFn?: typeof fetch }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `apps/mobile/src/lib/assistant/stream.test.ts`, following its existing SSE-fixture pattern:

```ts
  // The server has emitted this event since C5 and this client has silently dropped it since C5 --
  // which is why an answer could never be kept on the device at all (S1.5 §"Current architecture").
  it("yields the offer event", async () => {
    const events = await collect(streamOf([
      `event: offer\ndata: ${JSON.stringify({ statement: "Cá hồi giàu omega-3.", sourceUrl: "https://e.com" })}\n\n`,
    ]));
    expect(events).toContainEqual({
      type: "offer", statement: "Cá hồi giàu omega-3.", sourceUrl: "https://e.com",
    });
  });

  // sourceUrl is absent for general knowledge, and an explicit `sourceUrl: undefined` would be
  // written into the note's source_meta as a null on one path and an absent key on another --
  // the exact split buildSavedAnswerRow's spread-if comment exists to prevent.
  it("omits sourceUrl entirely when the offer carries none", async () => {
    const events = await collect(streamOf([
      `event: offer\ndata: ${JSON.stringify({ statement: "S." })}\n\n`,
    ]));
    expect(events).toContainEqual({ type: "offer", statement: "S." });
  });

  it("drops an offer event with no statement", async () => {
    const events = await collect(streamOf([`event: offer\ndata: ${JSON.stringify({})}\n\n`]));
    expect(events.some((e) => e.type === "offer")).toBe(false);
  });
```

In `save.test.ts`:

```ts
describe("declineStatement", () => {
  it("posts the statement to the decline endpoint", async () => {
    const fetchFn = ok({});
    await declineStatement({ apiUrl: "http://api", token: "t", statement: "s", fetchFn });
    expect(fetchFn.mock.calls[0]![0]).toBe("http://api/assistant/decline");
    expect(JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string))
      .toEqual({ statement: "s" });
  });

  it("does not throw when the decline fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(declineStatement({
      apiUrl: "http://api", token: "t", statement: "s", fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/mobile`

Expected: FAIL — no `offer` event is yielded; `declineStatement` is not exported.

- [ ] **Step 3: Implement**

In `stream.ts`, add to the `BoxEvent` union after the `mood` member:

```ts
  | { type: "offer"; statement: string; sourceUrl?: string }
```

and in the event switch, beside the `mood` branch:

```ts
      } else if (name === "offer") {
        // Guarded on a non-empty statement: an offer with nothing to save is a box with a blank
        // line and two buttons. Spread-if on sourceUrl for the reason buildSavedAnswerRow
        // documents -- absent and null are two different rows.
        const statement = typeof d.statement === "string" ? d.statement : "";
        if (statement !== "") {
          yield {
            type: "offer", statement,
            ...(typeof d.sourceUrl === "string" ? { sourceUrl: d.sourceUrl } : {}),
          };
        }
```

In `save.ts`, add:

```ts
/**
 * Record that the assistant should stop offering this fact (C5 §12). ONLY for the automatic
 * offer -- the manual save's "Thôi" must not call this. A decline says "do not raise this with me
 * again"; a user who asked to keep an answer and then changed their mind said no such thing, and
 * writing one would suppress future offers about a fact they never rejected.
 */
export async function declineStatement(a: {
  apiUrl: string; token: string; statement: string; fetchFn?: typeof fetch;
}): Promise<void> {
  const f = a.fetchFn ?? fetch;
  try {
    await f(`${a.apiUrl}/assistant/decline`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ statement: a.statement }),
    });
  } catch {
    // §11: "declining costs nothing" is a claim about latency as much as about writes. The box is
    // already gone; a failed decline means it may be offered again, which is fine.
  }
}
```

In `apps/mobile/src/screens/assistant-box.tsx`:

Add state beside `mood`:

```ts
  // NOT cleared by the `finally` that settles the turn: like web, the offer must survive the
  // hand-off into the transcript -- it disappears only when the user acts on it, or when the next
  // submit() starts (the reset block above).
  const [offer, setOffer] = useState<{ statement: string; sourceUrl?: string } | null>(null);
```

Add `setOffer(null);` to the reset block at the top of `submit()`, beside `setMood(null)`.

Add the event branch in the stream loop, beside `else if (ev.type === "mood")`:

```ts
            else if (ev.type === "offer") {
              setOffer({
                statement: ev.statement,
                ...(ev.sourceUrl !== undefined ? { sourceUrl: ev.sourceUrl } : {}),
              });
            }
```

Add the UI after the `mood` block:

```tsx
      {offer ? (
        // One line, two buttons, easy to ignore -- same rule web's .offer follows: an offer that
        // interrupts is a nag. Worded differently from chat.tsx's manual save box, because both
        // can be on screen at once and mean different things (S1.5 §4).
        <View testID="offer" style={{ gap: 8, padding: 12, borderRadius: 8,
                                      borderWidth: 1, borderColor: theme.line }}>
          <Text style={{ color: theme.text }}>{offer.statement}</Text>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <Pressable testID="offer-accept" accessibilityRole="button" onPress={() => {
              const o = offer;
              setOffer(null);
              void (async () => {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) return;
                await saveStatement({
                  apiUrl: process.env.EXPO_PUBLIC_API_URL!,
                  token: session.access_token,
                  statement: o.statement,
                  ...(o.sourceUrl !== undefined ? { sourceUrl: o.sourceUrl } : {}),
                });
              })();
            }}>
              <Text style={{ color: theme.accent }}>Lưu</Text>
            </Pressable>
            <Pressable testID="offer-decline" accessibilityRole="button" onPress={() => {
              const o = offer;
              // Cleared FIRST, before any await: "declining costs nothing" is a claim about
              // latency too, and the box must be gone the instant it is tapped.
              setOffer(null);
              void (async () => {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) return;
                await declineStatement({
                  apiUrl: process.env.EXPO_PUBLIC_API_URL!,
                  token: session.access_token, statement: o.statement,
                });
              })();
            }}>
              <Text style={{ color: theme.muted }}>Bỏ qua</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
```

Add the imports this needs: `useColorScheme` from `react-native`, `themeFor` from `../theme`, and `declineStatement, saveStatement` from `../lib/assistant/save`. Add `const theme = themeFor(useColorScheme());` at the top of the component — this screen still uses literal colours (`#ccc`, `#222`, `#eee`) at `:147`, `:159` and `:225`; leave those alone in this task rather than mixing a restyle into a feature commit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run typecheck && pnpm turbo run test --filter=@cortex/mobile`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/assistant/stream.ts apps/mobile/src/lib/assistant/stream.test.ts apps/mobile/src/lib/assistant/save.ts apps/mobile/src/lib/assistant/save.test.ts apps/mobile/src/screens/assistant-box.tsx
git commit -m "feat(mobile): receive the assistant's offer to save"
```

---

### Task 12: verify the whole stage, by machine and by hand

**Files:**
- Modify: `docs/deploy.md` (the migration step)
- Modify: `docs/superpowers/specs/2026-08-22-citations-tone-and-saving-design.md` (status line)

- [ ] **Step 1: Run every gate**

```bash
pnpm turbo run lint typecheck test
```

Expected: all green. **Read the `Cached:` line.** A run reporting `N/N successful` can be mostly replays if Docker was down for an earlier run, and a replayed `packages/db` suite proves nothing about the new migration.

- [ ] **Step 2: Run the e2e suites**

```bash
pnpm turbo run test:e2e
```

Expected: green. The web Playwright suite renders assistant replies, and the new "Lưu câu trả lời" button sits inside `.bubble.assistant` — if `assistant-box.spec.ts` asserts on that subtree's text content, extend the selector rather than deleting the assertion.

- [ ] **Step 3: Apply the migration to the hosted project**

This is a deploy step, not a code change, and it is the one thing in this plan that no test can tell you was skipped.

```bash
pnpm supabase db push
```

**No `--local` flag: this targets the HOSTED project.** Confirm the prompt lists `00035_search_notes_source_type.sql` and nothing else before accepting. Never echo the connection string this prints; if you must quote an error containing one, redact from the LAST `@`.

Then add one line to `docs/deploy.md`'s migration section recording that 00035 drops and recreates `search_notes`, so the revoke/grant pair is expected in the diff rather than alarming.

- [ ] **Step 4: The judgement no test can make**

Run the app on a real device and on the web, and check all five findings by hand. Record the verdict in the commit message of step 5. **Check both halves of each pair** — checking only the first is how an exception clause gets deleted later.

1. **Length.** Ask a substantive question ("giải thích giúp tôi tại sao ngủ ít lại tăng cân"). The answer should be as long as it needs to be, in prose. Then ask something casual ("mỏi mắt ăn gì") — it must still be short, and it must **not** come back with headings.
2. **Structure.** Ask explicitly to enumerate ("liệt kê các bước"). It must still produce a list. This is the half `FORMAT_RULE`'s exception clause protects.
3. **No brackets.** Ask about something you have written a note about. There must be no `[1]` anywhere, and the recall should name a date or a title.
4. **No disclaimer on an empty search.** Ask about something you have never written about. It must answer without announcing that your notes had nothing.
5. **Saving.** On both clients: press "Lưu câu trả lời", confirm the condensed statement appears, press "Lưu câu này", and verify a `notes` row exists with `source_type` `'assistant'` (or `'web_search'` for a grounded reply). Then press "Lưu câu trả lời" again on another reply and press "Thôi" — verify **no** new row in `notes` and **no** new row in `memory_facts`.
6. **Provenance framing.** With the `'assistant'` note from step 5 now in the corpus, ask a question that should retrieve it. The reply must not present it as something you wrote.

If any of 1–4 reads worse than before, that is a prompt-wording adjustment, not a rollback — the tests pin the structure, not the phrasing.

- [ ] **Step 5: Close the spec and commit**

Change the spec's status line to `Status: implemented and merged on <date> (PR #NN, <sha>).` once merged; until then, `Status: implemented on <date>, not yet merged.`

```bash
git add docs/deploy.md docs/superpowers/specs/2026-08-22-citations-tone-and-saving-design.md
git commit -m "docs: record the hosted migration step and close stage S1.5"
```

---

## Notes for whoever executes this

**The two riskiest tasks are 1 and 6.** Task 1 drops a `SECURITY DEFINER` function and the only thing standing between that and an `anon`-executable function reading `note_chunks` is a two-line footer that is easy to lose in a copy. Task 6 rewrites a function whose `"failed"` branch is the difference between "you have no notes about this" and "the search broke" — a claim the server does not get to make when it never looked.

**Tasks 3 through 6 all edit `prompts.ts` in sequence.** Do them in order and commit between each; the later ones assume the earlier ones' text. If you reorder them you will re-resolve the same conflicts four times.

**What this stage does NOT change**, so a well-meaning improvement does not creep in: `OFFER_MAX_CHARS`, `OFFER_DEDUP_THRESHOLD`, the four gates at `turn.ts:441`, the automatic offer's behaviour, `resolveCurrentSession`, and anything in enrichment or the sweep.
