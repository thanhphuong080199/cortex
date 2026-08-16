# Stage C4 — The Transcript and the Third Intent: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web chat pane shows the current session's real conversation — the user's turns and the assistant's replies, with their provenance, read from `chat_messages` — and small talk is classified as `chitchat`, answered with its own prompt, stamped on the note, and kept out of every note list, out of retrieval, and out of search.

**Architecture:** One pure function, `resolveCurrentSession`, decides which session is current; the pane and the turn both call it, so they cannot disagree. The pane's data comes from `chat_messages` scoped by that session id, which is what splits the pane's query from the sidebar's — two tables, not two narrowings of one. A third `intent` value threads from the classifier's response schema through a new prompt branch into a third `source_type`, which four separate appliers must exclude: two note-list queries, one Realtime predicate, and `search_notes`.

**Tech Stack:** TypeScript, pnpm/Turborepo, NestJS (`apps/api`), Next.js App Router (`apps/web`), Expo/React Native (`apps/mobile`), Supabase Postgres, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-stage-c4-c5-conversation-design.md` (stage C4 is §2–§7; §8–§15 are C5 and are **not** in this plan)

---

## Spec corrections — read these before Task 1

Two statements in the spec were true when it was drafted and are not true now. Neither changes a design decision; both change what the code in front of you looks like.

**1. §1's "there is no chat pane, and there is no shared query" is stale.** Commit `f8ec896` — *"feat(web): collapse the home page into one chat box with a sidebar"* — landed at 13:05 on 2026-08-16, 36 minutes before the spec was committed, and the spec's §1 was verified against the tree before it. As of now:

- `apps/web/src/app/assistant-box.tsx` **does** hold a thread: `messages: Message[]`, seeded from an `initialMessages` prop and appended to on every send.
- `apps/web/src/app/page.tsx:54` — `const messages = [...notes].reverse().map(...)` — **is** the shared query the requirement warned about. One `applyNoteFilters` call feeds both the sidebar and the pane.

So the brief's premise was right and §1's refutation of it is wrong. The consequence for this plan is concrete and it makes C4 **larger**, not smaller: the pane today is filtered exactly the way the sidebar is, which means `/?view=archived` shows an archived-only "conversation" and `/?q=dune` shows a three-message one. Task 7 repoints it at `chat_messages` and deletes line 54. Everything §3 says about what the pane must show still stands unchanged.

**2. §3.2 says to extract session resolution into `packages/core/src/assistant/session.ts`. It cannot live there.** `apps/web/package.json` depends on `@cortex/shared` and not on `@cortex/core`, deliberately — `packages/shared/src/notes/filters.ts:14-19` records the reason (core's barrel reaches `archiver`, declares no `sideEffects: false`, and a bundler must therefore drag Node builtins into a `"use client"` component). The pane is the second caller the extraction exists for, so the function goes in `packages/shared/src/assistant/session.ts` and `@cortex/core` re-exports it. This is the same move, for the same reason, that `filters.ts` already made — the precedent is in the file the spec cites for E5.

---

## Global Constraints

- **Run package tests through turbo, never through the package directly.** `pnpm turbo run test --filter=@cortex/core` — not `pnpm --filter @cortex/core test`. `@cortex/shared` and `@cortex/core` resolve as compiled `dist/`, so the direct form tests stale output.
- **No test may ever call the real Gemini API.** Use `createFakeAi` (`packages/core/src/ai/fake.ts`) or `bootstrapTestApp({ ai: createFakeAi() })` in `apps/api`.
- **No note content, chat text, or model output in any log line or error message.** Master spec §15.6 rule 1. Report a length, never the payload.
- **Never print a line of `apps/api/.env`.** If a connection string must be redacted, split on the **last** `@`, not the first.
- **New test suites must be named in CI.** `.github/workflows/ci.yml`'s `checks` job filters per package: `@cortex/shared`, `@cortex/sync`, `@cortex/mobile`, `@cortex/web`, `@cortex/db`, `@cortex/api`, `@cortex/core`. Every package this plan touches is already named, and every test lands in either an existing file or a new file inside one of those packages — so no `ci.yml` change is required. Task 8 verifies that this still holds.
- **`enum-parity.test.ts` asserts ordered equality** (`toEqual`) between the zod enum and the live SQL CHECK. `'chitchat'` must be appended in the **same position** on both sides — last.
- **Migration numbers: `00030` and `00031`.** The latest in `supabase/migrations/` is `00029_usage_kind_grounding.sql` (stage C3, merged). Do not renumber, and do not fold the two into one: `00030` widens a CHECK and `00031` replaces a function body — one concern each, the way `00022`, `00024` and `00026` each replaced `search_notes` for exactly one reason.
- **`supabase db push` targets the HOSTED project by default.** Use `pnpm supabase db push --local` while developing. The unflagged form is production.
- **A cached turbo run is not a run.** Read the `Cached:` line in turbo's summary. With Docker down the database-backed suites replay a previous green without executing.
- `SESSION_IDLE_RESET_MS = 4 * 60 * 60 * 1000` — the rolling idle gap that defines "the current session". Unchanged from `packages/core/src/assistant/context.ts:11`; Task 1 only moves it.
- **Out of scope, and named so nobody adds it:** scrollback across earlier sessions; chat history on mobile (`chat_sessions`/`chat_messages` stay absent from `packages/sync/src/sync-rules.yaml`, whose header records absence-by-omission as deliberate); deleting chitchat notes; skipping classification for chitchat; anything in C5 (§8–§15).

---

## File Structure

**Created:**
- `packages/shared/src/assistant/session.ts` — `SESSION_IDLE_RESET_MS`, `isStale`, `resolveCurrentSession`. The one answer to "which session is current?" (Task 1).
- `packages/shared/src/assistant/session.test.ts` — its tests (Task 1).
- `packages/shared/src/assistant/index.ts` — the sub-barrel, matching `notes/index.ts` (Task 1).
- `supabase/migrations/00030_note_source_type_chitchat.sql` — `'chitchat'` in `notes_source_type_check` (Task 3).
- `supabase/migrations/00031_search_notes_exclude_chitchat.sql` — `search_notes` with the exclusion (Task 6).
- `apps/web/src/app/provenance.tsx` — the note/web citation blocks, extracted so the live turn and a reloaded transcript row render identically (Task 7).

**Modified:**
- `packages/shared/src/index.ts` — exports the new sub-barrel (Task 1).
- `packages/shared/src/enums.ts` — `noteSourceType` gains `'chitchat'` (Task 3).
- `packages/shared/src/notes/filters.ts` — `applyNoteFilters`, `matchesFilters`, `noteFiltersToSql` exclude chitchat (Task 5).
- `packages/shared/src/notes/filters.test.ts` — the exclusion tests, and `source_type` added to existing `matchesFilters` fixtures (Task 5).
- `packages/core/src/assistant/context.ts` — `isStale`/`SESSION_IDLE_RESET_MS` re-exported from `@cortex/shared` instead of declared (Task 1).
- `packages/core/src/assistant/turn.ts` — session resolution via the shared function; the three-way intent branch; the `chitchat` stamp (Tasks 1, 4).
- `packages/core/src/assistant/turn.test.ts` — a `lastMessage` option on the `dbs()` double, plus the session and chitchat turn tests (Tasks 1, 4).
- `packages/core/src/assistant/prompts.ts` — `buildChitchatPrompt` (Task 4).
- `packages/core/src/assistant/prompts.test.ts` — its tests (Task 4).
- `packages/core/src/enrich/extract.ts` — `INTENTS`, the schema enum, the prompt rule, the three-way default (Task 2).
- `packages/core/src/enrich/extract.test.ts` — the intent tests (Task 2).
- `packages/core/src/notes/filters-equivalence.test.ts` — a chitchat row in the fixture corpus (Task 5).
- `packages/db/src/test/search-notes.test.ts` — chitchat is not retrievable (Task 6).
- `apps/api/test/search.e2e.test.ts` — chitchat is not in `/search` results (Task 6).
- `apps/web/src/app/note-list.tsx` — `NoteRow` gains `source_type` (Task 5).
- `apps/web/src/app/page.tsx` — the transcript query replaces the derived `messages` (Task 7).
- `apps/web/src/app/assistant-box.tsx` — `initialTurns`, the transcript render, the hand-off on `done` (Task 7).
- `apps/web/src/app/assistant-box.test.tsx` — the transcript tests (Task 7).
- `apps/web/src/app/globals.css` — the interrupted-turn marker (Task 7).
- `e2e/scripts/seed.mjs` — a seeded session and a seeded chitchat note (Task 7).
- `apps/web/e2e/assistant-box.spec.ts` — the pane-versus-list split, end to end (Task 7).

---

### Task 1: One answer to "which session is current?"

The pane needs the same answer `turn.ts:106-115` computes inside the generator. Computing it a second time is how the two disagree — issue-log **E5** is that exact failure, one narrowing that existed twice. This task is a behaviour-preserving refactor; it ships no user-visible change and exists so Task 7 has something to call.

**Files:**
- Create: `packages/shared/src/assistant/session.ts`
- Create: `packages/shared/src/assistant/session.test.ts`
- Create: `packages/shared/src/assistant/index.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/core/src/assistant/context.ts:1-11, 71-75`
- Modify: `packages/core/src/assistant/turn.ts:11, 106-115`
- Test: `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const SESSION_IDLE_RESET_MS: number`
  - `export function isStale(lastMessageAt: string | null, now: Date): boolean`
  - `export function resolveCurrentSession(last: { session_id: string; created_at: string } | null, now: Date): string | null`
  - All three re-exported from `@cortex/shared`'s root barrel and, unchanged in name, from `@cortex/core`'s `assistant/context.js`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/assistant/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SESSION_IDLE_RESET_MS, isStale, resolveCurrentSession } from "./session.js";

const now = new Date("2026-08-16T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe("resolveCurrentSession", () => {
  it("has no current session when the user has never written anything", () => {
    expect(resolveCurrentSession(null, now)).toBeNull();
  });

  it("continues the session the most recent message belongs to", () => {
    expect(resolveCurrentSession({ session_id: "s1", created_at: ago(60_000) }, now)).toBe("s1");
  });

  // THE ONE THIS FUNCTION EXISTS FOR. Past the idle gap there is no current session: the
  // transcript renders empty and the next turn opens a new one. Two call sites deciding this
  // separately is how a pane ends up showing yesterday's thread above today's first reply --
  // and the day the gap changes, only one of them would move.
  it("has no current session once the idle gap has passed", () => {
    expect(resolveCurrentSession({ session_id: "s1", created_at: ago(SESSION_IDLE_RESET_MS) }, now))
      .toBeNull();
  });

  it("keeps the session one millisecond short of the gap", () => {
    expect(resolveCurrentSession({ session_id: "s1", created_at: ago(SESSION_IDLE_RESET_MS - 1) }, now))
      .toBe("s1");
  });
});

describe("isStale", () => {
  it("treats no history as stale, so a first message starts a session", () => {
    expect(isStale(null, now)).toBe(true);
  });
  it("is exclusive below the gap and inclusive at it", () => {
    expect(isStale(ago(SESSION_IDLE_RESET_MS - 1), now)).toBe(false);
    expect(isStale(ago(SESSION_IDLE_RESET_MS), now)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/shared -- session`
Expected: FAIL — `./session.js` does not exist.

- [ ] **Step 3: Write the module**

Create `packages/shared/src/assistant/session.ts`:

```ts
/**
 * An idle gap rather than a calendar boundary, so someone writing at 1am is not cut
 * mid-thought.
 */
export const SESSION_IDLE_RESET_MS = 4 * 60 * 60 * 1000;

/** No history is stale: a first message starts a session rather than joining one. */
export function isStale(lastMessageAt: string | null, now: Date): boolean {
  if (lastMessageAt === null) return true;
  return now.getTime() - new Date(lastMessageAt).getTime() >= SESSION_IDLE_RESET_MS;
}

/**
 * THE answer to "which session is the user currently in?", given their most recent message.
 * `null` means there is no live session -- either nothing was ever written, or the idle gap
 * has passed and the next turn will open a new one.
 *
 * Two callers, one function, for the reason recorded in notes/filters.ts: this narrowing
 * existed in `turn.ts` alone, and stage C4 adds a second consumer (the web transcript pane)
 * that has to reach the SAME answer. A pane that computed it separately would drift the day
 * the gap changed, and the symptom -- yesterday's conversation rendered above today's first
 * reply -- looks like a sync bug rather than a duplicated constant.
 *
 * It lives in @cortex/shared and not @cortex/core for the same reason applyNoteFilters does:
 * apps/web depends on @cortex/shared only, and core's barrel reaches Node builtins that a
 * bundler must then follow into a "use client" component. Core re-exports it.
 *
 * The row shape is snake_case because both callers hand it a PostgREST row verbatim; mapping
 * it into camelCase first would be a second place for the column names to be written down.
 */
export function resolveCurrentSession(
  last: { session_id: string; created_at: string } | null,
  now: Date,
): string | null {
  if (last === null) return null;
  return isStale(last.created_at, now) ? null : last.session_id;
}
```

Create `packages/shared/src/assistant/index.ts`:

```ts
export * from "./session.js";
```

and add to `packages/shared/src/index.ts`, after the `notes` line:

```ts
export * from "./assistant/index.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/shared -- session`
Expected: PASS, 6 assertions.

- [ ] **Step 5: Point `@cortex/core` at the moved function**

In `packages/core/src/assistant/context.ts`, delete the `SESSION_IDLE_RESET_MS` declaration (lines 7-11) and the `isStale` function (lines 71-75), and add at the top of the file:

```ts
// Moved to @cortex/shared in stage C4 so the web transcript pane can reach it -- apps/web
// depends on shared and not on core. Re-exported here under the same names so this module
// stays the one import site for the assistant's context and session rules.
export { SESSION_IDLE_RESET_MS, isStale, resolveCurrentSession } from "@cortex/shared";
```

`context.test.ts` imports `isStale` from `./context.js` and needs no edit — that is the point of the re-export.

- [ ] **Step 6: Use it in `turn.ts`**

In `packages/core/src/assistant/turn.ts`, change the import on line 11:

```ts
import { isStale, resolveCurrentSession, selectContext, type ThreadTurn } from "./context.js";
```

(`isStale` stays imported only if something else in the file still uses it — after this step nothing does, so drop it and let the linter confirm.)

Replace lines 106-115 with:

```ts
  const { data: last } = await userDb
    .from("chat_messages").select("session_id, created_at")
    .eq("user_id", args.userId).order("created_at", { ascending: false }).limit(1);
  const lastRow = (last ?? [])[0] as { session_id: string; created_at: string } | undefined;
  // The SAME call the web pane makes (page.tsx). A client-supplied id is honoured only while
  // the thread it names is still live: past the idle gap this turn starts a new session
  // whatever the client asked for, which is what the two lines this replaced already did.
  const live = resolveCurrentSession(lastRow ?? null, new Date());
  sessionId = live === null ? undefined : (sessionId ?? live);
  if (!sessionId) {
    const { data: created } = await userDb
      .from("chat_sessions").insert({ user_id: args.userId }).select("id").single();
    sessionId = (created as { id: string } | null)?.id ?? randomUUID();
  }
```

- [ ] **Step 7: Give the test double a last message**

`dbs()` in `packages/core/src/assistant/turn.test.ts` currently answers the session probe with a hard-coded `[]`, so every turn in that suite starts a fresh session and nothing can test resumption. Add an option.

In the `opts` parameter type, after `history?: HistoryRow[];`:

```ts
    lastMessage?: { session_id: string; created_at: string };
```

and replace the session-probe branch:

```ts
      // The "last message" probe (session resolution). Empty by default, so a turn with no
      // `lastMessage` starts a fresh session -- which is what every test written before C4
      // assumed. `lastMessage` is what lets a test say "this user was mid-conversation".
      if (name === "chat_messages" && cols?.includes("session_id")) {
        return chain(() => ({ data: opts.lastMessage ? [opts.lastMessage] : [], error: null }));
      }
```

- [ ] **Step 8: Write the turn-level session tests**

Add to `packages/core/src/assistant/turn.test.ts`:

```ts
// The turn's half of the shared decision. This asserts the OUTCOME (a new chat_sessions row,
// or none) rather than that a particular function was called, which is the honest limit here:
// it stays green against a correct copy of the logic and turns red against a wrong one. The
// guard against a *correct* copy silently drifting later is that there is only one place to
// change -- Step 6 removed the arithmetic from this file entirely.
it("resumes the session the last message belongs to", async () => {
  const { client, inserted } = dbs({
    lastMessage: { session_id: "s-old", created_at: new Date(Date.now() - 60_000).toISOString() },
  });
  await collect(runTurn({ userDb: client, serviceDb: client, ai: ai() },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(inserted.chat_sessions ?? []).toHaveLength(0);
  expect((inserted.chat_messages ?? []).every((r) => r.session_id === "s-old")).toBe(true);
});

it("opens a new session once the idle gap has passed", async () => {
  const { client, inserted } = dbs({
    lastMessage: {
      session_id: "s-old",
      created_at: new Date(Date.now() - SESSION_IDLE_RESET_MS - 1000).toISOString(),
    },
  });
  await collect(runTurn({ userDb: client, serviceDb: client, ai: ai() },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(inserted.chat_sessions ?? []).toHaveLength(1);
  expect((inserted.chat_messages ?? []).some((r) => r.session_id === "s-old")).toBe(false);
});
```

`ai()` is the file's existing default AI double (`turn.test.ts:184`) and `inserted` is the plain
`Record<string, Record<string, unknown>[]>` `dbs()` already returns — hence `inserted.chat_messages`,
not a call. Import `SESSION_IDLE_RESET_MS` from `@cortex/shared` at the top of the file, alongside
the existing `GROUNDING_USD_PER_QUERY`.

Note that `chat_sessions` is only ever inserted into by this path, so `?? []` covers the case where
the key was never created at all — which is exactly what "resumed" looks like.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/shared --filter=@cortex/core`
Expected: PASS. `context.test.ts` still passes through the re-export; every existing `turn.test.ts` case still starts a fresh session because `lastMessage` is absent.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/assistant packages/shared/src/index.ts packages/core/src/assistant/
git commit -m "refactor(assistant): one shared answer to which session is current"
```

---

### Task 2: `chitchat`, the third intent

The classifier's binary forces "hello", "haha ok" and "1111" into `question` or `statement`, and neither is right: the model either searches the user's notes for an answer to "what?", or replies as though this were journaling. This task adds the value. Nothing branches on it yet — Task 4 does that.

**Files:**
- Modify: `packages/core/src/enrich/extract.ts:7-14, 16-40, 74-104, 111-122, 279-291`
- Test: `packages/core/src/enrich/extract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const INTENTS = ["question", "statement", "chitchat"] as const`
  - `export type Intent = (typeof INTENTS)[number]`
  - `extractNote(...)` returns `intent: Intent` (was `"question" | "statement"`)

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/enrich/extract.test.ts`:

```ts
import { INTENTS, buildPrompt } from "./extract.js";

describe("the intent vocabulary", () => {
  // The schema enum is what the model is allowed to return; the prompt is the only place it
  // learns what the values MEAN. A value present in one and absent from the other is never a
  // type error -- it is a value the model never emits, or emits and cannot be parsed. Derived
  // from one constant here for the same reason the media-kind line is derived from mediaKind.
  it("names every intent in the classification prompt", () => {
    const prompt = buildPrompt("bất kỳ", []);
    for (const intent of INTENTS) {
      expect(prompt, `the prompt never mentions "${intent}"`).toContain(`"${intent}"`);
    }
  });

  it("offers exactly the three intents and no more", () => {
    expect([...INTENTS]).toEqual(["question", "statement", "chitchat"]);
  });
});
```

And, in the describe block that already covers `extractNote`'s return shape (follow the file's existing `extractNote` setup — it builds a fake db and a `createFakeAi` whose `generateJson` returns a scripted extraction; do not introduce a second helper):

```ts
it("passes a chitchat classification through", async () => {
  const out = await runExtract({ intent: "chitchat" });
  expect(out.intent).toBe("chitchat");
});

// THE DEFAULT, AND WHY IT IS A COMPARISON AND NOT A CAST. `required` in a responseSchema is a
// request, not a guarantee. "statement" is the branch that never spends the reasoning model
// and never grounds, so it is the only safe landing place for a value the model did not send
// or sent wrong. Widening the return type with `value.intent as Intent` would compile, would
// pass every other test in this file, and would let "chit chat" or "" through into turn.ts's
// branch -- where it silently reads as "not a question", which is right by accident today and
// wrong the moment a fourth intent exists.
it("defaults a missing intent to statement", async () => {
  expect((await runExtract({})).intent).toBe("statement");
});

it("defaults an unrecognised intent to statement", async () => {
  expect((await runExtract({ intent: "chit chat" })).intent).toBe("statement");
});
```

`runExtract(partial)` is shorthand for whatever the file already does to call `extractNote` with a scripted model response; if no such helper exists, inline the existing setup in each test rather than adding one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- extract`
Expected: FAIL — `INTENTS` is not exported; the prompt mentions no intent at all; `"chitchat"` comes back as `"statement"`.

- [ ] **Step 3: Declare the vocabulary and widen the schema**

In `packages/core/src/enrich/extract.ts`, above `RESPONSE_SCHEMA`:

```ts
/**
 * The three kinds of turn. `chitchat` is stage C4: "hello", "haha ok", "1111" -- input with
 * nothing to file and no question in it. Before it existed, those were forced into one of the
 * other two, and both reply templates are wrong for them (prompts.ts's acknowledge branch
 * explicitly refuses to converse; the answer branch searches the corpus for an answer to
 * "what?").
 *
 * Exported and reused in buildPrompt below so the schema and the prompt cannot name different
 * sets -- the same drift `mediaKind` already cost this file once.
 */
export const INTENTS = ["question", "statement", "chitchat"] as const;
export type Intent = (typeof INTENTS)[number];
```

Change the `Extraction` interface (line 8) and the schema (line 21):

```ts
  intent?: Intent;
```

```ts
    intent: { type: "string", enum: [...INTENTS] },
```

- [ ] **Step 4: Teach the prompt what the three mean**

`buildPrompt` currently says nothing about `intent` — the model infers it from the schema key alone, which was survivable for a binary and is not for a three-way. Add to the `Rules:` list, after the `mood` rule:

```ts
    "- intent is \"question\" when they are asking you something; \"chitchat\" for greetings,",
    "  reactions and noise with nothing to file (\"hello\", \"haha ok\", \"1111\"); otherwise",
    "  \"statement\". Chitchat is still saved as a note -- you are labelling the turn, not",
    "  deciding whether it is worth keeping.",
```

The last sentence is load-bearing: without it the model reads "nothing to file" as an instruction to discard, and §4.3 is explicit that the note is created first, before classification, and is never gated on it.

- [ ] **Step 5: Return it without a cast**

Replace the `intent` line in the return object (line 288):

```ts
    // A COMPARISON, not a cast. See extract.test.ts's default cases: `value.intent as Intent`
    // compiles and lets an unrecognised string through to turn.ts's branch.
    intent: value.intent === "question" || value.intent === "chitchat" ? value.intent : "statement",
```

and widen the declared return type on line 120:

```ts
  intent: Intent;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- extract`
Expected: PASS.

- [ ] **Step 7: Run the whole package**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS. `turn.ts` compares `extracted?.intent === "question"`, which still narrows correctly against the widened union.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/enrich/extract.ts packages/core/src/enrich/extract.test.ts
git commit -m "feat(enrich): classify small talk as a third intent"
```

---

### Task 3: `source_type = 'chitchat'`

The stamp, and only the stamp. Nothing writes it yet (Task 4) and nothing excludes it yet (Tasks 5 and 6) — this task exists on its own because the migration and the zod enum must move together or `enum-parity.test.ts` fails, and that pair is worth its own review.

**Files:**
- Create: `supabase/migrations/00030_note_source_type_chitchat.sql`
- Modify: `packages/shared/src/enums.ts:30-39`
- Test: `packages/shared/src/enums.test.ts:22-26`, `packages/db/src/test/enum-parity.test.ts` (no edit — it reads the enum)

**Interfaces:**
- Consumes: nothing.
- Produces: `noteSourceType.options` ends with `"chitchat"`; `notes.source_type` accepts `'chitchat'`.

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/enums.test.ts`, extend the existing options assertion (lines 22-26):

```ts
  it("noteSourceType covers capture channels, chat, saved answers, and small talk", () => {
    expect(noteSourceType.options).toEqual([
      "quick", "web_clip", "voice", "email", "telegram", "import",
      "chat", "assistant", "web_search", "chitchat",
    ]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/shared -- enums`
Expected: FAIL — the array is one element short.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00030_note_source_type_chitchat.sql`:

```sql
-- packages/db's enum-parity test reads notes_source_type_check out of pg_constraint and asserts
-- it matches @cortex/shared's noteSourceType exactly, IN ORDER, so these two move together or
-- the suite fails. 'chitchat' is appended LAST on both sides. See 00020, which set up this
-- mechanism, and the header of packages/shared/src/enums.ts.
--
-- 'chitchat' is a turn with nothing to file: "hello", "haha ok", "1111". It is still SAVED --
-- a capture surface that silently discards captures on a classifier's judgment is one you
-- cannot trust (stage C4 spec §6) -- but it is excluded from every note list (00031 and
-- packages/shared/src/notes/filters.ts) and from retrieval, so it never becomes a citation.
alter table public.notes drop constraint notes_source_type_check;
alter table public.notes add constraint notes_source_type_check
  check (source_type in (
    'quick','web_clip','voice','email','telegram','import',
    'chat','assistant','web_search','chitchat'
  ));
```

- [ ] **Step 4: Move the enum with it**

`packages/shared/src/enums.ts`, replace lines 36-39 and extend the comment block above them:

```ts
// 'chitchat'  -- small talk with nothing to file. Saved like everything else, but excluded
//                from the note lists AND from search_notes, so banter never becomes a
//                citation the model then answers around (stage C4 spec §5.3).
export const noteSourceType = z.enum([
  "quick", "web_clip", "voice", "email", "telegram", "import",
  "chat", "assistant", "web_search", "chitchat",
]);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/shared -- enums`
Expected: PASS.

- [ ] **Step 6: Apply the migration and run the parity test**

```bash
docker ps
pnpm supabase db push --local
pnpm turbo run test --filter=@cortex/db --force -- enum-parity
```

Expected: PASS, including `notes.notes_source_type_check matches its zod enum exactly`.

`--local` is not optional: the unflagged `db push` targets the hosted project. `--force` bypasses turbo's cache — with Docker down this suite replays a previous green without executing, and a gate that did not run did not pass.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/00030_note_source_type_chitchat.sql packages/shared/src/enums.ts packages/shared/src/enums.test.ts
git commit -m "feat(db): allow chitchat as a note source type"
```

---

### Task 4: The chitchat branch — its own prompt, its own stamp

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts`
- Modify: `packages/core/src/assistant/turn.ts:234-244`
- Test: `packages/core/src/assistant/prompts.test.ts`
- Test: `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: `Intent` and the widened `extractNote` return (Task 2); `'chitchat'` accepted by `notes.source_type` (Task 3).
- Produces: `export function buildChitchatPrompt(a: { text: string; history: ThreadTurn[] }): string`

- [ ] **Step 1: Write the failing prompt tests**

Add to `packages/core/src/assistant/prompts.test.ts`:

```ts
import { buildChitchatPrompt } from "./prompts.js";

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
```

- [ ] **Step 2: Write the failing turn tests**

First, `dbs()` must record updates. It captures inserts into a plain `Record` (`turn.test.ts:46, 68`) but its `update` branch for `notes` returns `{ data: null }` without recording anything, so no test can currently see a `source_type` stamp. Add a second record beside `inserted`:

```ts
  const updated: Record<string, Record<string, unknown>[]> = {};
```

and push into it at the top of `table(name).update`, before the existing `media_items` / `media_item_id` branches, so every update is recorded whatever branch then answers it:

```ts
    update: (row: Record<string, unknown> = {}) => {
      // Recorded for EVERY table before the branches below answer the call: an update whose
      // response shape a test does not care about is still an update a test may need to assert.
      // The 'chitchat' stamp is exactly that -- runTurn ignores what it resolves to.
      (updated[name] ??= []).push(row);
```

and return it: `return { client, inserted, updated };`

Now add to `packages/core/src/assistant/turn.test.ts`. `ai(value)` (line 184) already takes an extraction override, so the classification is `ai({ intent: "chitchat" })` — no new double:

```ts
it("stamps a chitchat turn's note as chitchat", async () => {
  const { client, updated } = dbs();
  await collect(runTurn({ userDb: client, serviceDb: client, ai: ai({ intent: "chitchat" }) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(updated.notes ?? []).toContainEqual(expect.objectContaining({ source_type: "chitchat" }));
});

it("stamps a question's note as chat, not chitchat", async () => {
  const { client, updated } = dbs();
  await collect(runTurn({ userDb: client, serviceDb: client, ai: ai({ intent: "question" }) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(updated.notes ?? []).toContainEqual(expect.objectContaining({ source_type: "chat" }));
});

// The three-way must stay three-way. A statement is the DEFAULT branch and is left alone at
// 'quick': stamping it would relabel every ordinary capture as something it is not.
it("leaves an ordinary statement's source_type alone", async () => {
  const { client, updated } = dbs();
  await collect(runTurn({ userDb: client, serviceDb: client, ai: ai({ intent: "statement" }) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect((updated.notes ?? []).some((r) => "source_type" in r)).toBe(false);
});

// Small talk does not need the reasoning model, and this is the assertion that keeps it from
// silently falling through into the question branch -- where it would spend ANSWER_MODEL and,
// since C3, ground against Google on "haha ok".
//
// A recorder ARRAY, not a nullable variable reassigned by the fake, for the reason spelled out
// at turn.test.ts:548: an early return inside createFakeAi that TS cannot see would leave a
// nullable `seen` undefined, and `seen?.model` then passes vacuously.
it("does not spend the answer model on chitchat", async () => {
  const { client } = dbs();
  const seen: { model?: string; grounding?: boolean }[] = [];
  const recordingAi = createFakeAi({
    generateJson: async () => ({
      value: { intent: "chitchat", complexity: "simple", domain: null,
               domain_meta: {}, tags: [], mood: null },
      inputTokens: 10, outputTokens: 5, model: "fake-classify",
    }),
    generateStream: async (args) => {
      seen.push(args);
      return {
        chunks: (async function* () { yield { text: "hehe" }; })(),
        usage: () => ({ inputTokens: 5, outputTokens: 2, model: "fake-classify" }),
      };
    },
  });

  await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(seen[0]?.model).toBe(CLASSIFY_MODEL);
  expect(seen[0]?.grounding).toBeFalsy();
});
```

Import `CLASSIFY_MODEL` from `@cortex/shared` alongside the existing constants.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- assistant`
Expected: FAIL — `buildChitchatPrompt` is not exported; no note update carries `source_type: "chitchat"`.

- [ ] **Step 4: Write the prompt**

In `packages/core/src/assistant/prompts.ts`, after `buildAcknowledgePrompt`:

```ts
/**
 * The third branch, stage C4 §4. "hello", "haha ok", "1111" -- a turn with no question in it
 * and nothing to file.
 *
 * Deliberately shorter than the other two and deliberately missing their framing. The
 * acknowledge prompt announces a filing ("You filed it under ...") and the answer prompt asks
 * for citations; applied to small talk, the first announces bookkeeping nobody asked about and
 * the second searches the user's corpus for an answer to "what?". The note is still saved --
 * that happens in assistant-box.tsx before this prompt exists -- so nothing here needs to
 * mention it.
 *
 * History is included: "haha ok" means nothing without the turn before it.
 */
export function buildChitchatPrompt(a: { text: string; history: ThreadTurn[] }): string {
  return [
    "The user said something conversational -- a greeting, a reaction, or noise. Reply in one " +
      "short, natural line. Do not ask a follow-up question and do not start a topic.",
    LANGUAGE_RULE,
    renderHistory(a.history),
    `\n\nThey said: ${a.text}`,
  ].join("\n");
}
```

- [ ] **Step 5: Branch the turn**

In `packages/core/src/assistant/turn.ts`, replace lines 234-244:

```ts
  const isQuestion = extracted?.intent === "question";
  const isChitchat = extracted?.intent === "chitchat";
  // A note that already exists, restamped after classification -- the shape 'chat' has used
  // since C1. `statement` is the default branch and writes nothing: every ordinary capture
  // keeps the 'quick' the row was created with.
  if (isQuestion || isChitchat) {
    await userDb.from("notes")
      .update({ source_type: isQuestion ? "chat" : "chitchat" })
      .eq("id", args.noteId);
  }
  const prompt = isQuestion
    ? buildAnswerPrompt({ question: text, citations: citationsForPrompt, history })
    : isChitchat
      ? buildChitchatPrompt({ text, history })
      : buildAcknowledgePrompt({
          note: text, domain: extracted?.domain ?? null, tags: extracted?.tagNames ?? [],
          related: citationsForPrompt, history,
        });
  // Unchanged, and it is what keeps small talk cheap: only a question reaches ANSWER_MODEL,
  // and only a question grounds (`grounding: isQuestion`, below).
  const model = isQuestion ? ANSWER_MODEL : CLASSIFY_MODEL;
```

and extend the import on line 12:

```ts
import { buildAcknowledgePrompt, buildAnswerPrompt, buildChitchatPrompt } from "./prompts.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- assistant`
Expected: PASS.

- [ ] **Step 7: Run the whole package**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/assistant/
git commit -m "feat(assistant): answer small talk with its own prompt and stamp"
```

---

### Task 5: Three of the four appliers — the note lists and the live patch

The spec's §5.2 names four places that must exclude chitchat and warns that `filters-equivalence.test.ts` guards only the first against the second. This task does 1, 2 and 3; Task 6 does 4.

| # | Where | Function | Missed → |
|---|---|---|---|
| 1 | Web SSR + Realtime refetch | `applyNoteFilters` | the web list shows chitchat |
| 2 | Mobile SQLite | `noteFiltersToSql` | the mobile list shows chitchat |
| 3 | Realtime row patch | `matchesFilters` | SSR excludes it, Realtime patches it back in |

**#3 is the one that has already burned this codebase.** It is the surviving half of E5: `filters.ts:134-143` records that `matchesFilters` and `requiresRefetch` are a deliberate pair naming exactly the fields the other ignores. The eviction path itself already works — a chitchat note is created as `'quick'` and stamped only after classification, so Realtime delivers it to the list first and the stamping `UPDATE` arrives second, where `note-list.tsx:85-92` removes it by id and re-adds it only `if (matchesFilters(row, ...))`. Soft-deletes already ride that exact path. Nothing new is needed; the risk is purely forgetting the field.

**Files:**
- Modify: `packages/shared/src/notes/filters.ts:78-112, 114-132, 198-233`
- Modify: `apps/web/src/app/note-list.tsx:10-14`
- Test: `packages/shared/src/notes/filters.test.ts`
- Test: `packages/core/src/notes/filters-equivalence.test.ts`

**Interfaces:**
- Consumes: `'chitchat'` as a legal `source_type` (Task 3).
- Produces: `matchesFilters(note: { lifecycle: string; deleted_at: string | null; source_type: string; domain?: string | null }, f: NoteFilters): boolean` — `source_type` is **required**, so a caller that forgets it is a type error rather than a note that quietly vanishes or quietly appears.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/notes/filters.test.ts`:

```ts
describe("chitchat is not a note anyone browses", () => {
  // Applier 1. Asserted through a recording double rather than a live query, the way this
  // file's other applyNoteFilters cases are: what matters is the CALL, since a missing `neq`
  // is invisible in a result set that happens to contain no chitchat.
  it("applyNoteFilters excludes it from every view", () => {
    for (const view of NOTE_VIEWS) {
      const calls: [string, unknown][] = [];
      const q = new Proxy({}, {
        get: (_t, prop: string) => (...args: unknown[]) => { calls.push([prop, args]); return q; },
      });
      applyNoteFilters(q, { view });
      expect(calls, `view=${view}`).toContainEqual(["neq", ["source_type", "chitchat"]]);
    }
  });

  // Applier 2. Trash included: chitchat is excluded everywhere, not just from the live views.
  it("noteFiltersToSql excludes it from every view", () => {
    for (const view of NOTE_VIEWS) {
      const { where, params } = noteFiltersToSql({ view });
      expect(where, `view=${view}`).toContain("source_type");
      expect(params, `view=${view}`).toContain("chitchat");
    }
  });

  // Applier 3, AND the reason it is separate from applier 1. A chitchat note is created as
  // 'quick' and stamped only after classification, so Realtime delivers it to the list first
  // and the stamping UPDATE arrives second. Without this the SSR query excludes it and the
  // live patch puts it straight back -- E5's surviving half, exactly.
  it("matchesFilters evicts a row that has just been stamped chitchat", () => {
    const row = { lifecycle: "inbox", deleted_at: null, source_type: "chitchat" };
    expect(matchesFilters(row, { view: "inbox" })).toBe(false);
  });

  it("matchesFilters still admits an ordinary note", () => {
    const row = { lifecycle: "inbox", deleted_at: null, source_type: "quick" };
    expect(matchesFilters(row, { view: "inbox" })).toBe(true);
  });

  // A note in the trash is still not browsable banter. Checked separately because the trash
  // branch of matchesFilters returns before the lifecycle checks.
  it("matchesFilters evicts chitchat from trash too", () => {
    const row = { lifecycle: "inbox", deleted_at: "2026-08-16T00:00:00Z", source_type: "chitchat" };
    expect(matchesFilters(row, { view: "trash" })).toBe(false);
  });
});
```

TypeScript will now error on every **existing** `matchesFilters` call in this file, because `source_type` is required and none of them pass it. Add `source_type: "quick"` to each — that is the point of making it required rather than optional.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/shared -- filters`
Expected: FAIL — no `neq` call, no `source_type` in the SQL, and `matchesFilters` admits the chitchat row.

- [ ] **Step 3: Exclude it in `applyNoteFilters`**

In `packages/shared/src/notes/filters.ts`, add `neq` to the structural builder type (after `eq`):

```ts
    neq: (c: string, v: string) => typeof q;
```

and add the clause immediately after the `order` call, before the view branching:

```ts
  // Applied to EVERY view including trash, and before the view branching so it cannot be
  // reached around. Chitchat is saved (stage C4 §6) and never browsed: it is a turn of small
  // talk, not a note. `neq` and not a null-tolerant form because notes.source_type is
  // `not null default 'quick'` (00002) -- there is no null here to lose a row to.
  q = q.neq("source_type", "chitchat");
```

- [ ] **Step 4: Exclude it in `matchesFilters`**

Replace the signature and add the first check:

```ts
export function matchesFilters(
  note: {
    lifecycle: string; deleted_at: string | null;
    /**
     * REQUIRED, not optional. Realtime hands back the full row and `noteSelect` already
     * returns "*", so the data is always there -- making it optional would only buy a caller
     * the right to forget it, and forgetting it is silent: the SSR query excludes the note
     * and this predicate patches it straight back in. That is E5's surviving half.
     */
    source_type: string;
    domain?: string | null;
  },
  f: NoteFilters,
): boolean {
  // First, and above the trash branch: banter in the trash is still not a note anyone browses.
  if (note.source_type === "chitchat") return false;
  if (f.domain && note.domain !== f.domain) return false;
  if (f.view === "trash") return note.deleted_at !== null;
  ...
```

- [ ] **Step 5: Exclude it in `noteFiltersToSql`**

Add as the first pushed clause, before the `deleted_at` clause:

```ts
  // Parameterised like every other value here. Null-tolerant, unlike the Postgres side: the
  // local replica is written by mobile's own capture path as well as by PowerSync, and a bare
  // `!= 'chitchat'` evaluates to NULL -- and therefore excludes the row -- for any local row
  // whose source_type was never set. Hiding a note the user just captured is the worse error
  // by a distance. (capture.ts and media-log.ts both write 'quick' today, so this is a guard
  // against a future write path, not a bug being papered over.)
  clauses.push(`(n.source_type is null or n.source_type != ${p("chitchat")})`);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/shared -- filters`
Expected: PASS.

- [ ] **Step 7: Anchor the equivalence suite**

`packages/core/src/notes/filters-equivalence.test.ts` is the only guard against appliers 1 and 2 drifting, and it anchors every case to an expected id set. Seed a chitchat note in its `beforeAll`, after `ids.inbox`:

```ts
  // Stage C4: excluded from BOTH engines. Seeded as a real row -- agreement alone is the
  // weaker property (two appliers that both forget the clause agree perfectly), so this id is
  // named in the expectations below and must appear in neither.
  const chit = await svc.create({ content: "haha ok chitchat row" });
  await client.from("notes").update({ source_type: "chitchat" }).eq("id", chit.id);
  ids.chitchat = chit.id;
```

Then add a case in the same shape as the file's existing ones (it runs both appliers over the same corpus and compares each against an expected id set):

```ts
it("excludes a chitchat note from the inbox on both engines", async () => {
  const filters: NoteFilters = { view: "inbox" };
  const { pg, sqlite } = await bothEngines(filters); // the file's existing helper
  expect(pg).not.toContain(ids.chitchat);
  expect(sqlite).not.toContain(ids.chitchat);
  expect(pg).toContain(ids.inbox);   // not vacuous: the inbox is not simply empty
  expect(sqlite).toContain(ids.inbox);
});
```

Use whatever the file already names the helper that runs both sides; do not add a second one. The last two assertions are not decoration — without them a clause that excluded *everything* would pass.

- [ ] **Step 8: Give the web row type the field**

`apps/web/src/app/note-list.tsx`, in `NoteRow`:

```ts
export interface NoteRow {
  id: string; title: string | null; content: string;
  lifecycle: string; updated_at: string; deleted_at: string | null;
  /** Required because matchesFilters requires it. `noteSelect` returns "*", so it is always here. */
  source_type: string;
  domain?: string | null;
}
```

No other change is needed in this file: `matchesFilters(row, stableFilters)` at line 88 now reads it, and the `return without` fallback at line 91 is the eviction path soft-deletes already use.

- [ ] **Step 9: Run the affected packages**

Run: `pnpm turbo run test --filter=@cortex/shared --filter=@cortex/core --filter=@cortex/web`
Expected: PASS. Run `pnpm turbo run typecheck` too — `NoteRow`'s new required field must not have broken a fixture in `apps/web`.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/notes/ packages/core/src/notes/filters-equivalence.test.ts apps/web/src/app/note-list.tsx
git commit -m "feat(notes): keep chitchat out of every note list"
```

---

### Task 6: The fourth applier — retrieval and search

`retrieve.ts` → `search_notes` is a separate read path that does not go through `NoteFilters` at all. Left alone, "haha ok" and "1111" stay eligible as citations, so the model is fed the small talk it just produced — a self-reinforcing loop in the most context-sensitive part of the system. §5.3 judges this to matter **more** than the sidebar does.

One clause, in `search_notes`, covers both retrieval and the `/search` page. The accepted cost is written down in the spec: *"what was that joke I made last month"* will not come back.

Note the deliberate asymmetry with §6.3's existing 0.8 down-weight for `'assistant'` and `'web_search'`: that is a **multiplier**, and a multiplier still lets banter win when nothing else matches — exactly the turn where a citation does the most damage. Chitchat is excluded, not down-weighted.

**Files:**
- Create: `supabase/migrations/00031_search_notes_exclude_chitchat.sql`
- Test: `packages/db/src/test/search-notes.test.ts`
- Test: `apps/api/test/search.e2e.test.ts`

**Interfaces:**
- Consumes: `'chitchat'` as a legal `source_type` (Task 3).
- Produces: nothing in TypeScript. `search_notes`'s signature and return columns are unchanged.

- [ ] **Step 1: Write the failing db tests**

Add to `packages/db/src/test/search-notes.test.ts`, inside the existing `describe("search_notes")`:

```ts
// Stage C4 §5.3. The FTS arm: a chitchat note whose text matches the query exactly must not
// come back. Anchored against a control note with the same keyword, so a green result cannot
// come from the query simply matching nothing.
it("never returns a chitchat note matched by keyword", async () => {
  const control = await seed(bob, "the flibbertigibbet protocol, a real note");
  const chit = await seed(bob, "the flibbertigibbet protocol, haha ok", { sourceType: "chitchat" });
  const rows = await search(bob, "flibbertigibbet protocol", vec(7));
  expect(rows.map((r) => r.note_id)).toContain(control);
  expect(rows.map((r) => r.note_id)).not.toContain(chit);
});

// The VECTOR arm, separately: the two arms are joined with a full outer join, so a clause
// present in one and absent from the other still returns the row. A near-identical embedding
// is the strongest possible pull into the vector arm -- if the exclusion is missing there,
// this is the assertion that says so.
it("never returns a chitchat note matched by embedding", async () => {
  const target = vec(21);
  const chit = await seed(bob, "banter with a very close embedding", {
    sourceType: "chitchat", embedding: target,
  });
  const rows = await search(bob, "nothing-matches-this-keyword-zzz", target);
  expect(rows.map((r) => r.note_id)).not.toContain(chit);
});
```

- [ ] **Step 2: Write the failing API test**

Add to `apps/api/test/search.e2e.test.ts`, inside `describe("POST /search")`:

```ts
// The same clause, asserted over the HTTP path -- a separate assertion because it is a
// separate consumer: /search reaches search_notes through SearchController's service-role
// client, while retrieval reaches it through retrieve.ts. A regression that dropped the
// exclusion for one would drop it for both, and this is the half a user would notice.
it("never returns a chitchat note", async () => {
  const marker = "quixotic-chitchat-marker";
  await request(app.getHttpServer()).post("/notes")
    .set(auth(alice.token)).send({ content: `${marker} a real note` }).expect(201);
  const { data: chit } = await admin.from("notes")
    .insert({ user_id: alice.id, content: `${marker} haha ok`, source_type: "chitchat" })
    .select("id").single();

  const res = await request(app.getHttpServer()).post("/search")
    .set(auth(alice.token)).send({ q: marker }).expect(201);
  // Not vacuous: the real note with the same marker must come back.
  expect(res.body.results.length).toBeGreaterThan(0);
  expect(res.body.results.map((r: { noteId: string }) => r.noteId)).not.toContain(chit!.id);
});
```

- [ ] **Step 3: Run both to verify they fail**

```bash
pnpm turbo run test --filter=@cortex/db --force -- search-notes
pnpm turbo run test --filter=@cortex/api --force -- search
```

Expected: FAIL — the chitchat notes come back in all three cases.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/00031_search_notes_exclude_chitchat.sql`. This is `00026_vietnamese_fts.sql`'s function body verbatim plus three predicates — `create or replace` needs the whole body, and reproducing it is how this file stays readable as the current definition.

```sql
-- Stage C4 §5.3: chitchat is EXCLUDED from search_notes, not down-weighted.
--
-- The 0.8 multiplier below covers 'assistant' and 'web_search' -- material the user chose to
-- save, which should rank low but stay reachable. A multiplier is the wrong tool for banter: it
-- still lets "haha ok" win when nothing else matches, which is exactly the turn where a citation
-- does the most damage. Excluded from retrieval, the model is never fed the small talk it just
-- produced; excluded from /search, "what was that joke I made last month" does not come back.
-- That second cost is accepted and recorded (spec §5.3, §15) -- if it turns out wrong, the
-- reversal is to down-weight instead, which is a decision rather than a discovery.
--
-- The predicate is repeated in BOTH arms and in the final select. Not redundancy for its own
-- sake: the arms are joined with a full outer join, so a clause present in one arm only still
-- returns the row, and the final `where` is the same defence-in-depth the p_user_id predicate
-- already documents below.
--
-- Everything else is 00026 verbatim. See 00022's header for why this is SECURITY DEFINER, why
-- `set search_path` must name `extensions`, and why the parameter type stays written as
-- `extensions.vector(1536)`; see 00024's for the recency clamp.
create or replace function public.search_notes(
  p_user_id uuid,
  p_query text,
  p_embedding extensions.vector(1536),
  p_limit int
)
returns table (note_id uuid, title text, snippet text, score real, matched_by text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with vector_arm as (
    select c.note_id,
           row_number() over (order by c.embedding <=> p_embedding) as rank
    from public.note_chunks c
    join public.notes n on n.id = c.note_id
    where c.user_id = p_user_id
      and n.deleted_at is null
      and n.source_type <> 'chitchat'
      and c.embedding is not null
    order by c.embedding <=> p_embedding
    limit 40
  ),
  -- One row per note: a long note with three matching chunks must not out-rank a short one
  -- three times over.
  vector_best as (
    select note_id, min(rank) as rank from vector_arm group by note_id
  ),
  -- Postgres evaluates window functions before the statement's own ORDER BY/LIMIT, so an
  -- unordered `limit 40` over a row_number() column takes an ARBITRARY 40 rows, not the
  -- top 40 by rank -- for a user with more than 40 keyword matches the highest-ranked notes
  -- could be dropped entirely. Rank first (ranked CTE, ordered `order by rank`), then limit.
  fts_ranked as (
    select n.id as note_id,
           row_number() over (
             order by ts_rank(to_tsvector('simple', public.immutable_unaccent(n.content_text)),
                              websearch_to_tsquery('simple', public.immutable_unaccent(p_query))) desc
           ) as rank
    from public.notes n
    where n.user_id = p_user_id
      and n.deleted_at is null
      and n.source_type <> 'chitchat'
      and to_tsvector('simple', public.immutable_unaccent(n.content_text))
          @@ websearch_to_tsquery('simple', public.immutable_unaccent(p_query))
  ),
  fts_arm as (
    select note_id, rank from fts_ranked order by rank limit 40
  ),
  fused as (
    select coalesce(v.note_id, f.note_id) as note_id,
           -- Reciprocal Rank Fusion, k = 60. RRF needs no score normalisation between the two
           -- arms, which is the point: cosine distance and ts_rank are not comparable
           -- quantities and any attempt to scale them into each other is a fudge factor.
           -- The SUM is the whole claim: two arms agreeing at rank 2 (1/62 + 1/62) beats one
           -- arm alone at rank 1 (1/61), and because every rank here is <= 40, a note in both
           -- arms beats a note in one arm for EVERY combination of ranks (2/100 > 1/61).
           -- packages/db's "fuses both arms" test pins that inequality in both directions.
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + f.rank), 0) as base,
           case
             when v.note_id is not null and f.note_id is not null then 'both'
             when v.note_id is not null then 'vector'
             else 'fts'
           end as matched_by
    from vector_best v
    full outer join fts_arm f on f.note_id = v.note_id
  )
  select n.id,
         n.title,
         left(n.content_text, 240) as snippet,
         (
           fused.base
           -- Recency. tau = 180 days for search (parent §6.8). The age is clamped to
           -- [0 days, 100 years] because created_at comes from the device; see 00024's
           -- header for the amplification and the numeric overflow that motivated each bound.
           * exp(
               -least(greatest(extract(epoch from (now() - n.created_at)) / 86400.0, 0), 36525.0)
               / 180.0
             )
           -- Provenance. A saved answer is not the user's own thinking, so it ranks below an
           -- own note of equal relevance rather than being hidden (life-domains spec §6.3,
           -- "provenance, not prohibition"). 'chat' is EXCLUDED: a question the user typed is
           -- their own words. 'chitchat' is not down-weighted here at all -- it never reaches
           -- this select.
           * case when n.source_type in ('assistant', 'web_search') then 0.8 else 1.0 end
         )::real as score,
         fused.matched_by
  from fused
  join public.notes n on n.id = fused.note_id
  -- Redundant with the per-arm `c.user_id = p_user_id` / `n.user_id = p_user_id` filters
  -- above, and nearly free here. p_user_id is the ONLY thing separating two users' corpora --
  -- a redundant predicate on the final select turns a future missing filter in just ONE arm
  -- into a no-op instead of a cross-user leak. The chitchat predicate rides along for exactly
  -- the same reason.
  where n.user_id = p_user_id
    and n.deleted_at is null
    and n.source_type <> 'chitchat'
  -- Deterministic tiebreaker: `score desc` alone leaves ties (e.g. two notes with identical
  -- RRF base, recency and provenance) in an unspecified order, which matters once Task 15
  -- exposes this over an API -- a non-reproducible top-N cut is a bad API contract even
  -- before it's a UX problem.
  order by score desc, n.created_at desc, n.id
  limit p_limit;
$$;
-- `create or replace` preserves the existing ACL, so these are no-ops today. Restated so the
-- current definition of this function is readable in one file: a future change that has to DROP
-- and recreate it (adding a parameter creates an overload rather than replacing -- 00023's
-- lesson) would otherwise silently ship a function granted to public.
revoke execute on function public.search_notes(uuid, text, extensions.vector(1536), int) from public;
grant execute on function public.search_notes(uuid, text, extensions.vector(1536), int) to service_role;
```

- [ ] **Step 5: Apply it and run both suites**

```bash
docker ps
pnpm supabase db push --local
pnpm turbo run test --filter=@cortex/db --force -- search-notes
pnpm turbo run test --filter=@cortex/api --force -- search
```

Expected: PASS, all three new cases, and every pre-existing `search_notes` assertion (fusion ranks, the recency clamp, the 0.8 provenance weight, cross-user isolation) still green — the body is otherwise byte-identical to 00026's.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00031_search_notes_exclude_chitchat.sql packages/db/src/test/search-notes.test.ts apps/api/test/search.e2e.test.ts
git commit -m "feat(search): exclude chitchat from retrieval and search"
```

---

### Task 7: The transcript pane

The largest single item in C4, and the one the spec's §1 mis-scoped (see **Spec corrections**). The pane exists; it reads the wrong table. Today `page.tsx:54` derives the thread from the same `applyNoteFilters` query that feeds the sidebar, so the "conversation" is whatever the sidebar is currently narrowed to — `/?view=archived` renders an archived-only thread, `/?q=dune` renders a three-message one, and after Task 5 a chitchat turn disappears from the conversation it belongs to.

After this task the pane reads `chat_messages` for the current session. The split the requirement asked for then holds **by construction**: two tables, not two narrowings of one. `chat_messages` also holds the assistant's own replies, which are not notes and never will be, so no second narrowing exists to drift.

**Files:**
- Create: `apps/web/src/app/provenance.tsx`
- Modify: `apps/web/src/app/page.tsx:27-33, 52-70`
- Modify: `apps/web/src/app/assistant-box.tsx`
- Modify: `apps/web/src/app/globals.css:199-219`
- Modify: `e2e/scripts/seed.mjs`
- Test: `apps/web/src/app/assistant-box.test.tsx`
- Test: `apps/web/e2e/assistant-box.spec.ts`

**Interfaces:**
- Consumes: `resolveCurrentSession` from `@cortex/shared` (Task 1); `readCitation`, `AnyCitation`, `Citation`, `WebCitation` from `@cortex/shared` (stage C3).
- Produces:
  - `export interface TranscriptTurn { id: string; role: "user" | "assistant"; content: string; citations: AnyCitation[]; incomplete: boolean }` in `assistant-box.tsx`
  - `<AssistantBox token initialTurns />` — the `initialMessages` prop is **replaced**, not added to
  - `export function Provenance({ citations, entryPoint }: { citations: AnyCitation[]; entryPoint?: string })` in `provenance.tsx`

- [ ] **Step 1: Write the failing component tests**

Add to `apps/web/src/app/assistant-box.test.tsx`:

```ts
const turn = (over: Partial<TranscriptTurn> = {}): TranscriptTurn => ({
  id: "t1", role: "assistant", content: "Đã lưu.", citations: [], incomplete: false, ...over,
});

describe("the transcript", () => {
  it("renders both sides of a past turn", () => {
    render(<AssistantBox token="t" initialTurns={[
      turn({ id: "u1", role: "user", content: "hôm nay tôi chạy bộ" }),
      turn({ id: "a1", role: "assistant", content: "Đã lưu vào health." }),
    ]} />);
    expect(screen.getByText("hôm nay tôi chạy bộ")).toBeInTheDocument();
    expect(screen.getByText("Đã lưu vào health.")).toBeInTheDocument();
  });

  // A reloaded turn must look like the turn did while it streamed -- same component, same
  // split. Rendering a persisted turn's citations differently is how "did it remember?"
  // becomes a question the user has to ask.
  it("renders a past turn's note and web provenance in the same split blocks", () => {
    render(<AssistantBox token="t" initialTurns={[turn({
      citations: [
        { type: "note", noteId: "n1", title: "Dune", snippet: "s", score: 1, matchedBy: "fts" },
        { type: "web", url: "https://a.example", title: "a" },
      ],
    })]} />);
    expect(screen.getByRole("heading", { name: "Từ notes của bạn" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Từ web" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "a" })).toHaveAttribute("href", "https://a.example");
  });

  // THE ONE THAT IS INVISIBLE OTHERWISE. retrieval_meta.incomplete marks an answer the stream
  // never finished. It stays in the thread deliberately (it is already kept OUT of the prompt
  // at turn.ts:134, because the model reads a truncated answer as a complete one) -- but in
  // the `content` column alone, an interrupted answer and a short answer are the same string.
  // Only the flag can tell them apart, and only the pane can say so.
  it("marks an interrupted answer as interrupted", () => {
    render(<AssistantBox token="t" initialTurns={[
      turn({ content: "Theo notes của bạn thì", incomplete: true }),
    ]} />);
    expect(screen.getByText(/interrupted|bị gián đoạn/i)).toBeInTheDocument();
  });

  it("does not mark a complete answer", () => {
    render(<AssistantBox token="t" initialTurns={[turn()]} />);
    expect(screen.queryByText(/interrupted|bị gián đoạn/i)).toBeNull();
  });

  // The naive version double-renders the last turn: once from the box's streaming state and
  // once from the transcript it was just appended to. The box owns what is still streaming;
  // the transcript owns everything that is done.
  it("shows a finished turn exactly once", async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : sse([
            ["token", { text: "Đã lưu nhé." }],
            ["done", { messageId: "m1", sessionId: "s1" }],
          ])) as typeof fetch;

    render(<AssistantBox token="t" initialTurns={[]} />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getAllByText("Đã lưu nhé.")).toHaveLength(1));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/web -- assistant-box`
Expected: FAIL — `initialTurns` is not a prop and `TranscriptTurn` does not exist.

- [ ] **Step 3: Extract the provenance blocks**

Create `apps/web/src/app/provenance.tsx`. This is `assistant-box.tsx:150-184` lifted verbatim, with the two lists derived from one discriminated array — so a streaming turn and a reloaded one go through the same code and cannot render differently.

```tsx
"use client";
import type { AnyCitation } from "@cortex/shared";

/**
 * The notes/web split, for BOTH the turn that is streaming right now and every turn read back
 * out of chat_messages. One component on purpose: stage C4 §3.1 requires a turn to look the
 * same after a reload as it did while it streamed, and two renderers for one concept is how
 * that stops being true without anyone noticing.
 *
 * The two blocks are NEVER merged into one list -- life-domains spec §6.2 requires the visible
 * split between what came from the user's own notes and what came from the open internet.
 */
export function Provenance(
  { citations, entryPoint }: { citations: AnyCitation[]; entryPoint?: string },
) {
  const notes = citations.filter((c) => c.type === "note");
  const web = citations.filter((c) => c.type === "web");

  return (
    <>
      {notes.length > 0 && (
        <section className="provenance">
          <h3>Từ notes của bạn</h3>
          <ul className="citations">
            {notes.map((c) => <li key={c.noteId}>{c.title ?? "Untitled"}</li>)}
          </ul>
        </section>
      )}

      {web.length > 0 && (
        <section className="provenance web">
          <h3>Từ web</h3>
          <ul className="citations">
            {web.map((s) => (
              // rel="noopener noreferrer": these are URLs the model chose, not ones we vetted.
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
              </li>
            ))}
          </ul>

          {entryPoint && (
            // Google's own markup, rendered because Google's terms require the returned Search
            // Suggestions entry point to be displayed when grounding is used (life-domains §6.2).
            // It is HTML+CSS produced by Google for exactly this, which is why it is injected
            // rather than rebuilt. The source is the Gemini API response relayed by our own API,
            // not user input and not a third-party page. Only the LIVE turn passes it: it is not
            // persisted on chat_messages, so a reloaded turn shows sources without the chips.
            <div className="search-suggestions" dangerouslySetInnerHTML={{ __html: entryPoint }} />
          )}
        </section>
      )}
    </>
  );
}
```

TypeScript narrows `c.type === "note"` against the `AnyCitation` union, so `c.noteId` and `s.url` are both checked rather than cast.

- [ ] **Step 4: Rebuild the box around the transcript**

In `apps/web/src/app/assistant-box.tsx`:

Replace the `Message` type and the `Web` type region with:

```tsx
import { readCitation, readEvents, type AnyCitation, type Citation, type WebCitation }
  from "@cortex/shared";
import { Provenance } from "./provenance";

/**
 * One row of chat_messages, ready to render. Built in page.tsx, where the jsonb `citations`
 * column is read through readCitation -- the single place a pre-C3 entry with no `type` key
 * becomes a note citation, and a malformed one is dropped rather than taking the transcript
 * down with it.
 */
export interface TranscriptTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: AnyCitation[];
  /** retrieval_meta.incomplete: the stream died mid-answer. Shown, never hidden. */
  incomplete: boolean;
}
```

Replace the props and the `messages` state:

```tsx
export function AssistantBox(
  { token, initialTurns }: { token: string; initialTurns?: TranscriptTurn[] },
) {
  const [turns, setTurns] = useState<TranscriptTurn[]>(initialTurns ?? []);
```

Keep `attached`, `citations`, `web`, `answer`, `status`, `error` exactly as they are — a partially streamed answer is not in `chat_messages` yet and cannot come from the transcript.

In `submit()`, replace the `setMessages` call after `createNote` resolves:

```tsx
    // Appended only after createNote resolves -- a capture box never loses a thought, and never
    // shows a bubble for a message that was never actually saved. The server writes the real
    // chat_messages row inside runTurn; this is the optimistic twin of it, and a reload replaces
    // it with the persisted one.
    setTurns((prev) => [...prev, {
      id: note.id, role: "user", content: text, citations: [], incomplete: false,
    }]);
```

Add a `done` branch to the event loop, alongside the existing ones:

```tsx
        } else if (ev.type === "done") {
          // THE HAND-OFF. The turn is in the database now, so the transcript owns it and the
          // live state is cleared in the same update. Without this the last turn renders twice
          // -- once from `answer` and once from the row it was just appended to.
          const d = ev.data as { messageId?: unknown };
          const web_ = web;
          setTurns((prev) => [...prev, {
            id: typeof d.messageId === "string" && d.messageId !== "" ? d.messageId : `local-${Date.now()}`,
            role: "assistant",
            content: answerRef.current,
            citations: [...citations, ...(web_?.sources ?? [])],
            incomplete: false,
          }]);
          setAnswer("");
          setCitations([]);
          setWeb(null);
        }
```

`answerRef` is needed because `answer` is stale inside the async loop's closure: add `const answerRef = useRef("")` beside the state and set it in the same place `setAnswer` is called —

```tsx
        } else if (ev.type === "token") {
          const chunk = String((ev.data as { text?: unknown }).text ?? "");
          answerRef.current += chunk;
          setAnswer((a) => a + chunk);
        }
```

— and reset `answerRef.current = ""` in `submit()` next to `setAnswer("")`.

`attached` is deliberately **not** carried into the transcript: it describes what was filed on the note, not what the assistant said, and it is not on the `chat_messages` row. It stays live-turn-only, exactly as now.

Replace the render body's `messages.map(...)` and the assistant bubble with:

```tsx
        {turns.length === 0 && !hasReply && (
          <p className="chat-empty">What are you thinking?</p>
        )}

        {turns.map((t) => (
          t.role === "user" ? (
            <div key={t.id} className="bubble user"><p>{t.content}</p></div>
          ) : (
            <div key={t.id} className="bubble assistant">
              <Provenance citations={t.citations} />
              {t.content && <p className="answer">{t.content}</p>}
              {t.incomplete && (
                // An interrupted answer and a short answer are the same string in `content`.
                // Only retrieval_meta.incomplete tells them apart, and the user is the one who
                // needs to know -- the model is already shielded from it at turn.ts:134.
                <p className="interrupted" role="note">Câu trả lời bị gián đoạn (interrupted).</p>
              )}
            </div>
          )
        ))}
```

and, in the live `hasReply` bubble, replace the two inline provenance sections with:

```tsx
            <Provenance
              citations={[...citations, ...(web?.sources ?? [])]}
              {...(web?.entryPoint !== undefined ? { entryPoint: web.entryPoint } : {})}
            />
```

Finally update `hasReply` — it no longer needs to consider the transcript:

```tsx
  const hasReply =
    attached !== null || citations.length > 0 || web !== null || answer !== "" || status !== null;
```

(unchanged, but confirm it still reads that way after the edits) and change the autoscroll dependency array's `messages` to `turns`.

- [ ] **Step 5: Style the marker**

In `apps/web/src/app/globals.css`, beside the other `.bubble.assistant` rules (~line 210):

```css
.bubble.assistant .interrupted { margin: 0; font-size: 12.5px; color: var(--muted); font-style: italic; }
```

- [ ] **Step 6: Run the component tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/web -- assistant-box`
Expected: PASS.

- [ ] **Step 7: Repoint the page at `chat_messages`**

In `apps/web/src/app/page.tsx`, **delete line 54** (`const messages = [...notes].reverse()...`) and add, after the notes query:

```tsx
  // THE SPLIT. The pane reads chat_messages; the sidebar reads notes. Two TABLES, not two
  // narrowings of one -- so the pane cannot inherit the sidebar's view/q/tag filters, which is
  // what it did until stage C4 (`/?view=archived` rendered an archived-only "conversation").
  // chat_messages also holds the assistant's own replies, which are not notes and never will
  // be, so there is no second narrowing here to drift.
  //
  // RLS is the isolation layer and it is already in place: chat_messages_own (00006) scopes
  // both statements below to this user, which is why the second one can be scoped by session
  // alone -- the same shape turn.ts reads it with.
  const { data: last } = await supabase
    .from("chat_messages").select("session_id, created_at")
    .eq("user_id", user.id).order("created_at", { ascending: false }).limit(1);
  const sessionId = resolveCurrentSession(
    ((last ?? [])[0] as { session_id: string; created_at: string } | undefined) ?? null,
    new Date(),
  );

  // Scrollback across earlier sessions is OUT of stage C4 (§2), and the limit is the visible
  // form of that decision: the pane shows the rolling 4-hour thread, not an unbounded list with
  // no bottom. Reaching older conversations is a search problem and gets its own stage.
  const TRANSCRIPT_LIMIT = 200;
  const { data: messageRows } = sessionId
    ? await supabase
        .from("chat_messages").select("id, role, content, citations, retrieval_meta")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .limit(TRANSCRIPT_LIMIT)
    : { data: [] };

  const turns: TranscriptTurn[] = (messageRows ?? []).map((m) => {
    const row = m as {
      id: string; role: string; content: string;
      citations: unknown; retrieval_meta: { incomplete?: boolean } | null;
    };
    return {
      id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      // readCitation is the one place a jsonb entry's shape is decided: a pre-C3 entry with no
      // `type` reads as a note, and anything unreadable is DROPPED rather than rendered. One
      // bad entry must not cost the user the rest of the transcript.
      citations: (Array.isArray(row.citations) ? row.citations : [])
        .map(readCitation)
        .filter((c): c is AnyCitation => c !== null),
      incomplete: row.retrieval_meta?.incomplete === true,
    };
  });
```

Extend the imports:

```tsx
import { readCitation, resolveCurrentSession, type AnyCitation } from "@cortex/shared";
import { AssistantBox, type TranscriptTurn } from "./assistant-box";
```

and change the render:

```tsx
      <AssistantBox token={session.access_token} initialTurns={turns} />
```

- [ ] **Step 8: Seed a conversation and a chitchat note for E2E**

In `e2e/scripts/seed.mjs`, add a PostgREST helper beside the existing `authFetch` (the file is dependency-free by design — this is plain HTTP with the service-role key, the same shape `authFetch` already uses):

```js
/** Service-role PostgREST. Used only for rows no HTTP route can create (chat_messages). */
async function restInsert(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function restPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`patch ${table} -> ${res.status}: ${await res.text()}`);
}
```

and at the end of `seedCorpus`, before the `return`:

```js
  // Stage C4: a conversation for the transcript pane, and a chitchat note that must appear in
  // the pane and NOT in the sidebar list. There is no HTTP route that writes chat_messages --
  // runTurn does, and driving a real turn would need a live model -- so these go in directly.
  //
  // TIME-SENSITIVE BY CONSTRUCTION. The pane shows the CURRENT session, which is a rolling
  // 4-hour idle window (SESSION_IDLE_RESET_MS). These rows are stamped now(), so the transcript
  // assertions hold for four hours after a seed and then stop. If the pane renders empty
  // locally, re-run this script; in CI the seed always runs immediately before the tests.
  const chitchatNote = await api("/notes", "POST", token, {
    content: "haha ok chitchat seeded turn",
    title: "Chitchat seed",
  });
  await restPatch("notes", `id=eq.${chitchatNote.id}`, { source_type: "chitchat" });

  const [chatSession] = await restInsert("chat_sessions", [{ user_id: userId }]);
  await restInsert("chat_messages", [
    { user_id: userId, session_id: chatSession.id, role: "user",
      content: "haha ok chitchat seeded turn" },
    // citations stays EMPTY on purpose: a seeded turn carrying note citations would render a
    // second "Từ notes của bạn" heading on the home page, and assistant-box.spec.ts's grounding
    // test matches that heading by role and name.
    { user_id: userId, session_id: chatSession.id, role: "assistant",
      content: "Hehe, seeded assistant reply.", citations: [] },
  ]);
  notes.chitchat = chitchatNote;
```

`seedCorpus` currently takes only `token`; it needs the user id for these rows. Change its signature to `seedCorpus(token, userId)` and its one call site in `main()` to `await seedCorpus(session.access_token, session.user.id)`.

- [ ] **Step 9: Write the failing E2E**

Add to `apps/web/e2e/assistant-box.spec.ts`:

```ts
/**
 * Stage C4: the pane and the sidebar read DIFFERENT TABLES, and this is the assertion that
 * says so. Both halves matter and neither implies the other:
 *
 *   - the seeded assistant reply exists only in chat_messages, so it can only appear if the
 *     pane reads that table (before C4 the pane was derived from `notes` and this text was
 *     nowhere on the page);
 *   - the seeded chitchat note exists only in `notes`, and must NOT be in the sidebar list --
 *     if applyNoteFilters loses its clause, this is where it shows.
 *
 * The seeded conversation is timestamped at seed time and the pane shows a rolling 4-hour
 * session; re-run `node e2e/scripts/seed.mjs` if this goes red with an empty pane.
 */
test("the transcript reads the conversation, and the list does not show chitchat", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Hehe, seeded assistant reply.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("haha ok chitchat seeded turn")).toBeVisible();

  // The sidebar's note list, scoped so the pane's copy of the same text cannot satisfy it.
  await expect(
    page.locator("ul.notes").getByText("Chitchat seed", { exact: false }),
  ).toHaveCount(0);
  // Not vacuous: the list is rendering other notes.
  await expect(page.locator("ul.notes li").first()).toBeVisible();
});
```

Confirm the sidebar's list selector against `apps/web/src/app/sidebar.tsx` and `note-list.tsx:117` (`<ul className="notes">`) before running — if the markup differs, fix the selector, not the assertion.

- [ ] **Step 10: Run the E2E**

```bash
node e2e/scripts/seed.mjs --reset
pnpm turbo run test:e2e --filter=@cortex/web
```

(Use the repo's existing E2E command — check `apps/web/package.json` and `.github/workflows/e2e-web.yml` for the exact invocation and the env it needs.)

Expected: PASS, including the pre-existing grounding and capture specs.

- [ ] **Step 11: Run every web gate**

```bash
pnpm turbo run lint typecheck test --filter=@cortex/web
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/app/ e2e/scripts/seed.mjs apps/web/e2e/assistant-box.spec.ts
git commit -m "feat(web): read the transcript from chat_messages, not from the note list"
```

---

### Task 8: Full verification and PR

**Files:** none.

- [ ] **Step 1: Run every gate**

```bash
pnpm turbo run lint typecheck test build
```

Expected: PASS. **Read the `Cached:` line in turbo's summary.** `26/26 successful` can be 23 cache replays and 3 real runs; with Docker down the database-backed suites replay a previous green without executing. A gate that did not run did not pass.

- [ ] **Step 2: Confirm the database suites actually executed**

```bash
docker ps
pnpm turbo run test --filter=@cortex/db --filter=@cortex/api --force
```

`--force` bypasses the cache. Expected: real execution, PASS, including `enum-parity` and `search-notes`.

- [ ] **Step 3: Confirm the migrations are applied in order and nothing was renumbered**

```bash
git diff --name-only --diff-filter=A main -- supabase/migrations/
```

Expected: exactly `00030_note_source_type_chitchat.sql` and `00031_search_notes_exclude_chitchat.sql`. If C5 or another branch has taken either number, renumber **this** branch's files upward — never rewrite a number that has already been pushed.

- [ ] **Step 4: Confirm no new suite is invisible to CI**

```bash
git diff --name-only --diff-filter=A main -- '*.test.ts' '*.test.tsx' '*.spec.ts'
```

Expected: `packages/shared/src/assistant/session.test.ts` and nothing else new. `@cortex/shared` is already named in `ci.yml`'s `checks` job, so no workflow change is needed. If any other file appears, check it lands in a package that job runs — a suite CI does not name runs nowhere but the author's machine.

- [ ] **Step 5: Check the whole thing by hand, once**

`pnpm dev`, then in the browser: type "hello", then "hôm nay tôi chạy bộ", then "haha ok", then a question. Confirm the thread accumulates all four turns with replies; reload and confirm it comes back; confirm the sidebar shows the run and the question but neither piece of small talk; switch to `/?view=archived` and confirm the **thread is unchanged** — that is the split, and it is the one thing no test in this plan asserts through a real browser against a real API.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "Stage C4: the transcript, and a third kind of turn" --body "…"
```

The body must state, in the author's own words: what C4 does; that the spec's §1 was stale and how (the pane existed and was fed by the sidebar's query — the requirement's warning was correct); that session resolution landed in `@cortex/shared` rather than `@cortex/core` because `apps/web` cannot import core; that **retrieving a chitchat note is impossible by design** (§5.3) and the reversal, if it turns out wrong, is to down-weight rather than exclude; and that scrollback across sessions and chat history on mobile are both out and unassigned.

- [ ] **Step 7: Watch CI, including the checks that block**

A required check is a **literal job name**. If every visible check is green and the PR still reads BLOCKED, branch protection is requiring a job name that no longer exists — see `docs/ci.md`. The blocking check renders nowhere in the UI.

---

## Self-Review

**Spec coverage.** §2's "in" column → Tasks 1–7; its "out" column is named in Global Constraints and asserted nowhere, which is correct for a list of things not built. §3.1 → Task 7 steps 3, 4 and 7 (one query scoped by `session_id`, ordered by `created_at`, RLS as the isolation layer; `incomplete` rendered as interrupted; citations through the same component the live box uses). §3.2 → Task 1, relocated to `@cortex/shared` for the reason recorded in **Spec corrections**. §3.3 → Task 7's `done` hand-off and its "shows a finished turn exactly once" test. §4.1–§4.2 → Task 2 (the schema, the prompt rule, `CLASSIFY_MODEL` via Task 4's untouched `model` line, and the `statement` default as a comparison). §4.3 → nothing to build: `assistant-box.tsx` already creates the note first, awaited, before the assistant is called; Task 2 step 4's prompt wording protects the property from the classifier's side. §5.1 → Task 3. §5.2's four appliers → Tasks 5 (1, 2, 3) and 6 (4). §5.3 → Task 6, including the exclude-not-down-weight reasoning in the migration header. §6 → nothing is built; both "not doing" items are enforced by absence and named in Global Constraints. §7's eleven test rows → all covered: rows 1–2 in Task 5 step 1, row 3 in Task 5 step 1 (`matchesFilters` eviction), rows 4–5 in Task 6, rows 6–7 in Task 7 (the E2E's two halves and `resolveCurrentSession`'s staleness test), row 8 in Task 1, row 9 in Task 7, rows 10–11 in Tasks 4 and 2.

**The one row whose test is weaker than the spec implies.** §7's "the pane and the turn pick the same session — turns red when the session logic is copied instead of shared". No test can catch a *correct* copy; Task 1 step 8 says so in the test's own comment and asserts the outcome instead. The real guard is structural: the arithmetic no longer exists in `turn.ts`.

**Placeholders.** Three remain and each names the file to read instead: `extract.test.ts`'s existing `extractNote` setup (Task 2 step 1), `filters-equivalence.test.ts`'s both-engines helper (Task 5 step 7), and the E2E command in `apps/web/package.json` (Task 7 step 10). Reproducing any of them would mean shipping a second near-copy of a helper this repo deliberately has one of — which is the failure those steps exist to prevent. `turn.test.ts`'s doubles are **not** among them: Tasks 1 and 4 name `ai(value)`, the `inserted`/`updated` records and the `seenArgs`-style recorder array exactly as the file already defines them.

**Type consistency.** `resolveCurrentSession(last, now)` takes a snake_case row and returns `string | null`, and is called with exactly that shape in Task 1 step 6 (`turn.ts`) and Task 7 step 7 (`page.tsx`). `TranscriptTurn` is declared once in `assistant-box.tsx` (Task 7 step 4) and imported by `page.tsx` (step 7) and the tests (step 1); its `citations` field is `AnyCitation[]` in all three, produced by `readCitation` (stage C3, `@cortex/shared`) and consumed by `Provenance` (step 3). `INTENTS`/`Intent` are declared in `extract.ts` (Task 2) and never re-declared; `turn.ts` branches on the string literals rather than importing the type. `matchesFilters`'s `source_type` is required in the signature (Task 5 step 4), in `NoteRow` (step 8) and in every test fixture (step 1). The migration numbers are `00030` and `00031` in the file names, the Global Constraints, the File Structure and Task 8 step 3.
