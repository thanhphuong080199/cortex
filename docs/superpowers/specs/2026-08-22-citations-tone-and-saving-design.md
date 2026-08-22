# Stage S1.5: what the assistant says it knows, and what you can keep

Status: designed and approved by the user on 2026-08-22. Not implemented.

This stage closes three of the debts stage S1 carried in from C5 (§11.1, §11.5, §11.6), one
defect found by using the shipped shell on the same day, and one capability the user went
looking for and could not find. It is numbered S1.5 rather than S2 because §10 of the S1 spec
reserves S2/S3/S4 for named work that this does not touch.

## Problem

Five findings, four of them from the user reading real replies on 2026-08-22, the day S1 merged.

1. **`[1, 2]` is unreadable.** The user's words: *"[1, 2] nhìn không biết gì hết"*. Recorded as
   S1 §11.6.
2. **A saved answer is cited as if the user wrote it.** `search_notes` reads `source_type`
   internally but does not return it, so nothing downstream can tell the model that a note came
   from an earlier answer. Recorded as S1 §11.1.
3. **Replies are too short.** S1 §11.5 said `FORMAT_RULE` obedience could only be judged by a
   person. The person judged it: the rule overshot.
4. **"Trong note của bạn không có, nhưng theo mình biết..." on every turn.** The user's words:
   *"đa phần tình huống tôi chat với AI là không có note sẵn, cứ nghe câu này suốt cũng phiền"*.
5. **There is no way to keep an answer.** The user asked the assistant *"ok note lại giúp tôi
   đi"*, was told *"Mình đã ghi nhận lại thông tin này cho bạn nhé"*, and found nothing in
   `notes`. Diagnosed below: not a bug, a missing capability plus an acknowledgement that speaks
   for a write it never performed.

## Current architecture (verified against `687ffa1`, 2026-08-22)

- **The bracket lives in four places**, and three of them are instructions rather than
  rendering: `buildAnswerPrompt`'s standalone *"Cite the notes you used by their bracketed
  number, like [1]."* (`prompts.ts:171`), `buildAcknowledgePrompt`'s *"say so and cite them like
  [1]"* (`prompts.ts:222`), `RECALL_RULE`'s second half — *"Still carry the bracket, like [1], so
  they can trace it"* (`prompts.ts:38`) — and `renderCitations`, which numbers each entry
  `[${i + 1}]` (`prompts.ts:147`). Removing three of the four leaves the model still emitting
  brackets, because the fourth keeps modelling them.
- **Nothing reads the bracket back out.** `Provenance` renders web sources only, and its own
  comment records that the note list was removed on 2026-08-18 because *"a matched note is
  usually the user's own chat message echoed back"*. Mobile has no note-citation UI at all. The
  `citations` sent to either client come from retrieval directly, never from numbers parsed out
  of the reply text. The bracket is decorative in the shipped product.
- **`renderCitations` already gives the model a human-readable anchor it was never told to use.**
  Each entry renders as `[n] (18 thg 8) title: snippet`, with the date resolved in the caller's
  time zone by `formatNoteDate`. `createdAt` is nullable and the function already renders no
  parenthesis at all rather than `(null)`.
- **`search_notes` reads `source_type` and does not return it.** The 0.8 provenance down-weight
  for `'assistant'` and `'web_search'` is inside the function
  (`00032_search_notes_created_at.sql`); the `returns table` clause stops at
  `note_id, title, snippet, created_at, score, matched_by`. `retrieve.ts`'s `SearchRow` and
  `Citation` therefore have no such field.
- **The promise was written in `00020` and never delivered.** `enums.ts` documents `'assistant'`
  as *"Down-weighted in retrieval (see search_notes) and cited as something you saved, never as
  your own thinking."* The first half exists. The second half has never had a mechanism.
- **`FORMAT_RULE` ties two independent axes together.** *"A short, casual question gets a short,
  conversational answer — two or three sentences of prose, no headings and no list"*
  (`prompts.ts:62-69`). Length is bound to structure: short↔prose, long↔headings. The missing
  cell is **long prose** — a substantive question that deserves depth and is not a list. With no
  cell for it, such a question falls into the casual branch and gets capped at two or three
  sentences. The fixed number compounds it: it is the most concrete instruction in the rule, and
  a model latches onto a number before it latches onto the word "casual".
- **The gap-filling disclaimer is a standing instruction**, not a conditional one
  (`prompts.ts:173-175`). It runs on every turn including turns where retrieval returned nothing
  — which, per the user, is most turns.
- **Saving an answer requires all four gates plus two model decisions.** `turn.ts:441` reads
  `if (wantsAnswer && searched && !incomplete && answer !== "")`. `searched` is the one that
  bites: an answer drawn from the user's own notes, or from the model's own knowledge without a
  web search, produces no offer at all — the comment names this as the cost ceiling. Past the
  gates, `proposeOffer`'s prompt states *"Returning null is the normal case and is always better
  than a weak offer"*, and past that a cosine ≥ `OFFER_DEDUP_THRESHOLD` (0.88) against any
  `'rejected'` or `'active'` memory fact suppresses it too.
- **Mobile has no offer path whatsoever.** `apps/mobile/src/screens/assistant-box.tsx` (245
  lines) contains no handling of the `offer` SSE event, no save button, and no decline. On the
  client the user uses most, an answer can never be kept.
- **The write and the claim about the write live on different sides.**
  `buildAcknowledgePrompt` carries *"Mention what you attached, briefly"*, and the server emits
  that line without checking anything: on web the note is written by `POST /notes` from
  `assistant-box.tsx` before the stream opens, and on mobile by `captureNote` into local SQLite,
  uploaded later by PowerSync. The assistant's "đã ghi nhận" is an assumption, not an
  observation.
- **The save endpoint already exists and is already sized for a whole reply.** `POST
  /notes/save-answer` (`notes.controller.ts:52`) takes `saveAnswerInput`, whose `statement` cap
  is **100_000** — deliberately matched to `createNoteInput` rather than to `OFFER_MAX_CHARS`.
  The 400 cap applies to an offer and to a decline, not to a save. `notes.controller.ts:47-51`
  anticipates a second caller by name.

### What was diagnosed and is NOT a bug

The user's report — assistant said "đã ghi nhận", `notes` was empty — resolved to expectation,
not defect. Their own message *was* written as a note. What they expected to find was the
**assistant's previous answer**, and no mechanism has ever saved that except the offer's accept
button, which had not fired. The hosted database was the right database and the web client was
the right client. No data was lost.

Two real problems survive that diagnosis, and both are in scope here: there is no user-initiated
way to keep an answer (§4), and the acknowledgement announces a filing whose content is the
user's own request text — technically true, and misleading in exactly the way that matters.

## Design

### 1. Scope, and the fact that it is two stages merged

This stage is two coherent pieces that were brainstormed separately and then merged **at the
user's explicit direction** — *"gộp cả 2 đi rồi tôi test 1 lần cho lẹ"*. The recommendation on
record was to keep them apart, and the reason stands: the prompt half can only be accepted by a
person reading replies and judging whether they sound better, so shipping a new feature in the
same merge means a favourable verdict cannot be attributed to either half. The user weighed that
and chose one test cycle. It is recorded here so a later reader sees a decision, not an
oversight.

The two pieces are:

- **Prompt and provenance** (§2, §3) — S1 §11.1, §11.5, §11.6, plus finding 4.
- **Keeping an answer** (§4) — finding 5, on both clients.

### 2. `source_type` leaves the database through `search_notes`

Two routes existed. The chosen one is a migration that adds `source_type` to the function's
`returns table`; the rejected one was a second query in `retrieve.ts` selecting `source_type`
for the ids the RPC returned.

**Why the migration, despite being the more expensive option.** The second query has no
acceptable failure branch. If it fails, `retrieve.ts` must either fail the whole turn — the
exact trade the file refuses one function above, where a `usage_ledger` outage is caught
precisely so *"a ledger outage must not turn a working turn into a failed one"* — or default
`authoredBy` to `"user"`, which silently reconstructs the bug being fixed here, intermittently
and with nothing in the logs. The migration has one query, one failure branch, and no state in
which the value is merely absent.

It is also where the data already is: the function reads `source_type` to apply the 0.8
down-weight, and then discards it.

**What the migration must do, and the trap it inherits.** Adding a column to `returns table`
cannot be done with `create or replace` — Postgres answers `cannot change return type of
existing function`. It must `drop` and recreate, which **discards the ACL**.
`00032_search_notes_created_at.sql` performed this same operation last month and left a header
explaining it; its `revoke execute ... from public` / `grant execute ... to service_role` footer
is not decoration. Without it the recreated function carries PostgreSQL's default grant to
`public`, on a `SECURITY DEFINER` function that reads `note_chunks` — a table with RLS enabled
and no policies precisely because nothing but this function should read it.

`_test_has_function_privilege` already exists (added by `00032` for exactly this risk) and is
how the grant is proven from `packages/db`'s suite, which reaches Postgres only through
PostgREST.

**This migration must also be applied to the hosted project.** That is a deploy step, not a code
change, and it gets its own named step in the plan rather than being folded into "run the
migrations" — `supabase db push` targets the hosted project by default, and the local/hosted
split has cost this repo before.

### 3. `prompts.ts`

#### 3.1 The bracket goes, and a date takes its place

All four sites change together. Three of them are what teaches the model to emit brackets; the
fourth is what models them in the input.

- `buildAnswerPrompt` (`:171`) — the standalone cite-by-number line is **deleted**.
- `buildAcknowledgePrompt` (`:222`) — *"say so and cite them like [1]"* becomes an instruction to
  say **when** they wrote it.
- `RECALL_RULE` (`:38`) — the second half stops requiring the bracket and starts requiring the
  anchor: name the date, or the title. **The first half is preserved verbatim.** It forbids the
  database-match framing (*"Trong các ghi chú của bạn [1, 3] có nhắc đến..."*, *"Đã lưu ghi chú
  của bạn vào mục..."*), it is working, and it is not what the user complained about.
- `renderCitations` (`:147`) — entries render as bullets, not `[n]`. Leaving numbers in the input
  while forbidding them in the output is a prompt arguing with itself, and the model will
  occasionally echo the very thing just banned.

**Why a date rather than nothing.** The bracket's stated justification was that it is the only
link between a claim and the note behind it. That justification describes an intent the product
never realised: nothing reads `[2]` back, so a *wrong* `[2]` is invisible to every party
including the user. A date is a link the user can check without any UI at all, and a wrong one is
immediately visible. It also preserves the pressure the bracket was applying — the model still
has to point at a specific retrieved row rather than produce a vague "bạn từng nói...". That
pressure is the real risk in dropping the bracket outright, and this is what answers it.

**When there is no anchor.** `createdAt` is nullable and `renderCitations` already handles that
by rendering no date. The rule must then fall back to the title, and if there is no title
either, mention **no anchor at all**. A fabricated date is worse than a bare recall.

**No internal marker survives.** The alternative considered was emitting a hidden marker,
stripping it from the SSE stream, and persisting parsed note ids for a future footnote UI. It is
rejected: stripping must happen mid-stream where a marker can be split across chunks, which is
new machinery on the one path that must not break, and it is paid for a UI that has now been
deleted twice (the note list inside `Provenance` on 2026-08-18, the whole note browser in S1). If
a footnote UI is ever built, re-adding a marker is a prompt line and a parser — not a migration.

#### 3.2 A saved answer is labelled as one

`SearchRow` gains `source_type`. `Citation` — the **internal** interface in `retrieve.ts`, not
the wire type — gains `authoredBy: "user" | "assistant"`, collapsed at construction:
`'assistant'` and `'web_search'` map to `"assistant"`, everything else to `"user"`.

**Why a binary field rather than the raw enum.** The distinction the model needs is "your words"
versus "my words". Passing all nine `noteSourceType` values into `prompts.ts` would make the
prompt path responsible for a vocabulary it does not use, and every future capture channel added
to the enum would become a thing someone has to remember to handle there. Collapsing at the
retrieval boundary means the enum can grow without the prompt path changing.

`renderCitations` labels the assistant-authored entries. `RECALL_RULE` gains one clause: never
recall your own past words as though they were something the user thought.

**`@cortex/shared`'s wire `Citation` is unchanged.** `Provenance` renders web sources only and
has no use for the field. The extra key will ride along into `chat_messages.citations` when
`turn.ts` persists `[...citations, ...webCitations]` — harmless, unread, and noted here so a
later reader finding it in the jsonb does not mistake it for debris.

**This cannot be validated against the real corpus.** Because saving an answer has until now
required the offer to fire, and the offer is gated as §"Current architecture" describes, the
user's corpus holds approximately zero `'assistant'` notes — which is also why the
misattribution has never actually been observed. The test must **seed** such a note. The plan
says so explicitly rather than leaving an implementer to look for data that is not there.

#### 3.3 Replies are allowed to be as long as the question deserves

`FORMAT_RULE` separates the two axes it currently fuses:

- **Length** — the fixed *"two or three sentences"* is removed. Depth follows the weight of the
  question: a passing remark gets a short answer, a real question gets a real answer.
- **Structure** — kept, close to verbatim. Headings and numbered lists remain the exception,
  reached for when the user asked to enumerate or compare or when the content genuinely is a set
  of parallel items. **The user did not complain about this half**, and the observed defect that
  created it (a casual "mỏi mắt ăn gì" answered with bolded section headers) is not a defect this
  stage wants back.

The result is that "long prose" becomes a shape the rule permits, which today it does not.

`buildAcknowledgePrompt` (*"one or two sentences"*) and `buildChitchatPrompt` (*"one short,
natural line"*) are loosened **inside their own sentences**. `FORMAT_RULE` is not extended to
cover them: the file already records why, and the reason holds — a second, differently worded
length rule gives the model two constraints to reconcile where it currently has one.

The direction for both, so this is not left to interpretation: each keeps its **purpose** clause
and loses its **counting** clause. An acknowledgement stays an acknowledgement — it must not
become an answer, and `buildAcknowledgePrompt`'s standing "the user did not ask a question" rule
is untouched — but it is no longer capped at a sentence count. Chitchat stays a conversational
line rather than a paragraph, without being pinned to exactly one.

`prompts.test.ts` continues to assert **each half of `FORMAT_RULE` separately**. That separation
exists because the exception clause is the half a later edit silently drops, and an edit that
loosens length is exactly such an edit.

#### 3.4 The "not from your notes" disclaimer moves into the branch that needs it

The instruction leaves the standing rule list and moves into `renderCitations`, which already
branches on precisely the three states that matter:

- **Citations present** — kept. This is the only case where the disclaimer does work: the reply
  mixes the user's material with outside material, and in a second brain a false "bạn từng
  viết..." costs more than a redundant hedge.
- **Empty** — dropped. There is nothing to confuse the outside material *with*. The branch's
  current text, *"The user has no notes matching this."*, is additionally rewritten to tell the
  model there is nothing to attribute **and not to announce the absence** — as written, it reads
  as an invitation to report it.
- **`"failed"`** — untouched, and not negotiable. That branch exists so the model never says
  "bạn không có note nào về chuyện này" on a turn where the search never ran. Dropping it here
  would convert a technical failure into a false assertion about the user's corpus. Its comment
  already spells this out.

*"Never present web content as the user's own thinking."* stays on every branch. It concerns
attribution of web material, not the absence of notes, and `Provenance` depends on that
obligation.

### 4. Keeping an answer, on purpose

A **"Lưu câu trả lời"** control under every assistant reply, on **web and mobile**.

The flow: tap → `POST /assistant/distill` (new route) → `{ statement: string | null }` → a box
showing the condensed statement with **Lưu** / **Bỏ qua** → Lưu calls the existing
`POST /notes/save-answer`.

**Why distil rather than save the reply verbatim.** Chosen by the user over saving raw text. The
cost is a model call and a wait after the tap; what it buys is a corpus of standalone facts
rather than transcript prose, which is what retrieval is built to rank.

**`offer.ts` splits.** The model call becomes a shared `distill()`; `proposeOffer` becomes
`distill()` plus the dedup; the four gates stay at their call site in `turn.ts` where `searched`
is already computed. Both paths must produce the same row shape, and `save-answer.ts` already
requires that the second path *"come through this same function, which is what makes the two
indistinguishable BY CONSTRUCTION rather than by discipline"*.

**A separate prompt for the on-demand path.** The existing one opens with *"The assistant just
answered a question using knowledge that was NOT in the user's own notes"*, which is false here —
the user may well want to keep an answer drawn from their own notes. And *"Returning null is the
normal case and is always better than a weak offer"* must not appear: on a path the user
deliberately invoked, null is a failure, not modesty.

**No dedup on this path.** Silence because the statement resembles something previously declined
would be indistinguishable from a broken button, with no way for the user to find out why.

**Cancelling here writes nothing.** Pressing "Bỏ qua" on this box must **not** write a
`memory_facts` decline. A decline exists to stop the assistant re-offering something on its own
initiative; recording one here would suppress future offers about a fact the user merely changed
their mind about keeping — fixing nothing and breaking something adjacent.

**No dead end.** If `distill()` returns null or fails, the box still opens, carrying the reply
verbatim, and the save still works. The endpoint's 100_000 cap is ample; no cap changes.

**Provenance is preserved.** A reply carrying web citations is saved with `sourceUrl`, producing
`source_type: 'web_search'` instead of `'assistant'` via the existing `buildSavedAnswerRow`. The
url is available from live turn state and, for a reply scrolled back to, from
`chat_messages.citations`.

**Metering.** The `distill()` call is recorded in `usage_ledger` like every other Gemini call on
this path, and a ledger failure is never fatal — the same trade `retrieve.ts` and `offer.ts`
already document.

**Mobile builds this from nothing.** `apps/mobile/src/screens/assistant-box.tsx` handles no
`offer` event today, so the same work delivers mobile its first automatic offer as well as the
manual control. This is deliberate: leaving mobile out again would repeat exactly the gap this
stage was created by.

**Two save affordances can appear on one reply**, when an automatic offer fired and the manual
control is also present. They mean different things — the offer's statement was chosen by the
assistant, the manual one by the user — and they must be labelled differently rather than shown
as two identical buttons.

### 5. Testing notes for the implementer

Every item below was chosen by asking *what one-line change would turn this red*. This repo has
shipped tests that could not fail, in every stage so far.

- **Provenance labelling** needs a seeded `'assistant'` note. The corpus has none, so a test
  reading real data would assert nothing.
- **The bracket's absence is asserted on the generated prompt**, not on the diff: the built
  prompt for a turn with citations must contain no `[1]`. A test that only checks one of the
  four sites passes while the model keeps emitting brackets.
- **`renderCitations` gets one test per branch**: empty must **not** contain the disclaimer,
  populated must, `"failed"` must keep its current text.
- **`FORMAT_RULE` keeps its two separate assertions.** The structure half must be asserted by its
  own test, which is the test that fails if a future length edit deletes the exception clause.
- **The migration's ACL** is proven through `_test_has_function_privilege`: `anon` must not hold
  `execute` on `search_notes` after the drop/recreate.
- **`distill()` returning null** must be shown to produce a usable box carrying the verbatim
  reply, not an error state.
- **"Bỏ qua" writes nothing**: count `memory_facts` rows before and after.
- **Not provable by any test**: whether the replies now read better, and whether they are now the
  right length. That is the user's judgement on a real device, and the plan states it as a named
  step rather than letting a green suite imply it. Both halves of `FORMAT_RULE` must be checked —
  a casual question that comes back as prose, **and** a request to enumerate that still comes
  back as a list.

### 6. Consequences accepted

**6.1 A favourable verdict cannot be attributed.** Merging the prompt work and the save feature
was the user's explicit call (§1). If replies feel better afterwards, nothing distinguishes "the
prompts improved" from "having a save button changed how I use it".

**6.2 The corpus will grow faster, and saved answers are only down-weighted, not excluded.** An
easy save button gets used. `'assistant'` and `'web_search'` notes rank at 0.8, which is a
tilt rather than a barrier, and a long saved answer becomes several chunks. Measurable later;
not pre-solved here.

**6.3 `OFFER_DEDUP_THRESHOLD` (S1 §11.3) is still unmeasured — but stops being unmeasurable.**
It could not be tuned because real declines were near zero, which this stage now explains: offers
require a web-grounded answer, and mobile had no offer path at all. Mobile gaining one, plus a
manual path, is what finally produces the data. The number does not move in this stage.

**6.4 The acknowledgement still speaks for a write it does not observe.** §"Current
architecture" records that "đã ghi nhận" is emitted by the server while the note is written by
the client. This stage does not close that; it only removes the case that made it visible, by
giving the user a real way to keep an answer. Naming it here so it is not later rediscovered as
a surprise.

## Out of scope

- S1 §11.2 — the declined-offer exclusion. It belongs to S4, which builds the consumer.
- S1 §11.4 — whether verification flagging is *useful*. A judgement over sustained use.
- S2, S3, S4 as recorded in S1 §10. Nothing here starts any of them.
- No change to routing, retrieval ranking, grounding, enrichment, embedding or the sweep. The
  only retrieval change is one column added to `search_notes`'s output.
- No change to `OFFER_MAX_CHARS`, `OFFER_DEDUP_THRESHOLD`, or the four gates in `turn.ts:441`.
  The automatic offer behaves exactly as it does today.
- No footnote UI, and no internal citation marker to feed one (§3.1).
- No conversational save command. *"ok note lại giúp tôi đi"* remains an ordinary note; the
  control in §4 is the mechanism, and teaching the turn to recognise a save intent is a
  different design with a different failure mode.
