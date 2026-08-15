# Stage C2 — the box on mobile: one input, three widgets retired, and an answer that survives airplane mode

**Design, 2026-08-15.** Takes `2026-08-12-stage-c1-assistant-box-design.md` §1's "Mobile (→ C2)"
and makes it the whole stage. Read C1 §4 (the turn), §6 (the SSE contract) and
`2026-08-10-phase-2-3-assistant-design.md` §3 (the ten pre-design rulings) first; this spec does
not repeat them.

C1 is merged (PR #15) and its handoff is `docs/superpowers/plans/2026-08-15-stage-c1-HANDOFF.md`.
Read that too — four of its deferred findings are load-bearing here, and one of them (the shared
budget aggregate) is promoted into this stage's scope by §7.

---

## 1. What C2 is, and what it is not

| | |
|---|---|
| **In** | The box on the mobile home screen, **replacing all three of `QuickCapture`, `CheckinWidget` and `MediaLogForm`**; `POST /assistant` gaining get-or-create so a note that exists only in local SQLite can still be answered; SSE over `expo/fetch`; an offline answer read from the local FTS5 index; the AI writing `checkins` rows directly with an Undo; media identity resolved for AI-classified notes; the usage RPC learning to tell one budget from another (§7) |
| **Out of C2** | Accept/reject chips (→ stage D). Web grounding and the Search-Suggestions UI (→ C3). iOS. **Conversation history on device.** Any change to the web box |

**Conversation history is out, and it is a product limitation worth stating plainly.**
`chat_sessions` and `chat_messages` are absent from `packages/sync/src/sync-rules.yaml`, whose
header documents absence-by-omission as deliberate. So the mobile box shows *the current turn
only* — there is no scrollback, and there is nothing to scroll back to offline. The rolling
4-hour thread still works, because it lives on the server and `runTurn` reads it there; the user
simply cannot see it. Putting chat into the sync rules is a bucket-size and a privacy decision,
not a UI one, and it belongs to its own stage.

**The web box does not change.** Under §3 it *could* drop its separate `POST /notes` and save a
round trip, but C1 built a deliberate split between `error` (nothing was saved — keep the text)
and `status` (saved, no answer), and that split is exactly what collapses if the save and the
stream become one request. Recorded in §9 as a possible later simplification, not done here.

---

## 2. Why one stage rather than two

Splitting this into C2a (port the box) and C2b (the AI owns mood and media) was recommended and
was overruled: the stage ships as one. The reason to record here is what that costs, so the risk
is visible to whoever executes it rather than discovered in review.

Porting the box alone touches `apps/mobile` and one DTO. Retiring `CheckinWidget` and
`MediaLogForm` turns it into server work: **check-ins are not notes** (`packages/core/src/checkins/service.ts`
header: "they never touch the notes table, the inbox, or FTS"), and nothing in the enrichment
path emits a mood at all. Media is worse — identity is resolved in exactly one place,
`apps/api/src/sync/router.ts`, at *upload* time, while the AI fills `domain_meta` later at
*enrich* time, so an AI-classified media note reaches the resolver after the only window in which
the resolver runs. §5 and §6 are the consequences.

The mitigation is ordering, not scope: §8 puts the streaming spike first and the widget removals
last, so the stage has a shippable subset at every point after task 4.

---

## 3. The turn on mobile

### 3.1 Where the code goes

```
apps/mobile/src/screens/assistant-box.tsx        render only
apps/mobile/src/lib/assistant/stream.ts          the decisions of one turn
apps/mobile/src/lib/assistant/offline-answer.ts  the FTS5 branch
packages/shared/src/sse.ts                       readEvents, shared with web
```

The split is not stylistic. The mobile vitest project runs `environment: node`, and any module
that reaches React Native fails as a Rollup Flow parse error deep inside the RN sources — which
is why `capture.ts`, `checkins.ts` and `semantic-search.ts` already exist as logic files beside
their screens. A `.tsx` is the one place this app cannot put a test on, so nothing that can be
wrong may live in one.

`readEvents` moves to `@cortex/shared` rather than being copied. Its four subtleties — holding the
buffer tail across chunk boundaries, normalising `\r\n`, flushing `decoder.decode()` with no
argument so held multi-byte bytes are released (**the answers are Vietnamese**), and
`reader.cancel()` rather than `releaseLock()` in `finally` — are each a bug someone already paid
for once in `apps/web/src/app/assistant-box.tsx`. Two copies means paying twice.

### 3.2 The sequence

1. `const id = randomUUID()` from `expo-crypto`. The precedent is `logCheckin`, which generates
   client-side precisely because the caller needs the id back to offer an undo.
2. `captureNote(db, { content, domain: null }, id)`. `CAPTURE_NOTE_SQL` swaps `uuid()` for `?`.
   **This is the deliverable.** Everything after it is a bonus.
3. Clear the input, as soon as the local INSERT resolves. This is *faster and strictly safer* than
   web, where the box is cleared only after `POST /notes` returns over the network.
4. Branch on connectivity (§4).
5. Two taps inside one frame are blocked by the existing `createInFlightGuard()`, not by a
   `busy` state flag — state does not change within a frame, and two INSERTs are two notes.

A failed local INSERT is the **only** case in this design where text can be lost, so it is the
only one that keeps the text in the box and says so, reusing `QuickCapture`'s existing copy. Every
other failure — offline, 404, budget declined, a dead stream, `expo/fetch` not streaming at all —
costs the answer and never the note.

### 3.3 Why the id must be client-generated

`CAPTURE_NOTE_SQL` uses SQLite's `uuid()`, registered by the PowerSync core extension, so the
client never learns what id it just wrote. That is fine for a capture box and fatal for this one:
§5 needs to name the note in the request that asks for an answer about it, before PowerSync has
uploaded anything.

---

## 4. Offline: answering from the local index

Offline, the box still captures, and still answers — from `notes_fts`, the FTS5 virtual table
`apps/mobile/src/lib/fts.ts` maintains with triggers on `ps_data__notes`. No AI, no cost, no
queued request that fires later and surprises someone.

```
toFtsQuery(text) → select id, snippet(notes_fts, 1, '', '', '…', 12) from notes_fts
                   where notes_fts match ? limit 3

```

**`toFtsQuery` (`packages/shared/src/notes/filters.ts`) is reused, not reimplemented.** Raw user
text handed to `MATCH` is an FTS5 *syntax error* the moment it contains a quote, a `-`, a `*` or a
`:` — and Vietnamese notes contain punctuation like everyone else's. The same helper already
guards the note-list filter path, so there is one escaping implementation and one place to fix it.

Two branches follow from it, and both must be handled:

- A query that escapes to a non-empty term: *"Không có mạng — N ghi chú của bạn khớp với câu
  này"*, plus the snippets. Distinct from "no results", which is a different fact.
- A query that escapes to `""` (whitespace, or nothing but punctuation): `match ''` is itself a
  syntax error, so the FTS read is skipped entirely and the box says only *"Đã lưu"*.

Note that `notes_fts` deliberately indexes soft-deleted notes (`fts.ts`), so an offline answer can
cite something the user has trashed. Left as-is for C2 — the trash view relies on those rows being
present, and filtering them here means joining against `ps_data__notes` on every offline answer.
Recorded in §9.

The offline branch is also the **fallback for every online failure**, not just for a missing
connection: a fetch that throws, a non-2xx, or a stream that dies before the first token all land
here. An offline-shaped answer is always better than an error message, because the local index is
present either way.

---

## 5. `POST /assistant` learns get-or-create

`runTurn` opens by reading the note (`packages/core/src/assistant/turn.ts:53`):

```ts
const { data: note, error: noteErr } = await userDb
  .from("notes").select("id, content_text").eq("id", args.noteId).maybeSingle();
if (noteErr || !note) { yield { type: "error", message: "note not found" }; return; }
```

On mobile the note is **always** missing on the first turn: it exists in local SQLite and
PowerSync has not uploaded it yet. So `assistantInput` (still `.strict()`) gains two optional
fields:

```ts
content:   z.string().min(1).max(100_000).optional(),   // createNoteInput's cap, referenced not restated
createdAt: z.string().datetime().optional(),
```

and `runTurn`, on a miss with `content` present, calls
`notes.createWithId(noteId, { content, createdAt })` through **`userDb`** — the user id comes from
the verified JWT and RLS is the enforcement, exactly as the rest of the turn works. A miss without
`content` still yields `note not found`, so nothing about the web path changes.

**Why this is safe against the PowerSync PUT that arrives later.**
`NoteService.createWithId` (`packages/core/src/notes/service.ts:76`) is create-if-absent: on a
`23505` it re-reads the row by id and user_id and returns it. It never overwrites. So whichever of
the two writers arrives first wins, the second is a no-op, and the enrichment this turn performs
cannot be clobbered by a sync upload of the device's original, unenriched copy.

`content` is sent as a convenience for creation only — once the row exists, the turn's text comes
from `content_text` in the database and never from the caller's copy of it. That invariant is why
the read stays where it is instead of being replaced by the request body.

### 5.1 Two fixes that C2 makes non-optional

- **`attached` carries a real `domainMeta`.** `turn.ts:128` hardcodes `domainMeta: {}` while
  `extractNote` has just computed and stored the real thing. On web that was cosmetic; here it is
  the difference between the box being able to say what it filed and not (§6).
- **`sessionId` ownership is checked.** A client-supplied `sessionId` is currently trusted, so the
  history read at `turn.ts:77` is scoped by session alone. One `.eq("user_id", args.userId)` on
  the session lookup closes it. C1 deferred this; C2 is what turns `/assistant` into the only
  write path a mobile client has, which is what makes it worth a line of code now.

The SSE contract becomes `attached | citations | token | mood | declined | done | error`.

---

## 6. Mood and media: the AI does the filing

### 6.1 Mood

`RESPONSE_SCHEMA` in `packages/core/src/enrich/extract.ts` gains:

```
mood: { type: "integer", nullable: true }   // 1..5, matching checkins_mood_or_energy (00013)
```

with a prompt rule that it is filled **only** when the text states how the person feels, and is
`null` on any inference. `extractNote` returns `mood` alongside the `domainMeta` it already
computes but currently discards.

The row is written by `turn.ts`, not by `extractNote`, and the distinction matters: the 60-second
sweep runs `extractNote` too, and a sweep that writes check-ins would manufacture mood history for
old notes at arbitrary times, with no screen to undo it on.

```ts
if (extracted?.mood != null) {
  const id = randomUUID();
  await new CheckinService(userDb, args.userId)
    .createWithId(id, { mood: extracted.mood, createdAt: note.created_at });
  yield { type: "mood", checkinId: id, mood: extracted.mood };
}
```

`created_at` is the note's, not now(): the check-in belongs to the moment the thought was
captured, which offline can be hours before the turn runs.

### 6.2 Undo, and why the client mirrors the row

The naive Undo is broken, and it is worth writing down why so nobody simplifies it back.

The server creates the check-in; replication is a beat slower than a thumb. `UNDO_CHECKIN_SQL`
(`DELETE FROM checkins WHERE id = ?`) run against a local database that has not yet received the
row matches nothing, PowerSync queues no operation at all, the server keeps the row — and moments
later the check-in the user just undid appears on screen.

So on receiving the `mood` event the client **inserts its own copy locally with the id the server
sent**. The PUT that follows lands in `createWithId`'s `23505` branch and is a no-op; the two
writers converge on one row by construction. Undo is then the existing hard local DELETE, whose
whole path is already built and tested: PowerSync emits a `DELETE` op, `sync/router.ts` maps it to
`checkins.softDelete`, and `sync-rules.yaml`'s `deleted_at IS NULL` filter on checkins — which
exists for exactly this asymmetry, and says so — keeps the tombstone from replicating back down.

Web's Undo needs none of this: `DELETE /checkins/:id` already exists
(`apps/api/src/checkins.controller.ts`).

### 6.3 Media

The first draft of this design assumed `resolveNoteMediaLink` could simply be called later. It
cannot, and the reason is the whole problem: that method returns `null` unless
`domain_meta.pending_item` is present, and `pending_item` is *device scaffolding* the model knows
nothing about. Left alone, an AI-classified media note gets `{rating, status}` and never links.

So the extract prompt learns it: when `domain` is `media`, fill
`pending_item: { kind, title, year }` from what the text actually names.
`domainMetaSchemas.media` already accepts the field, so no schema changes — the strictness that
would have rejected it is the same strictness that documents it.

`resolveNoteMediaLink(noteId, meta)` is then called at **two call sites, after `extractNote`
returns**: the sweep, and `turn.ts` immediately after the `attached` yield. Deliberately *not*
inside `extractNote`, because in `turn.ts` that call is wrapped in
`withDeadline(…, EXTRACT_DEADLINE_MS)` = 4s — a slow `findOrCreate` would turn into
`attached: degraded`, trading the classification for a link. A throw from the resolver is logged
and swallowed: the note and its tags are already on screen, and `media_unresolved` exists for the
sync path, not this one.

### 6.4 The library can get dirty, so the box says what it did

`media_items` identity is `(user_id, kind, lower(title))` and there is **no delete surface for
`media_items`** — `MediaService.compensateIfCreated` exists because of that, and only covers a
failure in the same call. A model that writes "Inception (2010)" once and "inception 2" the next
time leaves two permanent library rows, silently, because `findOrCreate` cannot tell a new title
from a mistyped one.

C2's answer is the cheapest thing that makes the failure visible rather than silent: the
`attached` line **names the item it linked** — *"Đã ghi vào thư viện: Inception (2010) · 8.5/10"*.
No correction affordance; accept/reject chips are stage D. This is nearly free given §5.1 already
has to put real `domainMeta` on the event.

The rejected alternative was link-only-to-existing-items, holding unknown titles as `pending_item`
until stage D approves them. It keeps the library provably clean and it makes the feature silently
do nothing in its single most common case — the first time you log something new.

---

## 7. The budget aggregate, promoted into scope

C1's handoff deferred this: `usage_month_to_date_usd` (migration `00021`) sums `cost_usd` across
every `kind` and every `source`, so `ENRICH_MONTHLY_BUDGET_USD` and
`ASSISTANT_MONTHLY_BUDGET_USD` are two thresholds read off **one total**. Migration `00027` added
the `source` column to fix it; the RPC does not use it.

C2 is what makes it hurt. Capture on mobile costs nothing in the moment today. After this stage
every submission pays a classification and a retrieval embedding, and a question pays an answer
(~$0.009) on top — on the device where capture actually happens. The first symptom of leaving this
alone is `declined: budget` on the assistant while the enrichment sweep is what spent the money,
which is indistinguishable on screen from the assistant being broken.

One migration: `usage_month_to_date_usd` takes a `p_source` argument and filters on it, and
`isOverBudget` passes `"assistant"` from the turn and `"sweep"` from enrichment. The two
thresholds then mean what their names say. A null `p_source` keeps the old whole-total behaviour
for any caller that wants it.

---

## 8. Order of work

The stage is one PR; the ordering is what keeps it recoverable.

1. **Spike: does `expo/fetch` stream on a real Android development build?** Call `/assistant`,
   count the chunks. Expo Go cannot answer this. If the body arrives as one piece, the contract
   grows a non-streaming JSON response and the box shows a thinking state instead — and learning
   that at task 1 is far cheaper than learning it at task 8.

   **Spike result 2026-08-15:** not run — no Android device or emulator was available in the
   implementation environment. By explicit ruling, the streaming design below stands unverified
   on a real device rather than blocking the rest of the stage on hardware access. Task 6 ships
   the streaming implementation as written; the risk this defers is a box that renders a "thinking"
   state for longer than expected rather than token-by-token, if a real device turns out to
   buffer the body — not a crash, and cheap to catch on the first real device run.
2. `readEvents` → `@cortex/shared`, with the web box importing it (behaviour unchanged).
3. `captureNote` takes an id; `assistantInput` takes `content`/`createdAt`; `runTurn`
   get-or-creates. Server-side, testable, nothing on screen yet.
4. `offlineAnswer` against `notes_fts`.
5. The box itself, online + offline, replacing `QuickCapture` only.
6. `mood` through extract → `turn.ts` → the `mood` event → the client mirror → Undo. Remove
   `CheckinWidget`.
7. `pending_item` in the extract prompt, both resolver call sites, the item name on `attached`.
   Remove `MediaLogForm`.
8. The usage RPC's `source` filter (§7).
9. Maestro flows (§9.2).

After task 5 the stage is shippable at any point; tasks 6 and 7 each retire one widget and are
independent of each other.

---

## 9. Testing, and what makes each test able to fail

The recurring defect this repo has shipped ten times is a test that cannot go red. Every test
below is stated with the one-line implementation change that must break it.

| Behaviour | Package | Turns red when |
|---|---|---|
| `captureNote` writes the id it was given | `apps/mobile` | the SQL goes back to `uuid()` — the returned id no longer matches any row |
| `offlineAnswer` escapes its query | `apps/mobile` | `toFtsQuery` is dropped — a query containing `-` raises an FTS5 syntax error |
| `offlineAnswer` skips an empty query | `apps/mobile` | the empty-term guard is removed — `match ''` raises |
| `runTurn` get-or-creates | `apps/api` e2e | the create branch is removed — an unsynced noteId yields `note not found` |
| a later PUT does not clobber the enriched note | `apps/api` e2e | `createWithId` overwrites instead of returning the existing row |
| mood reaches `checkins` | `packages/core` | the `createWithId` call is dropped while `mood` is still returned — the table stays empty |
| the check-in carries the *note's* `created_at` | `packages/core` | `createdAt` is omitted — the row lands at now() |
| an AI-classified media note gets a `media_item_id` | `packages/core` | either resolver call site is removed |
| `attached` carries real meta and the item name | `apps/api` e2e | it goes back to `domainMeta: {}` |
| the two budgets are independent | `packages/db` | the RPC's `source` filter is removed — enrichment spend declines an assistant turn |

**Every new suite must be named in `ci.yml`'s `checks` job.** It filters per package, so an
unnamed suite runs on one laptop and nowhere else. The step is added in the task that creates the
suite, not afterwards.

Gates run through turbo (`pnpm turbo run test --filter=<pkg>`) — `shared` and `core` resolve as
compiled `dist/`, so `pnpm --filter <pkg> test` tests something else. Read the `Cached:` line
before claiming a gate passed; with Docker down, `26/26 successful` has been 23 replays.

### 9.2 Maestro

`02-online-basics.yaml` and `04a-offline-actions.yaml` tap `capture-input` / `capture-save`
directly and assert on the mood widget's `"Mood 4 of 5 — good"` label, and
`scripts/assert-offline-results.js` checks both the double-tapped Save and the mood undo against
the database. **They break by construction** — rewriting them is work inside the stage, not
fallout from it. The two database assertions survive unchanged; only the taps that produce them
move to the box. Three flows are enough:

- type → the note appears in the list, in airplane mode, with no server involved;
- type → an answer streams in;
- a note that states a mood → the mood line appears → Undo → the row is gone.

`e2e-mobile.yml` is `workflow_call`-only, invoked from `post-merge.yml` — **it cannot fail this
PR.** So a stale flow costs nothing until the moment it costs it on `main`, and the flows have to
be right before the merge rather than after the first red run. Task 9 sitting last in §8 is safe
for that reason and for no other.

Each Maestro fix round costs an APK build (issue-log E3), so the rule is that the logic is green
under vitest first and Maestro only confirms the wiring. And read the artifacts before blaming
sync: a header taller than the viewport, the keyboard covering the rows, and whole-text regex
selectors have each cost a day already.

---

## 10. Open items, recorded rather than solved

- **Offline answers can cite trashed notes**, because `notes_fts` indexes soft-deleted rows on
  purpose. Filtering means a join against `ps_data__notes` on every offline answer.
- **The web box could drop its separate `POST /notes`** once §5 lands, saving a round trip at the
  cost of C1's `error`/`status` split.
- **Chat history on device** — a sync-rules and privacy decision, its own stage.
- **Prompt injection**: user text and retrieved snippets are still concatenated into prompts
  undelimited (C1 handoff). Unchanged by C2, and C2 increases the volume flowing through it.
- **`CoreErrorFilter` logs `JSON.stringify(cause)`**, including PostgREST `details`/`hint`, which
  can carry note content. Unchanged by C2.
- **`complexity`** is still recorded by extract and read by nothing.
