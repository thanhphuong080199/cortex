# Phase 1c — issue log

Everything that went wrong, was wrong, or is still open, from implementing
`docs/superpowers/plans/2026-08-01-phase-1c-life-domain-capture.md`.

Written for review, not as a changelog: each entry records the **symptom you would
actually see**, the cause, and what was done — because several of these are invisible
until a specific moment (a rerun, a hosted push) and will recur.

Branch `feat/phase-1c-life-domains` · PR #4 · 13 commits.

---

## A. Resolved

### A1. Kong→auth routing dies after every `supabase db reset` — RECURRING

| | |
|---|---|
| **Symptom** | `AuthRetryableFetchError: {}`; 25 of 62 db tests fail at once, across every suite that signs a user in. Looks exactly like an auth regression in application code. |
| **Cause** | Stale Docker DNS in the `supabase_kong_*` container after the stack's containers are recreated by `db reset`. Nothing to do with this repo's code. |
| **Fix** | `docker restart supabase_kong_phase-0-foundations` |
| **Status** | Resolved, but **recurs after every `db reset`** — it is a workaround, not a fix. Already in project memory. |

Hit 3 times this session. If a mass auth failure appears immediately after a reset,
restart kong before reading a single line of application code.

### A2. Five tests only passed on a freshly-reset database

| | |
|---|---|
| **Symptom** | Suite green right after `db reset`, then 5 failures on the very next run with no code change. Two failures reported as `TypeError: Cannot read properties of null (reading 'id')` — actively misleading. |
| **Cause** | Fixtures inserted with fixed names into tables with unique constraints: `tags` ("chain-tag", "cycle"), `digests` `(user_id, period, period_start)`, `integrations` `(user_id, provider, external_id)`, plus two exact-row-count assertions on `memory_facts`/`digests`. The real error was `23505`; where the insert result was unchecked, the next line dereferenced `null` and masked it. |
| **Files** | `schema-domain.test.ts` (3), `note-tags-reattach.test.ts` (1), `updated-at.test.ts` (1) |
| **Fix** | Commit `174d683` — clear the fixture (scoped to the test user) before inserting, the pattern `rls-isolation.test.ts` already documented. Row-count assertions kept exact rather than loosened to `>=`. |
| **Status** | **Resolved.** Verified by running the suite twice back to back with no reset: 62/62 both times. |

Pre-existing, not introduced by 1c. Off-plan fix, agreed before doing it.

### A3. `findOrCreateItem` would attach logs to the wrong media item

| | |
|---|---|
| **Severity** | Highest-impact bug found. Silent data corruption, no error surfaced. |
| **Symptom** | Logging a title containing `%` or `_` returns an unrelated existing item. Logging `"D%"` with a `"Dune"` in the library attaches the new note to `Dune`. |
| **Cause** | The plan specified a bare `.ilike("title", input.title)`. `%` and `_` are LIKE wildcards, so the lookup is a pattern match — while the unique index it races with is `lower(title)`, exact. Lookup and constraint disagreed. |
| **Fix** | Commit `cc9f68f` — escape `\`, `%`, `_` before the ilike, then confirm with an exact `lower()` comparison. |
| **Note** | `TagService` **already had this exact fix, with a comment describing this exact bug.** The plan simply didn't carry it into `MediaService`. `escapeLike` now lives in `packages/core/src/like.ts` and both services share it, so it cannot be relearned a third time. |
| **Status** | **Resolved.** Regression test covers `"D%"` and `"Dun_"`. |

### A4. `00012` failed its first push to the hosted project

| | |
|---|---|
| **Severity** | Deploy-blocking. Passed every local check. |
| **Symptom** | `LegacyDbPushApplyError ... At statement: 1 / alter table public.note_chunks alter column embedding type vector(1536)`. The CLI truncates the underlying Postgres error, so that is *all* you get — no mention of the real cause. |
| **Cause** | `supabase db push` logs `Initialising login role...` and applies migrations as a dedicated role whose `search_path` excludes `extensions`, where `00001` installs pgvector. Local `supabase db reset` resolves the unqualified `vector` via `config.toml`'s `extra_search_path`, so **this class of bug cannot fail locally**. |
| **Fix** | Commit `b248481` — `extensions.vector(1536)` and `extensions.vector_cosine_ops`, which is what `00001`'s own comment prescribed years before it happened. |
| **Status** | **Resolved**, documented in `docs/deploy.md`, saved to project memory. |

Two things worth keeping:

- **The failed push rolled back cleanly.** `note_chunks_embedding_idx` survived and both
  columns were still 1024-dim — checked before touching anything, rather than assumed.
- **`00002`/`00005` use unqualified `vector(1024)` and pushed fine at phase 0.** So this
  is a behaviour change in the CLI's migration role, not a rule that was always enforced.
  Don't retro-fix the old migrations; do qualify every new one.

### A5. Plan specified a test mechanism that doesn't exist

| | |
|---|---|
| **Symptom** | Task 1 Step 1 said to read the pgvector dimension by reusing "the enum-parity mechanism" via a `runCatalogQuery` helper. No such helper exists. |
| **Cause** | The actual mechanism is a *narrow* RPC, `_test_check_constraint_def(p_table, p_constraint)` (`00001:70`). `packages/db` reaches Postgres only through PostgREST — there is no generic catalog-query path by design. |
| **Fix** | Added `_test_column_vector_dim(p_table, p_column)` to `00012`: third narrow SECURITY DEFINER reader, same revoke-from-public / grant-to-service_role pattern as `00001`'s two. |
| **Status** | **Resolved.** Agreed as a deviation before implementing. |

### A6. Plan would have added an index that never existed

| | |
|---|---|
| **Symptom** | `00012`'s SQL drops and recreates `memory_facts_embedding_idx`. |
| **Cause** | `00005` creates only `memory_facts_user_status_idx`. The plan assumed a symmetry with `note_chunks` that isn't there. Creating it would be new schema smuggled into a migration that claims to be a pure type change. |
| **Fix** | `memory_facts` gets a bare column alter. The index belongs to phase 8, which is the first thing to vector-search over facts. |
| **Status** | **Resolved.** Deliberate deviation. |

### A7. Stale `dist/` produced a false test failure — RECURRING FOOTGUN

| | |
|---|---|
| **Symptom** | Changed `EMBEDDING_DIM` to 1536 in `packages/shared/src`; `@cortex/shared`'s own tests passed, but `@cortex/db`'s assertion still read `1024`. Looks like the edit didn't take. |
| **Cause** | Since 1a, `@cortex/shared` and `@cortex/core` ship compiled `dist/` with `main`/`types` pointing there. Dependent *packages* resolve the build output; only the owning package's tests read source. |
| **Fix** | `pnpm --filter @cortex/shared build` before running a dependent package's tests. |
| **Status** | Resolved for this session. **Not structurally fixed** — will recur whenever a shared type changes. See B5. |

### A8. Export tests broke when the fixture gained a second note

| | |
|---|---|
| **Symptom** | Two pre-existing assertions failed once the export fixture logged a media note. |
| **Cause** | One selected the note file by *position* (`.find(startsWith("notes/"))`), the other asserted `notes` had length exactly 1. Both encoded "there is only ever one note". |
| **Fix** | Commit `be0bd7f` — select by content. |
| **Status** | **Resolved.** Test-only; no production behaviour involved. |

---

## B. Open → resolved 2026-08-01 (second pass)

All of section B except B2's interactive click-through and B4 (a billing decision) was
resolved in the review pass of 2026-08-01. Each entry keeps its original symptom for
context; resolution appended.

### B1. The API has not been redeployed — RESOLVED

`POST /checkins`, `DELETE /checkins/:id` and `POST /media-log` did not exist on the
running container. Redeployed via `railway up` after 00014 was pushed, and verified with
**writes** against production, per `docs/deploy.md` (never `/health`, which returns 200
even when the API cannot serve a request):

| Request | Result |
|---|---|
| `POST /checkins {"mood":4}` | **201** (row deleted again afterwards, 200) |
| `POST /media-log` incl. new `status: "in_progress"` | **201** |
| `PATCH /notes/:id {"domain":"health"}` on that media note | **400** — the B3 fix, live |

Verification rows cleaned up (checkin deleted via API; note purged; media item removed
via service-role PostgREST).

### B2. No browser click-through of the three web flows — OPEN (user step)

Everything short of a human in a browser is now verified: unit/integration logic, API
e2e against the deployed container (above), a clean production build, and the dev server
rendering against the hosted project (`/` 307s to `/login`, `/login` 200). The
interactive click-through still needs a Google-signed-in human: run
`pnpm --filter @cortex/web dev`, sign in at `http://localhost:3000`, then exercise (1)
mood tap → logged ✓ → undo, (2) media log with autocomplete/stars/status, (3) domain
chips on capture + `?domain=` filter + realtime arrival of a new note.

### B3. `domain_meta` is not re-validated when `domain` changes — RESOLVED

`NoteService.update` now re-validates existing meta against the new domain and throws
the new `validation` CoreError kind, which `CoreErrorFilter` maps to **400** with a
caller-facing message. Clearing the domain (`domain: null`) stays allowed — meta without
a domain is dormant. Covered by a service test and verified against production (table
above). Commit `fc9279d`.

### B4. Railway free trial lapses around 2026-08-31 — OPEN (user decision)

$5 of credit, 30 days from 2026-08-01. When it lapses the API stops answering and every
1c write path dies with it. Hobby is $5/month; the Free plan's $1/month credit will not
keep an always-on container running. **Decision + payment needed this month.**

### B5. Shared-package `dist/` staleness has no guard — RESOLVED (with a correction)

The candidate fix this log originally proposed (`test` dependsOn `^build` in
`turbo.json`) **was already in place** — the actual gap was that CI and local habit ran
`pnpm --filter <pkg> test`, which bypasses turbo and its dependency graph entirely; CI
compensated with a hand-maintained build step. CI now runs
`pnpm turbo run test --filter=<pkg>` and the manual build step is gone. The rule is
recorded in `ci.yml` itself and in `docs/deploy.md`. Commit `2e99f6d`.

### B6. `00012` becomes unsafe once embeddings exist — RESOLVED

`00012` now opens with a fail-fast guard: if either embedding column holds a non-null
value it raises, naming the re-embed requirement, instead of silently being a different
operation. Editing an already-applied migration is safe here — applied environments
never re-run it, and fresh replays hit the guard while the columns are still empty.
Commit `84397eb`.

### B7. Media autocomplete fetches the whole library — RESOLVED

The query now pushes `kind` server-side, orders by title, caps at 200 rows, refetches
when the kind changes, and surfaces a fetch failure instead of silently rendering an
empty library. The tag picker in `tag-chips.tsx` had the identical unbounded shape and
got the same bound. (The 200 cap is a cap, not a search — a library past 200 titles per
kind wants a typeahead query; deferred until that's a real number.) Commit `c63bfc0`.

---

## E. Second-pass findings (2026-08-01 review of this log)

Auditing the branch for issues *not* in this log found the following. All fixed the same
day unless marked accepted.

### E1. `domain_meta` / `media_item_id` are client-writable through PostgREST — ACCEPTED, comment fixed, FK hardened

The comment in `notes/service.ts` claimed keeping these out of the DTO "stops a client
inventing meta". False: the `notes` grant and RLS policy are row-scoped, so a row's
owner can `PATCH` arbitrary `domain_meta` through PostgREST with their own JWT. Column
grants can't close it — the API writes with the user's JWT (no service_role on the write
path, spec §4.1), so revoking columns from `authenticated` would break `MediaService`.

Decision: **accept** (self-owned rows only; phase 2 must validate meta on read and treat
it as untrusted), fix the lying comment, and harden the part that *was* closable at the
DB: `notes.media_item_id` is now a composite FK `(media_item_id, user_id) →
media_items (id, user_id)` — FK checks bypass RLS, so the single-column FK accepted
references to other users' items. Regression test: cross-user insert → `23503`.

### E2. `checkins`/`flashcards` lacked `updated_at` — FIXED (00014)

`00002`'s rule: PowerSync ordering depends on `updated_at` advancing on every UPDATE.
Both tables mutate (soft-deletes via UPDATE; SM-2 scheduling rewrites in phase 6) and
had no column at all — an incremental sync cursor would have had nothing to order on,
and retrofitting a synced table later costs more. Both now have the column + moddatetime
trigger, with tests. `media_items` deliberately stays without one (append-mostly, same
as `tags`/`links`).

### E3. RLS isolation tests were vacuous for the three new tables — FIXED

`rls-isolation.test.ts` asserted "bob reads zero rows" from `media_items` / `checkins` /
`flashcards` — but Alice had no rows there either, so dropping a policy entirely kept
the suite green. One Alice fixture row per table now makes the assertions real.

### E4. Check-in widget state bugs — FIXED

- Collapsing "more" kept hidden `energy`/`label`, so a later face tap silently logged
  values the user believed dismissed. Collapsing now discards them.
- A failed log kept the *previous* check-in's "logged ✓ / undo" on screen next to the
  error — and that undo deleted the previous, correct check-in. Failure now clears the
  undo affordance. `undo` also gained a busy guard.

### E5. `NoteList.refetch` dropped `q`/`tag` — FIXED (pre-existing on main)

The realtime refetch (every `SUBSCRIBED` transition, including ~1s after mount) applied
only the lifecycle/domain narrowings, so `/?q=...` briefly showed 3 search results and
then silently replaced them with the whole inbox. Refetch now mirrors every SSR
narrowing; while `q`/`tag` are active, realtime events trigger a refetch instead of a
local patch (FTS and tag membership can't be evaluated client-side).

### E6. `findOrCreateItem` residual sharp edges — FIXED

- **PostgREST maps `*` to `%` inside like/ilike operands**, so even the A3-escaped
  pattern wildcarded on `*` ("M\*A\*S\*H" scanned as `M%A%S%H`). The lookup no longer
  uses ilike at all: anchored, regex-escaped `imatch`, shared by `TagService` and
  `MediaService` (`like.ts`, now directly unit-tested).
- **`year` was accepted and silently discarded** when the item existed. Now: backfills a
  null year; a contradicting year is a 409 naming the existing value.
- **A failed note insert stranded a just-created item** in the library forever (no
  delete surface exists for `media_items`). `logMedia` now compensates by deleting the
  item it created; pre-existing items are left alone.
- **`status: "finished"` was hardcoded** into every log. `logMediaInput` gained optional
  `status` (default finished at the service); the web form has a selector.

### E7. Accessibility — FIXED

Star rating was toggle-buttons (`aria-pressed`) where filled-but-unselected stars
contradicted the visual state → now a radiogroup with `aria-checked` and ≥28px spaced
targets (a mis-tap on the current star *clears* the rating, so cramped targets silently
produced "no rating"). Mood buttons carry valence in their labels ("Mood 1 of 5 — very
bad") and 44px targets; hardcoded `id="energy-label"` → `useId`; `role="status"` no
longer wraps the undo button.

### Accepted / logged, not fixed

- **E1's PostgREST write path** (above) — validate-on-read is phase 2's entry gate.
- **The note list itself is unbounded** (`page.tsx` / `note-list.tsx` fetch every
  matching note). Same class as B7, pre-existing since 1a, needs pagination rather than
  a cap; deferred.
- **No UI path edits a note's domain** after capture (`updateNoteInput.domain` is
  `.nullable()` precisely for clearing a wrong domain, and the API path is tested, but
  no control reaches it). Deferred to the next UI pass.

---

## C. Deferred by design (not bugs)

- **PowerSync sync rules** for `media_items` / `checkins` / `flashcards` — phase **1b**;
  no PowerSync service exists yet to configure. When 1b lands, sync rules and RLS get
  reviewed in the same PR: two independent isolation layers over the same rows.
- **`flashcards` has a table but no service, routes or UI** — plan constraint.
  Extraction is phase 2, review UI is phase 6.
- **No `people` or `recipes` tables** — spec §2.1 deferrals. Relationships ride on
  `memory_facts` category `relationship`; recipe variations on `links.kind`.
- **No provider key in Railway** — the Gemini switch in `00012` is schema-only. Phase 2
  owns the key, together with its entry gate: **verify the Gemini project is on the paid
  tier**, because free-tier prompts are used for training and health/mood/finance content
  flows through this API (life-domains spec §5).
- **Phase 1b has no spec or plan yet** — next planning step if mobile is the next build.

---

## D. Verification state (updated 2026-08-01, after the second pass)

| Check | Result |
|---|---|
| `pnpm turbo run typecheck lint test` | 21/21 tasks green |
| `@cortex/db` | 75/75 (was 72; +updated_at ×2, +cross-user FK) |
| `@cortex/core` | 57/57 (was 48; +like.ts unit, +B3, +year, +orphan, +status, +`*` literal) |
| `@cortex/api` | 56/56 |
| `@cortex/shared` | 27/27 |
| `@cortex/web` | 29/29 |
| Full test gate rerun without reset | green twice back-to-back |
| Hosted migrations through `00014` | applied; `migration list` local == remote |
| Hosted API redeploy | **done** — verified by writes (B1 table) incl. the B3 400 path |
| Browser click-through | **open** — needs a Google-signed-in human (B2) |
