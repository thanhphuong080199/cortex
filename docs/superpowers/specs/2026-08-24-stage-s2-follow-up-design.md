# Stage S2: the assistant asks a follow-up

Status: implemented 2026-08-24 (packages/core only, all 6 tasks reviewed and merged to this
branch). **Not yet verified against the local stack** — the local Supabase stack was unreachable
for the remainder of this session (a Windows Hyper-V TCP port-exclusion range covering Supabase's
default ports, unrelated to this change; see PR for detail). `pnpm turbo run lint typecheck`
passes repo-wide and every DB-independent test in `@cortex/core` passes (`follow-up.test.ts`,
`prompts.test.ts`, `turn.test.ts` in full, plus `extract.test.ts`'s prompt-only tests); the two new
`extract.test.ts` end-to-end tests and the manual chat-box walkthrough in §10 below are still
outstanding and should be run before this stage is considered verified.

The second of the three stages `2026-08-22-chat-only-shell-design.md` §10 left as decisions. The
order agreed there was S3 → S2 → S4. S3 is merged; this is S2.

§10 also said S2 was deliberately placed after S1 because "it edits the prompt path every single
turn passes through, and it should be judged against the new shell rather than at the same time as
it." That shell has now shipped and been through a bugfix round (`b79c62c`), so the condition is
met.

## Problem

§10's framing: `"hôm nay tôi mới đi xem phim"` should draw out *which film, and was it any good*
over a couple of turns, ending in a real `media_items` row. What is missing is "a rule permitting
one follow-up question when a record is obviously incomplete — and a ceiling on how often it may
ask, because an assistant that interviews the user about every passing remark is worse than one
that files it silently."

Two things are decided here that §10 did not name, and both turned out to matter more than the
rule itself: **which note ends up carrying the structure** (§1), and **what makes a record
incomplete enough to be worth a question** (§2).

## Current architecture (verified against `b79c62c`, 2026-08-24)

- **Every chat turn creates a note.** The client writes it locally first; `turn.ts:92` creates it
  server-side if the upload has not landed yet. So the turn that *answers* a follow-up produces a
  second note, and there is no path on which it does not. This is the fact §1 is about.
- **The classifier already sees the assistant's question.** `extractNote` takes
  `EnrichTarget.history`, and `buildPrompt` renders the last `CLASSIFIER_HISTORY_TURNS = 2`
  (`extract.ts:100`) under "Earlier in this conversation:". `turn.ts:136` reads history *before*
  the current user message is inserted, so the newest row is the assistant's previous reply.
- **`retrieval_meta` is already a per-message jsonb bag** — `{ requestId, incomplete, error? }`,
  written at `turn.ts:487` — and it is already selected by the history query at `turn.ts:136-138`.
  Nothing else reads it except the `incomplete` filter at `turn.ts:152`.
- **A session is idle-derived and immutable once stale.** `SESSION_IDLE_RESET_MS = 4 hours`
  (`packages/shared/src/assistant/session.ts:5`); past that gap `resolveCurrentSession` returns
  `null` and the next turn mints a new id.
- **`notes.media_item_id` exists and is owner-scoped.** Added by `00013`, given a composite FK
  `(media_item_id, user_id) -> media_items (id, user_id)` with `on delete set null (media_item_id)`
  by `00014`. It is nullable, so backfilling it later is an ordinary update.
- **`resolveNoteMediaLink` already does find-or-create and returns the item.**
  `packages/core/src/media/service.ts:139` parses `pending_item`, strips it from the meta, calls
  `findOrCreate` (case-insensitive reuse), links the note, and compensates if the link fails.
  `turn.ts:207-216` calls it and currently keeps only `item.title`.
- **`pendingMediaItem` requires both `kind` and `title`.**
  `packages/shared/src/dto/media.ts:25-29` — `title` is `z.string().min(1).max(500)`, not optional.
  And `domainMetaSchemas.media` is `.strict()` with `pending_item` optional
  (`packages/shared/src/dto/domains.ts:25`), so *omitting* `pending_item` is valid while
  *half-filling* it is not.
- **A failed meta parse drops the whole object, not the bad key.** `extract.ts:319` sets
  `meta = {}` when `safeParse` fails. See §3 — this is a live data-loss path, not only an S2
  blocker.
- **`@cortex/core` already has a named CI step** — `pnpm turbo run test --filter=@cortex/core`
  (`.github/workflows/ci.yml:203`). A new test *file* in that package therefore needs no workflow
  change. Recorded because the reverse case has bitten before.

## 1. Which note carries the structure

The user answers `"Interstellar, hay lắm"` and that answer is itself a note. Three options were
weighed; **the entity link is backfilled onto the original note, and both notes stay first-class
and recallable.**

| | Note 1 `"đi xem phim"` | Note 2 `"Interstellar, hay lắm"` |
|---|---|---|
| **Chosen** | `media_item_id` → Interstellar (backfilled) | `media_item_id` → Interstellar, rating in meta |
| Rejected: leave it | no link, permanently vague | carries everything |
| Rejected: merge | carries everything | made unrecallable |

**Why not "leave it".** The cost is not that note 1 stays vague — that is tolerable. The cost is
that the assistant's question and the user's answer end up with **no structural relationship at
all**; they are two notes that happen to be adjacent in time. Every later feature that asks "what
did they say about this film" then has to reconstruct the thread from timestamps. The assistant
asked the question, so a broken record is a debt the assistant itself created.

**Why not "merge".** It violates a constraint this project already wrote down for S4: *nothing may
be hard deleted — a wrong inference must be a mistake and not a loss.* Making note 2 unrecallable
is a loss the user cannot see, and it rests on an inference ("these two are one thing") that
sometimes will be wrong. It is also lossy in the specific: `"Interstellar, hay lắm"` is the
higher-information sentence of the two, in the user's own words, and merging pushes it out of the
corpus in favour of a structured residue. The `chat` / `chitchat` precedents (`00031`, `00039`) do
not license this — those exclude turns with *nothing worth keeping*, and this excludes the turn
worth keeping most.

**Why the link and nothing else.** `media_items` is the thing that accumulates; notes are the
timeline of what was said about it. That is what the table was for, and it has been sitting empty
of this use. So the backfill writes `media_item_id` and **not** `domain_meta`, and **never**
`content_text`. Note 1 said nothing about a rating; writing one into it would be putting words in
the user's mouth.

## 2. The trigger: only gaps whose answer creates an entity

The assistant asks **only when the missing field is one without which no entity can exist.**

Today that is exactly one case: `domain === "media"` with no `pending_item.title`. With no title
there is no `media_items` row, and the record is unusable later. A missing `rating` does **not**
qualify — the record works without it.

`health`, `finance`, `learning` never qualify, because they have no entity table; their
`domain_meta` is decorative jsonb that nothing reads back. `life` and `reflection` have empty
schemas by design.

The rule is narrow, but narrow **for a stated reason**, and it extends itself: any domain that
later gains an entity table inherits the trigger with no new policy. The alternative — asking
whenever any meta field is absent — fires constantly, which is precisely the condition that would
force an arbitrary quota to hold it back.

This also removes the need for the model to decide *whether* to ask. Code decides whether; the
model decides only how to phrase it (§4).

## 3. Prerequisite: the classifier currently forbids the state S2 detects

`extract.ts:125` tells the model:

> `- when domain is "media", domain_meta.pending_item is REQUIRED and looks like {...}`

Given `"hôm nay tôi mới đi xem phim"`, that leaves the model two bad moves: invent a title, or drop
`domain: "media"` to avoid breaking the rule. On the second, **S2's trigger never fires at all.**

The line must be replaced with one that makes "the text names no work" a *sayable* state: fill
`pending_item` when the text names a work, and omit it entirely otherwise while still returning
`media`.

This is not only an S2 enabler. Because `pendingMediaItem` requires `title` and `extract.ts:319`
drops the **whole** `domain_meta` on a failed parse, a half-filled `pending_item` today destroys
every sibling key — so `"xem phim, 8 điểm"` with no title loses the rating as well. Omitting the
key is valid where half-filling it is not. Fixing the instruction closes that leak independently of
anything else here.

A second, smaller addition to the same prompt: *when the turn below answers a question you asked in
the exchange above, classify it as though the two were written together.* The prompt already has
the mirror-image rule for short follow-up **questions** (`extract.ts:133-135`); this is the case
where the assistant asked and the user answered.

## 4. The rule, and its four exclusions

`buildAcknowledgePrompt` gains an optional `askAbout`. When present it renders one rule: ask a
single short question, at the end of the acknowledgement, without explaining why; if it goes
unanswered, never raise it again.

No new model call and no new `usage_ledger` row — the question rides inside the acknowledgement
that this branch was already generating.

It is excluded on four paths, and the third is the one most likely to be missed:

1. **The answer branch** (`wantsAnswer`). They asked something; answer it.
2. **`buildChitchatPrompt`**, which already forbids follow-ups.
3. **Whenever `verify` is true.** `VERIFY_RULE` (`prompts.ts:105-112`) explicitly says "do not ask
   a follow-up, do not invite a reply". Rendering both rules puts two contradictory instructions in
   one prompt, and the model will occasionally obey the wrong one. Correcting a false factual claim
   outranks curiosity about a film title.
4. **A degraded or timed-out extraction** (`extracted === null`, `turn.ts:198`). No classification
   means no knowledge of any gap.

## 5. Where the pending question lives

On the assistant message that asked it:

```
chat_messages.retrieval_meta = {
  requestId, incomplete, error?,
  asked?: { noteId, field },   // this turn asked a follow-up      (§5)
  answeredAsk?: true,          // this turn answered one, and backfilled (§8)
}
```

No new table and no migration. Three reasons, and the second is the load-bearing one:

1. `retrieval_meta` is already selected by the history query (`turn.ts:136-138`), so reading the
   pending question costs no extra round trip.
2. **It expires correctly by construction.** The question dies when the session does — four hours
   idle and `resolveCurrentSession` mints a new id, so the record is unreachable. There is no
   expiry policy to invent, and therefore none to get wrong.
3. `retrieval_meta` is already the per-message bag; these are its fourth and fifth keys, not a new
   concept. The two are mutually exclusive on any one message — a turn either asks or answers.

**`asked` records an instruction, not an observation, and must be written honestly.** We know we
told the model to ask; we do not know that it did. So `asked` is written only when the streamed
answer contains a `?`. That is a heuristic, and both of its failure directions are harmless: a
rhetorical `?` records a question that was not asked (the next turn simply finds nothing to
backfill), and a question phrased without `?` is not recorded (no backfill, nothing broken).

## 6. Recognising and applying the answer

`historyRows[0]` is the message immediately preceding this turn. If it is an assistant message
carrying `asked`, this turn is the answer.

**`[0]`, never `find()`.** That single choice implements "ask once, never nag" structurally: a
question can only be answered by the very next turn, so a user who says something else has ended it
with no counter, no timeout and no decision to make.

After `extractNote` returns and `resolveNoteMediaLink` has produced the item for note 2:

```ts
await userDb.from("notes")
  .update({ media_item_id: item.id })
  .eq("id", pending.noteId)
  .is("deleted_at", null)      // a note trashed mid-conversation is not linked
  .is("media_item_id", null);  // never overwrite a link that already exists
```

`userDb`, so RLS is what proves ownership — `pending.noteId` comes out of a jsonb column and is
not re-validated anywhere else.

`turn.ts:207-216` currently keeps only `item.title` from the resolve call; it must keep the item.

If the classifier does not return `media` for the answer turn — the user said "à quên mất tên rồi",
or changed the subject — no item exists, nothing is backfilled, and the pending question lapses.
That is the correct outcome and needs no special case.

## 7. The ceiling

One condition: **if `historyRows[0].retrieval_meta.asked` exists, this turn does not ask.**

That covers both halves of what §10 asked for — never while a question is outstanding, and never
two turns running — with no number in it. A quota such as "at most N per day" was rejected as a
workaround for a trigger that fires too often; §2's trigger does not fire often, because writing a
`media` note that names no work is rare. `OFFER_DEDUP_THRESHOLD`'s own comment states the hazard
being avoided: "a number invented at design time would be a number nobody later dares to change
because it looks decided."

If measurement (§8) later shows the cooldown is too weak, a quota can be added **from data**. That
is a different thing from inventing one now.

## 8. Measurement

When a backfill succeeds, the new assistant message records `answeredAsk: true` in its
`retrieval_meta`. One query over `chat_messages` then answers both questions that tuning needs: how
often it asked, and how often the question was answered.

This exists because S1.5 recorded the opposite experience — offers "were too rare to measure", and
nothing had been instrumented to find out. The cost here is one boolean.

## 9. What this does not touch

- **No migration.** Nothing in §1–§8 needs a schema change.
- **No client change**, web or mobile. The question is text inside the streamed reply, and both
  clients already render it.
- **No new model call**, so no new `usage_ledger` row and no change to `isOverBudget`.
- **No new SSE event.** Note 1 is not on screen as a card in a chat-only shell, so the backfill has
  nothing to announce. A `mark()` line in the timing log is enough.
- **No queue of things the assistant wants to know.** Asking later, at a better moment, sounds more
  ambitious but destroys the thing that makes the answer easy to give: the user answers because
  they are still thinking about the film. S2 asks in the turn or not at all.

## 10. Testing

Each test below is followed by the one-line implementation change that must turn it red. This
project's recurring defect is tests that cannot fail, and every Stage C1 task shipped one.

**`follow-up.test.ts`** (new file, `packages/core/src/assistant/`)

- `media` with no `pending_item` → gap. *Red when:* the detector's domain check is inverted or the
  media branch is removed.
- `media` with `pending_item.title` present → no gap. *Red when:* the detector stops reading
  `title` and returns a gap for every media note.
- `media` with `pending_item` present but `title: ""` → gap. *Red when:* the check is
  `pending_item !== undefined` rather than a check on the title.
- `health` / `finance` / `learning` with empty meta → no gap. *Red when:* the rule is widened from
  "entity-creating" to "any missing field".
- `domain: null` → no gap. *Red when:* the null guard is dropped.

**`prompts.test.ts`**

- The rule appears when `askAbout` is passed and is absent when it is not. *Red when:* the rule is
  concatenated unconditionally.
- The rule and `VERIFY_RULE` never appear in the same prompt. *Red when:* §4's exclusion 3 is
  dropped. This test must assert on a call with **both** `verify: true` and `askAbout` set —
  asserting on a `verify`-only call passes for the wrong reason and proves nothing.

**`turn.test.ts`**

- A vague media turn builds an acknowledge prompt carrying the rule, and writes `asked` into
  `retrieval_meta` — *only* when the fake model's reply contains `?`. Two cases, one with and one
  without. *Red when:* `asked` is written unconditionally.
- The answering turn links note 1 and note 2 to the **same** `media_item_id`. Asserting note 1's
  link is merely non-null passes even when the backfill creates a second item, which is the actual
  bug worth catching.
- The turn immediately after an ask does not ask again. *Red when:* §7's condition is removed.
- A degraded extraction (`withDeadline` timeout) never asks. *Red when:* §4's exclusion 4 is
  dropped.
- The backfill does not fire for a note that already has a `media_item_id`. *Red when:* the
  `.is("media_item_id", null)` filter is removed.

## 11. Deferred, with reasons

- **Domains beyond `media`.** Automatic once a second domain gains an entity table; no policy
  change required (§2).
- **A quota**, if §8's data shows the cooldown is insufficient (§7).
- **Note 1's `domain_meta`.** The backfill writes the link only. Whether an answer should also
  enrich the original note's meta is a question about editing a user's record, and it deserves its
  own decision rather than riding along with this one (§1).
- **More than one question per record.** "Phim gì" and "hay không" are two gaps; only the first
  qualifies under §2, and asking both at once was excluded by §4's "a single short question". If
  the rating turns out to matter, the honest route is a second entity-creating gap, not a longer
  question.
