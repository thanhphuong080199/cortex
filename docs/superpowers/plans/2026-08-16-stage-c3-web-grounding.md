# Stage C3 — Web Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant box can search the web when the user's notes cannot answer a question, shows web sources as visibly distinct from note sources, and bills each grounded turn against the existing spending circuit breaker.

**Architecture:** One optional flag threads from `runTurn` down to the Gemini request body, where it adds `tools: [{ google_search: {} }]`. Grounding metadata is captured off the SSE stream in the same closure and at the same point `usageMetadata` already is, and exposed through a function (not a promise) so an aborted stream still reports what it saw. A new `web` SSE event carries the result to the clients; a discriminated `citations` array carries it to the database.

**Tech Stack:** TypeScript, pnpm/Turborepo, NestJS (`apps/api`), Next.js App Router (`apps/web`), Expo/React Native (`apps/mobile`), Supabase Postgres, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-stage-c3-web-grounding-design.md`

## Global Constraints

- **Run package tests through turbo, never through the package directly.** `pnpm turbo run test --filter=@cortex/core` — not `pnpm --filter @cortex/core test`. `@cortex/shared` and `@cortex/core` resolve as compiled `dist/`, so the direct form tests stale output.
- **No test may ever call the real Gemini API.** Use `createFakeAi` (`packages/core/src/ai/fake.ts`). `gemini.ts`'s HTTP shape stays untested — `gemini.test.ts:4-6` records why ("a mocked-fetch test would only assert the mock"). Anything in `gemini.ts` that can be wrong is therefore extracted as an exported pure function and tested directly, the way `extractVectors`, `normalizeEmbedding` and `parseModelJson` already are. **This shapes Tasks 2 and 3 and is not optional.**
- **No note content, chat text, or model output in any log line or error message.** Master spec §15.6 rule 1. `gemini.ts:147-149` is the precedent: report a length, never the payload.
- **Never print a line of `apps/api/.env`.** If a connection string must be redacted, split on the **last** `@`, not the first — a `[^@]+@` mask leaks a password containing `@` and has already cost two credential rotations.
- **New test suites must be named in CI.** `.github/workflows/ci.yml`'s `checks` job filters per package; a suite in a package that job does not run executes nowhere but the author's machine. Every test in this plan lands in an **existing** file in an **already-covered** package, so no CI change is required — verify this holds if you add a file.
- **`enum-parity.test.ts` asserts ordered equality** (`toEqual`) between the zod enum and the live SQL CHECK. A new value must be appended in the **same position** on both sides.
- **Migration number: `00029`.** The latest in `supabase/migrations/` is `00028_usage_by_source.sql`. If stage C4 is built first it takes `00030`; do not renumber.
- `GROUNDING_USD_PER_QUERY = 0.014` — $14 per 1,000 queries, the figure verified against Google's pricing on 2026-08-01 and recorded in life-domains spec §8.

---

## File Structure

**Created:**
- `supabase/migrations/00029_usage_kind_grounding.sql` — adds `'grounding'` to `usage_ledger`'s kind CHECK.

**Modified:**
- `packages/core/src/enrich/extract.ts:83` — the media-kind prompt line (Task 1).
- `packages/shared/src/enums.ts` — `usageLedgerKind` gains `'grounding'`; `GROUNDING_USD_PER_QUERY` added (Tasks 1, 6).
- `packages/shared/src/dto/assistant.ts` — `Citation` gains `type: "note"`; `WebCitation`, `AnyCitation`, `WebSource`, `readCitation` added (Task 4).
- `packages/core/src/ai/client.ts` — `generateStream` gains `grounding?`; `StreamResult` gains `grounding?()`; `GroundingResult` declared (Tasks 2, 3).
- `packages/core/src/ai/gemini.ts` — `buildStreamBody` and `extractGrounding` exported as pure functions and wired in (Tasks 2, 3).
- `packages/core/src/ai/gemini.test.ts` — tests for both pure functions (Tasks 2, 3).
- `packages/core/src/assistant/retrieve.ts` — `Citation` gains `type: "note"`, set where citations are built (Task 4).
- `packages/core/src/assistant/prompts.ts` — `buildAnswerPrompt` gains the §6.1 policy (Task 5).
- `packages/core/src/assistant/turn.ts` — `grounding: isQuestion`; capture in the existing `finally`; the `web` event; mixed citations persisted; the ledger row (Tasks 5, 6).
- `packages/core/src/assistant/turn.test.ts` — the turn-level tests (Tasks 5, 6).
- `packages/core/src/enrich/budget.ts` — `kind` widens; `costUsd` override (Task 6).
- `packages/db/src/test/enum-parity.test.ts` — no edit needed; it reads `usageLedgerKind` (Task 6 verifies).
- `apps/web/src/app/assistant-box.tsx` + `globals.css` — the two-block split and the entry point (Task 7).
- `apps/mobile/src/lib/assistant/stream.ts` + `apps/mobile/src/screens/assistant-box.tsx` — web citations and native chips (Task 8).
- Four spec documents — the documentation corrections (Task 1).

---

### Task 1: The cleanups (spec §10)

One code fix and four documentation corrections. First, because none of it touches grounding and leaving it entangled with C3's diff makes both harder to review.

**Files:**
- Modify: `packages/core/src/enrich/extract.ts:82-83`
- Modify: `docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md` (§5.2, §15.4, §5)
- Modify: `docs/superpowers/specs/2026-08-01-life-domains-web-search-design.md` (§9 risk table)
- Test: `packages/core/src/enrich/extract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

The bug: `extract.ts:83` offers the model `"show"` and `"album"`, which `mediaKind` rejects, so `domainMetaSchemas.media.safeParse` fails at `extract.ts:242-246`, `meta` falls back to `{}`, and `turn.ts:177-185` has no `pending_item` to resolve a media link from. It never offers `"tv"` or `"podcast"`, which are valid.

Add to `packages/core/src/enrich/extract.test.ts`:

```ts
import { mediaKind } from "@cortex/shared";
import { buildPrompt } from "./extract.js";

describe("the media prompt and the mediaKind enum", () => {
  // The prompt is the only place the model learns what kinds exist. Offering it a value the
  // strict parse then rejects silently costs the note its domain_meta AND its media link --
  // and the prompt and the enum are in different packages, so nothing else notices.
  it("offers exactly the kinds mediaKind accepts", () => {
    const line = buildPrompt("bất kỳ", []).split("\n").find((l) => l.includes("pending_item"));
    expect(line, "the pending_item instruction line").toBeDefined();

    const offered = [...line!.matchAll(/"([a-z_]+)"(?=\s*[|,])/g)].map((m) => m[1]!);
    expect(offered.length, "no quoted kinds parsed out of the prompt line").toBeGreaterThan(0);
    expect(new Set(offered)).toEqual(new Set(mediaKind.options));
  });
});
```

The regex reads the kinds out of the `{"kind": "a"|"b"|...}` fragment. If the prompt's wording changes the assertion on `offered.length` fails loudly rather than passing on an empty set.

- [ ] **Step 2: Export `buildPrompt` so the test can reach it**

`buildPrompt` is currently module-private (`extract.ts:69`). Change `function buildPrompt(` to `export function buildPrompt(`. Add above it:

```ts
/**
 * Exported for extract.test.ts only. The media-kind line has to be assertable against
 * `mediaKind`: the two live in different packages, drift is not a type error, and the
 * symptom is a silently empty domain_meta rather than anything that throws.
 */
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core -- extract`
Expected: FAIL — the offered set contains `show` and `album` and is missing `tv` and `podcast`.

- [ ] **Step 4: Fix the prompt line**

`packages/core/src/enrich/extract.ts`, replace lines 82-83:

```ts
    "- when domain is \"media\", domain_meta.pending_item is REQUIRED and looks like",
    "  {\"kind\": " + mediaKind.options.map((k) => `"${k}"`).join("|") +
      ", \"title\": \"...\", \"year\": 2010}.",
```

and extend the import on line 2:

```ts
import { domainMetaSchemas, mediaKind, noteDomain } from "@cortex/shared";
```

Derived from the enum rather than restated, for the reason `noteDomain.options.join(", ")` on line 80 is already derived: a hand-written list is a list that drifts.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/core -- extract`
Expected: PASS.

- [ ] **Step 6: Master design §5.2 — remove the C2 conditional**

In `docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md`, find the sentence in §5.2 (~line 214): *"This is the stage C2 design; until it ships, mobile capture is the same first two steps without the assistant"* and delete it. C2 merged as PR #17; the sentence describes a state that no longer exists.

- [ ] **Step 7: Master design §15.4 — correct the false claim about `notes.sensitive`**

§15.4 states `notes.sensitive` was "implemented in phase 2". No such column exists in any file under `supabase/migrations/`, and nothing in `packages/` references one. Replace the claim with:

```markdown
`notes.sensitive` is **designed but not built.** It is the control that would keep a note out
of web-search grounding, and grounding shipped in stage C3 without it — see that stage's spec
§11, which records the gap as its largest knowingly-unfinished item. Earlier revisions of this
section claimed the column was implemented in phase 2; it was not, and the claim is corrected
here rather than deleted so the error is visible to anyone who read it.
```

- [ ] **Step 8: Master design §5 — disclose Google's 30-day grounding retention**

Add to the tester-disclosure list in §5:

```markdown
- When the assistant searches the web (stage C3, Gemini Grounding with Google Search), Google
  retains the prompt, the contextual information sent with it, and the output for **30 days**
  in order to produce Grounded Results and Search Suggestions. This is separate from the
  paid-tier guarantee that content is not used for training, and it applies only to turns the
  model chose to ground.
```

- [ ] **Step 9: Life-domains §9 — close the stale risk row**

In `docs/superpowers/specs/2026-08-01-life-domains-web-search-design.md` §9, the row reading *"Gemini grounding + function calling can't be mixed in one request"* has the mitigation *"verify at phase-3 implementation"*. Replace the mitigation cell with:

```
CLOSED 2026-08-16: verified that Gemini 3 supports combining `google_search` with function
calling. No change to C3 — retrieval stays injected context by choice (C3 spec §11), not by
constraint.
```

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/enrich/extract.ts packages/core/src/enrich/extract.test.ts docs/superpowers/specs/
git commit -m "fix(enrich): offer the model only media kinds mediaKind accepts"
```

---

### Task 2: Declare the `google_search` tool

**Files:**
- Modify: `packages/core/src/ai/client.ts:19-23`
- Modify: `packages/core/src/ai/gemini.ts:105-117`
- Test: `packages/core/src/ai/gemini.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AiClient.generateStream(args: { prompt: string; model: string; signal?: AbortSignal; grounding?: boolean }): Promise<StreamResult>`
  - `export function buildStreamBody(args: { prompt: string; grounding?: boolean }): Record<string, unknown>` in `gemini.ts`

- [ ] **Step 1: Write the failing test**

The request body cannot be asserted through `fetch` — this repo does not mock it (see Global Constraints). So the body-building becomes a pure function and the test asserts that.

Add to `packages/core/src/ai/gemini.test.ts`:

```ts
import { buildStreamBody } from "./gemini.js";

describe("buildStreamBody", () => {
  it("sends no tools when grounding is off", () => {
    expect(buildStreamBody({ prompt: "xin chào" })).toEqual({
      contents: [{ parts: [{ text: "xin chào" }] }],
    });
  });

  it("omits tools when grounding is explicitly false", () => {
    expect(buildStreamBody({ prompt: "xin chào", grounding: false })).not.toHaveProperty("tools");
  });

  // The tool name is `google_search` and Gemini rejects any other spelling with a 400. Pinned
  // as a literal because a typo here fails only against the live API, which no test calls.
  it("declares the google_search tool when grounding is on", () => {
    expect(buildStreamBody({ prompt: "phim Dune 3 ra khi nào", grounding: true })).toEqual({
      contents: [{ parts: [{ text: "phim Dune 3 ra khi nào" }] }],
      tools: [{ google_search: {} }],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core -- gemini`
Expected: FAIL — `buildStreamBody` is not exported from `./gemini.js`.

- [ ] **Step 3: Add the function and use it**

In `packages/core/src/ai/gemini.ts`, above `openStream`:

```ts
/**
 * The streaming request body, as a pure function so it can be asserted without a mocked fetch
 * -- the same reason extractVectors and parseModelJson are exported. `google_search` is
 * Gemini's built-in grounding tool (life-domains spec §6.1); the model decides per turn whether
 * to use it, so declaring the tool is a permission, not an instruction.
 */
export function buildStreamBody(
  args: { prompt: string; grounding?: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = { contents: [{ parts: [{ text: args.prompt }] }] };
  // Spread-if rather than assigning undefined: `tools: undefined` survives into JSON.stringify
  // as an absent key here, but the shape a test compares against would still differ.
  if (args.grounding) body.tools = [{ google_search: {} }];
  return body;
}
```

Change `openStream`'s signature and body (lines 105-117):

```ts
async function openStream(
  apiKey: string,
  args: { prompt: string; model: string; signal?: AbortSignal; grounding?: boolean },
): Promise<StreamResult> {
  const res = await fetch(
    `${BASE}/models/${args.model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(buildStreamBody(args)),
      signal: args.signal,
    },
  );
```

- [ ] **Step 4: Widen the interface**

In `packages/core/src/ai/client.ts`, replace line 22:

```ts
  /**
   * `grounding` declares Gemini's built-in `google_search` tool for this call. Optional and
   * defaulting to off: an implementation that never grounds should not have to say so, and the
   * acknowledge path in turn.ts must never pass it (spec §2 -- searching the web to acknowledge
   * a private sentence spends money and privacy for nothing).
   */
  generateStream(args: {
    prompt: string; model: string; signal?: AbortSignal; grounding?: boolean;
  }): Promise<StreamResult>;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/core -- gemini`
Expected: PASS, 3 new tests.

- [ ] **Step 6: Verify nothing else broke**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS. The new field is optional, so every existing `createFakeAi({ generateStream })` still typechecks.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/ai/client.ts packages/core/src/ai/gemini.ts packages/core/src/ai/gemini.test.ts
git commit -m "feat(ai): allow generateStream to declare the google_search tool"
```

---

### Task 3: Parse `groundingMetadata` off the stream

**Files:**
- Modify: `packages/core/src/ai/client.ts` (add `WebSource`, `GroundingResult`, `StreamResult.grounding`)
- Modify: `packages/core/src/ai/gemini.ts:130-164`
- Test: `packages/core/src/ai/gemini.test.ts`

**Interfaces:**
- Consumes: `buildStreamBody` (Task 2) — not called here, but the same file.
- Produces:
  - `export interface WebSource { url: string; title: string }`
  - `export interface GroundingResult { sources: WebSource[]; queries: string[]; entryPoint?: string }`
  - `StreamResult.grounding?: () => GroundingResult | null`
  - `export function extractGrounding(obj: Record<string, unknown>): GroundingResult | null` in `gemini.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/ai/gemini.test.ts`:

```ts
import { extractGrounding } from "./gemini.js";

describe("extractGrounding", () => {
  it("returns null for a chunk with no grounding metadata", () => {
    expect(extractGrounding({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })).toBeNull();
    expect(extractGrounding({})).toBeNull();
  });

  it("reads sources and queries out of groundingMetadata", () => {
    const out = extractGrounding({
      candidates: [{
        groundingMetadata: {
          webSearchQueries: ["Dune Part Three release date"],
          groundingChunks: [
            { web: { uri: "https://example.com/a", title: "example.com" } },
            { web: { uri: "https://example.org/b", title: "example.org" } },
          ],
          searchEntryPoint: { renderedContent: "<div class=\"container\">chips</div>" },
        },
      }],
    });
    expect(out).toEqual({
      sources: [
        { url: "https://example.com/a", title: "example.com" },
        { url: "https://example.org/b", title: "example.org" },
      ],
      queries: ["Dune Part Three release date"],
      entryPoint: "<div class=\"container\">chips</div>",
    });
  });

  // A grounded turn where the model searched and every chunk was unusable is still a BILLED
  // turn (turn.ts fires the ledger row on queries, not on sources -- see Task 6), so this must
  // not collapse to null.
  it("returns queries with an empty source list rather than null", () => {
    expect(extractGrounding({
      candidates: [{ groundingMetadata: { webSearchQueries: ["gì đó"] } }],
    })).toEqual({ sources: [], queries: ["gì đó"] });
  });

  // groundingChunks can carry non-web entries (retrieved context); those have no `web` key and
  // must be dropped rather than becoming {url: undefined}.
  it("drops grounding chunks that carry no web entry", () => {
    const out = extractGrounding({
      candidates: [{
        groundingMetadata: {
          groundingChunks: [{ retrievedContext: { title: "x" } }, { web: { uri: "https://a", title: "a" } }],
        },
      }],
    });
    expect(out!.sources).toEqual([{ url: "https://a", title: "a" }]);
  });

  // A source with no usable URL is not a source. Rendering it produces a dead link presented
  // as provenance, which is worse than showing one fewer citation.
  it("drops a web chunk with no uri", () => {
    const out = extractGrounding({
      candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: "no link" } }] } }],
    });
    expect(out!.sources).toEqual([]);
  });

  // The title is what the UI renders. Falling back to the URL beats rendering an empty <a>.
  it("falls back to the url when a web chunk has no title", () => {
    const out = extractGrounding({
      candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: "https://a.example" } }] } }],
    });
    expect(out!.sources).toEqual([{ url: "https://a.example", title: "https://a.example" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core -- gemini`
Expected: FAIL — `extractGrounding` is not exported.

- [ ] **Step 3: Add the types**

In `packages/core/src/ai/client.ts`, after `StreamUsage`:

```ts
export interface WebSource {
  url: string;
  title: string;
}

/**
 * What Gemini reported about a grounded turn. `groundingSupports` -- the span-level mapping
 * from answer text back to individual chunks -- is deliberately NOT carried: spec §6.2 asks
 * for a visible notes/web split, not inline attribution, and the answer streams into a element
 * with no span structure to attach it to.
 */
export interface GroundingResult {
  sources: WebSource[];
  queries: string[];
  /** Google's Search Suggestions markup (HTML+CSS). Rendered by web, ignored by mobile. */
  entryPoint?: string;
}
```

and inside `StreamResult`, after `usage`:

```ts
  /**
   * What the model searched, or null if it did not search (or the field was never reported).
   *
   * A FUNCTION for exactly the reason `usage` above is one: grounding metadata arrives in a
   * late chunk, so a caller that aborts mid-stream would never see a promise resolve -- and an
   * aborted answer has still been searched and still been billed.
   *
   * OPTIONAL, unlike `usage`: an AiClient implementation that never grounds should not have to
   * stub it, and every existing test fake predates it. `stream.grounding?.() ?? null` at the
   * call site reads the same either way.
   */
  grounding?: () => GroundingResult | null;
```

- [ ] **Step 4: Add `extractGrounding` and wire it in**

In `packages/core/src/ai/gemini.ts`, above `openStream`:

```ts
/**
 * Pulls the grounding report out of one parsed SSE payload, or null if this chunk carried none.
 *
 * Pure and exported for the same reason buildStreamBody is: gemini.ts's HTTP shape is untested
 * by design, so anything here that can be wrong has to be reachable without a fetch.
 */
export function extractGrounding(obj: Record<string, unknown>): GroundingResult | null {
  const candidates = obj.candidates as { groundingMetadata?: Record<string, unknown> }[] | undefined;
  const meta = candidates?.[0]?.groundingMetadata;
  if (!meta) return null;

  const chunks = (meta.groundingChunks ?? []) as { web?: { uri?: string; title?: string } }[];
  const sources: WebSource[] = chunks
    .map((c) => c.web)
    // A chunk with no `web` is a retrieved-context chunk, and a `web` with no `uri` is a
    // citation with nothing to link to. Both are dropped rather than rendered as a dead link
    // presented to the user as provenance.
    .filter((w): w is { uri: string; title?: string } => typeof w?.uri === "string" && w.uri !== "")
    .map((w) => ({ url: w.uri, title: w.title && w.title !== "" ? w.title : w.uri }));

  const queries = ((meta.webSearchQueries ?? []) as unknown[])
    .filter((q): q is string => typeof q === "string");

  const entry = (meta.searchEntryPoint as { renderedContent?: unknown } | undefined)?.renderedContent;

  return {
    sources,
    queries,
    ...(typeof entry === "string" && entry !== "" ? { entryPoint: entry } : {}),
  };
}
```

Add `WebSource` and `GroundingResult` to `gemini.ts`'s import from `./client.js`.

Then, inside `openStream`, beside the existing `usage` closure variable (line 130):

```ts
  let usage: StreamUsage | null = null;
  let grounding: GroundingResult | null = null;
```

and inside `handleEvent`, immediately after the `usageMetadata` block and **before** the `const candidates = ...` / `if (text !== "")` lines:

```ts
    // BEFORE the text branch, not inside it. A chunk can carry grounding metadata and no text
    // at all, and a capture placed inside `if (text !== "")` silently sees nothing on exactly
    // those chunks -- the same failure this file already paid for once with usageMetadata (see
    // the header above openStream). Last one wins: Gemini reports the full accumulated metadata
    // each time rather than a delta.
    const g = extractGrounding(obj);
    if (g) grounding = g;
```

and in the returned object, beside `usage`:

```ts
    grounding: () => grounding,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/core -- gemini`
Expected: PASS.

- [ ] **Step 6: Run the whole package**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS — `grounding` is optional on `StreamResult`, so the existing fakes in `turn.test.ts` still typecheck.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/ai/client.ts packages/core/src/ai/gemini.ts packages/core/src/ai/gemini.test.ts
git commit -m "feat(ai): capture groundingMetadata off the answer stream"
```

---

### Task 4: The wire types — a discriminated citation

**Files:**
- Modify: `packages/shared/src/dto/assistant.ts:44-50`
- Modify: `packages/core/src/assistant/retrieve.ts` (the `Citation` interface and where citations are built)
- Test: `packages/shared/src/dto/assistant.test.ts` (create if absent — `@cortex/shared` is already covered by CI)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Citation` gains `type: "note"`
  - `export interface WebCitation { type: "web"; url: string; title: string }`
  - `export type AnyCitation = Citation | WebCitation`
  - `export function readCitation(raw: unknown): AnyCitation | null`

- [ ] **Step 1: Write the failing test**

The load-bearing behaviour is reading rows written before C3, which have no `type` field at all.

Create `packages/shared/src/dto/assistant.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readCitation } from "./assistant.js";

describe("readCitation", () => {
  // THE BACKWARD-COMPATIBILITY GUARD. Every chat_messages row written before stage C3 has a
  // citations array whose entries carry no `type` key. There is no backfill migration -- the
  // column is jsonb and rewriting a user's conversation history to add a field whose absence
  // already means exactly one thing is not worth the migration. This default is that decision,
  // and it is the only place it exists.
  it("reads a pre-C3 citation, which has no type, as a note", () => {
    expect(readCitation({
      noteId: "n1", title: "Dune", snippet: "…", score: 0.8, matchedBy: "fts",
    })).toEqual({
      type: "note", noteId: "n1", title: "Dune", snippet: "…", score: 0.8, matchedBy: "fts",
    });
  });

  it("reads an explicit note citation unchanged", () => {
    const row = { type: "note", noteId: "n1", title: null, snippet: "s", score: 0.5, matchedBy: "vec" };
    expect(readCitation(row)).toEqual(row);
  });

  it("reads a web citation", () => {
    expect(readCitation({ type: "web", url: "https://a.example", title: "a" }))
      .toEqual({ type: "web", url: "https://a.example", title: "a" });
  });

  // A malformed entry is dropped, not rendered. citations is jsonb with no database-level
  // shape, so a bad row must not take the whole transcript down with it.
  it("returns null for anything it cannot read", () => {
    expect(readCitation(null)).toBeNull();
    expect(readCitation("nope")).toBeNull();
    expect(readCitation({ type: "web" })).toBeNull();          // no url
    expect(readCitation({ title: "no ids at all" })).toBeNull(); // neither noteId nor url
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/shared -- assistant`
Expected: FAIL — `readCitation` is not exported.

- [ ] **Step 3: Write the types and the reader**

In `packages/shared/src/dto/assistant.ts`, replace the `Citation` interface (keeping its existing doc comment, which explains the deliberate duplication in `@cortex/core`) with:

```ts
export interface Citation {
  /**
   * The discriminator, added in stage C3. Rows written before C3 have no `type` at all; read
   * them through `readCitation`, which defaults a missing one to "note". Never widen this to
   * `string`: the whole point is that a reader can switch on it exhaustively.
   */
  type: "note";
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  matchedBy: string;
}

/** A web source Gemini grounded an answer on (life-domains spec §6.2). */
export interface WebCitation {
  type: "web";
  url: string;
  title: string;
}

export type AnyCitation = Citation | WebCitation;

/**
 * Reads one entry out of a persisted `chat_messages.citations` array.
 *
 * `citations` is jsonb and therefore has no shape the database enforces, so this is where the
 * shape is decided: a missing `type` means a pre-C3 row and reads as a note, and anything
 * unreadable is dropped rather than rendered. One bad entry must not cost the user the rest of
 * the transcript.
 */
export function readCitation(raw: unknown): AnyCitation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (r.type === "web") {
    return typeof r.url === "string" && r.url !== ""
      ? { type: "web", url: r.url, title: typeof r.title === "string" ? r.title : r.url }
      : null;
  }
  if (typeof r.noteId !== "string") return null;
  return {
    type: "note",
    noteId: r.noteId,
    title: typeof r.title === "string" ? r.title : null,
    snippet: typeof r.snippet === "string" ? r.snippet : "",
    score: typeof r.score === "number" ? r.score : 0,
    matchedBy: typeof r.matchedBy === "string" ? r.matchedBy : "",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/shared -- assistant`
Expected: PASS, 6 assertions.

- [ ] **Step 5: Give `@cortex/core`'s own `Citation` the same discriminator**

`packages/core/src/assistant/retrieve.ts` declares a structurally identical `Citation` that is deliberately not import-linked (the reason is in `dto/assistant.ts`'s doc comment: `apps/web` depends on `@cortex/shared` only). Add `type: "note";` as its first field, and set it where citations are built so `turn.ts` needs no mapping:

```ts
export interface Citation {
  /** Matches @cortex/shared's Citation. Set at construction so nothing downstream maps. */
  type: "note";
  noteId: string;
  // …unchanged
}
```

Then in the object literal(s) that build a `Citation` inside `retrieve()`, add `type: "note" as const,` as the first property. Run `pnpm turbo run build --filter=@cortex/core` and let TypeScript find any construction site you missed — it will error on each.

- [ ] **Step 6: Run both packages**

Run: `pnpm turbo run test --filter=@cortex/shared --filter=@cortex/core`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/dto/assistant.ts packages/shared/src/dto/assistant.test.ts packages/core/src/assistant/retrieve.ts
git commit -m "feat(shared): discriminate note and web citations"
```

---

### Task 5: The turn — grounding on the answer path, and the `web` event

**Files:**
- Modify: `packages/core/src/assistant/turn.ts:15-23, 233-286`
- Modify: `packages/core/src/assistant/prompts.ts:39-54`
- Test: `packages/core/src/assistant/turn.test.ts`
- Test: `packages/core/src/assistant/prompts.test.ts`

**Interfaces:**
- Consumes: `GroundingResult`, `WebSource`, `StreamResult.grounding` (Task 3); `WebCitation` (Task 4).
- Produces: `AssistantEvent` gains `{ type: "web"; sources: WebSource[]; queries: string[]; entryPoint?: string }`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/assistant/turn.test.ts`. `dbs()`, `collect()` and `createFakeAi` are already in scope in that file; follow the existing tests' setup shape exactly.

```ts
// A scripted stream that reports grounding, for the tests below.
const groundedAi = (g: GroundingResult | null, intent = "question") => createFakeAi({
  generateJson: async () => ({
    value: { intent, complexity: "simple", domain: null, domain_meta: {}, tags: [], mood: null },
    inputTokens: 5, outputTokens: 2, model: "fake-classify",
  }),
  generateStream: async (args) => {
    seenArgs = args;
    return {
      chunks: (async function* () { yield { text: "câu trả lời" }; })(),
      usage: () => ({ inputTokens: 30, outputTokens: 8, model: "fake-answer" }),
      grounding: () => g,
    };
  },
});
let seenArgs: { grounding?: boolean } | undefined;

it("declares grounding on the answer path", async () => {
  const { client } = dbs();
  seenArgs = undefined;
  await collect(runTurn({ userDb: client, serviceDb: client, ai: groundedAi(null) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(seenArgs?.grounding).toBe(true);
});

// The acknowledge branch runs CLASSIFY_MODEL and files a statement. Searching the web to
// acknowledge "hôm nay mình ngủ 5 tiếng" spends money on nothing AND sends a private sentence
// to Google for nothing -- two costs, neither recoverable. Turns red the moment `grounding`
// is passed unconditionally instead of as `isQuestion`.
it("does NOT declare grounding on the acknowledge path", async () => {
  const { client } = dbs();
  seenArgs = undefined;
  await collect(runTurn({ userDb: client, serviceDb: client, ai: groundedAi(null, "statement") },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  expect(seenArgs?.grounding).toBeFalsy();
});

it("emits a web event carrying the sources and the queries", async () => {
  const { client } = dbs();
  const events = await collect(runTurn(
    { userDb: client, serviceDb: client, ai: groundedAi({
        sources: [{ url: "https://a.example", title: "a" }],
        queries: ["Dune 3"], entryPoint: "<div>chips</div>",
      }) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 },
  ));
  expect(events.find((e) => e.type === "web")).toEqual({
    type: "web",
    sources: [{ url: "https://a.example", title: "a" }],
    queries: ["Dune 3"],
    entryPoint: "<div>chips</div>",
  });
});

// "Did this turn search the web" is exactly "did a web event arrive", with no second flag to
// keep in step. An unconditional yield destroys that property: a notes-only turn would emit
// `sources: []` and every client would need to re-check the length.
it("emits no web event at all when nothing was searched", async () => {
  const { client } = dbs();
  const events = await collect(runTurn(
    { userDb: client, serviceDb: client, ai: groundedAi(null) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 },
  ));
  expect(events.some((e) => e.type === "web")).toBe(false);
});

// It cannot ride in `citations` (yielded at turn.ts:222, before generateStream at 249 -- the
// metadata does not exist yet), and it must not arrive after `done`, which is the clients'
// end-of-turn signal.
it("emits web after the last token and before done", async () => {
  const { client } = dbs();
  const events = await collect(runTurn(
    { userDb: client, serviceDb: client, ai: groundedAi({
        sources: [{ url: "https://a.example", title: "a" }], queries: ["q"],
      }) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 },
  ));
  const types = events.map((e) => e.type);
  expect(types.lastIndexOf("token")).toBeLessThan(types.indexOf("web"));
  expect(types.indexOf("web")).toBeLessThan(types.indexOf("done"));
});

it("persists web sources alongside note citations", async () => {
  const { client, inserted } = dbs();
  await collect(runTurn(
    { userDb: client, serviceDb: client, ai: groundedAi({
        sources: [{ url: "https://a.example", title: "a" }], queries: ["q"],
      }) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 },
  ));
  const msg = inserted("chat_messages").find((r) => r.role === "assistant");
  expect(msg!.citations).toContainEqual({ type: "web", url: "https://a.example", title: "a" });
});
```

And add to `packages/core/src/assistant/prompts.test.ts`:

```ts
it("tells the answer prompt when it may search and what it may never claim", () => {
  const p = buildAnswerPrompt({ question: "Dune 3 khi nào?", citations: [], history: [] });
  expect(p).toMatch(/time-sensitive/i);
  expect(p).toMatch(/never present web content as the user's own/i);
});

// The acknowledge branch is not grounded (turn.ts passes `grounding: isQuestion`), so telling
// it about searching would describe a capability it does not have.
it("does not tell the acknowledge prompt about searching", () => {
  const p = buildAcknowledgePrompt({
    note: "hôm nay mình ngủ 5 tiếng", domain: "health", tags: [], related: [], history: [],
  });
  expect(p).not.toMatch(/search/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- assistant`
Expected: FAIL — no `web` event type; `seenArgs.grounding` is `undefined`; the prompt has no search policy.

- [ ] **Step 3: Add the event to the union**

`packages/core/src/assistant/turn.ts`, inside `AssistantEvent` after the `citations` line:

```ts
  | { type: "web"; sources: WebSource[]; queries: string[]; entryPoint?: string }
```

and extend the imports:

```ts
import type { AiClient, GroundingResult, WebSource } from "../ai/client.js";
import type { WebCitation } from "@cortex/shared";
```

- [ ] **Step 4: Capture grounding in the existing `finally`**

Replace `turn.ts:245-261` with:

```ts
  let answer = "";
  let incomplete = false;
  let streamUsage: { inputTokens: number; outputTokens: number; model: string } | null = null;
  let grounding: GroundingResult | null = null;
  try {
    const stream = await ai.generateStream({
      prompt, model, signal: args.signal,
      // The whole enablement decision. Never unconditional: see the acknowledge-path test.
      grounding: isQuestion,
    });
    try {
      for await (const chunk of stream.chunks) {
        answer += chunk.text;
        yield { type: "token", text: chunk.text };
      }
    } finally {
      // Both reads live in the `finally` for the same reason: an aborted answer has still been
      // billed and has still been searched, and neither fact survives if it is only read on the
      // success path.
      streamUsage = stream.usage();
      grounding = stream.grounding?.() ?? null;
    }
  } catch (err) {
    incomplete = true;
    yield { type: "error", message: errorMessage(err).slice(0, 200) };
  }
```

- [ ] **Step 5: Emit the event and merge the citations**

Immediately after that `catch` block, before the `if (streamUsage)` billing block:

```ts
  // `searched` and "has sources" are different facts and are used for different things. Google
  // billed the turn the moment the model issued a query, even if every chunk came back
  // unusable -- so the ledger row (Task 6) keys off `searched`. The EVENT keys off having
  // something to show: emitting `sources: []` would force every client to re-check a length,
  // when "a web event arrived" is otherwise exactly "the box searched".
  const searched = grounding !== null && grounding.queries.length > 0;
  const webCitations: WebCitation[] = (grounding?.sources ?? [])
    .map((s) => ({ type: "web" as const, url: s.url, title: s.title }));

  if (grounding && grounding.sources.length > 0) {
    yield {
      type: "web",
      sources: grounding.sources,
      queries: grounding.queries,
      ...(grounding.entryPoint !== undefined ? { entryPoint: grounding.entryPoint } : {}),
    };
  }
```

and change the `chat_messages` insert at line 278-281:

```ts
  const { data: message } = await userDb.from("chat_messages").insert({
    user_id: args.userId, session_id: sessionId, role: "assistant", content: answer,
    // `citations` already carries `type: "note"` from retrieve.ts, so no mapping happens here.
    citations: [...citations, ...webCitations],
    retrieval_meta: { requestId, incomplete },
  }).select("id").single();
```

- [ ] **Step 6: Add the search policy to the answer prompt**

`packages/core/src/assistant/prompts.ts`, in `buildAnswerPrompt`, replace the line at 48-49 (*"If their notes do not answer the question…"*) with:

```ts
    "If their notes do not answer the question, say so plainly and briefly.",
    // Life-domains spec §6.1, verbatim in intent. The third clause replaces the narrower rule
    // this line used to carry ("do not fill the gap with general knowledge presented as if it
    // came from them"): with grounding, the gap-filler is no longer only the model's memory.
    "You may search the web when their notes cannot answer the question, or when the question " +
      "is time-sensitive. Answer from their notes first.",
    "Never present web content as the user's own thinking. Say where something came from.",
```

Leave `buildAcknowledgePrompt` untouched.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- assistant`
Expected: PASS.

- [ ] **Step 8: Run the whole package**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/assistant/
git commit -m "feat(assistant): ground the answer path and stream web provenance"
```

---

### Task 6: Cost — a ledger row that the circuit breaker can see

**Files:**
- Create: `supabase/migrations/00029_usage_kind_grounding.sql`
- Modify: `packages/shared/src/enums.ts:76` and the price constants
- Modify: `packages/core/src/enrich/budget.ts:29-60`
- Modify: `packages/core/src/assistant/turn.ts` (the new `recordUsage` call)
- Test: `packages/core/src/enrich/budget.test.ts`, `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: `searched` and `grounding` (Task 5).
- Produces: `GROUNDING_USD_PER_QUERY: number`; `recordUsage`'s `kind` widened to include `"grounding"`; `recordUsage` gains `costUsd?: number`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/00029_usage_kind_grounding.sql`:

```sql
-- packages/db's enum-parity test reads usage_ledger_kind_check out of pg_constraint and asserts
-- it matches @cortex/shared's usageLedgerKind exactly, IN ORDER, so these two move together or
-- the suite fails. See the header of packages/shared/src/enums.ts.
--
-- 'grounding' is a Gemini Grounding with Google Search query. It is priced per query rather than
-- per token, so its rows carry 0 input and 0 output tokens and a cost_usd that recordUsage is
-- told rather than computes -- see budget.ts's costUsd override.
alter table public.usage_ledger drop constraint usage_ledger_kind_check;
alter table public.usage_ledger add constraint usage_ledger_kind_check
  check (kind in ('embed','chat','tag','digest','memory','transcribe','grounding'));
```

- [ ] **Step 2: Move the enum with it**

`packages/shared/src/enums.ts` line 76 — append `"grounding"` **last**, matching the SQL order (the parity test compares arrays with `toEqual`):

```ts
export const usageLedgerKind = z.enum([
  "embed", "chat", "tag", "digest", "memory", "transcribe", "grounding",
]);
```

and add below `MODEL_PRICES_USD_PER_MTOK`:

```ts
/**
 * Grounding with Google Search is priced per QUERY, not per token, so it cannot live in
 * MODEL_PRICES_USD_PER_MTOK. $14 per 1,000 queries, verified against Google's pricing page on
 * 2026-08-01 and recorded in the life-domains spec §8.
 *
 * The first 5,000 prompts per month are free and this constant does NOT model that: every
 * grounded turn is charged from the first one, so for a handful of testers the ledger reports
 * spend that was never billed. Wrong in the SAFE direction -- the circuit breaker trips early
 * rather than late -- and tracking a monthly allowance would be a second accounting system for a
 * discount that stops applying the moment this app has real users.
 */
export const GROUNDING_USD_PER_QUERY = 0.014;
```

- [ ] **Step 3: Write the failing tests**

Add to `packages/core/src/enrich/budget.test.ts`:

```ts
// THE ONE THAT MATTERS. recordUsage computes cost_usd from priceUsd(model, in, out), which is
// token-based -- and a grounding row has no tokens of its own (they are already on the `chat`
// row for the same call). Without the override the row lands at cost_usd = 0 and the most
// expensive per-unit thing in the system is free in the ledger. Asserting "a row exists" would
// pass against exactly that bug, so this asserts the VALUE.
it("writes the cost it is given rather than pricing it from tokens", async () => {
  const { db, rows } = fakeDb();
  await recordUsage(db, {
    userId: "u1", kind: "grounding", model: "gemini-3.1-pro-preview",
    inputTokens: 0, outputTokens: 0, source: "assistant",
    costUsd: GROUNDING_USD_PER_QUERY,
  });
  expect(rows[0]!.cost_usd).toBeCloseTo(0.014, 6);
});

it("still prices from tokens when no cost is given", async () => {
  const { db, rows } = fakeDb();
  await recordUsage(db, {
    userId: "u1", kind: "chat", model: "gemini-3.1-pro-preview",
    inputTokens: 1_000_000, outputTokens: 0, source: "assistant",
  });
  expect(rows[0]!.cost_usd).toBeCloseTo(2.0, 6);
});
```

(Use whatever `fakeDb`/insert-capture helper `budget.test.ts` already defines; do not introduce a second one.)

And to `turn.test.ts`:

```ts
it("bills a grounded turn against the assistant budget", async () => {
  const { client, inserted } = dbs();
  await collect(runTurn(
    { userDb: client, serviceDb: client, ai: groundedAi({
        sources: [{ url: "https://a.example", title: "a" }], queries: ["Dune 3"],
      }) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 },
  ));
  const row = inserted("usage_ledger").find((r) => r.kind === "grounding");
  expect(row, "no grounding row was written").toBeDefined();
  expect(row!.cost_usd).toBeCloseTo(GROUNDING_USD_PER_QUERY, 6);
  // `source: 'assistant'` is what makes isOverBudget see it -- that function sums by SOURCE,
  // not by kind, so any other value here means grounding spend never declines a later turn.
  expect(row!.source).toBe("assistant");
});

// The model searched and every chunk came back unusable. Google still billed the query.
it("bills a turn that searched and got no usable sources", async () => {
  const { client, inserted } = dbs();
  await collect(runTurn(
    { userDb: client, serviceDb: client, ai: groundedAi({ sources: [], queries: ["gì đó"] }) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 },
  ));
  expect(inserted("usage_ledger").some((r) => r.kind === "grounding")).toBe(true);
});

it("writes no grounding row when the model did not search", async () => {
  const { client, inserted } = dbs();
  await collect(runTurn(
    { userDb: client, serviceDb: client, ai: groundedAi(null) },
    { userId: "u1", noteId: "n1", budgetUsd: 5 },
  ));
  expect(inserted("usage_ledger").some((r) => r.kind === "grounding")).toBe(false);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- budget assistant`
Expected: FAIL — `costUsd` is not a parameter; `"grounding"` is not an allowed `kind`.

- [ ] **Step 5: Widen `recordUsage`**

`packages/core/src/enrich/budget.ts`, line 33:

```ts
    kind: "embed" | "tag" | "chat" | "grounding";
```

and add to the parameter object after `contentChars`:

```ts
    /**
     * An explicit price, for a call priceUsd cannot compute. Grounding is billed per QUERY, so
     * its row carries 0 tokens and priceUsd would return 0 -- the row would land free and the
     * ledger would under-report the most expensive per-unit thing in the system. Used by that
     * one call site and no other; everything else must keep pricing from tokens, or a caller
     * can quietly set its own bill.
     */
    costUsd?: number;
```

and change line 58:

```ts
    cost_usd: u.costUsd ?? priceUsd(u.model, u.inputTokens, u.outputTokens),
```

- [ ] **Step 6: Write the row in `turn.ts`**

Directly after the existing `if (streamUsage) { … }` billing block:

```ts
  // A SECOND row, not a field on the chat row. Grounding is priced per query while the answer
  // is priced per token, and folding a per-query charge into a per-token row makes both
  // unreadable. `source: 'assistant'` is what puts it inside the existing circuit breaker --
  // isOverBudget sums by source, so no new budget is introduced.
  if (searched) {
    try {
      await recordUsage(serviceDb, {
        userId: args.userId, kind: "grounding", model,
        inputTokens: 0, outputTokens: 0,
        costUsd: GROUNDING_USD_PER_QUERY,
        source: "assistant", noteId: args.noteId, requestId,
        latencyMs: Date.now() - classifyStarted, contentChars: text.length,
      });
    } catch (err) {
      console.error(`[assistant] grounding usage_ledger write failed: ${errorMessage(err)}`);
    }
  }
```

Add `GROUNDING_USD_PER_QUERY` to the `@cortex/shared` import at `turn.ts:3`.

**Note for whoever reads the ledger later:** this writes **one row per grounded turn**, which is the per-*request* reading of Google's pricing. Whether they bill per request or per query in `webSearchQueries` is unverified against a real invoice — C3 spec §11. If an invoice shows per-query, the fix is `costUsd: GROUNDING_USD_PER_QUERY * grounding!.queries.length`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- budget assistant`
Expected: PASS.

- [ ] **Step 8: Apply the migration and run the parity test**

```bash
pnpm supabase db push
pnpm turbo run test --filter=@cortex/db -- enum-parity
```

Expected: PASS, including `usage_ledger.usage_ledger_kind_check matches its zod enum exactly`.

If Docker is not running, `turbo` will replay a **cached** result and report success without executing anything. Read the `Cached:` line in turbo's summary before believing a green gate here — a cache replay is not a run.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/00029_usage_kind_grounding.sql packages/shared/src/enums.ts packages/core/src/enrich/budget.ts packages/core/src/enrich/budget.test.ts packages/core/src/assistant/
git commit -m "feat(budget): bill grounding per query against the assistant budget"
```

---

### Task 7: Web UI — two blocks, and the Search Suggestions entry point

**Files:**
- Modify: `apps/web/src/app/assistant-box.tsx`
- Modify: `apps/web/src/app/globals.css` (or wherever `.citations` is styled)
- Test: `apps/web/e2e/` — add to the existing assistant spec

**Interfaces:**
- Consumes: the `web` SSE event (Task 5); `Citation`, `WebCitation` from `@cortex/shared` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Write the failing E2E assertion**

Find the existing assistant E2E spec under `apps/web/e2e/` and add a case that stubs `POST /assistant` with an SSE body containing a `web` event, then asserts the split. Follow the stubbing shape the existing assistant spec already uses — do not invent a second one.

```ts
test("shows web sources in their own block, separate from note citations", async ({ page }) => {
  // …existing route-stub setup, with the SSE body ending:
  //   event: citations\ndata: {"citations":[{"type":"note","noteId":"n1","title":"Dune", …}]}\n\n
  //   event: token\ndata: {"text":"…"}\n\n
  //   event: web\ndata: {"sources":[{"url":"https://a.example","title":"a"}],"queries":["Dune 3"]}\n\n
  //   event: done\ndata: {"messageId":"m1","sessionId":"s1"}\n\n
  await expect(page.getByRole("heading", { name: "Từ notes của bạn" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Từ web" })).toBeVisible();
  await expect(page.getByRole("link", { name: "a" })).toHaveAttribute("href", "https://a.example");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run e2e --filter=web` (or the repo's existing E2E command — check `apps/web/package.json`)
Expected: FAIL — neither heading exists.

- [ ] **Step 3: Handle the event and render the split**

In `apps/web/src/app/assistant-box.tsx`:

```ts
import { readEvents, type Citation, type WebCitation } from "@cortex/shared";

type Web = { sources: WebCitation[]; queries: string[]; entryPoint?: string };
```

Add state beside `citations`, and clear it in `submit()` alongside the others:

```ts
const [web, setWeb] = useState<Web | null>(null);
```

Add the branch in the event loop, after the `citations` branch:

```ts
} else if (ev.type === "web") {
  const d = ev.data as { sources?: unknown; queries?: unknown; entryPoint?: unknown };
  setWeb({
    sources: (Array.isArray(d.sources) ? d.sources : []) as WebCitation[],
    queries: (Array.isArray(d.queries) ? d.queries : []) as string[],
    ...(typeof d.entryPoint === "string" ? { entryPoint: d.entryPoint } : {}),
  });
}
```

Replace the `citations.length > 0 && …` block with the two-block render:

```tsx
{citations.length > 0 && (
  <section className="provenance">
    <h3>Từ notes của bạn</h3>
    <ul className="citations">
      {citations.map((c) => <li key={c.noteId}>{c.title ?? "Untitled"}</li>)}
    </ul>
  </section>
)}

{web && web.sources.length > 0 && (
  <section className="provenance web">
    <h3>Từ web</h3>
    <ul className="citations">
      {web.sources.map((s) => (
        <li key={s.url}>
          {/* rel="noopener noreferrer": these are URLs the model chose, not ones we vetted. */}
          <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
        </li>
      ))}
    </ul>
  </section>
)}
```

The two blocks are never merged into one list — life-domains spec §6.2 requires the visible split, and merging them is exactly the regression this task's test exists to catch.

- [ ] **Step 4: Render the Search Suggestions entry point**

Below the web block, still inside the `web &&` guard:

```tsx
{web.entryPoint && (
  // Google's own markup, rendered because Google's terms require the returned Search
  // Suggestions entry point to be displayed when grounding is used (life-domains §6.2). It is
  // HTML+CSS produced by Google for exactly this, which is why it is injected rather than
  // rebuilt -- the compliant path, and free on web.
  //
  // The source is the Gemini API response relayed by our own API, not user input and not a
  // third-party page. If that ever stops being true, this line is the thing to revisit.
  <div className="search-suggestions" dangerouslySetInnerHTML={{ __html: web.entryPoint }} />
)}
```

Add minimal styling for `.provenance h3` (small, uppercase, muted) and a globe marker on `.provenance.web li`, matching whatever the existing `.citations` rule does.

- [ ] **Step 5: Run the E2E to verify it passes**

Run: `pnpm turbo run e2e --filter=web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/assistant-box.tsx apps/web/src/app/globals.css apps/web/e2e/
git commit -m "feat(web): split note and web provenance, render Search Suggestions"
```

---

### Task 8: Mobile UI — native web citations and reconstructed suggestion chips

**Files:**
- Modify: `apps/mobile/src/lib/assistant/stream.ts:12-20, 59-94`
- Modify: `apps/mobile/src/screens/assistant-box.tsx`
- Test: `apps/mobile/src/lib/assistant/stream.test.ts`

**Interfaces:**
- Consumes: the `web` SSE event (Task 5).
- Produces: `BoxEvent` gains `{ type: "web"; sources: WebCitation[]; queries: string[] }`.

**Read before starting:** C3 spec §7.2. Mobile does **not** render `entryPoint` — `apps/mobile/package.json` has no `react-native-webview` and React Native cannot render HTML without one. Chips are rebuilt from `queries`. This is a knowingly-accepted ToS judgment call made by the project owner on 2026-08-16, with a recorded condition for revisiting. Do not "fix" it by adding a WebView dependency, and do not quietly drop the feature.

- [ ] **Step 1: Write the failing test**

`stream.ts` is a logic file precisely so it can be tested — `apps/mobile`'s vitest project runs `environment: node` and anything reaching React Native fails as a Rollup Flow parse error, which is why `.tsx` files here carry no logic. Add to `apps/mobile/src/lib/assistant/stream.test.ts`, following the existing tests' fake-`Response` shape:

```ts
it("yields a web event with its sources and queries", async () => {
  const body = sse([
    ["token", { text: "ừ" }],
    ["web", { sources: [{ type: "web", url: "https://a.example", title: "a" }], queries: ["Dune 3"] }],
    ["done", { messageId: "m1", sessionId: "s1" }],
  ]);
  const events = await collect(streamTurn(/* …existing args… */, body));
  expect(events).toContainEqual({
    type: "web",
    sources: [{ type: "web", url: "https://a.example", title: "a" }],
    queries: ["Dune 3"],
  });
});

// The default: break at stream.ts:92 already documents that the server is deployed
// independently of the APK. This pins it, so adding a `throw` there later fails here rather
// than in a user's hands.
it("drops an event type this build does not know", async () => {
  const body = sse([["some_future_event", { x: 1 }], ["done", { messageId: "m", sessionId: "s" }]]);
  const events = await collect(streamTurn(/* … */, body));
  expect(events.map((e) => e.type)).toEqual(["done"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=mobile -- stream`
Expected: FAIL — the `web` event falls into `default: break` and is dropped.

- [ ] **Step 3: Add the case**

`apps/mobile/src/lib/assistant/stream.ts`, in `BoxEvent` after the `citations` line:

```ts
  | { type: "web"; sources: WebCitation[]; queries: string[] }
```

(import `WebCitation` from `@cortex/shared`), and in the switch, after `case "citations"`:

```ts
      case "web":
        yield {
          type: "web",
          sources: (Array.isArray(d.sources) ? d.sources : []) as WebCitation[],
          // `entryPoint` is deliberately dropped: it is HTML+CSS and this app has no WebView
          // to render it in. Chips are rebuilt from `queries` in the screen -- C3 spec §7.2,
          // including the condition under which that decision gets revisited.
          queries: (Array.isArray(d.queries) ? d.queries : []) as string[],
        };
        break;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm turbo run test --filter=mobile -- stream`
Expected: PASS.

- [ ] **Step 5: Render in the screen**

`apps/mobile/src/screens/assistant-box.tsx` — add `web` state, clear it on submit alongside the other per-turn state, set it from the new event, and render:

```tsx
{web && web.sources.length > 0 && (
  <View style={styles.provenance}>
    <Text style={styles.provenanceTitle}>Từ web</Text>
    {web.sources.map((s) => (
      <Text key={s.url} style={styles.webLink}
            onPress={() => void WebBrowser.openBrowserAsync(s.url)}>
        {s.title}
      </Text>
    ))}
  </View>
)}

{web && web.queries.length > 0 && (
  <View style={styles.chips}>
    {web.queries.map((q) => (
      <Text key={q} style={styles.chip}
            onPress={() => void WebBrowser.openBrowserAsync(
              `https://www.google.com/search?q=${encodeURIComponent(q)}`,
            )}>
        {q}
      </Text>
    ))}
  </View>
)}
```

`import * as WebBrowser from "expo-web-browser";` — already a dependency, no install. `encodeURIComponent` is not optional: the queries are Vietnamese and contain spaces and diacritics.

Keep the existing note-citation block separate and above this one. The two are never merged.

- [ ] **Step 6: Verify the whole mobile package**

Run: `pnpm turbo run test --filter=mobile`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/lib/assistant/stream.ts apps/mobile/src/lib/assistant/stream.test.ts apps/mobile/src/screens/assistant-box.tsx
git commit -m "feat(mobile): render web provenance and native suggestion chips"
```

---

### Task 9: Full verification and PR

**Files:** none.

- [ ] **Step 1: Run every gate**

```bash
pnpm turbo run lint typecheck test build
```

Expected: PASS. **Read the `Cached:` line in turbo's summary.** `26/26 successful` can be 23 cache replays and 3 real runs; if Docker is down, the database-backed suites replay a previous green without executing. A gate that did not run did not pass.

- [ ] **Step 2: Confirm the database suites actually executed**

```bash
docker ps
pnpm turbo run test --filter=@cortex/db --force
```

`--force` bypasses the cache. Expected: real execution, PASS, including `enum-parity`.

- [ ] **Step 3: Confirm no new suite is invisible to CI**

Every test in this plan was added to a file that already existed in a package `.github/workflows/ci.yml`'s `checks` job already runs. Verify with `git diff --name-only --diff-filter=A main` that no new `*.test.ts` file was created outside those packages. If one was, add it to `ci.yml` in this task — a suite CI does not name runs nowhere but your machine.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "Stage C3: web grounding" --body "…"
```

The body must state, in the author's own words: what C3 does; that mobile's Search Suggestions are a **reconstruction** rather than Google's supplied entry point (C3 spec §7.2) and that this is a knowingly-accepted ToS judgment; that the ledger over-reports inside Google's free tier by design; and that the billing unit is unverified against a real invoice.

- [ ] **Step 5: Watch CI, including the checks that block**

A required check is a **literal job name**. If every visible check is green and the PR still reads BLOCKED, branch protection is requiring a job name that no longer exists — see `docs/ci.md`. The blocking check renders nowhere in the UI.

---

## Self-Review

**Spec coverage.** §2 → Tasks 2 and 5 (`grounding: isQuestion`). §3.1 → Task 3 step 4, the capture placed before the text branch. §3.2 → Task 3 step 3, `grounding` as a function. §4.1 → Task 5's ordering test. §4.2 → Task 5 steps 3 and 5, including "zero sources means no event". §5 → Task 4, `readCitation` and the missing-`type` default; Task 5 step 5 persists the mixed array. §6.1 → Task 6 steps 1-2. §6.2 → Task 6 steps 5-6, the `costUsd` override. §6.3 → Task 6's `source: 'assistant'` assertion. §6.4 → recorded in the constant's doc comment and in Task 6 step 6's note. §7.1 → Task 7. §7.2 → Task 8. §8 → Task 5 step 6. §9's thirteen rows → covered across Tasks 2-8; the one row with no test is "an unknown SSE event does not break an old client", which Task 8 step 1 pins on mobile (where the `default: break` lives) rather than in `@cortex/shared`. §10 → Task 1. §11 → nothing to build; the open items are recorded in the PR body (Task 9 step 4).

**Placeholders.** One remains and it is deliberate: Task 7 step 1 and Task 8 step 1 say "follow the stubbing shape the existing spec already uses" rather than reproducing it, because inventing a second SSE-stubbing helper alongside the one C1 and C2 built is the failure those steps are trying to prevent. Both name the file to read.

**Type consistency.** `WebSource` (`{url, title}`, `@cortex/core/ai/client.ts`) is the *stream* type; `WebCitation` (`{type:"web", url, title}`, `@cortex/shared`) is the *wire and storage* type. The `web` SSE event carries `WebSource[]`; `chat_messages.citations` stores `WebCitation[]`; `turn.ts` maps between them in Task 5 step 5. Mobile's `BoxEvent` declares `WebCitation[]` for its `sources` — harmless structurally, since a `WebSource` from the wire is JSON either way, and it saves the client a second near-identical type. `GroundingResult` is `{sources, queries, entryPoint?}` in Task 3 and is read with exactly those three names in Tasks 5 and 6. `readCitation` is named identically in Task 4's test, its implementation, and nowhere else.
