# Stage S2: Follow-Up Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a note names a domain whose entity cannot be created from what was written — today, a `media` note that names no work — the assistant asks one short question, and the answer backfills the entity link onto the original note.

**Architecture:** A pure detector decides *whether* there is a gap; the existing acknowledge prompt decides *how* to phrase the question, so no new model call is made. The pending question lives in `chat_messages.retrieval_meta.asked` on the message that asked it, which is already selected by the history query and which expires with the session. The next turn — and only the next turn — may answer it, at which point `resolveNoteMediaLink`'s item is linked onto the original note as well.

**Tech Stack:** TypeScript, Vitest, Supabase/PostgREST, Gemini via the existing `AiClient` interface.

**Spec:** `docs/superpowers/specs/2026-08-24-stage-s2-follow-up-design.md`

## Global Constraints

- **No migration.** Nothing in this plan changes the schema. If you reach for one, you have left the design.
- **No client change**, web or mobile. The question is text inside the streamed reply, which both clients already render.
- **No new model call**, therefore no new `usage_ledger` row and no change to `isOverBudget`.
- **No new SSE event type.** `AssistantEvent` is unchanged.
- **No new CI step and no new package.** `.github/workflows/ci.yml:203` already runs `pnpm turbo run test --filter=@cortex/core`, and every file this plan touches lives in that package.
- **Tests run through turbo:** `pnpm turbo run test --filter=@cortex/core`, never `pnpm --filter @cortex/core test`. `@cortex/shared` is consumed as compiled `dist/`, and only turbo's `test -> ^build` edge builds it first.
- **`extract.test.ts` needs the local Supabase stack up** (`createServiceClient`, real tables). `follow-up.test.ts`, `prompts.test.ts` and `turn.test.ts` are pure or use the in-file double and need nothing running.
- **Never log note content, prompts, or model output** — spec §15.6 rule 1. Log the requestId and an error message, nothing else.
- **`asked` and `answeredAsk` are mutually exclusive** on any single `chat_messages` row: a turn either asks a question or answers one.
- **Prompt rules are written in English**; only examples quoting Vietnamese phrasing are in Vietnamese, matching `LANGUAGE_RULE`'s existing reasoning in `prompts.ts:5-12`.
- **`verify` beats `askAbout` everywhere.** `VERIFY_RULE` (`prompts.ts:105-112`) forbids follow-ups outright; the two must never render into one prompt.

---

### Task 1: Let the classifier say "the text names no work"

`extract.ts:125` currently tells the model `pending_item` is REQUIRED whenever `domain` is `media`. Given `"hôm nay tôi mới đi xem phim"` that leaves two bad moves: invent a title, or drop `domain: "media"` — and on the second, S2's trigger never fires at all. This task removes that trap before anything depends on it.

**Files:**
- Modify: `packages/core/src/enrich/extract.ts:125-128` (the `pending_item` rule) and the intent rule block ending at `:151`
- Test: `packages/core/src/enrich/extract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `buildPrompt` output in which `media` with no `pending_item` is an explicitly permitted result. Task 2's detector depends on that state being reachable.

- [ ] **Step 1: Write the failing prompt tests**

Add to `packages/core/src/enrich/extract.test.ts`, inside the existing `describe("buildPrompt", ...)` block (if the file has no such block, append these as top-level `it`s beside the other `buildPrompt` tests):

```ts
  // S2 §3. The old wording ("pending_item is REQUIRED") left the model no way to say "they did
  // not name the work", which is the exact state the follow-up question exists to resolve.
  it("permits a media note that names no work, instead of requiring a title", () => {
    const p = buildPrompt("hôm nay tôi mới đi xem phim", []);
    expect(p).not.toMatch(/pending_item is REQUIRED/i);
    expect(p).toMatch(/OMIT pending_item/i);
    expect(p).toMatch(/never invent a title/i);
  });

  // The mirror of the existing "a short follow-up counts as a question" rule: here the assistant
  // asked and the user answered.
  it("tells the classifier to read an answer together with the question it answers", () => {
    const p = buildPrompt("Interstellar, hay lắm", []);
    expect(p).toMatch(/ANSWERS a question you asked/i);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- extract.test.ts`
Expected: FAIL — the first on `expect(p).not.toMatch(/pending_item is REQUIRED/i)`, the second on the missing rule.

- [ ] **Step 3: Replace the `pending_item` rule**

In `packages/core/src/enrich/extract.ts`, replace these three lines inside `buildPrompt`:

```ts
    "- when domain is \"media\", domain_meta.pending_item is REQUIRED and looks like",
    "  {\"kind\": " + mediaKind.options.map((k) => `"${k}"`).join("|") +
      ", \"title\": \"...\", \"year\": 2010}.",
    "  Use the work's own title as the person wrote it. Omit year when the text does not say.",
```

with:

```ts
    "- when domain is \"media\" AND the text names the work, fill domain_meta.pending_item:",
    "  {\"kind\": " + mediaKind.options.map((k) => `"${k}"`).join("|") +
      ", \"title\": \"...\", \"year\": 2010}.",
    "  Use the work's own title as the person wrote it. Omit year when the text does not say.",
    "  When the text names NO work -- \"hôm nay tôi mới đi xem phim\" -- still return \"media\"",
    "  and OMIT pending_item entirely. Never invent a title. Never send a pending_item without",
    "  one either: kind and title are required TOGETHER, and a half-filled pending_item is",
    "  discarded along with every other key in domain_meta.",
```

That last clause is not a stylistic warning. `pendingMediaItem` (`packages/shared/src/dto/media.ts:25-29`) requires both `kind` and `title`, `domainMetaSchemas.media` is `.strict()`, and `extract.ts:319` sets `meta = {}` when the parse fails — so a `pending_item` missing its title takes `rating` and `consumed_at` down with it.

- [ ] **Step 4: Add the answers-a-question rule**

In the same array, immediately after the `checkable_claim` bullet (the block ending `"  need on something that was right.",`), insert:

```ts
    "- when the note below ANSWERS a question you asked in the exchange shown at the end,",
    "  classify it as though the two had been written together. \"Interstellar, hay lắm\" after",
    "  you asked which film they saw is a media note about Interstellar, not a bare remark.",
```

- [ ] **Step 5: Run the prompt tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- extract.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the two end-to-end extraction tests**

These need the local Supabase stack up (`supabase start`). Add to `extract.test.ts` beside the other `extractNote` tests:

```ts
  // The state Task 2's detector keys off must be reachable end to end, not just permitted by the
  // prompt: `media` survives with an EMPTY meta, rather than being rejected or coerced.
  it("keeps domain \"media\" when the model omits pending_item", async () => {
    const note = await seedNote("hôm nay tôi mới đi xem phim");
    const result = await extractNote(
      { db, ai: aiReturning({ intent: "statement", complexity: "simple", domain: "media",
                              domain_meta: {}, tags: [], mood: null }) },
      note,
    );
    expect(result.domain).toBe("media");
    expect(result.domainMeta).toEqual({});
  });

  // Characterisation, and the reason Step 3's last clause is in the prompt: a half-filled
  // pending_item does not merely lose itself, it loses every sibling key. If this test ever goes
  // red because `rating` survived, extract.ts started salvaging valid keys -- read the S2 spec §3
  // before deleting the test, because the prompt rule was written against this behaviour.
  it("drops the WHOLE meta when pending_item has no title, rating included", async () => {
    const note = await seedNote("xem phim, 8 điểm");
    const result = await extractNote(
      { db, ai: aiReturning({ intent: "statement", complexity: "simple", domain: "media",
                              domain_meta: { pending_item: { kind: "movie" }, rating: 4 },
                              tags: [], mood: null }) },
      note,
    );
    expect(result.domainMeta).toEqual({});
  });
```

- [ ] **Step 7: Run the full core suite**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS. Read the `Cached:` line in turbo's summary — if it says the task was replayed from cache, the suite did not actually run. Re-run with `--force` in that case.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/enrich/extract.ts packages/core/src/enrich/extract.test.ts
git commit -m "feat(stage-s2): let the classifier say a media note names no work

extract.ts told the model pending_item was REQUIRED for media, which left it
inventing titles or dropping the domain -- and the domain drop is the branch on
which S2's trigger can never fire.

It also closes a live leak: pendingMediaItem requires kind and title together
and a failed parse drops the whole domain_meta, so a half-filled pending_item
was taking rating down with it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The gap detector

**Files:**
- Create: `packages/core/src/assistant/follow-up.ts`
- Test: `packages/core/src/assistant/follow-up.test.ts`

**Interfaces:**
- Consumes: nothing (a pure function; no database, no AI client).
- Produces:
  - `interface EntityGap { domain: "media"; field: string; wants: string }`
  - `function detectEntityGap(domain: string | null, meta: Record<string, unknown>): EntityGap | null`

  Task 3 uses `gap.wants`; Task 4 uses `gap.field`; Task 6 reads `field` back off the stored record.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/assistant/follow-up.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectEntityGap } from "./follow-up.js";

describe("detectEntityGap", () => {
  // The case the whole stage exists for: "hôm nay tôi mới đi xem phim" classifies as media and
  // names no work, so no media_items row can exist and the record is unusable later.
  it("finds a gap when a media note names no work", () => {
    expect(detectEntityGap("media", {})).toEqual({
      domain: "media",
      field: "pending_item.title",
      wants: "which film, series or book it was",
    });
  });

  it("finds none when the work is named", () => {
    expect(detectEntityGap("media", {
      pending_item: { kind: "movie", title: "Interstellar" },
    })).toBeNull();
  });

  // A blank title could never have produced a media_items row either -- pendingMediaItem is
  // z.string().min(1). Keying on `pending_item !== undefined` instead of on the title lets this
  // through, which is why it is asserted separately.
  it("finds a gap when pending_item exists but its title is blank", () => {
    expect(detectEntityGap("media", { pending_item: { kind: "movie", title: "   " } }))
      .toMatchObject({ field: "pending_item.title" });
  });

  // The line between "worth a question" and "an interview". These three domains have no entity
  // table, so nothing is created by answering and there is nothing to ask for.
  it("finds none for domains that have no entity table", () => {
    expect(detectEntityGap("health", {})).toBeNull();
    expect(detectEntityGap("finance", {})).toBeNull();
    expect(detectEntityGap("learning", {})).toBeNull();
    expect(detectEntityGap("life", {})).toBeNull();
    expect(detectEntityGap("reflection", {})).toBeNull();
  });

  // A degraded extraction reaches turn.ts as `domain: null`. It must never produce a question.
  it("finds none when there is no domain at all", () => {
    expect(detectEntityGap(null, {})).toBeNull();
  });

  // A media note whose rating is missing is still a usable record: the entity exists.
  it("does not ask for fields that are merely nice to have", () => {
    expect(detectEntityGap("media", {
      pending_item: { kind: "movie", title: "Interstellar" },
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- follow-up.test.ts`
Expected: FAIL — `Cannot find module './follow-up.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/assistant/follow-up.ts`:

```ts
/**
 * A gap worth exactly one question (S2 design §2).
 *
 * The rule is not "a meta field is missing" -- it is "the missing field is one without which no
 * ENTITY can exist". `media` qualifies because `media_items` is a real table that
 * `resolveNoteMediaLink` creates and reuses; without a title there is no row and the record is
 * unusable later. `health`, `finance` and `learning` do not, because their `domain_meta` is
 * decorative jsonb that nothing reads back -- answering creates nothing.
 *
 * That is what keeps the assistant from interviewing the user, and it is why S2 needs no
 * invented per-day quota: the trigger is rare by construction rather than by rate limit.
 *
 * A domain that later gains an entity table gets a branch here and inherits the whole mechanism
 * -- the prompt rule, the pending record, the cooldown and the backfill -- with no new policy.
 */
export interface EntityGap {
  domain: "media";
  /**
   * The dotted path of what is missing. Stored in `chat_messages.retrieval_meta.asked.field`, so
   * a later read can say what was asked for without re-deriving it from the note.
   */
  field: string;
  /**
   * What the acknowledge prompt is told to ask for. English, like every other prompt rule --
   * LANGUAGE_RULE is what decides the language the reply comes back in.
   */
  wants: string;
}

/**
 * Pure: no database, no AI client, no clock. Everything it needs is already in `extractNote`'s
 * return value, which is why the follow-up costs no extra call.
 *
 * `meta` is the POST-VALIDATION meta (`extractNote`'s `domainMeta`), not the model's raw output.
 * That matters: a half-filled `pending_item` fails `domainMetaSchemas.media` and arrives here as
 * `{}`, which this function correctly reads as "no title".
 */
export function detectEntityGap(
  domain: string | null,
  meta: Record<string, unknown>,
): EntityGap | null {
  if (domain !== "media") return null;

  const pending = meta.pending_item;
  const title =
    typeof pending === "object" && pending !== null
      ? (pending as { title?: unknown }).title
      : undefined;

  // Trimmed, and a blank string counts as absent: pendingMediaItem is z.string().min(1), so "  "
  // could never have produced a media_items row either. Keying on `pending_item !== undefined`
  // instead would call a title-less pending_item complete.
  if (typeof title === "string" && title.trim() !== "") return null;

  return {
    domain: "media",
    field: "pending_item.title",
    // Deliberately covers all three media kinds rather than naming one: the classifier may have
    // returned no `kind` either, and "which film was it" about a book is worse than a vague ask.
    wants: "which film, series or book it was",
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- follow-up.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/assistant/follow-up.ts packages/core/src/assistant/follow-up.test.ts
git commit -m "feat(stage-s2): detect gaps whose answer would create an entity

Asks only when the missing field is one without which no entity can exist --
today, a media note with no title. Domains with no entity table never qualify,
which is what makes the trigger rare enough to need no invented quota.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The prompt rule, and its exclusion with VERIFY_RULE

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts` (add the rule constant near `VERIFY_RULE:105`; extend `buildAcknowledgePrompt:228-268`)
- Test: `packages/core/src/assistant/prompts.test.ts`

**Interfaces:**
- Consumes: `EntityGap["wants"]` from Task 2 (a plain `string` at this boundary).
- Produces: `buildAcknowledgePrompt` accepts one new optional field, `askAbout?: string`. Task 4 passes it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/assistant/prompts.test.ts`, inside `describe("buildAcknowledgePrompt", ...)`:

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts.test.ts`
Expected: FAIL — TypeScript rejects the unknown property `askAbout` on the first and third tests.

- [ ] **Step 3: Add the rule constant**

In `packages/core/src/assistant/prompts.ts`, immediately after `VERIFY_RULE` (which ends at line 112), add:

```ts
/**
 * Stage S2 §4. Rendered only when `detectEntityGap` found a gap whose answer would create an
 * entity -- never on a merely incomplete note.
 *
 * Three constraints, all load-bearing. ONE question, because an assistant that asks two has
 * started an interview. At the END, because a question in the middle of an acknowledgement
 * interrupts the filing confirmation it was supposed to deliver. And no promise to follow up,
 * because the code guarantees it will never be raised again -- a reply ending "nhớ nói cho mình
 * biết nhé" would be writing a cheque turn.ts refuses to honour.
 *
 * MUTUALLY EXCLUSIVE with VERIFY_RULE above, which forbids follow-ups outright. The guard is in
 * buildAcknowledgePrompt below; turn.ts also refuses to compute a gap on a verifying turn, so the
 * two agree by saying the same thing rather than by one trusting the other.
 */
const followUpRule = (wants: string) =>
  `One thing is missing from what they just told you: ${wants}. Ask for it -- ONE short, ` +
  "natural question at the very end, the way a friend would ask. Do not ask about anything " +
  "else, do not ask two things, and do not explain why you are asking. If they do not answer " +
  "it, it will never be raised again -- so do not promise to follow up and do not tell them to " +
  "let you know later.";
```

- [ ] **Step 4: Extend `buildAcknowledgePrompt`**

Add the parameter to the signature, immediately after the `verify: boolean;` field and its comment:

```ts
  /**
   * What to ask for, from `detectEntityGap().wants`. Absent means there is nothing worth asking,
   * which is the ordinary case for almost every note.
   */
  askAbout?: string;
```

Then inside the returned array, replace the `verify` spread line with both spreads:

```ts
    // Spread-in rather than an empty string: an ordinary acknowledgement must carry no
    // instruction about verification at all, not a blank line where one used to be.
    ...(a.verify ? [VERIFY_RULE] : []),
    // `!a.verify` is the exclusion, not an oversight: see followUpRule's header. A turn that is
    // correcting a false factual claim never also asks a question.
    ...(a.askAbout !== undefined && !a.verify ? [followUpRule(a.askAbout)] : []),
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/assistant/prompts.ts packages/core/src/assistant/prompts.test.ts
git commit -m "feat(stage-s2): the follow-up rule, excluded against VERIFY_RULE

The question rides inside the acknowledgement the branch was already
generating, so it costs no model call. VERIFY_RULE forbids follow-ups outright,
so a verifying turn drops the question rather than sending the model two
contradictory instructions.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Ask, and record that the question was asked

**Files:**
- Modify: `packages/core/src/assistant/turn.ts` (import at `:1-16`; gap derivation after `verifies:286`; the `buildAcknowledgePrompt` call at `:317-324`; the `chat_messages` insert at `:480-488`)
- Test: `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: `detectEntityGap` / `EntityGap` (Task 2); `askAbout` on `buildAcknowledgePrompt` (Task 3).
- Produces: `chat_messages.retrieval_meta.asked = { noteId: string; field: string }` on the assistant message. Tasks 5 and 6 read it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/assistant/turn.test.ts`, inside `describe("runTurn", ...)`. Note the local helper — the shared `ai()` helper streams `"Đã lưu."`, which contains no `?`:

```ts
  /** Like `ai()`, but the reply is a question and the prompt it was built from is captured. */
  const askingAi = (value: Record<string, unknown>, reply = "Phim gì vậy?") => {
    const seen: string[] = [];
    return {
      seen,
      client: createFakeAi({
        generateJson: async () => ({
          value: { intent: "statement", complexity: "simple", domain: null,
                   domain_meta: {}, tags: [], mood: null, ...value },
          inputTokens: 10, outputTokens: 5, model: "fake-classify",
        }),
        generateStream: async ({ prompt }) => {
          seen.push(prompt);
          return {
            chunks: (async function* () { yield { text: reply }; })(),
            usage: () => ({ inputTokens: 20, outputTokens: 4, model: "fake-answer" }),
          };
        },
      }),
    };
  };

  const assistantRow = (inserted: Record<string, Record<string, unknown>[]>) =>
    (inserted.chat_messages ?? []).find((r) => r.role === "assistant");

  const MEDIA_NO_TITLE = { domain: "media", domain_meta: {} };

  it("asks one question when a media note names no work", async () => {
    const { client, inserted } = dbs();
    const { seen, client: fake } = askingAi(MEDIA_NO_TITLE);
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(seen[0]).toContain("which film, series or book it was");
    expect(assistantRow(inserted)?.retrieval_meta)
      .toMatchObject({ asked: { noteId: "n1", field: "pending_item.title" } });
  });

  // We know we told the model to ask. We do not know that it did. Recording `asked` anyway would
  // leave the next turn hunting for an answer to a question nobody was given.
  it("records nothing when the reply contains no question at all", async () => {
    const { client, inserted } = dbs();
    const { client: fake } = askingAi(MEDIA_NO_TITLE, "Đã lưu.");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("asked");
  });

  it("never asks on a turn that is correcting a false claim", async () => {
    const { client, inserted } = dbs();
    const { seen, client: fake } = askingAi({ ...MEDIA_NO_TITLE, checkable_claim: true });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(seen[0]).not.toContain("which film, series or book it was");
    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("asked");
  });

  it("never asks on a turn that answered a question", async () => {
    const { client, inserted } = dbs();
    const { seen, client: fake } = askingAi({ ...MEDIA_NO_TITLE, intent: "question" });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(seen[0]).not.toContain("which film, series or book it was");
    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("asked");
  });

  // Reachable, and not covered by the prompt builder: buildChitchatPrompt has no askAbout to
  // pass, so the RULE could never leak there -- but the RECORD would still be written, leaving a
  // question outstanding that nobody was asked. The guard has to be in the gap derivation.
  it("never asks on small talk, even if the classifier called it media", async () => {
    const { client, inserted } = dbs();
    const { client: fake } = askingAi({ ...MEDIA_NO_TITLE, intent: "chitchat" });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("asked");
  });

  // A degraded extraction knows of no domain and therefore of no gap. Asking anyway would be the
  // assistant inventing curiosity about a note it failed to read.
  it("never asks when the extraction failed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { client, inserted } = dbs();
      const broken = createFakeAi({
        generateJson: async () => { throw new Error("classify exploded"); },
        generateStream: async () => ({
          chunks: (async function* () { yield { text: "Phim gì vậy?" }; })(),
          usage: () => null,
        }),
      });
      await collect(runTurn({ userDb: client, serviceDb: client, ai: broken },
        { userId: "u1", noteId: "n1", budgetUsd: 100 }));
      expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("asked");
    } finally {
      spy.mockRestore();
    }
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- turn.test.ts`
Expected: FAIL — the first two on the missing `asked` key; the last three pass vacuously for now, which is expected and is why they are written before the guard exists (they must stay green after Step 3, and each one's guard is removed individually in Step 5 to prove it).

- [ ] **Step 3: Derive the gap in `turn.ts`**

Add the import beside the other assistant imports near `turn.ts:14`:

```ts
import { detectEntityGap } from "./follow-up.js";
```

Then, immediately after the `verifies` derivation (`turn.ts:286`), add:

```ts
  // S2 §2/§4. THE FOURTH LINK in the same ordered chain, and derived ONCE: this value both puts
  // the rule in the prompt and decides what gets recorded as asked, so the two can never describe
  // different questions.
  //
  // Every conjunct is an exclusion the design names. `!wantsAnswer` -- they asked something, so
  // answer it. `!isChitchat` -- small talk files nothing. `!verifies` -- VERIFY_RULE forbids
  // follow-ups outright (prompts.ts), and correcting a false claim outranks curiosity.
  // `extracted &&` -- a degraded or timed-out extraction knows of no domain and no gap.
  const gap = extracted && !wantsAnswer && !isChitchat && !verifies
    ? detectEntityGap(extracted.domain, extracted.domainMeta)
    : null;
```

- [ ] **Step 4: Pass it to the prompt and record it**

In the `buildAcknowledgePrompt` call (`turn.ts:317-324`), add as the last field:

```ts
          ...(gap !== null ? { askAbout: gap.wants } : {}),
```

Then in the `chat_messages` insert (`turn.ts:480-488`), extend `retrieval_meta`:

```ts
    retrieval_meta: {
      requestId, incomplete,
      ...(streamError !== null ? { error: streamError } : {}),
      // S2 §5. `asked` records an INSTRUCTION, not an observation: we told the model to ask, and
      // whether it did is only knowable from the text. The `?` test is the honest approximation,
      // and both of its failure directions are harmless -- a rhetorical `?` records a question
      // nobody was asked (the next turn simply finds nothing to backfill), and a question with no
      // `?` goes unrecorded (no backfill, nothing broken).
      //
      // `!incomplete`: an answer that was cut off mid-sentence may have been cut off before the
      // question, so it must not leave one outstanding.
      ...(gap !== null && !incomplete && answer.includes("?")
        ? { asked: { noteId: args.noteId, field: gap.field } }
        : {}),
    },
```

- [ ] **Step 5: Run, then prove each guard**

Run: `pnpm turbo run test --filter=@cortex/core -- turn.test.ts`
Expected: PASS.

Then confirm the three vacuous-looking tests can actually fail. One at a time, make the change, re-run, see red, revert:

| Change | Test that must go red |
|---|---|
| Drop `!verifies` from the `gap` conjunction | "never asks on a turn that is correcting a false claim" |
| Drop `!wantsAnswer` | "never asks on a turn that answered a question" |
| Drop `!isChitchat` | "never asks on small talk, even if the classifier called it media" |
| Change `extracted &&` to `true &&` | "never asks when the extraction failed" |
| Drop `answer.includes("?")` | "records nothing when the reply contains no question at all" |

If any of these stays green, the guard is being enforced somewhere else by accident and the test proves nothing — fix the test before moving on.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/assistant/turn.ts packages/core/src/assistant/turn.test.ts
git commit -m "feat(stage-s2): ask the question, and record that it was asked

One derivation drives both the prompt rule and the record, so the two cannot
describe different questions. The record is written only when the reply
actually contains a question mark: we know we told the model to ask, not that
it did.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The ceiling — read the pending question, and do not ask twice

**Files:**
- Modify: `packages/core/src/assistant/turn.ts` (after the history read at `:136-139`; the `gap` derivation from Task 4)
- Modify: `packages/core/src/assistant/turn.test.ts:104-114` (the double's history ordering)

**Interfaces:**
- Consumes: `retrieval_meta.asked` (Task 4).
- Produces: `const pendingAsk: { noteId: string; field: string } | null` in `runTurn`'s scope. Task 6 reads it.

- [ ] **Step 1: Fix the double's history ordering first**

The real query is `.order("created_at", { ascending: false })`, but `dbs()` returns fixtures in the order they were given. Nothing depended on that before — `selectContext` sorts its own copy (`turn.ts:145`) — but `historyRows[0]` is about to mean "the newest message", and a double that returns the oldest first would make every test in this task pass or fail for the wrong reason.

In `turn.test.ts`, in the `chat_messages` full-history branch (`:104-114`), sort the merged result:

```ts
      if (name === "chat_messages" && cols?.includes("retrieval_meta")) {
        return chain(() => {
          const already = (inserted.chat_messages ?? []).map((r) => ({
            role: r.role as string,
            content: r.content as string,
            created_at: new Date().toISOString(),
            retrieval_meta: (r.retrieval_meta as HistoryRow["retrieval_meta"]) ?? null,
          }));
          // Newest first, matching the real query's `order("created_at", { ascending: false })`.
          // runTurn now reads history[0] as "the message immediately before this turn", so a
          // double that answered in insertion order would silently invert that.
          return {
            data: [...(opts.history ?? []), ...already]
              .sort((a, b) => b.created_at.localeCompare(a.created_at)),
            error: null,
          };
        });
      }
```

Also widen the `HistoryRow` interface at `turn.test.ts:16-21` so fixtures can carry an ask:

```ts
interface HistoryRow {
  role: string;
  content: string;
  created_at: string;
  retrieval_meta: {
    incomplete?: boolean;
    asked?: { noteId: string; field: string };
  } | null;
}
```

Run: `pnpm turbo run test --filter=@cortex/core -- turn.test.ts`
Expected: PASS — no existing test asserts on history ordering, so this is a no-op for them. If one goes red, it was depending on the wrong order; fix the fixture, not the sort.

- [ ] **Step 2: Write the failing test**

```ts
  // S2 §7. The whole ceiling, and there is no number in it: if the message immediately before
  // this turn asked something, this turn does not ask -- whether or not it was answered.
  it("does not ask again on the turn right after a question", async () => {
    const { client, inserted } = dbs({
      history: [{
        role: "assistant", content: "Phim gì vậy?", created_at: "2026-08-24T10:00:00.000Z",
        retrieval_meta: { asked: { noteId: "n0", field: "pending_item.title" } },
      }],
      lastMessage: { session_id: "s1", created_at: "2026-08-24T10:00:00.000Z" },
    });
    const { seen, client: fake } = askingAi(MEDIA_NO_TITLE);
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    expect(seen[0]).not.toContain("which film, series or book it was");
    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("asked");
  });

  // The other side of the same condition: an ordinary prior exchange does not suppress a question.
  it("still asks when the previous turn asked nothing", async () => {
    const { client, inserted } = dbs({
      history: [{
        role: "assistant", content: "Đã lưu.", created_at: "2026-08-24T10:00:00.000Z",
        retrieval_meta: { incomplete: false },
      }],
      lastMessage: { session_id: "s1", created_at: "2026-08-24T10:00:00.000Z" },
    });
    const { seen, client: fake } = askingAi(MEDIA_NO_TITLE);
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    expect(seen[0]).toContain("which film, series or book it was");
    expect(assistantRow(inserted)?.retrieval_meta).toHaveProperty("asked");
  });
```

- [ ] **Step 3: Run to verify the first fails**

Run: `pnpm turbo run test --filter=@cortex/core -- turn.test.ts`
Expected: FAIL on "does not ask again on the turn right after a question" — the rule is still in the prompt. The second test passes already; it is the control.

- [ ] **Step 4: Read the pending question**

In `turn.ts`, immediately after the history read (`:136-139`, before the user message is inserted at `:141`), add:

```ts
  // S2 §6/§7. `[0]`, NEVER `find()`. The query is `created_at desc` and it runs before this
  // turn's own message is written, so [0] is the message immediately before this one. Restricting
  // an answer to the very next turn is what makes "ask once, never nag" STRUCTURAL: a user who
  // says something else has ended it, with no counter to decrement and no timeout to expire.
  //
  // It is also the entire ceiling. One condition covers both halves of what the design asks for
  // -- never while a question is outstanding, and never two turns running -- with no invented
  // number in it.
  const previousMessage = ((historyRows ?? []) as {
    role: string;
    retrieval_meta: { asked?: { noteId: string; field: string } } | null;
  }[])[0];
  const pendingAsk = previousMessage?.role === "assistant"
    ? previousMessage.retrieval_meta?.asked ?? null
    : null;
```

- [ ] **Step 5: Add it to the gap conjunction**

Extend the `gap` derivation from Task 4 with one conjunct and one comment line:

```ts
  // `pendingAsk === null` is the ceiling (§7): the turn after a question never asks another,
  // whether this turn answered it or ignored it.
  const gap = extracted && !wantsAnswer && !isChitchat && !verifies && pendingAsk === null
    ? detectEntityGap(extracted.domain, extracted.domainMeta)
    : null;
```

- [ ] **Step 6: Run to verify both pass**

Run: `pnpm turbo run test --filter=@cortex/core -- turn.test.ts`
Expected: PASS.

Then prove the guard: remove `&& pendingAsk === null` and re-run. "does not ask again on the turn right after a question" must go red. Revert.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/assistant/turn.ts packages/core/src/assistant/turn.test.ts
git commit -m "feat(stage-s2): the ceiling, as one condition with no number in it

If the message immediately before this turn asked something, this turn does
not. Reading history[0] rather than searching it is what makes 'ask once, never
nag' structural -- there is no counter and no timeout to get wrong.

Also sorts the test double's history newest-first, matching the real query.
Nothing depended on the old order, but history[0] now carries meaning.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Backfill the entity link onto the original note

**Files:**
- Modify: `packages/core/src/assistant/turn.ts:206-216` (keep the resolved item) and the `chat_messages` insert
- Modify: `packages/core/src/assistant/turn.test.ts:52-69` and `:132-157` (record update filters in the double)
- Test: `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: `pendingAsk` (Task 5); `MediaService.resolveNoteMediaLink`'s returned `MediaItem`.
- Produces: `chat_messages.retrieval_meta.answeredAsk = true` on a turn that backfilled — the measurement signal of design §8.

- [ ] **Step 1: Teach the double to record update filters**

Today `dbs()` records the update ROW but discards `.eq()` / `.is()`, so no test can say *which* note an update targeted — and "which note" is the entire deliverable of this task.

In `turn.test.ts`, give `chain` an optional filter sink:

```ts
  function chain(
    resolve: () => { data: unknown; error: unknown },
    onFilter?: (column: string, value: unknown) => void,
  ) {
    const self: Record<string, unknown> = {
      eq: (column: string, value: unknown) => { onFilter?.(column, value); return self; },
      is: (column: string, value: unknown) => { onFilter?.(column, value); return self; },
      ilike: () => self,
      filter: () => self,
      order: () => self,
      limit: () => self,
      select: () => self,
      single: async () => resolve(),
      maybeSingle: async () => resolve(),
      then: (
        onFulfilled: (r: { data: unknown; error: unknown }) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return self;
  }
```

Then rewrite `update` so every recorded row carries the filters that scoped it. `__where` is populated by reference *after* the push, which is fine — the assertions run once the generator is exhausted:

```ts
    update: (row: Record<string, unknown> = {}) => {
      // `__where` captures the .eq()/.is() chain that scoped this update. Without it a test can
      // see that SOME note was linked but not WHICH -- and S2's backfill is defined entirely by
      // which note it targets.
      const where: Record<string, unknown> = {};
      (updated[name] ??= []).push({ ...row, __where: where });
      const sink = (column: string, value: unknown) => { where[column] = value; };

      if (name === "media_items") {
        return chain(() => (
          opts.mediaItem ? { data: { ...mediaItemRow(), ...row }, error: null } : { data: null, error: null }
        ), sink);
      }
      if (name === "notes" && "media_item_id" in row) {
        const noteRow = opts.note === undefined ? NOTE : opts.note;
        return chain(() => (
          noteRow ? { data: { id: noteRow.id }, error: null } : { data: null, error: null }
        ), sink);
      }
      return chain(() => ({ data: null, error: null }), sink);
    },
```

Run: `pnpm turbo run test --filter=@cortex/core -- turn.test.ts`
Expected: PASS — existing tests read `updated[name]` for its row fields only, and `__where` is additive.

- [ ] **Step 2: Write the failing tests**

```ts
  const MEDIA_WITH_TITLE = {
    domain: "media",
    domain_meta: { pending_item: { kind: "movie", title: "Interstellar" } },
  };

  const answeringHistory = () => ({
    history: [{
      role: "assistant", content: "Phim gì vậy?", created_at: "2026-08-24T10:00:00.000Z",
      retrieval_meta: { asked: { noteId: "n0", field: "pending_item.title" } },
    }],
    lastMessage: { session_id: "s1", created_at: "2026-08-24T10:00:00.000Z" },
  });

  /** Every notes update that carried a media link, as `{ noteId, itemId }`. */
  const links = (updated: Record<string, Record<string, unknown>[]>) =>
    (updated.notes ?? [])
      .filter((r) => "media_item_id" in r && r.media_item_id !== null)
      .map((r) => ({
        noteId: (r.__where as Record<string, unknown>).id,
        itemId: r.media_item_id,
        where: r.__where as Record<string, unknown>,
      }));

  // THE DELIVERABLE. Both notes must point at the SAME media_items row -- asserting only that
  // note n0 became non-null passes even when the backfill created a second, duplicate item,
  // which is the bug actually worth catching.
  it("links the answered note and the original note to one and the same media item", async () => {
    const { client, updated } = dbs(answeringHistory());
    const { client: fake } = askingAi(MEDIA_WITH_TITLE, "Hay đấy!");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    const linked = links(updated);
    expect(linked.map((l) => l.noteId).sort()).toEqual(["n0", "n1"]);
    expect(new Set(linked.map((l) => l.itemId)).size).toBe(1);
  });

  // The backfill writes the LINK and nothing else. Note n0 said nothing about a rating, and
  // writing one into it would be putting words in the user's mouth.
  it("backfills the link alone, never the original note's meta or text", async () => {
    const { client, updated } = dbs(answeringHistory());
    const { client: fake } = askingAi(MEDIA_WITH_TITLE, "Hay đấy!");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    const backfill = links(updated).find((l) => l.noteId === "n0")!;
    const row = (updated.notes ?? []).find((r) => r.__where === backfill.where)!;
    expect(Object.keys(row).filter((k) => k !== "__where")).toEqual(["media_item_id"]);
    // And it must refuse to touch a trashed note or overwrite an existing link.
    expect(backfill.where).toMatchObject({ deleted_at: null, media_item_id: null });
  });

  // §8: the measurement signal. One boolean is what makes "how often was a question answered"
  // a query rather than a guess.
  it("records that the question was answered", async () => {
    const { client, inserted } = dbs(answeringHistory());
    const { client: fake } = askingAi(MEDIA_WITH_TITLE, "Hay đấy!");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta).toMatchObject({ answeredAsk: true });
  });

  // No question outstanding means no backfill, however media-ish the note is. Only n1 is linked.
  it("does not backfill anything when no question was pending", async () => {
    const { client, updated, inserted } = dbs();
    const { client: fake } = askingAi(MEDIA_WITH_TITLE, "Hay đấy!");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(links(updated).map((l) => l.noteId)).toEqual(["n1"]);
    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("answeredAsk");
  });

  // The user was asked which film, and changed the subject. Nothing resolves, nothing backfills,
  // and the question lapses with no special case.
  it("backfills nothing when the answer turn produced no media item", async () => {
    const { client, updated, inserted } = dbs(answeringHistory());
    const { client: fake } = askingAi({ domain: "health", domain_meta: {} }, "Ừ.");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    expect(links(updated)).toEqual([]);
    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("answeredAsk");
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- turn.test.ts`
Expected: FAIL — the first three. `n0` is never updated, and `answeredAsk` is never written. The last two pass as controls.

- [ ] **Step 4: Keep the resolved item**

`turn.ts:206-216` currently keeps only the item's title. Replace that block with:

```ts
  let mediaTitle: string | undefined;
  // The ITEM, not just its title: S2's backfill needs the id, and re-resolving it for the
  // original note would be a second findOrCreate that could race into a duplicate row.
  let mediaItemId: string | undefined;
  if (extracted?.domain === "media") {
    try {
      const item = await new MediaService(userDb, args.userId)
        .resolveNoteMediaLink(args.noteId, extracted.domainMeta);
      if (item) { mediaTitle = item.title; mediaItemId = item.id; }
    } catch (err) {
      console.error(`[assistant] media link failed (request ${requestId}): ${errorMessage(err)}`);
    }
    mark("media link resolved");
  }
```

- [ ] **Step 5: Backfill the original note**

Immediately after that block, add:

```ts
  // S2 §6. THE BACKFILL. The note the question was about gets the entity link the answer just
  // produced -- and nothing else. Not `domain_meta`, not `content_text`: the original note said
  // nothing about a rating, and writing one into it would be putting words in the user's mouth.
  //
  // `userDb`, so RLS is what proves ownership: `pendingAsk.noteId` comes out of a jsonb column
  // and is validated nowhere else.
  //
  // Failure is logged and swallowed. The answer has already streamed and both notes are already
  // saved; a failed link must not retroactively fail a turn that succeeded.
  let backfilled = false;
  if (pendingAsk !== null && mediaItemId !== undefined && pendingAsk.noteId !== args.noteId) {
    const { error } = await userDb.from("notes")
      .update({ media_item_id: mediaItemId })
      .eq("id", pendingAsk.noteId)
      .is("deleted_at", null)      // a note trashed mid-conversation must not be linked
      .is("media_item_id", null);  // and an existing link is never overwritten
    if (error) {
      console.error(`[assistant] follow-up backfill failed (request ${requestId}): ${error.message}`);
    } else {
      backfilled = true;
    }
    mark("follow-up backfilled");
  }
```

- [ ] **Step 6: Record the measurement**

In the `chat_messages` insert's `retrieval_meta`, add one more spread beside `asked`:

```ts
      // S2 §8. The other half of the pair, and mutually exclusive with `asked`: a turn either
      // asks a question or answers one. One boolean is what turns "how often does a question get
      // answered" into a query instead of a guess -- the thing S1.5 found it had no way to know
      // about offers.
      ...(backfilled ? { answeredAsk: true } : {}),
```

- [ ] **Step 7: Run to verify all five pass**

Run: `pnpm turbo run test --filter=@cortex/core -- turn.test.ts`
Expected: PASS.

Then prove the guards, one at a time, reverting after each:

| Change | Test that must go red |
|---|---|
| Drop `.is("media_item_id", null)` | "backfills the link alone, never the original note's meta or text" |
| Add `domain_meta: extracted.domainMeta` to the backfill update | same test |
| Change `.eq("id", pendingAsk.noteId)` to `.eq("id", args.noteId)` | "links the answered note and the original note to one and the same media item" |
| Drop `mediaItemId !== undefined` | "backfills nothing when the answer turn produced no media item" |

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/assistant/turn.ts packages/core/src/assistant/turn.test.ts
git commit -m "feat(stage-s2): backfill the entity link onto the note that was asked about

Both notes end up pointing at one media_items row: the answer carries the
structure, and the original note gets the link. The link and nothing else --
the original said nothing about a rating.

Records answeredAsk so the ask/answer rate is a query rather than a guess.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Verify the whole stage, against the real stack

**Files:**
- Modify: `docs/superpowers/specs/2026-08-24-stage-s2-follow-up-design.md:3` (the status line)

**Interfaces:**
- Consumes: everything above.
- Produces: a verified branch ready for a PR.

- [ ] **Step 1: Run the full gate**

```bash
pnpm turbo run lint typecheck test
```

Expected: PASS. **Read the `Cached:` line.** `N/N successful` with most tasks replayed from cache is not evidence anything ran — if Docker is down, the suites needing Supabase silently replay. Re-run with `--force` if the cached count is not zero for `@cortex/core`.

- [ ] **Step 2: Exercise the loop against the real stack**

With the stack and API running, in the chat box:

1. Send `hôm nay tôi mới đi xem phim`. Expect an acknowledgement ending in one short question about which film — not two questions, and no "nhớ nói cho mình biết nhé".
2. Reply `Interstellar, hay lắm`. Expect an ordinary acknowledgement with **no** new question.
3. Check the data:

```sql
select id, content_text, domain, media_item_id from notes
  where user_id = '<uid>' order by created_at desc limit 2;
select role, retrieval_meta from chat_messages
  where user_id = '<uid>' order by created_at desc limit 4;
```

Both notes must carry the **same** non-null `media_item_id`; one assistant row must carry `asked`, the newer one `answeredAsk: true`.

4. Send `hôm nay đi xem phim nữa` immediately after. Expect **no** question — the previous turn asked, and the ceiling holds for one turn.

- [ ] **Step 3: Confirm the acknowledgement is still an acknowledgement**

Send an ordinary non-media note (`hôm nay tôi chạy bộ ở công viên`). Expect no question at all. This is the regression that matters most: S2 edits the prompt path every turn passes through, and a rule that leaks onto every acknowledgement is the failure mode the whole ceiling exists to prevent.

- [ ] **Step 4: Update the spec's status line**

Change line 3 of `docs/superpowers/specs/2026-08-24-stage-s2-follow-up-design.md` from
`Status: designed 2026-08-24, not yet implemented.` to
`Status: implemented <date>, verified against the local stack.`

- [ ] **Step 5: Commit and open the PR**

```bash
git add docs/superpowers/specs/2026-08-24-stage-s2-follow-up-design.md
git commit -m "docs(stage-s2): mark the design implemented and verified

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin stage-s2-follow-up
```

Then open the PR with `gh pr create`. Note in the body that no migration is included and no client file was touched, so the review surface is `packages/core` alone.

---

## Notes for the reviewer

- **Nothing here needs a migration.** A diff containing one has left the design.
- **The two `retrieval_meta` keys are mutually exclusive** on a single row. If a message carries both `asked` and `answeredAsk`, the `pendingAsk === null` conjunct in Task 5 has been dropped.
- **`historyRows[0]`, not `find()`** (Task 5). Searching history for the most recent ask would let a question be answered ten turns later, which reintroduces the expiry rule the design deliberately does not have.
- **The `?` test in Task 4 is deliberate, not lazy.** See the spec §5 for both failure directions and why each is harmless.
