# Stage C1 — the box: one input, an answer, and a ledger that can explain itself

**Design, 2026-08-12.** Narrows `2026-08-10-phase-2-3-assistant-design.md` §1's stage C to a
first shippable slice, and revises three of its assumptions against what stages A and B actually
shipped. Read that spec's §6, §9 and §11 first; this one does not repeat them.

Stages A and B are merged (PR #10, #11) and live in production. This is what goes on top.

---

## 1. What C1 is, and what it is not

| | |
|---|---|
| **In** | `POST /assistant` as SSE; intent routing; RAG answers with citations; save-as-note; the box replacing quick capture on web; a ledger that can attribute every cent |
| **Out of C1** | Mobile (→ C2). Web grounding + the Search-Suggestions UI Google's terms require (→ C3). Review/accept-reject chips (→ stage D) |

**Why web first.** A web redeploy is free; mobile needs a new APK for every fix round
(issue-log E3). Chat is not in the sync rules, so mobile gains nothing from being early — the
thread is online-only there by design. Grounding carries a legal UI obligation and does not
belong in the PR that establishes the architecture.

**The parent spec estimated stage C at "one or two PRs".** That was low. C1 alone is the work
below; C2 and C3 are separate.

---

## 2. Product priority, stated because it decides the rest

The system has **two users**. A cost review of ten proposed optimisations was run against real
unit prices before this design was fixed, and the ruling was: **UX first, record every cent, and
optimise later from data.**

Measured unit costs (prices pinned in `packages/shared/src/enums.ts`):

| Work | Cost | Note |
|---|---|---|
| Embed a 500-char note | $0.000019 | |
| Extract the same note | $0.00068 | ~36× the embed; ~600 of ~1000 input tokens are the 200-tag vocabulary |
| One search | $0.0000009 | measured in production, issue-log §F |
| One RAG answer (est.) | ~$0.009 | the dominant cost, and it is what this stage adds |

**Answering will cost roughly six times the entire enrichment pipeline.** Everything else is
rounding error at this scale. So this design contains **no cost-*reduction* mechanism at all** —
only §9's circuit breaker, which exists to bound a runaway, not to ration — and it does contain
§7's ledger work, which is the part that expires if skipped.

**Explicitly rejected**, with the reason, so it is not re-proposed: a minimum-content threshold
before embedding (saves $0.011/month, costs recall on the notes hardest to find by keyword);
query-embedding caching ($0.90 per million searches, and a TTL invents a "wrote it, can't find
it" bug); FTS-only routing for short queries (would disable the arm carrying Vietnamese
quality — see §8); reducing `TAG_VOCABULARY_LIMIT` (a quality change dressed as a cost change);
an idempotency redesign (embedding is already crash-idempotent per chunk, and extraction's
exposure is one $0.00068 call per process death).

**Deferred until there is data:** model routing by question complexity, and failure-class-aware
retry.

---

## 3. Architecture

```
apps/api/src/
└── assistant.controller.ts       ← SSE framing, auth, abort; no logic

packages/core/src/assistant/
├── turn.ts        ← orchestrates one turn; returns an async iterable of events
├── context.ts     ← the rolling window and the 4-hour reset
├── retrieve.ts    ← wraps search_notes for both branches
└── prompts.ts     ← the two system prompts, kept out of the orchestration

packages/core/src/enrich/extract.ts   ← gains `intent`, and a language rule
packages/core/src/ai/client.ts        ← gains generateStream
```

Logic in `core`, wiring in `apps/api`. Phase 1b established the reason concretely: code in a
file the test runner cannot import is code that does not get tested.

**No new package**, so `ci.yml` needs no new job — checked against the workflow, not assumed.

---

## 4. One turn, end to end

1. **The client writes the note first.** `POST /notes` returns a `noteId` before any AI work
   starts. If the tab closes here, the 60-second sweep enriches the note anyway.
2. Client opens SSE `POST /assistant` with `{ noteId, sessionId? }`, `.strict()`.
3. Server reads the note with `createUserClient` — never the client's copy of the text, and RLS
   is what proves ownership.
4. **Classification and retrieval run concurrently.** Retrieval needs only the note text, not the
   classification, so `max(classify, retrieve)` replaces `classify + retrieve` — about half a
   second, at no extra cost. **`attached` and `citations` may therefore arrive in either order**,
   and the SSE contract says so rather than leaving clients to discover it.
5. Branch on `intent`, stream the answer.
6. Write the assistant turn, emit `done`.

### 4.1 Why the statement branch also calls a model

Both branches are `retrieve → prompt → stream`, differing only in prompt and model tier. A
templated acknowledgement built from the structured extraction would have been free and
deterministic, and it was rejected: it reads like a UI, not like something talking back, and the
acknowledgement is exactly what makes this feel like an assistant rather than an inbox
(parent §6 obligation 3).

**The cost is real and accepted**: roughly $0.00085 per capture, which nearly doubles per-note
cost. At this scale that is still under a dollar a month.

**Tests are unaffected by the non-determinism** because they assert the plumbing — which events
fired, in what shape, and what landed in the database — never the model's wording.

### 4.2 `source_type='chat'` is an UPDATE, and that is safe

The note is created at step 1, before anyone knows the intent, so step 5 patches
`source_type` when the input was a question. `notes_set_updated_at` fires on every UPDATE, which
looks exactly like the self-feeding loop parent §7.1 warns about.

It is not one. The sweep's predicate keys on `md5(content_text)`, and the content did not change,
so the note is skipped. **This is the case the two-hash design was built to survive**, and it is
recorded here because the next reader will stop at it.

The sweep still picks the note up afterwards to run the *embed* step: the box stamps
`extracted_hash` only. That is parent §6's two-hash split working as designed.

---

## 5. The SSE contract

`attached` → `citations` → `token`* → `done`, with `attached` and `citations` interchangeable in
order (§4 step 4), and `declined` replacing the token stream when the circuit breaker is open.

| Event | Payload |
|---|---|
| `attached` | `{ domain, domainMeta, tags[], degraded? }` |
| `citations` | `{ citations: [{ noteId, title, snippet, score, matchedBy }], degraded? }` |
| `token` | `{ text }` |
| `declined` | `{ reason: 'budget' }` |
| `done` | `{ messageId, sessionId }` |
| `error` | `{ message }` |

---

## 6. Persistence

**Two clients in one turn, and the split is a security boundary.** `createUserClient` (the
caller's JWT, RLS enforcing) reads the note and writes `chat_*`. `createServiceClient` is used
for `search_notes` **only**, because it is `SECURITY DEFINER` over `note_chunks`. Every
user-facing path keeps RLS as the enforcement, per parent §11.

`chat_sessions` and `chat_messages` already exist (`00006`) with `citations` and
`retrieval_meta`, are client-writable under owner RLS, and `chat_messages` is append-only with no
`deleted_at`. `source_type` already accepts `'chat'`, `'assistant'` and `'web_search'` (`00020`).
**No schema work is needed for the conversation itself.**

**Write order.** The user turn is written *before* generation starts, so any later failure still
leaves a coherent thread. The assistant turn is written when the stream ends — including when it
ends badly, with `retrieval_meta.incomplete = true`.

**An incomplete turn is excluded from the rolling context.** A truncated answer fed back as
context poisons the next turn; keeping it visible in the thread while hiding it from the prompt
is the whole point of storing the flag.

**The 4-hour reset reads `chat_messages.created_at`**, not `chat_sessions.updated_at` — the
latter is only accurate if every turn touches the session, which is a write for nothing. The
existing index is `(session_id, created_at)`, wrong leading column; `00027` adds
`(user_id, created_at desc)`.

---

## 7. The ledger — the one thing that cannot be added later

Data not recorded now is not recoverable. This section exists because §2's strategy
("optimise later from data") is worthless if the first months are unmeasurable.

The ledger must be able to answer nine questions: cost of embedding, of classification, of
answering, and of search; cost of retries; and cost per user, per note, per search, and per
answered question.

`usage_ledger` today is `user_id, kind, model, input_tokens, output_tokens, cost_usd,
created_at`. It answers two of the nine. It cannot distinguish a search from a note embedding —
`search.controller.ts` and `embed.ts` both write `kind='embed'` — and it cannot attribute
anything to a note, a turn, or a retry.

**Migration `00027`** adds, without touching the `kind` CHECK constraint (so `enum-parity.test.ts`
stays green):

| Column | Answers |
|---|---|
| `note_id uuid null` | cost per note |
| `source text null` — `sweep` \| `assistant` \| `search` | separates search spend from note embedding |
| `request_id uuid null` | cost per answered question: groups the classify and answer calls of one turn |
| `attempt int null` | retry cost |
| `latency_ms int null` | not cost — the UX number |
| `content_chars int null` | see below |

Also: `note_enrichment.last_error_status int`, so the 429-vs-400 mix is measurable without
parsing error strings.

**`content_chars` exists because the token counts are wrong for Vietnamese.** `gemini.ts` and
`embed.ts` estimate `ceil(len/4)`, an English ratio; Vietnamese runs nearer 2–3 characters per
token, so embedding spend is under-reported by roughly 40–60%. Only `kind='embed'` rows are
estimates — `extract` reads real `usageMetadata` — so the dollar error is a fraction of ~2.5% of
spend. Storing the character count makes the ratio **recalibratable later from stored data**,
which is strictly better than replacing a known-wrong divisor with an unknown-wrong one.

**`generateStream` must capture `usageMetadata` from the final chunk.** Streaming APIs report
token counts at the end. Miss it and the single largest line item — answer generation, ~75% of
spend — has no row in the ledger at all. Usage is recorded even when the stream fails, for
whatever tokens were produced: an interrupted turn is still money spent.

**`complexity` is added to the classification schema and deliberately not used.** It costs a few
output tokens and produces the dataset — question complexity × real cost × model — that a future
routing decision needs. Recording it is not the same as acting on it.

---

## 8. Language

**Cortex's users write Vietnamese.** This is a first-class constraint, not an edge case; three
shipped defects came from assuming otherwise, each green under English tests.

- **Prompts must answer and tag in the language the user wrote in.** No prompt in the pipeline
  says anything about language today. Mixed-language tags fragment exactly the vocabulary
  `TAG_VOCABULARY_LIMIT` exists to keep stable.
- **`notes.domain` stays an English enum.** It is a stored CHECK value, not model output.
  Localise the label, never the value.
- **Embeddings need no change** — `gemini-embedding-001` is multilingual. Stated so nobody
  "fixes" it.
- **No ASCII-range character classes** anywhere in text handling. The chunker's `[A-Z]` lookahead
  (PR #12) and the `english` FTS configuration (PR #13) were both this mistake.
- Intent classification must not lean on English question cues — Vietnamese questions end in
  `không?`, `à?`, `nhỉ?` as often as they use `gì`/`sao`. A model handles this; a heuristic would
  not, so there is no heuristic.

---

## 9. Failure handling

The governing rule: **the note is never rolled back, and no failure here can lose data.** That is
what writing the note first (§4 step 1) buys.

| Failure | Emitted | User sees |
|---|---|---|
| `POST /notes` fails | no SSE opened | text stays in the box, retry offered |
| note missing / not owned | 404 before the stream opens | banner; the sweep still enriches it |
| classify exceeds its deadline, or throws | `attached` with `degraded: true` | "nothing attached yet, it will be handled shortly" |
| retrieval fails | `citations: []`, `degraded: true` | answers, and says it is not grounded in notes |
| circuit breaker open | `declined { reason: 'budget' }` | stated plainly, like the offline path |
| generation fails before the first token | `error` | "no answer right now" |
| generation fails mid-stream | `error` after tokens | partial text kept, marked incomplete |
| client disconnects | server aborts | — |

**The synchronous extract carries a ~4s deadline.** Keeping extraction synchronous is right — its
result is on screen — but without a deadline a hung Flash call holds the SSE connection open
indefinitely. On timeout the turn proceeds degraded and the sweep does the enrichment later; that
escape hatch already exists and this reuses it.

**Client disconnect must abort for real.** Nest listens for `close` and fires an `AbortController`
into the Gemini call. Without it, closing a tab still pays for an answer nobody reads.

**The circuit breaker, not a budget.** `ASSISTANT_MONTHLY_BUDGET_USD` is checked before the
generation call only, and set high enough that ordinary use never reaches it. Its job is to bound
a runaway loop or a pathological output, not to ration the product — §2's priority makes refusing
to answer a UX failure, so the threshold is generous and the note and retrieval are never gated.

Per project memory, a new env var must be declared in **four** places: `turbo.json`, `ci.yml`,
`e2e-web.yml`, `e2e-mobile.yml`. Three of the four have been missed before (issue-log A1, G1).

---

## 10. Testing

| Package | What it pins |
|---|---|
| `@cortex/shared` | `assistantInput` zod, and the SSE event union |
| `@cortex/core` | `createFakeAi` gains `generateStream`, throwing clearly when unscripted (the `fake.ts` convention). Turn orchestration, the context window, the 4-hour boundary, exclusion of incomplete turns |
| `@cortex/db` | `00027`'s columns and index; `usage_ledger` still invisible to `authenticated` |
| `@cortex/api` | SSE framing; **`attached`/`citations` in either order**; 401 without a token; 400 on an extra body field; abort on disconnect |
| `@cortex/web` | the box assembling from events; offline, declined, and incomplete states |

**E2E covers the local-first half only, deliberately.** `e2e-web.yml` runs with a dummy Gemini
key and states in capitals that no E2E run may reach the real API, so there is no real answer to
assert. The property most worth protecting is testable inside that constraint anyway: type →
the note appears in the list → the answer area shows a clean failure state. That is precisely
"capture never depends on the AI".

**No model may be called for real in any test.** Every suite uses the fake.

---

## 11. Open items this design does not close

- **The reasoning model id is not pinned here.** Parent §10 says to pin it at stage C against
  documentation current at the time. The implementation plan carries an explicit step to check
  the Gemini docs and add the constant beside `CLASSIFY_MODEL`, rather than pasting a name from
  memory that may not resolve.
- **`gemini.ts` sends every chunk of a note in one `batchEmbedContents`** with no size cap, and
  the API's limit is 100 requests. A ~180KB note — a pasted import — therefore 400s, burns its
  five attempts, and is permanently unsearchable while the sweep logs success. This is a stage A
  reliability defect, not stage C work, and is fixed in its own PR.
- **Failure-class-aware retry.** `gemini.ts` attaches `status` to its errors specifically so a
  caller can distinguish 429 from 400; no caller does, so every failure gets the same five
  attempts. Deferred: after the batch cap lands, the common deterministic 400 disappears, and the
  remaining cost is $0.003.
