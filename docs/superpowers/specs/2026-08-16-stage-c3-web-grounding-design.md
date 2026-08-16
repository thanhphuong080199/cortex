# Stage C3 — grounding: the box can look things up, and says so

**Design, 2026-08-16.** Implements `2026-08-01-life-domains-web-search-design.md` §6.1 and §6.2.
Read those two sections first; this spec does not repeat them. C1
(`2026-08-12-stage-c1-assistant-box-design.md`) built the turn and the SSE contract, C2
(`2026-08-15-stage-c2-mobile-box-design.md`) put the same box on Android, and both are merged.

C3 changes exactly one model call and adds one SSE event. It does **not** change the shape of a
turn, the order of its events, or what gets persisted as a note.

The conversation-surface work that grew out of the same brainstorm — a visible transcript, a
`chitchat` intent, verification of the user's own claims, and the offer to save what the model
contributed — is **not here**. It is `2026-08-16-stage-c4-c5-conversation-design.md`, and it is
deliberately a separate stage: none of it blocks grounding and grounding blocks only part of it.

---

## 1. What C3 is, and what it is not

| | |
|---|---|
| **In** | `google_search` declared as a tool on the answer call only; `groundingMetadata` parsed off the stream; a new `web` SSE event carrying web sources and the queries the model ran; web citations persisted alongside note citations under a discriminator; Search Suggestions rendered on both clients; one `usage_ledger` row per grounded turn; five documentation corrections (§10) |
| **Out of C3** | Save-as-note (§6.3) and the saved-external filter chip — → C5. `notes.sensitive` — §11. Retrieval as a model-called tool — §11. Any change to how a note is captured, classified, or filed |

Nothing about capture changes. `assistant-box.tsx:49` still creates the note first, awaited, in
its own `try`/`catch`, before the stream is opened — the note is the deliverable and the answer
is the bonus. Grounding is a property of the bonus.

---

## 2. Where grounding is switched on

`AiClient.generateStream` gains one optional field:

```ts
generateStream(args: {
  prompt: string; model: string; signal?: AbortSignal; grounding?: boolean;
}): Promise<StreamResult>;
```

`openStream` (`packages/core/src/ai/gemini.ts:105`) adds `tools: [{ google_search: {} }]` to the
request body when it is set. The body is `{ contents: [...] }` today and gains one sibling key;
nothing else about the request changes.

**It is passed only on the answer path.** `turn.ts:237-243` already branches:

```ts
const isQuestion = extracted?.intent === "question";
const prompt = isQuestion ? buildAnswerPrompt(...) : buildAcknowledgePrompt(...);
const model  = isQuestion ? ANSWER_MODEL : CLASSIFY_MODEL;
```

`grounding: isQuestion` joins that line. Searching the web in order to acknowledge *"hôm nay mình
ngủ 5 tiếng"* is money spent for nothing and a private sentence sent to Google for nothing — two
separate costs, both avoidable, neither recoverable afterwards. The acknowledge path is also the
one running on `CLASSIFY_MODEL`, so a tool declaration there would be attached to the model least
able to use it well.

This is the whole of the enablement decision. There is no user-facing toggle: §6.1 assigns the
per-turn choice to the model, and a switch would be a second control over a decision the prompt
policy (§8) already states.

---

## 3. Reading `groundingMetadata` back out

### 3.1 Where the capture goes, and why the position is load-bearing

`handleEvent` (`gemini.ts:138`) is a plain generator that parses one SSE `data:` line. It already
captures `usageMetadata` into a closure variable at line 151-158, *before* it looks at whether the
event carried any text:

```ts
const meta = obj.usageMetadata as ... ;
if (meta) { usage = { ... }; }
const candidates = obj.candidates as ... ;
const text = candidates?.[0]?.content?.parts?.map(...).join("") ?? "";
if (text !== "") yield { text };
```

Grounding metadata is captured the same way and in the same region: read
`candidates[0].groundingMetadata`, assign a closure variable, and do it **outside** the
`if (text !== "")` guard. A chunk can carry metadata and no text, and any capture placed inside
that guard silently sees nothing on exactly those chunks. That is the failure this file already
paid for once with `usageMetadata` — the header at line 99-104 records it as "the ledger cannot
see ~75% of the money" — so the mechanism is copied, not re-derived.

The same applies to the post-loop flush below the read loop (`gemini.ts:186+`): the final SSE
event frequently arrives with no trailing blank line, and that final event is the one carrying
the metadata. Delegating through `handleEvent` with `yield*` is what already makes the flush and
the loop agree; grounding inherits that for free by living inside `handleEvent`.

### 3.2 The accessor is a function, not a promise

`StreamResult` gains:

```ts
grounding: () => GroundingResult | null;
```

matching `usage: () => StreamUsage | null` exactly, and for the reason its doc comment already
gives (`client.ts:42-48`): metadata arrives in the final chunk, so a caller that aborts mid-stream
would never see a promise resolve — and an aborted answer has still been searched, still been
billed, and still has sources the user was shown mid-stream. Reading whatever was counted is the
point. A promise here would be the same bug as a promise there.

```ts
export interface WebSource { url: string; title: string; }
export interface GroundingResult { sources: WebSource[]; queries: string[]; }
```

`sources` is built from `groundingChunks[].web` (`{uri, title}`), `queries` from
`webSearchQueries`. `groundingSupports` — the per-span mapping from answer text back to
individual chunks — is **not** carried: §6.2 asks for a visible split between notes and web, not
for inline span-level attribution, and the answer is streamed token by token into a `<p>` that has
no span structure to attach it to. Recorded as a deliberate omission rather than an oversight.

`searchEntryPoint.renderedContent` is carried too, on the web path only — see §7.

---

## 4. The SSE contract: a new event, and why it cannot be an old one

### 4.1 It cannot ride in `citations`

`turn.ts:222-224` yields the `citations` event:

```ts
yield citationsResult.status === "fulfilled"
  ? { type: "citations", citations }
  : { type: "citations", citations: [], degraded: true };
```

and `generateStream` is not called until line 249. At the moment `citations` is emitted the
grounding call has not been made, so there is no grounding metadata in existence. This is a
physical ordering constraint, not a preference between two equally workable shapes.

Reordering the turn so that `citations` waits for the stream is the rejected alternative: it would
delay the note-provenance UI behind the entire answer, and the concurrency at `turn.ts:146` (extract
and retrieve raced together, so `attached` and `citations` land as early as each can) exists
precisely to avoid that.

### 4.2 The event

```ts
| { type: "web"; sources: WebSource[]; queries: string[]; entryPoint?: string }
```

added to `AssistantEvent` (`turn.ts:15-23`), emitted **after the token stream completes and before
`done`**.

**Zero sources means no event at all.** The consequence is worth stating because it is the whole
reason not to send an empty one: "did this turn search the web" is then exactly "did a `web` event
arrive", with no second flag to keep in step and no empty-array-versus-absent distinction for a
client to get wrong. A turn answered purely from notes is byte-identical on the wire to a turn
today.

**It is non-breaking.** `readEvents` (`packages/shared/src/sse.ts:13`) yields
`{ type: string; data: Record<string, unknown> }` — the type is a bare `string`, not a union — and
both clients branch with an `if`/`else if` chain over known types with no `else`. An unknown event
type is therefore ignored silently by every client that has not been updated. A deployed web build
and an installed C2 Android build both keep working against a C3 server, unchanged.

---

## 5. Persistence

`chat_messages.citations` becomes a mixed array under a discriminator, per §6.2:

```ts
export interface Citation    { type: "note"; noteId; title; snippet; score; matchedBy; }
export interface WebCitation { type: "web";  url: string; title: string; }
export type AnyCitation = Citation | WebCitation;
```

in `packages/shared/src/dto/assistant.ts`, whose existing doc comment (lines 29-43) already
records why `@cortex/core`'s `assistant/retrieve.ts` keeps its own structurally identical copy and
is deliberately not import-linked. That reasoning is unchanged and the core copy gains `type` the
same way.

**Rows written before C3 have no `type` field, and there is no backfill.** The reader treats a
missing `type` as `"note"`. The column is `jsonb`; a backfill migration would rewrite the user's
conversation history to add a field whose absence already means exactly one thing. The default is
one expression in one place and it is covered by a test (§9).

`retrieval_meta` is untouched. It carries `{ requestId, incomplete }` and both still mean what
they meant; whether a turn was grounded is derivable from the citations array itself.

---

## 6. Cost

### 6.1 A row of its own

Migration **`00029`** adds `'grounding'` to `usage_ledger`'s `kind` CHECK constraint, and
`usageLedgerKind` in `packages/shared/src/enums.ts` moves with it. These two move together or
`packages/db`'s `enum-parity.test.ts` fails — the mechanism `00020_note_source_types.sql` set up
and whose header says so. `recordUsage`'s own narrowed `kind` parameter (currently
`'embed' | 'tag' | 'chat'`) widens to include it.

One row per grounded turn: `kind: 'grounding'`, `source: 'assistant'`, 0 input tokens, 0 output
tokens, the answer model recorded as `model`, and the request's `requestId` and `noteId` so the
grounding spend joins to the `chat` row from the same turn.

### 6.2 The price has to be passed in

`recordUsage` computes `cost_usd` itself from `priceUsd(model, inputTokens, outputTokens)`, which
is token-based. A grounding row has no tokens of its own — the tokens are already on the `chat`
row for the same call — so `priceUsd` returns 0 and the row would land free. `recordUsage` gains
an explicit `costUsd?: number` override, used by this call site and no other.

The price itself is a new constant in `@cortex/shared`, beside `MODEL_PRICES_USD_PER_MTOK`:

```ts
export const GROUNDING_USD_PER_QUERY = 0.014; // $14 per 1,000, verified 2026-08-01 (§8)
```

### 6.3 No new budget

`isOverBudget(serviceDb, userId, budgetUsd, "assistant")` (`turn.ts:228`) sums `usage_ledger` by
`source`, not by `kind`. A grounding row written with `source: 'assistant'` therefore counts
against the existing circuit breaker on the very next turn, with no change to the breaker and no
second limit for the user to reason about. This is the reason `source` is a required parameter on
`recordUsage` and never defaulted.

### 6.4 Two inaccuracies, accepted and recorded

**It over-reports inside the free tier.** Google's grounding pricing (§8 of the life-domains spec)
is 5,000 free prompts per month, then $14 per 1,000 queries. This design charges every grounded
turn from the first one, so for a small number of testers the ledger will report spend that was
never billed. Wrong in the safe direction: the circuit breaker trips early rather than late, and
the alternative — tracking a monthly free allowance in the ledger — is a second accounting system
for a discount that stops applying the moment the app has real users.

**The billing unit is unverified.** Whether Google bills per *request* that declares the tool or
per *query* the model actually issues (`webSearchQueries` can hold more than one) is not settled
from the docs. This design writes **one row per grounded turn**, which is the per-request reading.
If a real invoice shows per-query billing the fix is one line — multiply by
`queries.length` — but the number to check it against is an invoice, not a doc page. Named in §11.

---

## 7. Provenance in the UI, and an asymmetry that is knowingly accepted

### 7.1 Web

Two visually distinct blocks, never one merged list — §6.2 requires the split:

```
Từ notes của bạn      [note icon]   …existing <ul className="citations">
Từ web                [globe icon]  …title, linked to url, target=_blank rel=noopener
```

Search Suggestions are rendered by injecting `searchEntryPoint.renderedContent`, the HTML+CSS
snippet Gemini returns for exactly this purpose. This is the compliant path and costs nothing on
web: Google supplies the markup because Google's terms require its markup.

### 7.2 Mobile

Web citations render natively. Search Suggestions are **reconstructed**: native chips built from
`webSearchQueries`, each opening `https://www.google.com/search?q=…` through `expo-web-browser`.

`apps/mobile/package.json` has no `react-native-webview`, and `renderedContent` is HTML+CSS that
React Native cannot render without one. So the options were: add a WebView dependency, ship mobile
without grounding, or reconstruct the entry point.

**The reconstruction was chosen deliberately, by the project owner, on 2026-08-16, with the
trade-off stated before the choice.** What is accepted is that Google's terms ask for *the
returned entry point* to be displayed, and a rebuilt set of chips is a good-faith equivalent
rather than the literal artifact — which is precisely the clause the life-domains spec §9 risk
table flagged as easy to trip. It is recorded here rather than omitted so that whoever revisits it
is revisiting a decision, not discovering a gap.

**Condition for revisiting:** if the Android app goes beyond the 2–3 invited testers it is built
for, the mobile entry point is re-examined before that happens — either `react-native-webview`
with the supplied `renderedContent`, or grounding disabled on mobile.

---

## 8. Prompt policy

`buildAnswerPrompt` (`packages/core/src/assistant/prompts.ts:39`) gains §6.1's three clauses:

- answer from the user's notes first;
- search when the notes cannot answer, or when the question is time-sensitive;
- never present web content as the user's own thinking.

The third is a stronger version of a rule the prompt already carries ("Do not fill the gap with
general knowledge presented as if it came from them", line 48-49) and replaces it, because with
grounding the gap-filler is no longer only the model's own memory.

`buildAcknowledgePrompt` is not touched in C3. `LANGUAGE_RULE` is unchanged and still applies —
Cortex's users write in Vietnamese, and a web source summarized back at them in English is the
same failure that rule exists to prevent.

---

## 9. Testing

Every row names the one-line implementation change that turns the test red. A test whose red
condition cannot be stated is not a test.

| Behaviour | Package | Turns red when |
|---|---|---|
| The tool is declared on the answer path | core | `grounding` is never passed — a question's request body has no `tools` key |
| The tool is **not** declared on the acknowledge path | core | `grounding` is passed unconditionally rather than as `isQuestion` |
| Metadata is captured from a chunk carrying no text | core | the capture moves inside `if (text !== "")` in `handleEvent` |
| Metadata is captured from the unterminated final event | core | the post-loop flush stops delegating through `handleEvent` |
| `grounding()` is readable after an abort | core | it becomes a promise that settles at end-of-stream |
| No `web` event when nothing was searched | core | the event is yielded unconditionally, so a notes-only turn emits `sources: []` |
| The `web` event lands after the last token and before `done` | core | it is moved next to the `citations` yield, where the metadata does not exist yet |
| Web sources persist beside note citations | core | `citations` is written from the retrieval result alone |
| A pre-C3 `chat_messages` row still reads as note citations | shared | the missing-`type` default is dropped |
| The grounding cost reaches the ledger | core | the `costUsd` override is dropped — `priceUsd(model, 0, 0)` is 0 and the row goes free |
| Grounding spend declines the *next* turn | db | the row is written with any `source` other than `'assistant'`, so `isOverBudget` cannot see it |
| An unknown SSE event does not break an old client | shared | `readEvents` is narrowed to a union of known types |
| Web and note citations render as two blocks | web / mobile | the two arrays are concatenated into one list |

The `usage_ledger` assertions are the ones most likely to be written so they cannot fail: asserting
"a row exists" passes with `cost_usd = 0`. The assertion is on the **value**.

---

## 10. Documentation corrections folded into this stage

Five, all small, all in `docs/superpowers/specs/`. They ride with C3 because four of them are
about grounding and the fifth was left explicitly conditional on C2, which has merged.

1. **`extract.ts:83` — the `mediaKind` enum mismatch.** The media prompt offers the model
   `"movie"|"book"|"show"|"game"|"album"` while `packages/shared/src/enums.ts:52` declares
   `mediaKind = ["movie","tv","book","game","podcast"]`. `"show"` and `"album"` fail the strict
   parse at `extract.ts:242-246`, so `domain_meta` is dropped to `{}` and the media link at
   `turn.ts:177-185` is skipped; `"tv"` and `"podcast"` are never offered. Pre-existing, but
   **activated by C2**, which asks for `pending_item.kind` on every media note. This is a code fix,
   not a doc fix, and is the only one.
2. **Master design §5.2** (`2026-07-31-cortex-second-brain-design.md`, ~line 214) — drop *"This is
   the stage C2 design; until it ships, mobile capture is the same first two steps without the
   assistant"*. C2's own closing checklist asked for this once C2 merged. It has.
3. **Life-domains §9 risk table** — close the row *"Gemini grounding + function calling can't be
   mixed in one request"*, whose mitigation was "verify at phase-3 implementation". Verified:
   Gemini 3 supports combining `google_search` with function calling. No change to C3 — retrieval
   stays injected context (§11) — but the risk is answered rather than left open.
4. **Master design §15.4** — it states `notes.sensitive` was "implemented in phase 2". It was not.
   A search across every migration in `supabase/migrations/` and all of `packages/` finds no such
   column and no code referencing one. The sentence is false and is corrected to name the control
   as unbuilt, with a pointer to §11 below.
5. **Master design §5, tester disclosure** — add that when Grounding with Google Search is used,
   Google retains prompts, contextual information, and output for 30 days in order to produce
   Grounded Results and Search Suggestions. This is a distinct surface from the paid-tier
   training-exclusion guarantee §5 already relies on, and §5 already commits to disclosing
   handling to testers.

---

## 11. Open items

**`notes.sensitive` does not exist.** Master design §15.4 designates it as the control that keeps
a note out of web-search grounding — the exact surface this stage opens — and claims it shipped in
phase 2. It did not (§10 item 4). C3 ships without it by explicit decision: the model chooses per
turn under §6.1's policy, with no user-facing tier. This is the largest thing C3 knowingly leaves
undone, and it is a privacy control, not a feature. It gets its own stage.

**The billing unit is unverified.** Per-request or per-query — see §6.2. Check against a real
invoice, not a doc page.

**The ledger over-reports inside the free tier.** §6.4. Accepted.

**Mobile's Search Suggestions are a reconstruction.** §7.2, with its revisit condition.

**Retrieval could become a model-called tool and is not.** §6.1 sidestepped mixing grounding with
function calling because Gemini historically could not do both; it now can (§10 item 3). Making
note retrieval a tool would let the model decide whether to search the corpus at all, instead of
always paying for a retrieval it may not use. Not done: it is a latency and cost optimisation for
a system with three users, and it would remove the guarantee that the `citations` event arrives
early. YAGNI, recorded so the option is known rather than rediscovered.

**Save-as-note and the saved-external filter chip** (§6.3) are in
`2026-08-16-stage-c4-c5-conversation-design.md`, stage C5.
