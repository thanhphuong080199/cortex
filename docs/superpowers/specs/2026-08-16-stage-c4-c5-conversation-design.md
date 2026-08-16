# Stages C4 and C5 — the thread you can see, and an assistant that pushes back

**Design, 2026-08-16.** Two stages in one document because they share a surface: C5's offer to
save something has nowhere to appear until C4 builds a transcript for it to appear in.

Read `2026-08-12-stage-c1-assistant-box-design.md` §4 (the turn) and
`2026-08-01-life-domains-web-search-design.md` §6.3 and §6.4 first. C3
(`2026-08-16-stage-c3-web-grounding-design.md`) is a sibling, not a prerequisite for most of this
— see §0.

---

## 0. What blocks what

| Stage | Depends on |
|---|---|
| **C3** grounding | nothing |
| **C4** transcript + `chitchat` intent | nothing |
| **C5 §2** verification | **C3** — grounding is the second source a claim can be checked against |
| **C5 §3-§5** save-as-note, the offer, the decline store | **C4** — the offer needs a thread to live in |

C3 and C4 can be built in either order or concurrently. C5 needs both.

---

## 1. A premise in the brief that turned out to be false

The requirement that produced this design says:

> *the chat pane and the sidebar note list read from the same `notes` table under two different
> narrowings, not one shared query. (Today's web home page uses one query for both — this is the
> point that has to split.)*

**There is no chat pane, and there is no shared query.** Verified 2026-08-16:

- `apps/web/src/app/assistant-box.tsx` holds exactly **one turn** in React state — `answer`,
  `citations`, `attached` — and `submit()` clears all three at lines 39-42 on every send. It never
  renders history and has no concept of a previous turn.
- `chat_messages` is written by `turn.ts:278` and read back by `turn.ts:119` to build the prompt.
  Nothing else reads it. A grep across `apps/` finds one other match, in an API e2e test.
- `apps/web/src/app/page.tsx:32-35` runs one query and it feeds `NoteList`. There is nothing
  sharing it.

So the described work — split one query into two narrowings — does not exist as described. The
actual work is **building the transcript surface**, which the brief treats as a parenthetical and
which is the largest single item across both stages.

**What already works is the part the brief assumed was missing.** "One continuous thread, not a
fixed set of modes" is already true in the data model: `turn.ts:105-114` reads the user's most
recent `chat_messages` row, reuses its `session_id`, and only opens a new session when
`isStale(lastMessageAt, now)` — a 4-hour idle gap (`context.ts:11`). The web client does not send
a `sessionId` at all and does not need to. The thread exists; nobody can see it.

**And the split, once built, is cleaner than the brief's version.** The transcript reads
`chat_messages`; the sidebar reads `notes`. Two *tables*, not two narrowings of one — and
`chat_messages` also holds the assistant's own replies, which are not notes and never will be.
The requirement "the chat pane is NOT filtered the way the sidebar is" is therefore satisfied by
construction: the pane shows everything because it reads a table that only ever contained the
conversation. No second narrowing is written, so no second narrowing can drift.

---

# Stage C4 — the thread, and a third kind of turn

## 2. What C4 is, and what it is not

| | |
|---|---|
| **In** | A transcript pane on web reading `chat_messages` for the current session; the session-resolution logic extracted from `turn.ts` so the pane and the turn cannot disagree; a third intent `chitchat` with its own prompt; `source_type = 'chitchat'`; exclusion of chitchat from the note views **and** from retrieval and search |
| **Out of C4** | Scrollback across earlier sessions. Chat history on mobile. Deleting chitchat notes. Skipping classification for chitchat. Anything in C5 |

**Scrollback across sessions is out and the boundary must be visible.** The pane shows the
*current* session — the rolling 4-hour thread. Without that limit, "one continuous thread" reads
as "unbounded", which is a list with no bottom, an unbounded query, and a scroll position that
means nothing. Reaching older conversations is a search problem, not a scroll problem, and it gets
its own stage.

**Mobile does not get the transcript in C4.** `chat_sessions` and `chat_messages` are absent from
`packages/sync/src/sync-rules.yaml`, whose header records absence-by-omission as deliberate. C2's
spec §1 already states this and gives the reason: putting chat into the sync rules is a
bucket-size and a privacy decision, not a UI one. Unchanged here.

## 3. The transcript pane

### 3.1 It reads `chat_messages`

One query, scoped by `session_id`, ordered by `created_at`. RLS is the isolation layer and it is
already in place: `turn.ts` reads and writes this table through `userDb`, the user's own client.

Rows carry `retrieval_meta.incomplete` (`turn.ts:280`). An interrupted answer **stays visible in
the thread** and is already excluded from the prompt at `turn.ts:133` — the model reads a truncated
answer as a complete one. The pane must render it as visibly interrupted rather than as a short
answer, because those two are indistinguishable in the `content` column alone.

Assistant rows also carry `citations`, which C3 turns into a mixed note/web array. The pane
renders them with the same component the live box uses, so a turn looks the same after a reload as
it did while streaming.

### 3.2 Session resolution moves out of `turn.ts`

The logic at `turn.ts:105-114` — take the latest message's session, open a new one if
`isStale` — currently exists only inside the generator. The pane needs the same answer to the same
question ("which session is current?"), and computing it a second time is how the two disagree.

Extract it into `packages/core/src/assistant/session.ts` and have both call it. The equivalent
mistake has already been made once in this codebase and is written up as issue-log **E5**
(`packages/shared/src/notes/filters.ts:9-13`): a narrowing that existed twice, in a query and in a
refetch, and the two drifted. The fix there was one function used by both call sites. Same fix,
before rather than after.

### 3.3 The live box and the pane

`AssistantBox` keeps its streaming state — a partially streamed answer is not in `chat_messages`
yet and cannot come from the pane's query. On `done`, the turn is in the database and the pane
owns it.

The naive version double-renders the last turn: once from the box's state and once from the
refetched pane. The pane is the source of truth for completed turns and the box renders only what
is still streaming.

## 4. `chitchat`, the third intent

### 4.1 Why the binary is wrong

`extract.ts`'s `RESPONSE_SCHEMA.intent` is `["question", "statement"]` and both reply templates
assume the input is *about* a note. `buildAnswerPrompt` answers from the corpus;
`buildAcknowledgePrompt` files a statement and explicitly refuses to converse — `prompts.ts:79`:
*"The user did not ask a question. Do not answer one, and do not invent one to answer."*

"hello", "haha ok", "1111" get forced into one of the two, and neither is right: the model either
searches the user's notes for an answer to "what?", or replies as though this were journaling.

### 4.2 The change

- `RESPONSE_SCHEMA.intent` becomes `["question", "statement", "chitchat"]`.
- `buildChitchatPrompt` — history included, **no** note-filing framing, **no** "mention what you
  attached". The `LANGUAGE_RULE` still applies.
- Model: `CLASSIFY_MODEL`. Small talk does not need the reasoning model.
- The default stays `"statement"` (`extract.ts:282`). `required` in a `responseSchema` is a
  request, not a guarantee, and `"statement"` is the branch that never spends the expensive model
  — the comment at `extract.ts:270-272` already says exactly this and the reasoning is unchanged
  by adding a third value.

The classifier's job is unchanged: decide what **kind** of turn this is, not whether to persist it.

### 4.3 Persistence is unchanged — every turn still becomes a note

`assistant-box.tsx:49` creates the note first, awaited, in its own `try`/`catch`, before the
assistant is called at all. The note is the deliverable; the answer is the bonus; the property
survives a dead model.

Gating note creation on the classification would invert that: the turn would have to classify
*before* persisting, which means a model call ahead of the one that already exists — a second
round trip and a new failure mode, for a UX property §5 gets for free.

## 5. `source_type = 'chitchat'` and the four places that must exclude it

### 5.1 The stamp

`turn.ts:235` already does exactly this shape for questions:

```ts
if (isQuestion) {
  await userDb.from("notes").update({ source_type: "chat" }).eq("id", args.noteId);
}
```

after classification, on a note that already exists. It becomes a three-way. Migration **`00030`**
(`00029` is C3's grounding kind) adds `'chitchat'` to `notes_source_type_check`, and
`noteSourceType` in `packages/shared/src/enums.ts` moves with it — the mechanism
`00020_note_source_types.sql` set up, enforced by `packages/db`'s `enum-parity.test.ts`.

### 5.2 Four appliers, not one

| # | Where | Function | Missed → |
|---|---|---|---|
| 1 | Web SSR + Realtime refetch | `applyNoteFilters` | the web list shows chitchat |
| 2 | Mobile SQLite | `noteFiltersToSql` | the mobile list shows chitchat |
| 3 | Realtime row patch | `matchesFilters` | SSR excludes it, Realtime patches it back in |
| 4 | Retrieval + search | `search_notes` (migration) | banter becomes a citation |

`filters-equivalence.test.ts` guards 1 against 2. It does not guard 3 or 4; those need their own
tests (§7).

**#3 is the one that has already burned this codebase.** It is the surviving half of E5 —
`filters.ts:134-143` records that `matchesFilters` and `requiresRefetch` are a deliberate pair
naming exactly the fields the other ignores. `matchesFilters` currently takes
`{ lifecycle, deleted_at, domain? }` and gains `source_type`; `NoteRow` in
`apps/web/src/app/note-list.tsx:10-14` gains it too. `noteSelect` already returns `"*"` and the
Realtime payload is the full row, so the data is present — only the type and the predicate are
missing.

**The eviction path already works.** A chitchat note is created as `'quick'` and only stamped
after classification, so Realtime delivers it to the list first and the stamping `UPDATE` arrives
after. `note-list.tsx:85-92` already handles this: the row is removed from `prev` by id, and
re-added only `if (matchesFilters(row, ...))` — the `return without` fallback is what soft-deletes
already ride on ("soft-deletes arrive as UPDATEs failing matchesFilters → drop"). Adding
`source_type` to the predicate makes chitchat use the same path. Nothing new is needed; the risk
is purely forgetting the field.

### 5.3 #4: exclusion from retrieval, decided deliberately

`retrieve.ts` → `search_notes` is a separate read path that does not go through `NoteFilters` at
all. Left alone, "haha ok" and "1111" remain eligible as citations, so the model is fed the small
talk it just produced — a self-reinforcing loop in the most context-sensitive part of the system.
Excluding them there matters more than the sidebar does.

The chosen exclusion covers **both** retrieval and the `/search` page, from one clause in
`search_notes` rather than two divergent ones. The accepted cost: *"what was that joke I made last
month"* will not come back. Judged a good trade — the alternative pollutes every answer to protect
a query nobody has run.

Note that §6.3's existing 0.8 down-weight for `'assistant'` and `'web_search'`
(`00022_search_notes.sql:92`, `00024_search_recency_clamp.sql:127`) is a *multiplier*. Chitchat is
excluded, not down-weighted: a multiplier still lets banter win when nothing else matches, which is
exactly the turn where a citation does the most damage.

## 6. Not doing

**Not deleting chitchat notes.** The note is still the deliverable. A capture surface that
silently discards some captures based on a classifier's judgment is a capture surface you cannot
trust.

**Not skipping the domain/tag classifier for chitchat.** `extractNote` already returns
`domain: null, tags: []` cheaply for content with nothing to classify, and one model call is
simpler than branching the pipeline on a guess about what needs classifying *before* it has been
classified. The classification is also what produces the `chitchat` label in the first place —
skipping it is circular.

## 7. Testing C4

| Behaviour | Package | Turns red when |
|---|---|---|
| chitchat is absent from the web note list | shared | the clause is dropped from `applyNoteFilters` |
| chitchat is absent from the mobile note list | shared | the clause is dropped from `noteFiltersToSql` |
| a chitchat row patched in by Realtime is evicted | web | `matchesFilters` does not read `source_type`, or `NoteRow` omits it |
| chitchat is not retrievable as a citation | db | the `search_notes` migration omits the exclusion — ask a question immediately after typing "haha ok" |
| chitchat is not in `/search` results | db | same clause, separate assertion |
| the pane shows chitchat that the list does not | web | the pane queries `notes` instead of `chat_messages` |
| an earlier session does not leak into the pane | web | the `session_id` constraint is dropped |
| the pane and the turn pick the same session | core | the session logic is copied instead of shared |
| an interrupted answer renders as interrupted | web | `retrieval_meta.incomplete` is ignored |
| a chitchat turn does not spend `ANSWER_MODEL` | core | the intent switch falls through to the question branch |
| a missing intent still defaults to `statement` | core | the third value is added by widening the cast instead of the comparison |

---

# Stage C5 — verification, and the offer to save

## 8. What C5 is, and what it is not

| | |
|---|---|
| **In** | A `checkable_claim` flag from the classifier; verification of the user's own factual claims in the acknowledgement, on the reasoning model only; save-as-note (§6.3); the model offering to save what it contributed; a decline that sticks; the saved-external filter chip |
| **Out of C5** | Auto-saving anything. Feeding offers or declines into the nightly memory pipeline (§6.4). Verifying anything the user did not write |

## 9. Verifying the user's own notes

### 9.1 The problem with doing it on the cheap model

The acknowledge branch runs `CLASSIFY_MODEL` — flash-lite (`turn.ts:243`). Asking flash-lite to
adjudicate whether a factual claim is true is asking the weakest model in the system to do the
task with the most asymmetric failure mode: *"your note is wrong"* when the note is right is far
more damaging than saying nothing, and it undermines the whole surface in a way silence never
does. The requirement itself makes this point — *silence on a claim means the model had no basis
to doubt it, not that it confirmed it*.

### 9.2 The flag

`extract.ts`'s `RESPONSE_SCHEMA` gains `checkable_claim: { type: "boolean" }` — a couple of output
tokens on a call that is already happening. This is the same trick `complexity` already uses
(`extract.ts:22-24`: *"RECORDED, NOT ACTED ON. It costs a couple of output tokens…"*), except this
one is acted on.

Defaulted to `false` at the return, alongside `intent` and `complexity` and for the same stated
reason: a schema is a request, not a guarantee, and the default must be the branch that does not
spend money or make claims.

Only a `statement` carrying the flag is routed to `ANSWER_MODEL`. Ordinary statements stay on
flash-lite. The cost has a ceiling and the ceiling is visible.

### 9.3 The prompt

`prompts.ts:79` currently reads:

> The user did not ask a question. Do not answer one, and do not invent one to answer.

This is in direct conflict with volunteering a correction, and it cannot simply be deleted — it is
what stops the acknowledgement from turning into a conversation. It is replaced by the same
prohibition plus **one named exception**: the model may note a single factual discrepancy, briefly,
without asking a follow-up question and without inviting a reply.

And one addition with no exception: **silence is not confirmation.** The prompt must forbid any
phrasing implying the claim was checked and found correct — "đúng rồi", "chính xác", "xác nhận" —
because the model only looked at the claims it flagged, and the user cannot tell which those were.

Where C3 has shipped, the verification turn is grounded (a flagged statement takes the answer
model, and §2 of the C3 spec ties `grounding` to that path); without C3 it checks against the
model's own knowledge only. Both are acceptable; the prompt does not need to know which.

## 10. Save-as-note (§6.3)

A note with `lifecycle = 'inbox'`, `source_type = 'web_search'` when the answer carried web
citations and `'assistant'` when it came from the model's general knowledge, and the URL in
`source_meta`. `source_meta jsonb not null default '{}'` already exists — `00002_content.sql:10` —
so no column is added.

Corpus pollution is handled by provenance, not prohibition, and the mechanism is already built:
`search_notes` down-weights both source types by 0.8 (`00022_search_notes.sql:92`,
`00024_search_recency_clamp.sql:127`), and retrieval carries the source type so chat cites such a
note as something the user saved, never as their own thinking.

The saved-external filter chip — §6.3's third bullet — lands here, next to the thing it filters.

## 11. The offer

When the model fills a gap from its own knowledge or from grounding, and that knowledge is not
already reflected in the user's notes, it offers to save it: one line, one tap, easy to ignore.
Carried as its own SSE event holding the proposed statement, the same way `web` is carried in C3.

**Auto-saving stays rejected.** §6.3: saving is always a deliberate act. The offer is that act's
entry point, not a replacement for it — a distinction that only holds if declining is free, which
is §12.

## 12. Declining, and not being asked twice

### 12.1 Where a declined offer lives

`memory_facts` (`00005_memory_feedback.sql`) already has the shape: `statement`, `confidence`,
`evidence jsonb`, `embedding`, and `status` with `'rejected'` in its CHECK. A declined offer is a
row at `status = 'rejected'`; an accepted one becomes a note (§10) and, if it is durable, a fact.

The act of declining goes to `feedback_events`, whose `subject_type` CHECK already lists
`'chat_answer'`.

Both tables are server-only for writes — `memory_facts` grants `authenticated` `select` and
nothing else, deliberately (`00005:52-65`) — so this all runs through the API under the service
role, which is where it belongs.

### 12.2 The carve-out, written down because reuse is how a rejected decision gets back in

Life-domains **§6.4 explicitly rejected** feeding web-search signal into the memory layer:
*"A dedicated search-signal pipeline would add a weak-evidence source to the most trust-sensitive
subsystem."* Reusing `memory_facts` without a fence is that rejected pipeline, arriving through a
side door.

**Rows created by an assistant offer are marked as such in `evidence` and are excluded from the
nightly `memory.update`.** They exist for deduplication and for nothing else. This is a named
requirement with its own test (§14), not a convention.

### 12.3 Deduplication is semantic, not textual

Before offering, embed the candidate statement and compare against the user's `rejected` and
`active` facts. One embed call per offer, recorded in `usage_ledger` like every other.

The threshold is deliberately **not** fixed in this spec. It has to be measured against real
declines, and a number invented at design time would be a number nobody later dares to change
because it looks decided. The implementation picks a starting value and the plan says so.

A string comparison here would not work: "the same fact" recurs in different words, which is the
entire reason this is embedded rather than hashed.

## 13. Symmetry, stated

§6.3 gives the *user* an action: save the model's web-cited answer as a note. §11 gives the
*model* an opening move toward the same action. They are the same write, reached two ways, and
they must produce the same row — a note saved through the offer and a note saved through the chip
are indistinguishable afterwards, by construction rather than by care.

## 14. Testing C5

| Behaviour | Package | Turns red when |
|---|---|---|
| an ordinary statement does not reach the answer model | core | the flag is ignored and every statement routes to `ANSWER_MODEL` |
| a missing `checkable_claim` defaults to false | core | the default is dropped — one schema miss then costs an extraction |
| a statement without the flag draws no comment | core | the prompt's exception is written broadly enough to apply to everything |
| the acknowledgement never claims it verified | core | the "silence is not confirmation" clause is dropped |
| a saved answer is down-weighted in retrieval | db | the note is written with `source_type = 'quick'` |
| a note saved via the offer matches one saved via the chip | core | the two paths build the row separately |
| a declined fact is not offered again | core | the dedup step is skipped, or compares strings instead of embeddings |
| a declined offer never reaches the nightly memory update | core | the `evidence` carve-out is dropped and the row is picked up as evidence |
| declining costs nothing | web | the decline path writes a note, or blocks the turn |

## 15. Open items

**The dedup threshold is unmeasured.** §12.3. It needs real declines, not a guess.

**Verification quality is unmeasured.** No test can assert "the model correctly identified a false
claim"; the tests in §14 assert routing, prompting and cost. Whether the flagging is *useful* is a
judgment call over real use, and the honest position is that C5 ships a mechanism whose value is
unproven.

**Scrollback across sessions** is out of C4 (§2) and unassigned.

**Chat history on mobile** is out of C4 (§2) and depends on a sync-rules decision, not a UI one.

**Retrieving a chitchat note is impossible by design** (§5.3). If that turns out to be wrong, the
fix is to down-weight instead of exclude — and the reason it was not done that way is recorded
there, so the reversal is a decision rather than a discovery.
