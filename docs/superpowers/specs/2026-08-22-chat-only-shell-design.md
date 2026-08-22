# Stage S1: the chat-only shell

Status: designed and approved by the user on 2026-08-22. Not implemented.

This is the first of three stages agreed in the same session. The other two are recorded in §10
so they are inherited as decisions rather than rediscovered as gaps.

## Problem

The user's verdict, 2026-08-22: the mobile UI is ugly, they have no need to browse their own
notes, and when they want to find something they will ask the assistant rather than search. So
the note browser and the search UI should not be on screen at all — on either client. What they
want is one chat box, the way ChatGPT presents one.

This is not a new direction. `2026-08-10`'s ruling already said the target is one input box and
that structure is extracted rather than captured; phase 1c's forms were always the half that was
never meant to survive. Stage C1–C5 built the assistant turn underneath. This stage removes what
the assistant made redundant.

## Current architecture (verified against `4968ea0`, 2026-08-22)

- **Web** renders `AppShell` (a drawer on narrow screens) with `Sidebar` on one side and
  `AssistantBox` on the other. `Sidebar` holds `CheckinWidget`, `MediaLogPanel`, the view chips
  (`NOTE_VIEWS`), the domain chips (`noteDomain.options`), a GET search form, `NoteList`, an
  `ExportButton` and sign-out. `page.tsx` does two independent reads: `notes` (narrowed by
  `applyNoteFilters`) for the sidebar, and `chat_messages` for the pane.
- **The web transcript is bounded by session and by count.** `page.tsx` finds the newest
  `chat_messages` row, passes it to `resolveCurrentSession`, and reads at most
  `TRANSCRIPT_LIMIT = 200` messages of that session. Past the 4-hour idle gap the thread is
  simply gone from the screen.
- **Mobile has no transcript at all.** `apps/mobile/app/index.tsx` renders `NoteList` with
  `AssistantBox` as its list header and export/sign-out as its footer. `AssistantBox` holds one
  turn in component state and clears every field on the next submit, so the previous exchange is
  destroyed rather than scrolled away. Stage C4 §2 left this deliberately out.
- **`chat_messages` is written only by the server.** `turn.ts` inserts the user's row before
  streaming and the assistant's row after. The table is client-writable at the grant and policy
  level (`00006`), but no client writes it.
- **`chat_messages` does not replicate.** It is absent from `packages/sync/src/sync-rules.yaml`,
  from `packages/sync/src/schema.ts`, from `SYNC_TABLES`, and from the `powersync` publication.
- **`SYNC_TABLES` is doing two jobs.** Its doc comment says it plainly: *"Tables PowerSync
  replicates to Android clients, and therefore the only tables POST /sync/upload will write."*
  `syncOp.table` is `z.enum(SYNC_TABLES)`, so the download list and the upload allow-list are the
  same six names. Three suites read it: `packages/sync/src/schema.test.ts`,
  `packages/db/src/test/sync-rules-isolation.test.ts` (against the YAML *and* against the live
  publication), and the DTO itself.
- **Markdown never shipped on mobile.** PR #24 touched no mobile file. `assistant-box.tsx` still
  renders `<Text testID="box-answer">{answer}</Text>`, and no markdown dependency is in
  `apps/mobile/package.json`. Task 6's spike was never run, so `**Cá hồi**` still reaches the user
  as two literal asterisks.
- **The Maestro suite is built almost entirely on surfaces this stage deletes** — see §7, which
  is the largest single piece of work here and the one most likely to be underestimated.

## Design

### 1. What is deleted

**Web.** `sidebar.tsx`, `app-shell.tsx`, `note-list.tsx`, `checkin-widget.tsx`,
`media-log-form.tsx`, `media-log-panel.tsx`, `export-button.tsx`, the `search/` route (page,
client, form and its test), the `notes/[id]/` route (page, editor, tag-chips),
`lib/note-views.ts` and its test, and `lib/checkin.ts` / `lib/use-debounced-save.ts` once nothing
imports them.

**Mobile.** `screens/note-list.tsx`, `screens/note-editor.tsx`, `screens/export-button.tsx`,
`app/notes/[id].tsx`, `lib/export.ts`, `lib/note-edits.ts`, `lib/edit-base.ts`.

**Kept despite having no UI:** `lib/fts.ts` and `lib/semantic-search.ts`. `offline-answer.ts`
calls them to answer from the local index when the network is down. That path is now the *only*
thing standing between the user and a dead app on a plane, so it gets more important here, not
less.

**The API is not touched.** `POST /notes`, `/notes/search`, `/checkins`, `/media` and the export
endpoint all survive with no caller on the clients. Deleting UI is an afternoon to reverse;
deleting endpoints is a migration to reverse. They stay until something needs them gone.

### 2. Web: one column

`page.tsx` loses the entire notes read, `applyNoteFilters`, `href`, `domainHref` and the filter
parsing. What remains is the auth check and the transcript read.

The layout is a single column, `max-width: 720px`, centred; a sticky header carrying only the
product name, a connection indicator (§6) and a `⋮` menu whose sole item is sign-out; and a
composer pinned to the bottom that grows with its content. Enter sends, Shift+Enter breaks the
line.

The user's message renders as a right-aligned bubble. The assistant's reply renders with **no
bubble**, running the full column width. This is the ChatGPT/Claude shape the user chose, and it
is also the shape `FORMAT_RULE` assumes: a reply that was allowed to use a table or a numbered
list needs the width. The `.bubble .markdown` rules added in the previous stage carry over
unchanged.

### 3. One continuous thread, not a session

The session boundary comes out of the **UI only**. `resolveCurrentSession` stays exactly where it
is in `turn.ts` — it decides how far back the model's prompt reaches, which is a modelling
decision and not a display one. Removing it there would silently widen every prompt's history.

The display query becomes: `chat_messages` for this user, `created_at desc`, 30 rows; reaching
the top of the scroll loads the next 30 by a `created_at` cursor. The index this needs already
exists — `chat_messages_user_idx (user_id, created_at desc)`, added in `00027`, so the pagination
change needs **no migration of its own**. §4 adds the stage's only one.

Losing the session boundary loses the only visual break in the thread, so day separators
(`Hôm nay` / `Hôm qua` / `18 thg 8`) are inserted between messages that fall on different days in
the caller's time zone. The time-zone plumbing landed in the temporal-context work and is
reused; a separator computed in UTC would put the break in the wrong place for every Vietnamese
evening.

### 4. Mobile gets the transcript, through PowerSync

The user chose replication over an API read, and the reason holds: when chat is the entire app,
opening it without a network and seeing an empty screen is not a degraded experience but a broken
one.

**`chat_messages` replicates down and must never upload.** This is the part that needs care,
because `SYNC_TABLES` currently means both directions at once.

Split it in `packages/shared/src/dto/sync.ts`:

- `SYNCED_TABLES` — what replicates to the device. The existing six plus `chat_messages`.
- `UPLOADABLE_TABLES` — what `POST /sync/upload` will write. The existing six, unchanged.
- `syncOp.table` becomes `z.enum(UPLOADABLE_TABLES)`, so an op naming `chat_messages` is rejected
  by validation at the edge of the API, before `router.ts`'s switch is ever reached.
- `SERVER_ONLY_TABLES` is unchanged.

Add an assertion that `UPLOADABLE_TABLES` is a subset of `SYNCED_TABLES` and that neither
intersects `SERVER_ONLY_TABLES`. Three lists that can drift is how a table ends up writable by
accident, and the existing comment in `sync.ts` already records that two hand-maintained copies of
one list was a bug this repo has shipped before.

Everything downstream then follows the split rather than being edited by hand:

- `sync-rules.yaml` gains `SELECT * FROM chat_messages WHERE user_id = auth.user_id()`.
- `packages/sync/src/schema.ts` gains the table (`session_id`, `role`, `content`, `citations`,
  `retrieval_meta`, `created_at`; jsonb arrives as a JSON string, as `notes.domain_meta` does).
- `sync-rules-isolation.test.ts` and `schema.test.ts` compare against `SYNCED_TABLES`.
- **The `powersync` publication needs a migration**: `alter publication powersync add table
  public.chat_messages`. Without it nothing replicates no matter what the rules say, and
  `sync-rules-isolation.test.ts`'s publication assertion — which reads the live publication
  through `_test_publication_tables` and has no skip guard — turns red until it is done. It must
  also be applied to the hosted project, which is a deploy step, not a code change.

**On the device the table is read-only.** The server writes both rows of every turn, the device
writes none, so no upload op is ever generated. The zod narrowing above is the guard for the case
where one is generated anyway.

**The live turn stays local state.** The streaming answer is not in `chat_messages` until the
server finishes persisting it, so mobile appends the in-flight exchange at the bottom of the
transcript from component state and drops it once the replicated rows arrive — the same
substitution the web pane already performs. The dedup key is the note id the turn was started
with, which the client generated and therefore knows before any row exists.

### 5. Mobile stops being ugly

The cause is mechanical: every colour, radius and gap in mobile is a literal at its use site
(`#ccc`, `#222`, `#eee`, `padding: 16`), so nothing is consistent and nothing responds to dark
mode. Web has had `:root` tokens with a `prefers-color-scheme` block since phase 1a.

Add `apps/mobile/src/theme.ts` exporting the **same token names** web uses — `bg`, `panel`,
`text`, `muted`, `line`, `accent`, `danger` — resolved through `useColorScheme()`. The two
clients cannot share styling code (React Native has no CSS), but sharing the vocabulary is what
makes it possible to change one and notice the other.

**Markdown on mobile is retried, as a spike first.** The gate is unchanged from the previous
plan's Task 6: `@ronradtke/react-native-markdown-display@^9.0.3` must be shown to render on a real
device on RN 0.86 / React 19.2 / Expo 57, and must not break the Vitest suite by reaching for a
native module at import time. Its permissive peer range proves npm will install it and nothing
more. A failed spike stops there — mobile keeps plain text, the stage still closes, and no
substitute library or hand-rolled renderer is attempted.

### 6. The connection indicator

`ExportButton`'s label was the plainest UI proof that PowerSync's download stream was alive —
`02-online-basics.yaml` uses "Export all notes" vs "Export needs a connection" for exactly that,
and says so in its header comment. Deleting export removes that proof.

Replace it with a small indicator in the chat header, driven by the same `useStatus().connected`,
carrying a stable `testID`. It is not only test scaffolding: in an app that is nothing but a chat
box, "you are offline, this reply came from your own notes" is information the user needs, and it
is the honest frame for the offline answer path that `offline-answer.ts` already produces.

Web gets the same indicator, on the same rule: an offline web client cannot reach the assistant at
all, and a composer that silently fails is worse than one that says why.

### 7. The e2e suites have to move, and mobile's is a rewrite

This is the largest piece of work in the stage and the easiest to under-scope. **The failure mode
is a suite that stays green while asserting nothing**, which this repo has shipped before.

`02`, `03`, `04a` and `04b` assert almost exclusively through the note list, the `search-input`
box, the note editor, the view chips and the export button. Every one of those is deleted. What
those flows prove, and where each proof goes:

| What is proved today | Through | After S1 |
|---|---|---|
| PowerSync reports connected | Export button label | The §6 indicator |
| Server→device replication | A server edit appears in the list | Seed a `chat_messages` row server-side; assert it appears in the transcript |
| Offline capture is durable | The note appears in the list | Ask a question offline; assert `box-offline-match` — proof the row reached local SQLite |
| The in-flight guard collapses a double tap | Counted server-side by `assert-offline-results.js` | Unchanged |
| FTS5 survives an apostrophe | The search box | **Retired from e2e.** `lib/fts.ts` keeps its unit tests; no UI reaches it any more |
| Offline trash stays trashed | Trash/restore in the editor | **Retired with the feature** (§9.1) |
| The conflict copy | Editing the same note on device and server | **Retired with the feature** (§9.1) |

Deleting the note editor removes the only client that can produce a conflicting edit, so the
conflict-copy scenario cannot be staged from a device at all. `notes/service.ts`'s server-side
resolution keeps its unit tests and stays correct; what is retired is the end-to-end scenario and
the two client modules that fed it, `edit-base.ts` and `note-edits.ts`.

The local `note_edit_base` table **stays**, and so does the connector branch that reads it.
`connector.ts` queries that table directly in `uploadData` and attaches `base_content` to a notes
`PATCH`; with no editor left, no such `PATCH` is ever generated and the query simply returns
nothing. Removing it would mean surgery on the upload path — the one path that must never break,
because it is how a note captured offline reaches the server. A dead local table costs nothing;
an unnecessary edit to `uploadData` could cost captures.

Playwright: delete `search-filter.spec.ts`, `edit-persist.spec.ts` and `checkin-media.spec.ts`;
strip `capture.spec.ts` down to the capture-through-the-box half; keep `assistant-box.spec.ts`;
add one spec for scroll-up-to-load-more.

### 8. Testing notes for the implementer

- The three-list invariant in §4 is asserted, not assumed: a test that fails if
  `chat_messages` ever appears in `UPLOADABLE_TABLES`. Its whole value is that it turns red when
  a future stage widens the wrong list.
- Pagination gets a test with **more than one page** of fixtures. A 30-row cursor test against 12
  rows is a test that cannot fail.
- The day separator gets a case that crosses midnight in `Asia/Ho_Chi_Minh` but not in UTC. That
  is the case a UTC implementation gets wrong, and the only one.
- Deleting a component whose test file is deleted with it proves nothing. For each deleted
  surface, the check is that **no route renders it and no import survives** — a typecheck plus a
  grep, stated as a step rather than assumed.
- Nothing here proves the new shell looks good. That is a judgement made by a person against a
  real device, and the plan must say so rather than implying the suite covers it.

### 9. Consequences accepted

**9.1 There is no longer any way to delete a note, and the replacement is S4.** Trash and restore
existed only inside the note editor. From the moment this stage merges until S4 ships, a mis-typed
or regretted line stays in the corpus permanently and retrieval keeps surfacing it. Deliberately
not solved by keeping a trash screen — the user's ruling was one chat box, and a half-kept browser
is the worst of both. The direction is recorded in §10 as S4; the window between the two stages is
the cost of taking them in this order, and it is accepted knowingly rather than overlooked.

**9.2 Notes the assistant saved on its own are now invisible.** Stage C5's save-answer, the offer,
and the decline all keep working and keep feeding retrieval; the `saved` filter chip that made
them visible dies with `note-list.tsx`. Consistent with "no need to look back at notes", and named
here so nobody reads it later as a regression.

**9.3 A turn taken offline leaves no trace in the transcript.** The server writes
`chat_messages`, and offline there is no server. The note is saved locally and the assistant will
find it later, but the exchange itself is gone after a restart. Closing this means letting the
device write its own message rows, which drags `chat_sessions` into replication, offline session
creation, and foreign-key ordering on upload — a stage, not a task. Accepted and deferred.

**9.4 The mood and media accelerators are gone before their replacements exist.** No capability is
lost: enrichment already extracts a mood or a media item from free text, and that path has tests.
What is lost is the tap. §10's S2 and S3 are what make the loss temporary.

### 10. The roadmap this stage was split out of

Agreed with the user on 2026-08-22 and recorded so the next stage inherits it. Each gets its own
brainstorm, spec and plan; each merges alone. The order settled on is **S3 → S2 → S4**, cheapest
and most isolated first, with the one that edits every turn's prompt path judged against the
finished shell.

One thing to watch rather than decide now: §9.1's gap opens the day S1 merges and only S4 closes
it. If living without any way to retract a note turns out to bite before S2 is done, S4 moves up.
That is a judgement to make from use, and the trigger is named here so the reordering is a
decision rather than a scramble.

**S3 — mood synthesised per session.** Not real time. A scheduled job summarises a chat session
that has gone idle into a mood reading. The user's framing: gather the data first, decide how to
use it later — which argues for building it early, so months of history exist by the time the
question is asked. It has a home already: `apps/api/src/enrich/` runs a pg-boss cron every 60
seconds behind an advisory lock, and a second scheduled job fits beside it. **It must not write to
`checkins`.** `turn.ts` already records why in a comment: a job writing check-ins would manufacture
mood history the user never reported. It needs its own table, and mixing the two writers is the
mistake to avoid, not a shortcut to consider.

**S4 — letting go of what is no longer true.** Raised by the user on 2026-08-22 as the answer to
§9.1, and explicitly deferred by them on the grounds that it needs a lot of brainstorming. It is
two mechanisms, and separating them is the first thing the brainstorm should do because they have
different tables and very different risk:

- *Told, in conversation.* "giờ tôi không còn làm việc đó nữa" should retire what the assistant
  had been recording, in the same turn, without a form. Most of the schema for this was designed
  in `00005` and never built: `memory_facts.status` already has `'archived'`, `superseded_by`
  already points at the fact that replaced it, and `memory_revisions.action` already enumerates
  `'archive'` and `'update'` with an `actor` of `'agent'` or `'user'`. Notes have their own
  vocabulary for the same idea in `lifecycle`. **Which of the two a given sentence should move is
  the design question**, and answering "both, always" is how a stray remark quietly archives a
  month of work.
- *Noticed, on a schedule.* A job that reviews the corpus and decides what is still worth keeping.
  `memory_revisions.action` already lists `'decay'`, so the audit trail for this was anticipated
  too. It shares a home with S3's job and possibly its cadence.

`packages/core/src/memory/` does not exist. Nothing reads or writes `memory_facts` today except
C5's declined-offer rows, so S4 is building the consumer these tables were designed for, not
extending a running system.

Two constraints S4 inherits from this stage and cannot design around: **nothing may be hard
deleted** — every retirement is a status change with a revision row, because a wrong inference is
then a mistake and not a loss; and **chat is the only surface left**, so whatever the assistant
retires it has to be able to say so, and the user has to be able to say no. §1 removed the screen
where a person could have reviewed this quietly on their own.

**S2 — the assistant asks a follow-up.** "hôm nay tôi mới đi xem phim" should draw out *which
film, and was it any good* over a couple of turns, ending in a real `media_items` row. Most of the
substrate exists: `extractNote` already receives conversation history (`EnrichTarget.history`,
truncated to `CLASSIFIER_HISTORY_TURNS`), so the turn that answers "Interstellar, hay lắm" is
classified with the assistant's question visible above it; and `domain_meta.pending_item` plus
`resolveNoteMediaLink` already create and case-insensitively reuse a media item. What is missing
is a rule permitting one follow-up question when a record is obviously incomplete — and a ceiling
on how often it may ask, because an assistant that interviews the user about every passing remark
is worse than one that files it silently. Deliberately last: it edits the prompt path every single
turn passes through, and it should be judged against the new shell rather than at the same time as
it.

### 11. Debts carried in from stage C5

Recorded here because they were recorded **only** in the tail of
`docs/superpowers/plans/2026-08-18-chat-shape-and-stage-c5.md`, and a debt that lives in a
finished plan is a debt that gets lost. None is touched by S1; each is listed with where it
belongs.

Two items from that list are **closed** and are not repeated below. Mobile markdown turned out
never to have been attempted — PR #24 touched no mobile file — so S1 §5 re-runs the spike rather
than inheriting an unknown. And "scrollback across earlier sessions" plus "chat history on
mobile" are what §3 and §4 of this document build; they stop being out of scope the day S1
merges.

**11.1 A saved answer is cited as if the user wrote it.** `search_notes` reads `source_type`
internally — to exclude chitchat, and to apply the 0.8 down-weight to `'assistant'` and
`'web_search'` — but does **not return it**. `retrieve.ts`'s `SearchRow` and `Citation` therefore
have no such field, and `renderCitations` cannot tell the model that a note came from an earlier
answer rather than from the user's own thinking. The down-weight is real and tested; the framing
is not. Closing it means a `search_notes` migration, a widened `Citation` on both sides of the
wire, and a `renderCitations` change. **It belongs to the retrieval path, not to a UI stage** —
which is why S1 does not touch it, and why it should be weighed on its own rather than folded
into S2, S3 or S4.

**11.2 The declined-offer exclusion is unproven, because nothing consumes it.**
`packages/core/src/memory/` does not exist and no nightly `memory.update` job was ever built, so
C5 Task 13 could only assert that the row is **written** with the `'assistant_offer'` category and
the `evidence` marker a future job will filter on. There is no consumer to exclude it from, and a
test that mocked one would assert nothing. **This is S4's to close** (§10): the stage that builds
a memory consumer is the stage that can finally prove a declined offer stays out of it.

**11.3 `OFFER_DEDUP_THRESHOLD` is an estimate.** `offer.ts` sets it to `0.88` against no data.
C5 §12.3 and §15 both said it must be measured against real declines, and it still has not been.
**Tune down, not up:** too low means the assistant occasionally stays quiet about something it
could have offered; too high means it re-offers a fact the user has already refused, which is the
behaviour the whole dedup exists to prevent.

**11.4 Verification quality is unmeasured.** No test can assert "the model correctly identified a
false claim". C5's tests cover routing, prompting and cost; whether the flagging is *useful* is a
judgement over real use, and C5 shipped a mechanism whose value is still unproven. It needs
sustained use to evaluate, not a task — but it should be evaluated deliberately rather than
forgotten, and S2 is the natural moment, since S2 changes the same prompt path.

**11.5 `FORMAT_RULE` obedience has no automated check, and this is a stated limit rather than a
gap.** The tests assert the prompt's content and its scoping — that both halves of the rule are
present, and that `buildAcknowledgePrompt` and `buildChitchatPrompt` do not carry it. Whether
replies actually get shorter is checked by a person, and **both halves must be checked**: a casual
question coming back as prose, *and* a request to enumerate still coming back as a list. Checking
only the first is how the exception clause gets deleted later.

## Out of scope

- No change to any API endpoint, service or controller.
- No change to the assistant turn: routing, prompts, retrieval, grounding, offers and declines are
  all untouched.
- No change to enrichment, embedding, dedupe or the 60-second sweep.
- No new way to delete, archive or retract a note (§9.1), and no trash screen kept back to provide
  one. S4 is that work and none of it starts here — not the conversational retraction, not the
  scheduled review, and not a first `packages/core/src/memory/` module to hang them on.
- No device-written `chat_messages` and no `chat_sessions` replication (§9.3).
- No conversation list, no naming or managing of past conversations — one continuous thread is the
  whole of §3.
- No markdown renderer on mobile unless §5's spike passes on a real device.
- No new capture widget of any kind, on either client.
