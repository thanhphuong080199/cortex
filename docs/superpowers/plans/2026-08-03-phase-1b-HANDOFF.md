# Phase 1b — handoff, 2026-08-03 (updated 2026-08-04)

## 2026-08-04, session 2 — the first real device run. Four bugs, and none of them was sync.

The branch is now **pushed** (`feat/phase-1b-mobile-offline-sync`) and there is a **GitHub
Actions APK build**, so device testing no longer depends on EAS quota. No PR is open for phase
1b; the only thing merged to `main` is the workflow file (PR #5).

Commits this session, oldest first:

| Commit | What |
|---|---|
| `504b518` | TEMPORARY sync diagnostic (removed again in `ec537dc`) |
| `ec537dc` | empty note list + `connect()` deadlock + save indicator |
| `f95359e` | Android APK workflow |
| `0589613` | workflow named its deps, died on the ref lacking one |
| `76ecfed` | sync-rule assertions stripped no comments on CRLF |
| `cc52fcb` | conflict base is a body, not a timestamp |

### 1. The note list was empty because it was rendered zero pixels tall

Hours went into the sync layer. The sync layer was correct the whole time. On-device probes:

```
ps_data__notes = 10     notes(view) = 10     inbox(filter) = 10
ps_crud = 0             ps_buckets = 2       useQuery(list) rows=10 error=none
```

`NoteList` was a sibling of QuickCapture, CheckinWidget and MediaLogForm inside a plain `View`.
Their fixed heights consumed the screen, its `flex: 1` resolved to nothing, and every row
rendered at zero height with no scroll anywhere to reach them. Indistinguishable from having no
notes — `ListEmptyComponent` is invisible for the same reason. It also produced the report that
the app had "no edit feature": no row could be tapped.

Fixed by making the list the screen's ONLY scrolling surface (`ListHeaderComponent` /
`ListFooterComponent`), not by wrapping the screen in a `ScrollView`, which would nest two
scroll views and break virtualisation.

**Nine hypotheses were wrong before the instruments were added**: sync rules not deployed, split
`@powersync/common`, `useQuery` result shape, missing stream subscription, publication scope,
token mismatch, FTS triggers, a sign-in deadlock, replication. Every one was eliminated by
measurement, none by argument. The measurement took one run.

### 2. `await connect()` held the whole app behind a spinner

`connect()` resolves only once the sync status passes through `connecting` and back out
(`AbstractStreamingSyncImplementation.connect`). On this device it never did — four launches,
`powersync_control(start)` and an `EstablishSyncStream` each time, `"connected":true` **zero**
times. Awaited, `db` stayed null forever and `PowerSyncProvider` covered the app, including the
sign-in button inside it. Now fired and logged, not awaited. Regression test hangs `connect`
deliberately and fails on a timeout; verified by reinstating the `await`.

### 3. The conflict base was a timestamp no client could ever hold

Reported from the device: any edit, online or offline, unraced, updated the note AND forked a
second one. Two independent causes, same symptom:

1. `notes.updated_at` is **server-owned** — ignored on insert (`default now()`), overwritten by
   `notes_set_updated_at` on update. A device-created note holds a device clock; the server
   holds a Postgres clock.
2. Even for a downloaded note the serialisers disagree: PowerSync writes
   `2026-08-04T04:13:37.916374Z`, PostgREST returns `2026-08-04T04:13:37.916374+00:00`. Same
   instant, different zone suffix — compared with `!==`.

The base is the note **body** now, end to end: `syncOp.base_content`,
`note_edit_base.base_content`, `sessionBase` holding the seeded body. `Date.parse` was rejected:
it fixes (2) and leaves (1). An empty body is a real base, so every guard tests
`undefined`/`null`, never falsiness — a falsy check anywhere turns that edit into unconditional
last-write-wins.

**`note_edit_base` is local-only and does not migrate on upgrade.** Rows from the old build read
back `base_content` null; the connector treats null as no base rather than forwarding it.

**Why the suite never caught it:** every test in `conflict-copy.test.ts` fed `note.updated_at`
straight back from the response that produced it — the one input no client can hold. Fed a body
instead, `applies normally when the base matches` became a real assertion for the first time.

### 4. `sync-rules-isolation` stripped no comments on a CRLF checkout

`split("\n")` leaves `\r` on every line; `\r` is a line terminator to a JS regex, so `.` will
not cross it and `#.*$` matches nothing. `directives` silently became the raw file — the exact
thing it exists to avoid. Red on Windows, green on Linux. This repo warns `LF will be replaced
by CRLF` on every commit, so CRLF is the normal case here.

### STILL OPEN — server-to-device sync does not run

`"connected":true` has never been observed. Uploads work (`completed_upload` seen; notes reach
the web). The ten local rows came from an earlier session. Consequences for the checklist:

- Checklist step 3 (edit on web, sync, search the old word) **cannot pass**.
- Security table's last row (purge on web disappears from the phone) **cannot pass**.
- Everything else is unaffected, and conflict detection no longer depends on download working
  at all, now that the base is a body.

Server side is provably healthy — PowerSync Diagnostics App shows bucket
`1#user_data|0["5f9ef175-…"]` **Ready**, `notes` 10/10 synced, stream `user_data` active and
default, and that app is itself a PowerSync client syncing fine against the same instance. So
the fault is client-side and still unlocated. **Next step is instrumentation, not argument:** a
trace-level logger (`createConsoleLogger({ minLevel: LogLevels.trace })`) is what made the
sync engine's `powersync_control` conversation visible at all — the SDK defaults to `info`, and
at that level a stalled connection leaves no trace anywhere, including in the PowerSync
instance's own logs.

### Builds and CI

- **EAS preview APK, commit `ec537dc`** (before the conflict fix):
  `https://expo.dev/artifacts/eas/3okWbAV3yXt_fMJMpY3M9WUNDkWjiwEc-sWX4gRXhTA.apk`
- **GitHub Actions** `.github/workflows/android-apk.yml` — `workflow_dispatch` plus `push` to
  `main`. First green run took 24m49s. Signed with the Expo template's DEBUG keystore, so its
  signature differs from EAS's: installing one over the other needs an uninstall first, and it
  is not Play-Store material.
- Four `EXPO_PUBLIC_*` repository **variables** (not secrets — they are compiled into the
  bundle) are set and asserted non-empty before the slow part of the job.
- EAS reported `New builds are blocked until your billing period resets`, then built anyway.
  Treat the quota as nearly exhausted.

### Process notes this session earned

- **A diagnostic hidden behind the bug it diagnoses is useless.** The panel that answered the
  empty-list question in one run was invisible for hours because `await connect()` put a spinner
  over it. Make the instrument reachable first, even if that means a temporary change.
- **`gh`/`eas` polling flags must be verified.** `eas build:view --non-interactive` is not a
  valid flag; a background poller failed silently for ~21 minutes while reporting progress.
- Read the `Cached:` line. A full `--force` run is what proves a gate ran; the final gate here
  was 27/27, **0 cached**, 539 tests.

## 2026-08-04 — the whole-branch review ran. Round 1 of 2.

Four reviewers over Tasks 14–23, plus an inline pass on the `.tsx` files (which no reviewer
was given, because no test can reach them). **Six commits: `033b2fa`, `84e3b40`, `9f7088d`.**
Gate after each: 26/26, 0 cached, Docker up — 526 tests at the end.

**The review was worth running.** It found two CRITICALs, both of which would have shipped:

1. **Trashing a note never reached the server** and the note reappeared on the next sync.
   Mobile trashes with an UPDATE, PowerSync emits UPDATE as PATCH, and the router's PATCH
   branch silently dropped `deleted_at`. Found independently by two reviewers. Fixed in
   `9f7088d`, server-side, with three e2e cases that fail against the old router.
2. **Any 4xx discarded the user's offline writes.** 413 was not hypothetical — Express
   defaults the body limit to 100 kB and a 500-op batch is ~75 kB of envelope alone. Now only
   400/422 may complete a batch; the body limit is 10mb.

Plus, fixed the same day: FTS5 search escaping (typing an apostrophe broke search outright),
the double-tap guard that existed in one screen and not the three others that write, a note
editor that could swallow an entire session of typing, a `tag` URL param that crashed the web
page, and **seven tests that could not fail** (two in `packages/db`, four in `apps/mobile`,
one in `packages/core`). `@cortex/web`'s whole suite was running nowhere in CI.

### Deployed 2026-08-04 — and the deploy itself found two more bugs

`railway up` → deployment `5a78c149`, **SUCCESS**, serving the round-1 fixes. Verified against
the live URL with three unauthenticated probes, since neither needs a token:

| Probe | Old build | New build |
|---|---|---|
| `GET /health` | 200 | 200 |
| `POST /sync/upload`, 500 KB body, no auth | **500** | **401** (body parses, then auth rejects) |
| same, 12 MB body | **500** | **413** |

**The first `railway up` FAILED, and that is a finding the test suite could never produce.**
The API image had not built since Task 15: `@cortex/core` gained better-sqlite3 as a test-only
devDependency, the image installs `--filter @cortex/api...` which pulls core's devDependencies,
and node:22-alpine is musl — no prebuild, so node-gyp ran and died on missing Python. No gate
on this branch builds the image. Fixed with `--ignore-scripts` (see the Dockerfile comment for
why that is safe and why `apk add python3` was rejected), verified by building and running the
image locally before redeploying.

**The 500s in that table were the second bug.** Express middleware throws http-errors, not
`HttpException`, so everything raised before a controller — body-parser above all — fell into
`CoreErrorFilter`'s catch-all. A too-large body answered 500, which the sync connector reads
as transient and retries forever. Both are fixed in `0c7cf42`.

### 2026-08-04 — the app could not bundle, and had not been able to since ~Task 13

The first EAS preview build failed in the Bundle JavaScript phase. Reproduced locally with
`expo export`; **two independent causes**, and between them apps/mobile has been unbundlable
for most of this branch while typecheck, lint and 159 tests stayed green.

1. **`./x.js` imports.** Ten of them across eight files. The suffix is REQUIRED in the packages
   that compile to `dist/` under NodeNext, so it looks correct, and both tsc and vitest resolve
   it. Metro looks for a file of that literal name and fails. The `.tsx` screens already used
   the extensionless form, which is why the inconsistency never showed.
2. **`dist/` is not in the EAS archive.** `@cortex/shared` and `@cortex/sync` resolve through
   `./dist/index.js`; `dist/` is gitignored and EAS archives from git. Locally Metro only
   succeeds because dist/ happens to be present from the last turbo run. Fixed with an
   `eas-build-post-install` hook.

**Treat "the device checklist has never been run" as the correct reading of this branch.** It
was not possible to run it. Every device-only claim in this document — the conflict run, the
security table, all of it — is still entirely unverified, and now for a second, sharper reason
than "nobody got round to it".

**The gate now bundles** (`turbo run bundle`, wired into ci.yml, `expo export`, 1565 modules).
Deliberately not named `build`: turbo gives typecheck/test a dependency on the package's own
build, so that name would bundle the whole app before every mobile test run. Fixed in `2817d92`.

**A preview APK now exists and is the right thing to test on.** EAS build
`9f55d4d9-7f9d-49ec-83d1-0726e1483a31`, profile `preview`, gitCommit `2817d925`, FINISHED.
It embeds the JS bundle, so it needs no Metro and no computer — which also means airplane mode
is genuinely offline rather than "offline plus a dead bundler connection". The four
`EXPO_PUBLIC_*` variables are now set in the EAS `preview` environment (`POWERSYNC_URL` and
`API_URL` were missing; without them the app would have built fine and then synced nothing).

Prefer this APK over the dev client for the checklist. Keep dev client `f603e36f` only for
iterating on code.

### Device checklist — what round 1 changed about it

> **Superseded in places by session 2 (top of this file).** Dev client `f603e36f` is dead: it
> predates `@op-engineering/op-sqlite` and throws `Base module not found` at import, taking every
> route's default export with it. Dev client `bd5832eb` replaces it and shares the working
> preview APK's native fingerprint (`072c009a…`). Two checklist rows cannot pass at all until
> server-to-device sync is fixed — see STILL OPEN above.
>
> **The dev client CAN test airplane mode**, contrary to the note below: it needs Metro only at
> launch. Be online when the app starts, then switch to airplane mode and do not reload. No
> checklist step requires a cold start while offline. `adb backup` needs Android platform-tools,
> which are not installed on this machine.

**One prerequisite left.**

- **No new dev client build is needed.** Round 1 added no native module — `lib/in-flight.ts`
  is plain JS — so EAS `f603e36f` still loads everything over Metro. (`37039bce` is still too
  old: it predates `expo-sharing`/`expo-file-system`.) **Wrong as of session 2** — see the note
  above; `f603e36f` cannot start.
- The API prerequisite is **discharged**: production now runs the trash fix, so the trash
  check below tests the fix rather than the old bug.

**Five checks to add, one per round-1 fix. Each is only observable on a device.**

| Check | Expected |
|---|---|
| Airplane mode, trash a note, reconnect | Trashed on web, and it does **not** reappear on the phone. This is the CRITICAL fix; nothing below matters more. |
| Restore that note from trash, reconnect | Live again on web, and stays live on the phone |
| Search a word with an apostrophe (`don't`) | Results, never "Could not read notes on this device" |
| Double-tap Save on capture, and on the media form | Exactly ONE note / one log, not two |
| Open a note and start typing immediately | The text is still there after leaving and reopening |

The 413 fix cannot be checked by hand without a large backlog; it is covered by the connector
tests instead. Its device-visible symptom, if it were still broken, is offline writes
disappearing on the first reconnect after a long offline stretch.

### Round 2 — open findings, ranked. None of these is fixed.

**1. CRITICAL (security) — `note_tags` and `links` have single-column FKs, so a child row can
carry one user's `user_id` while its parent note belongs to another.** Migration `00014`
named this exact hazard and fixed it for `notes.media_item_id` with a composite FK into
`(id, user_id)`; the precedent was never extended to `note_tags.note_id`, `note_tags.tag_id`,
`links.from_note_id`, `links.to_note_id`. Phase 1b is what made these tables client-writable
with client-chosen FK values (`router.ts` upserts `{...op.data, id, user_id}` straight in).
A modified client PUTs a link whose `from_note_id` is another user's note; the row buckets
into the attacker's stream on `user_id` and replication delivers the foreign note id to their
device. **Honest bound: what crosses is row *ids*, not note bodies** — the `notes` sync rule
still filters on `user_id` — plus an existence oracle (23503 vs success). Fix is mechanical
and modelled in-repo: unique index on `(id, user_id)` + composite FK. Needs a migration and
a hosted `supabase db push`.

**2. CRITICAL — the only test covering that shape cannot fail.**
`sync-rules-isolation.test.ts:257-293` reads back rows its own `beforeAll` seeded, which are
correct by construction, and never attempts the violating insert. It passes unconditionally,
today and under item 1. Write it to attempt the cross-owner insert: it should fail before the
migration in item 1 and pass after, which also proves the migration bites.

**3. IMPORTANT — an offline capture's `created_at` is overwritten with the reconnect time.**
The router never passes `created_at`, and both `notes` and `checkins` default it to `now()`.
A mood logged Monday on a plane becomes a Wednesday row when the phone reconnects, so the
timeline and every chart over it are silently wrong. The `NOW_ISO` work is correct locally
and simply has no receiver. Fix: accept `created_at` on the PUT paths of both `createWithId`s.

**4. IMPORTANT — a replayed conflict PATCH creates a new conflict copy every time.**
`updateWithConflictCopy` has no dedupe, and `note_edit_base` is cleared only after
`batch.complete()`, so a lost response resends the same base and manufactures C2, C3… — N
duplicate notes in the inbox for one flaky upload.

**5. IMPORTANT — the conflict path can discard the losing body.** The metadata `update()`
runs before `create()` writes the copy and can throw (a domain change whose existing meta
fails the new domain's schema), so the op fails after the phone's text has left the queue and
before the copy exists. Creating the copy first makes the same failure non-destructive.

**6. IMPORTANT — the edit base is deleted after `complete()`.** A keystroke landing between
the read and the delete produces a second CRUD entry whose base row is then deleted, so the
next upload carries no base and silently last-write-wins over a concurrent web edit. Same
across a `haveMore` boundary. Delete only for note ids with nothing left queued.

**7. IMPORTANT — a failed open leaks the constructed `PowerSyncDatabase`.** If `setupNotesFts`
or `connect` throws, the catch nulls `opening` and rethrows without `close()`, so the retry
the code exists to enable opens a SECOND handle over the same encrypted file — the exact
state the in-flight guard is for.

**8. IMPORTANT — the sync-rules static assertions are blind to any query line not literally
starting `- SELECT`.** Lowercase, quoted, or block-scalar rules are invisible to every
assertion in the file, including the table-set equality. An unscoped duplicate `notes` query
in that form ships every user's notes to every device with all six static tests green.

**9. IMPORTANT — a replayed PUT for a since-deleted note reports `not_found`.**
`createWithId`'s 23505 fallback reads through `getById`, which filters `deleted_at`. The
replay branch wants "does this id exist and is it mine", not "is it live". Note this is the
*opposite* asymmetry from the ledgered `CheckinService.createWithId` item below.

**Minor, all recorded rather than fixed:** benign duplicate DELETEs pollute the `failed`
channel that is the only loss-detection surface; the conflict copy loses `domain`,
`domain_meta` and `media_item_id`; `resolveNoteMediaLink` writes the client's `domain_meta`
unvalidated on the PATCH path; an undone check-in will resurrect once anything reads
`checkins` locally (server soft-deletes, the sync rule has no `deleted_at` filter); a partial
export download leaves a truncated zip in cache; the share-sheet availability check runs after
the download rather than before; `trashNote` has no `deleted_at IS NULL` guard;
`note_tags`/`media_items.external_meta` mismatches between the device schema and Postgres are
latent until something writes those tables; web's refetch re-applies `matchesFilters` over
rows the query already narrowed; web's `useCallback` keys on object identity.

**A ledgered item below is WRONG and must not be actioned.** The deferred list says
`packages/sync` declares `updated_at` on `checkins` while `public.checkins` has no such
column. `00014_phase1c_hardening.sql:20-22` added it, with a `moddatetime` trigger,
explicitly for PowerSync ordering. `schema.ts` is correct; removing the column would be the
regression.

**Judgement call, deliberately not changed:** web's refetch keeps its client-side
`matchesFilters` pass. A reviewer argued it is a second description of the narrowing on the
very path the refactor single-sources. Task 16 kept it knowingly as a net, it is a strict
no-op today, and both directions have a failure mode. Left as-is, recorded here so the next
session does not rediscover the argument.

---

# Phase 1b — handoff, 2026-08-03

Plan: `docs/superpowers/plans/2026-08-02-phase-1b-mobile-offline-sync.md` (23 tasks, 4 stages).
Execution method: `superpowers:subagent-driven-development`.

Branch `feat/phase-1b-mobile-offline-sync`, working tree clean, nothing pushed. The SDD ledger
at `.superpowers/sdd/2026-08-02-phase-1b-mobile-offline-sync/progress.md` holds per-task detail,
but `.superpowers/` is **gitignored** — it exists only on this machine. This file is the
committed copy of what matters.

---

## Where execution stopped

| Stage | Tasks | State |
| --- | --- | --- |
| 1 — server + shared | 1–7 | **Complete.** Every task reviewed clean. Shipped to production. |
| 2 — security baseline | 8–13 | **Complete.** All six tasks done and reviewed. |
| 3 — shared filters | 14–16 | **Complete.** `282666d`, `b824a2a`, `083ab6a`. None independently reviewed. |
| 4 — mobile parity | 17–23 | **All complete.** None independently reviewed. |
### Where this actually stands

**All 23 tasks are implemented and committed. Nothing is pushed.** Two things remain, both
needing a human:

1. **Task 23 Step 4 — the device-security table**, plus the accumulated feature checklist
   below. None of it can be asserted from a test runner.
2. **Task 23 Step 6 — push and open the PR.** Deliberately not run: it is outward-facing and
   was never explicitly authorised.

**Then the whole-branch review.** Tasks 14–23 were all implemented inline rather than by
subagents (the session harness forbids dispatching agents unasked), so **ten consecutive tasks
have had no independent review**. That is the single largest risk on this branch.

### Device verification checklist

Use dev client EAS **`f603e36f`** (submitted 2026-08-03), NOT `37039bce` — Stage 4 added
`expo-sharing` and `expo-file-system`, which a binary built before them cannot load.

Features:

1. Capture online, then in airplane mode; both appear instantly; both reach web on reconnect.
2. Three notes in the list, view switching, search for a word in one body only.
3. Edit a note on web, wait for sync, search the OLD word — must return nothing (the
   replace-safe FTS trigger).
4. **The conflict run, which nothing else can prove:** open a note, airplane mode, edit the
   body. Edit the same note differently on web, save. Reconnect. Expect TWO notes — the web
   body on the original, the phone body as a new inbox note. This is the only check on the
   `sessionBase` fix, which lives in a `.tsx` no unit test can import.
5. Airplane mode: tap a mood, "Logged ✓", Undo. Reconnect and confirm **no** check-in row on
   web — the Task 21 regression check.
6. Airplane mode: log a film that already exists in the library under different casing.
   Reconnect. On web, **one** media item, both notes pointing at it.
7. Export while online — share sheet opens with a zip. Then airplane mode: the button reads
   "Export needs a connection" and is disabled.

Security (Task 23 Step 4):

| Check | Expected |
|---|---|
| Kill and reopen the app | Biometric prompt before any note is visible |
| Background 10s, return | No prompt (inside the 60s grace) |
| Background 90s, return | Prompt |
| Sign out, sign back in | Zero local notes before the first sync completes |
| Enroll a new fingerprint, reopen | Reset banner appears; notes resync from the server |
| `adb backup` the app | Refused / empty — `allowBackup=false` |
| Purge a note on web | It disappears from the phone after sync |

Also confirm the three `[OP-SQLITE]` lines in the new build's Gradle log, or re-run the APK
marker check in `docs/deploy.md` § "Stage 4 ship".

### Verification state — the full gate has been run

Docker was down for Tasks 9–13, so every gate in that stretch was 26/26 with **23 cached**; only
the three `@cortex/mobile` tasks ran fresh. Docker has been up since; the gate after Task 16 was
`pnpm turbo run typecheck lint test --force` → **26/26 fresh, 0 cached, 395 tests**
(mobile 47, shared 54, sync 4, api 68, core 100, web 20, db 93). Every Supabase-backed suite ran
rather than replayed.

One clarification for whoever reads a `Cached:` line next. During Task 16,
`turbo run build --filter=@cortex/web` answered `FULL TURBO, 2 cached` on a tree with
uncommitted web changes, which looks like a stale replay but was **not** one:
`turbo.json` gives `test` and `typecheck` `dependsOn: ["^build", "build"]`, so the filtered
`typecheck lint test` run a moment earlier had already built web with those changes, and the
explicit build legitimately hit that entry. Re-running with `--force` produced the same result.
The rule still stands — read the `Cached:` line, and `--force` when a gate has to be evidence —
but a cache hit on `build` right after a `test` run is expected, not a symptom.

Docker Desktop is frequently down on this machine. When it is, `@cortex/db`, `@cortex/api` and
`@cortex/core` are **turbo cache replays, not runs**. That is acceptable for a diff confined to
`apps/mobile` provided it is stated explicitly, and never implied as a run.

---

## Outstanding actions for the human

**None. All three cleared**, recorded here so a later session does not re-raise them.

0. **Dev client rebuilt, and both native flags verified in the APK — done 2026-08-03.**
   EAS build `37039bce-24ce-4f6e-9e9c-a8ef1125369d`, profile `development`, commit `72cbae0`,
   finished. (`expo-dev-client` was missing and had to be added first — EAS refuses a
   `developmentClient` build without it.)

   There is no Android SDK on this machine, so the Gradle configure-time `[OP-SQLITE]` lines
   could not be produced locally. Verified against the **built artifact** instead, which is
   stronger than the log line and matches this branch's own rule about merged artifacts:
   `libop-sqlite.so` was extracted from the APK and scanned for markers that exist only when
   the feature is compiled in.

   | Flag | Markers | Result |
   | --- | --- | --- |
   | `sqlcipher: true` | `sqlite3_key`, `sqlite3_rekey`, `PRAGMA cipher`, `cipher_version`, `sqlcipher_extra_init` | **present** |
   | `fts5: true` | `bm25`, `detail=none`, `unindexed`, `fts5vocab`, `porter`, `trigram` | **present** |

   **Negative controls make this conclusive rather than suggestive**, because a bare `fts5`
   substring survives in the amalgamation whether or not the feature is compiled. The flags
   deliberately NOT set are all absent from the same binary: `rtree` (`rtreecheck`, `rtree_i32`,
   `RtreeNode`), sqlite-vec (`vec0`, `vec_distance`), CR-SQLite (`crsql_`) — every one at zero.
   So the config genuinely differentiates, and `fts5`'s markers are there because it was enabled.
   `unindexed` in particular is the exact column option Task 19's
   `fts5(id UNINDEXED, content)` needs.

   **All four ABIs checked, not just one** — `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` are
   identical on all three properties. A per-arch divergence would ship an unencrypted database
   to some devices only.

   For the record, **do not accept the plan's check for this**. It says to grep
   `apps/mobile/android/*.gradle` for `sqlcipher`; that matches nothing whether or not the flag
   is set, because the flag is consumed in op-sqlite's own `build.gradle` under `node_modules`.
   A green grep there would be an unencrypted database that looks configured.

1. **`supabase db push` for `00016_powersync_publication.sql` — done.** `00001`–`00016` are
   local == remote. (The CLI is a devDependency: `npx supabase`, not `supabase`.) The migration's
   `if not exists` guard means the push proved only that the `_test_publication_tables` helper
   landed, not that the hosted publication had the right scope — a pre-existing wrong scope would
   have been skipped silently. Closed separately by running
   `select * from _test_publication_tables('powersync');` in the dashboard SQL editor: **six rows,
   no `integrations`.** The automated test still covers the local stack and CI only, so any future
   suspicion of drift needs that same manual query.
2. **Stale plaintext Supabase sessions revoked — done.** Task 8 moved the session into Keystore,
   but the old one remained in plaintext on any device that already had one, and this build can no
   longer delete it (the `@react-native-async-storage/async-storage` dependency is gone). It was
   also inside whatever Auto Backup snapshots Google had already taken, and a Supabase refresh
   token does not expire on its own. Revoked server-side via the SQL editor — deleting from
   `auth.refresh_tokens` **and** `auth.sessions`, because tokens issued by older GoTrue versions
   can carry a null `session_id` and survive the cascade from `auth.sessions` alone.
   (`auth.refresh_tokens.user_id` is a `varchar`, so it needs an `::text` cast.)

   **Task 8's security claim now holds**: no live refresh token predates the Keystore migration,
   including the copies already on Drive, which is why server-side revocation was required rather
   than deleting the local file. Already-issued access tokens stayed valid until their normal
   1-hour expiry — a bounded, accepted window; rotating the JWT secret was judged unwarranted.

---

## Stage 4 — what shipped

### Tasks 22–23 — media log, export, purge propagation (commits `590469c`..`cf919a3`)

**Task 22 — the plan wrote the status list out by hand, directly under its own warning not
to.** The comment above `KINDS` explains that a hand-written copy of the media kinds drifted
during planning and the DB check constraint would have rejected every log at runtime — and then
`STATUSES` is a hand-written parallel list. The statuses already existed three times across the
codebase (`logMediaInput`, `domainMetaSchemas.media`, and the form). They are now one
`mediaStatus` enum in `@cortex/shared`, with the other two repointed at it. A drifted copy is
not a type error anywhere: it reaches the server, fails `.strict()` validation, and the op is
reported in `failed` inside a 200 — the log silently dropped.

`rating` is omitted rather than sent as `null`, for the same reason: `.strict()` treats `null`
as a value of the wrong type, not as "no rating".

The strongest test there **runs the server's own validator** — `validateDomainMeta("media", …)`
across every status the shared enum defines, plus `pendingMediaItem.safeParse` on the item.
Asserting the built object's shape by hand would restate the builder; running the real schema
is what catches drift between the two.

`datetime('now')` appeared in Tasks 18, 20, 21 **and** 22 — four of the five Stage 4 tasks that
write SQL. `NOW_ISO` in `src/lib/sql.ts` is now the only copy.

**Task 23 — the plan's export does nothing.** Its `run()` fetches the archive and discards it,
with a comment saying to add `expo-sharing` "if not already installed". It was not. Now
implemented: `File.downloadFileAsync` streams the zip to disk (the server streams it to keep
memory flat, so buffering here would undo that), into the **cache** directory rather than
documents — the file exists only to be handed to another app. A same-day export is cleared
first or the download fails on the existing name; an unavailable share sheet reports rather
than claiming a success the user cannot act on.

**The plan's first purge test is close to tautological** — it performs the delete, then asserts
the delete happened. The property worth asserting is that nothing rewrites that DELETE into an
update, and that children go with it, since logical replication bypasses RLS and a row still
visible to `service_role` is a row still on the phone. Added: `links` removed from **both** FK
directions (a cascade on one column is easy to miss and leaves half the references dangling), a
bystander note survives, and a note that was never trashed cannot be purged at all.

`docs/deploy.md` gained a "Stage 4 ship" section: the `op-sqlite` flags and the three Gradle
lines that confirm them, how to verify them from the APK with no Android SDK (with the negative
control that makes it conclusive), the rule that the PowerSync majors move together plus the
`readlink` check, and why a development build needs no EAS env vars while preview/production do.

Gate: **26/26, 0 cached, 491 tests**, Docker up.

### Task 21 — mood check-in, and an undo that could never reach the server (commit `590469c`)

**The plan's undo is an `UPDATE`, and the router rejects it.** It issues
`UPDATE checkins SET deleted_at = ...`, which PowerSync turns into a **PATCH**. The router
takes exactly PUT and DELETE on checkins and throws `validation` on anything else, so the op
lands in `failed` **while the response is still 200** — the connector completes the batch and
the undo is discarded. The check-in stays on the server forever while the phone shows it gone.
The plan's own Step 2 asks you to "confirm no check-in row arrives on web", which is precisely
the check its own code fails.

Undo is now a local `DELETE`, which becomes a DELETE op and reaches `CheckinService.softDelete`.
Hard locally, soft on the server, deliberately: the row is gone from the device because the
user asked for it, and the tombstone every synced table needs is the server's job.

**Nothing pinned that server rule before.** Two e2e cases now do — a checkins PATCH is rejected
and does not half-apply, and the DELETE mobile actually sends is accepted and tombstones.
Deleting the router's `else throw` fails the first.

`datetime('now')` was here too — **three tasks running** now (18, 20, 21). Assume Tasks 22–23
have it.

`updated_at` is not written. `packages/sync` declares the column on checkins but
`public.checkins` has none (migration 00013), so a value written there lives on one device and
is null the moment the server's row syncs back.

The double-tap guard is a **ref, not the `busy` state**: state updates are async, so two quick
taps both pass `disabled={busy}` before either re-render lands, and each is a separate
check-in.

10 mobile tests on real SQLite, 2 api e2e. Six mutations: the plan's undo fails 3 (including
the behavioural "removes the row from this device"), its `datetime('now')` fails its own, and a
reused id, a missing WHERE and a stray `updated_at` each fail theirs.
Gate: **26/26, 0 cached, 465 tests**, Docker up.

### Task 20 — note editor and the conflict base (commit `d93e324`)

**The plan captures the conflict base at the wrong moment, and the failure is silent.** It
calls `recordEditBase` inside the first debounced save, passing `note.updated_at` as the row
reads *then*. The editor seeds its text once and then leaves it alone, so a change arriving
from the server mid-session advances `notes.updated_at` while the text on screen still reflects
the OLDER body. Recording that newer value tells the server the user edited the current
version — its `moved` check finds nothing, no conflict copy is written, and the stale-based
edit overwrites the newer one. That is precisely the outcome §6.2 exists to prevent, arriving
through the mechanism meant to prevent it.

The base is now captured in a ref at the instant the content is seeded. The `note_edit_base`
row is still only written on first save: writing it on open would leave a stale base behind for
every note merely opened, and the connector only clears bases after an upload that actually
happened.

**`datetime('now')` was in all three mutations** — the Task 18 bug again, and worse here. This
column becomes the NEXT session's `base_updated_at`, which the server validates as
`z.iso.datetime()`, so the space-separated form is an upload **rejected outright** rather than
a sorting oddity. The expression now lives once in `src/lib/sql.ts` as `NOW_ISO`, with
`capture.ts` repointed at it. Two tasks in a row shipped this bug from the plan; assume
Tasks 21–23 do too.

**Tags are absent, and that is the plan's own inconsistency, not an omission here.** The task
is titled "Note editor, archive and tags" but no step implements any tag UI, its Files list has
nothing tag-related, and the plan's phase summary describes Stage 4 as "capture, list, editor,
check-in, media log, export". The note list's `tag` filter works; nothing on mobile assigns a
tag. **Decide whether phase 1b needs mobile tag assignment before the Task 23 gate** — if it
does, it is unplanned work, not a fix.

**A limitation to carry: the `sessionBase` fix cannot be unit-tested.** It lives in
`note-editor.tsx`, and importing an RN component under `environment: "node"` dies with a Rollup
Flow parse error. `recordEditBase` documents the contract and its own tests are thorough, but
nothing proves the caller passes the seeded value rather than the current one. **Step 5's
airplane-mode conflict run is the only thing that can**, which is why it is first on the device
checklist above.

11 new tests on real SQLite. The plan's `datetime('now')` fails 3; overwriting the base,
guarding on "any base exists" rather than this note's, a trash that skips `updated_at`, and a
hard delete each fail their own.
Gate: **26/26, 0 cached, 453 tests**, Docker up.

### Task 19 — note list and the local FTS index (commit `9cfe51b`)

**The plan's Step 2 could not have worked, in three independent ways.** It creates

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(content, content_rowid=id, tokenize='unicode61')
```

`content_rowid` is only legal alongside an external content table (`content=`), so the CREATE
itself fails; there is no `id` column for the clause `noteFiltersToSql` actually emits to select
from; and its population inserts a TEXT uuid into `rowid`, an INTEGER. The correct shape is
documented on `noteFiltersToSql` itself — `fts5(id UNINDEXED, content)`, selecting `id` and
never `rowid`, because an FTS5 rowid is an integer while `notes.id` is a uuid, so a rowid-keyed
table matches nothing for every search **without ever erroring**. The plan's shape fails 8 of
the 14 new tests.

Three further corrections, each its own failure mode:

- **Triggers on `ps_data__notes`, not a rebuild inside `statusChanged`.** The plan guarded its
  full repopulate with `if (!status.hasSynced) return`, but `hasSynced` latches true after the
  first sync — so every later status change (a connection blip, an upload starting, a
  checkpoint) would delete and rebuild the entire index while reads ran against it. Rebuild is
  now once per launch, which is what repairs an index that drifted; the triggers keep it
  current in between.
- **The insert trigger deletes any existing row for that id first.** SQLite fires DELETE
  triggers for a row evicted by `INSERT OR REPLACE` only when `recursive_triggers` is ON, and
  it is off by default — `libpowersync.so` never sets it. Without the extra DELETE a replace
  leaves the old body indexed forever: search keeps finding notes by words they no longer
  contain, gaining one stale copy per edit. Making the insert path idempotent covers every
  write pattern rather than betting on which one replication uses.
- **Soft-deleted notes stay indexed.** The plan populated `WHERE deleted_at IS NULL`, which
  makes trash search contradict itself — the view demands `deleted_at is not null` while the
  index holds only rows where it IS null — so it returns nothing and raises nothing. The index
  is a text index; deciding visibility is the WHERE clause's job.

Imports come from **`@cortex/shared`**, not `@cortex/core` as the plan says (Task 14 ruling).

**The tests run the real emitted clause against a faithful stand-in for PowerSync's local
layout on real SQLite**, so they exercise the `id`-vs-`rowid` trap directly. The internal shape
is not guessed: `(id TEXT PRIMARY KEY NOT NULL, data TEXT)` was read out of the
`libpowersync.so` inside the APK we ship, and `notes` is an auto-generated view of
`json_extract` over that `data` column. Useful for any later task that needs to reach beneath
the view.

**Two of my own tests were initially unfalsifiable**, both caught by mutation rather than by
review — the same failure mode this branch keeps finding. The trash test created its rows
*after* `setupNotesFts`, so the triggers indexed them whatever the rebuild did, and it stayed
green under the plan's `deleted_at` filter; it now seeds the row before setup. (Task 18 had one
too. Assume the next one exists and mutate for it.)

Gate: **26/26, 0 cached, 442 tests**, Docker up.

### Task 18 — quick capture, and two bugs a device write exposed (commit `1f900ce`)

Both were invisible until something actually wrote a note from the phone, which is why nothing
before this task caught them.

**1. `datetime('now')` is the wrong timestamp format, and Task 19 orders by it.** SQLite's
`datetime()` returns `2026-08-03 10:00:00` — space-separated, second precision, no zone. Rows
the server echoes back are ISO with a `T` and a `Z`, and `ORDER BY` on a TEXT column is a byte
comparison: a space (0x20) sorts below `T` (0x54), so within a single day **every locally
captured note sorts beneath every synced note** regardless of its real time. Separately,
`syncOp.base_updated_at` is `z.iso.datetime()`, which rejects both the space form and a numeric
offset, so Task 20 would have had its conflict-copy base rejected server-side. Now
`strftime('%Y-%m-%dT%H:%M:%fZ','now')`.

**2. `domain_meta` arrives at the server as a STRING and the router cast it to an object.**
PowerSync's local schema has no jsonb type, so `packages/sync` declares the column `column.text`
and the device serialises it — every op from a phone carries `"{}"`, not `{}`. The old
`(data.domain_meta ?? {}) as Record<string, unknown>` is a cast, so it silenced the difference
instead of handling it, and all three consequences were silent:

- With a domain set, `validateDomainMeta` parsed a string against an object schema, threw
  `validation`, and the op landed in `failed` **while the response stayed 200** — so the
  connector completed the batch and the note was dropped. Present on the device forever, never
  on the server, nothing surfaced to the user. This is the severe one.
- With no domain, `"{}"` reached PostgREST and stored in the jsonb column as a JSON *string*
  rather than an object.
- `domainMeta.pending_item` on a string is `undefined`, so an offline media log never resolved
  its media item (spec §5.3) and reported nothing either — the whole point of Task 22.

`readDomainMeta` now takes both shapes and **fails the op** on anything it cannot parse rather
than defaulting to `{}`; a device serialising this wrongly needs to appear in `failed`, not to
have its metadata quietly discarded while the note saves. `Array.isArray` is a separate guard
because `typeof [] === "object"`.

**Why it survived this long: every existing `sync-upload` test sends `domain_meta` as an
object.** The suite modelled the API contract, not the wire format the mobile write path
produces. The new cases send strings, and the original cast fails **5 of the 6**.

**The capture SQL is tested by executing it on real SQLite**, not by asserting its text — the
Task 15 precedent. The timestamp format is only observable by running the statement; an
assertion over the SQL string restates the implementation and passes on anything that parses.
`uuid()` is registered in the test because it belongs to PowerSync's SQLite core extension
rather than to SQLite. `better-sqlite3` is now a test-only devDependency of `@cortex/mobile`
as well as `@cortex/core`, and `pnpm-workspace.yaml`'s `allowBuilds` note was updated to say so.

The write lives in `src/lib/capture.ts`, not in the screen. Anything importing an RN component
dies under `environment: "node"`, so logic left in the `.tsx` is logic that cannot be tested —
and the statement is where every consequence is.

**One of my own tests was initially unfalsifiable** and is worth recording, because it is the
exact failure mode this branch keeps finding. The sort test overwrote the captured
`created_at` with an ISO literal before asserting order, so it tested SQLite's string
comparison rather than the statement, and stayed green under `datetime('now')`. It now derives
the comparison row from whatever the statement actually produced, and fails as it should.

Also: **the connector now surfaces ops the server rejected inside a 200.** Previously a 200 was
treated as total success. What to *do* about them is unresolved — see the deferred list.

Verified without a device: 9 capture tests on real SQLite, 6 new sync-upload e2e cases, 2 new
connector cases. Ten mutations run, each failing exactly its own test — including the plan's
own `datetime('now')` (fails 2 of 9) and the router's original cast (fails 5 of 6).
Gate: **26/26, 0 cached, 428 tests**, Docker up.

**Not verified:** Step 3's device run — capture online, capture in airplane mode, confirm both
reach web. That needs a human with the dev client installed.

### Task 17 — PowerSync provider and connector (commit `c6757f9`)

**The app is on the `@powersync/*` v2 major now, and that was forced, not chosen.** v2 is the
major that switched from `@journeyapps/react-native-quick-sqlite` to
`@op-engineering/op-sqlite`, so the plan's own Step 2 — installing op-sqlite and setting
`op-sqlite: { sqlcipher: true }` — only describes v2. v1 would need a different encryption
story entirely.

That exposed the dedupe trap from the other direction. `@powersync/react-native@2` peers on
`@powersync/common@^2`, `packages/sync` pinned `^1.57`, and `apps/mobile` declared no
`@powersync/common` at all — so pnpm resolved the shared peer **down a major**, giving a v2
`PowerSyncDatabase` running on v1.57 primitives, one physical copy and the wrong one. Both
packages now pin `^2.0.0` explicitly; `packages/sync` and `apps/mobile` and the RN SDK's own
tree all resolve to the same `@powersync/common@2.0.0` path. `packages/sync` needed no source
change — build, typecheck, lint and its 4 tests pass unchanged on v2.

**`fts5: true` is in the `op-sqlite` block, and Task 19 depends on it.** op-sqlite only adds
`-DSQLITE_ENABLE_FTS5=1` when that flag is set (`android/build.gradle`), so without it
Task 19's `CREATE VIRTUAL TABLE notes_fts USING fts5(...)` fails at runtime with "no such
module: fts5". It is a **native** flag — discovering it at Task 19 would cost a second
dev-client rebuild, so it went in here, with the rebuild this task already needs. **Both it and
`sqlcipher` are now verified in the built APK** — see "Outstanding actions" item 0 for the
marker evidence and the negative controls.

**`dbLocation` is pinned to op-sqlite's `ANDROID_DATABASE_PATH`, not left to default.** The
plan said to resolve the path against the installed package, and doing that revealed the path
is not a constant at all: `OPSqliteAdapter.openDatabase` picks explicit `dbLocation` first,
else asks `NativePowerSyncHelper.resolveDefaultDatabaseLocation`, which returns
`context.filesDir` **only if** a legacy RNQS database already sits there, else op-sqlite's
`context.getDatabasePath()`. Left unset, the location depends on a file's existence and the
recovery delete would have to reproduce that decision — a wrong guess deletes nothing,
succeeds silently, and the open then hits the still-present old file. Pinning collapses all
three branches to one constant that open and delete share. Safe on a first run: op-sqlite
`create_directories` the location on open (`cpp/bridge.cpp:73`). The RNQS branch can never
apply — no cortex build has ever shipped a local database.

**`getCrudBatch` takes an explicit limit, and this was a data-loss bug in the plan's code.**
Unbounded it can return more ops than `syncUploadInput` accepts; the server answers 400; the
connector's own 4xx branch treats 400 as permanent and calls `batch.complete()` — discarding
writes the user made offline. The cap is now `SYNC_UPLOAD_MAX_OPS`, exported from
`@cortex/shared` and used by both the zod schema and the connector, so a second literal cannot
drift. `haveMore` brings the remainder back, so the cap costs a round trip and never data.

`apps/mobile` depends on **`@cortex/shared`**, not `@cortex/core` — the Stage 3 ruling. The
plan's install list said core while its own connector code already imported `SyncOp` from
shared. This also discharges the "Task 19 must add the dependency" note below.

**25 tests where the plan specified 4**, and `uploadData` — which holds the batch limit, the
conflict-copy base, and which failures discard the user's writes — had none at all in the plan.
Two of the six mapping cases cover guard halves the plan's four left unexercised: drop
`op === "PATCH"` from the base guard, or the `?? {}` on `opData`, and all four plan cases stay
green. **Nine mutations run**, each failing exactly the test that exists to catch it:
constructing before the delete; leaving the `-wal`/`-shm` siblings; dropping the in-flight race
guard; hardcoding `strongBiometrics`; retaining the poisoned promise after a failed open;
dropping either half of the base guard; sending `data` on a DELETE; dropping the batch limit;
swapping the 4xx/5xx branches.

Gate: `pnpm turbo run typecheck lint test --force` → **26/26, 0 cached, 411 tests**
(mobile 72, shared 54, sync 4, api 68, core 100, web 20, db 93). Docker was up, so the
Supabase-backed suites ran rather than replayed. CI needed no change — `@cortex/mobile` and
`@cortex/shared` are already named in `ci.yml` (checked, per the Task 7 rule).

Smaller things carried forward:

- `initPowerSync` memoises an **in-flight promise**, not just the resolved database. Two
  callers racing the first mount would otherwise construct two `PowerSyncDatabase` instances
  over one file — two sync streams and two write queues. The promise is cleared on failure, or
  a user who cancelled the biometric prompt would re-await the same rejection forever with
  nothing to retry.
- `PowerSyncProvider` mounts **inside** `AppLockGate`. Opening the database prompts for the
  biometric guarding its key, so mounting it outside would authenticate the user twice for one
  entry and touch local data ahead of the gate that exists to stop that (§7.7).
- `signOut` now passes `getPowerSync()` instead of Task 13's `null` placeholder.
- The prebuild was re-run and `allowBackup="false"` plus the secure-store backup rules were
  re-confirmed in the merged `AndroidManifest.xml`. Task 11's guarantee survives the
  regeneration.

---

## Stage 3 — what shipped so far

### Task 14 changed where the filters live (commit `282666d`)

**The plan says `@cortex/core`. They are in `@cortex/shared`.** Tasks 15, 16 and 19 all inherit
this, so their plan text needs adjusting as you reach them.

Task 14 Step 5 asks for that decision at Task 14, on the question "does this drag Node-only code
into a bundler" — but the check it specifies cannot answer it. Deep-importing
`dist/notes/filters.js` passes either way, because `filters.ts` imports only the domain enum.
The import Tasks 16 and 19 actually use is the package **barrel**, and `@cortex/core`'s barrel
reaches `archiver` through `export/service.ts`, with no `sideEffects: false` in core's
package.json to stop a bundler following it. Task 16 puts that barrel behind
`apps/web/src/lib/note-views.ts`, which `note-list.tsx` — a `"use client"` component — imports;
Metro (Task 19) tree-shakes far less than webpack. The plan's fallback sentence also asserts
"@cortex/shared, which mobile already depends on": `apps/mobile` depends on neither shared nor
core today, so Task 19 has to add the dependency either way.

Ruled by the human on 2026-08-03: `packages/shared/src/notes/filters.ts`, with
`packages/core/src/notes/filters.ts` re-exporting the six names **explicitly** (not `export *`,
so adding an export to shared cannot silently widen core's surface). Shared is zod-only,
already a web dependency, and `applyNoteFilters` types the query builder structurally, so it
needs no supabase-js. Task 16's `from "@cortex/core"` still resolves for the server component —
but web's **client** component and mobile should import `@cortex/shared` directly.

Consequences to carry:

- Tests split by what needs a database: 20 pure tests in `@cortex/shared` (parse, select,
  predicate, refetch — **no Docker**), 12 PostgREST tests in `@cortex/core` where the harness
  lives. Both suites were already named in `ci.yml`, so no CI change was needed — checked
  rather than assumed, per the Task 7 rule.
- **Task 15's `noteFiltersToSql` belongs in shared too**, for the same reason: Task 19 consumes
  it from React Native. Only its equivalence test stays in `packages/core`, where Postgres and
  `better-sqlite3` can meet.

**Five of Task 14's planned DB tests could not fail** — the same scan that caught Task 12's.
All five asserted `data.every(...)` over the query's own narrowing with no lower bound, which
restates the query and is vacuously true on an empty result. The worst, "domain narrows without
overriding the view", asserted only `deleted_at !== null` — nothing about domain — over seed
data that returned zero rows. There was also no delete before seeding against a fixed fixture
email. Rewritten as exact id sets over named seeded rows, failing in both directions, with two
rows the plan did not seed (a trashed undomained note, an undomained inbox note) so the domain
filter has something to wrongly admit as well as wrongly exclude.

**Four mutations run to prove the guards bite**, each failing exactly the predicted tests:

- `eq("lifecycle","active")` for `in([active,evergreen])` → "active covers both" failed, 1 id
  vs 2. The plan's `every()` version stays green under this.
- domain clause skipped on trash → "domain narrows without overriding the view" failed, 2 vs 1.
  **This is the one the plan's assertion could not see** — both wrongly-returned rows are
  trashed, so `every(deleted_at !== null)` holds.
- domain clause applied with `is(deleted_at, null)` → same test failed.
- `textSearch` and the `note_tags.tag_id` predicate dropped → both FTS tests and "an unused tag
  returns nothing rather than everything" failed. "tag narrows through the join" **passed**
  under that mutation, which is the whole argument for the unused-tag test.

### Task 15 fixed a shipping bug in the plan's own code (commit `b824a2a`)

`noteFiltersToSql` and `toSqlitePlaceholders` are in `@cortex/shared` for the same reason as
Task 14 — Task 19 consumes them from React Native. Only the equivalence test lives in
`packages/core`, where Postgres and `better-sqlite3` can meet.

**The planned FTS clause could never match.** It read

```sql
n.id in (select rowid from notes_fts where notes_fts match ?)
```

An FTS5 `rowid` is an INTEGER and `notes.id` is a TEXT uuid, so that `in` is never true: it
compiles, executes, and silently returns nothing for every search. Confirmed by running the
plan's version against real SQLite — all four `q` cases came back `[]`. **Task 19 must create**

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, content)
```

and the clause selects `id`, not `rowid`. That is also the shape PowerSync's own FTS setup uses,
and it is documented on the function itself.

Nothing in the plan's suite could have caught it, by construction: `q` is deliberately excluded
from the structural cases (correctly — the two engines tokenise differently), the planned
`beforeAll` never created `notes_fts`, so the whole FTS branch shipped unexecuted. The `tag`
branch was unexecuted for the same reason — no tag case, and a `note_tags` table created but
never populated. Both have cases now.

**Agreement was also asserted where correctness was meant.** The plan asserted only
`sqlIds(f) == postgrestIds(f)`. Two implementations that both drop `evergreen` agree perfectly,
and two empty results agree too. Every case is now anchored three ways —
SQLite == expected == PostgREST — and the SQLite mirror asserts its own row counts, so a
silently-empty copy fails where the cause is visible instead of making every comparison vacuous.

`better-sqlite3` is a test-only devDependency of `@cortex/core`. `pnpm-workspace.yaml` now
allows its install script (`allowBuilds`), which a native module needs — CI installs would
otherwise skip the build and the suite would fail there only.

### Task 16 removed the E5 duplication (commit `083ab6a`)

Both web query sites now build from `applyNoteFilters`; `note-views.ts` keeps only
`VIEW_LABELS` and re-exports the rest **from `@cortex/shared`** (not core — `note-list.tsx` is
the `"use client"` component the placement ruling was about).

- The refetch gained a narrowing it never had: it applied `deleted_at`, `q`, `tag` and `domain`
  but **not `lifecycle`**, leaning on a client-side `matchesView` pass to drop rows the query
  should not have returned. It now narrows server-side and keeps the client pass as a net.
- `if (q || tag)` — the hand-maintained restatement of which fields `matchesView` ignores, kept
  in a different file from the function it had to agree with — is now `requiresRefetch(filters)`.
- Verified E5 cannot recur: `textSearch` and `note_tags!inner` appear nowhere in `apps/web/src`.
- Web's suite went 29 → 20: twelve `parseView`/`parseDomain`/`matchesView` cases moved to
  `@cortex/shared` (where 20 cases now cover them), replaced by three web-only ones.
- Production build run with `--force`, not from cache. Route `/` unchanged at 3.6 kB / 198 kB
  First Load JS, which is the evidence the shared placement kept the bundle flat.

**None of Tasks 14–16 has had an independent review** — they were implemented inline rather than
by subagents (the session harness forbids dispatching agents unasked). Fold all three into the
whole-branch review after Task 23.

---

## Stage 2 — what shipped

Task 9 was implemented but unreviewed at the previous handoff. **That review has now run.**

### Task 9 review outcome (commit `85c6bc2`)

All three of the implementer's deviations were adjudicated:

- **D1 — flag-first write ordering + load-path flag repair: CORRECT, kept.** The Critical they
  found is real. The new crash window flag-first opens (flag written, key not) always resolves
  to `lost`, and a false `lost` can never land on recoverable data: `lost` requires flag-present
  and key-absent, and with the key absent any existing encrypted database is unopenable anyway,
  so the wipe destroys nothing that was still readable. The only genuinely-false case is a flag
  written on a run that never produced a database, which costs a resync on what is still
  effectively a first run.
  - Caveat for the record: the `it.each` case for `cortex.db.initialized` does **not** pin the
    ordering on its own — with the load-path repair present, key-first passes it too. Only the
    `cortex.db.key` case exercises flag-first directly.
- **D2 — wrapping the creation-path write: CORRECT, with a required fix applied.** The mapping
  is right, but a bare `catch` turned a corrupt keystore or a full disk into
  `biometric_prompt_failed`, telling the caller to re-prompt a user who cannot fix it. Both
  paths now carry `{ cause }`.
- **D3 — the implementer was right; the plan correction was defensive, not load-bearing.**
  An un-gated recovery write is caught by the mock's own `else authGated.delete(k)`, and a
  missing write is caught by the `store.get(DB_KEY_NAME)` assertion on the preceding line. No
  wrong implementation exists that the `authGated` deletion catches and the rest misses. Kept
  as honest OS modelling only.

Both open questions were settled:

- **`lost` now names its key `unusableKey`.** With `key` on all three variants,
  `const { key } = await getOrCreateDatabaseKey()` type-checked and silently skipped the wipe.
  The asymmetry makes reading a key off the union a compile error until the caller branches on
  `status`. This also caught a real bug in **Task 17's planned code**, which built the database
  with `outcome.key` and called `disconnectAndClear()` afterwards — that has to init the
  database before it can clear it, so it would fail on "file is not a database" rather than
  recover. The plan now deletes the file first; see Task 17's note.
- **Risk 3 (no biometric enrolled) is resolved in Task 10.** See below.

### Task 10 — app lock, and the spec conflict it had to resolve (commit `ec5b7b4`)

Spec §7.6 keeps `disableDeviceFallback: false` so a PIN-only device is not locked out, but the
key manager's `requireAuthentication: true` throws on both read and write when no **Class 3**
biometric is enrolled. Those users cleared the lock with their PIN and were then rejected
fetching the key — the same lockout by another route.

- `getOrCreateDatabaseKey({ strongBiometrics })` gates only the **write**. No mode is persisted
  and none is needed: the Android read takes `requireAuthentication` from the *stored item*, not
  from the options (`SecureStoreModule.readJSONEncodedItem` line 130; `AESEncryptor` comments it
  explicitly). One key therefore survives a change of device security in both directions, and
  both transitions are tested.
- The un-gated key is deliberately **not** upgraded when a biometric appears later. Re-gating
  would silently arm the invalidation path, and therefore the wipe, for a user who had no such
  exposure before.
- **`hasStrongBiometrics()` uses `getEnrolledLevelAsync()`, never `isEnrolledAsync()`.** The
  latter is `canAuthenticateUsingWeakBiometrics()`, so a phone whose only enrolled biometric is
  2D face unlock answers `true` while SecureStore still throws — crashing on exactly the Class 2
  hardware §7.6 calls spoofable. The plan's original test mocked the wrong one.
- `AppLockGate` guards against its own prompt: on some devices the system biometric dialog moves
  AppState off `active`, which unguarded reads as a return from background and re-locks the user
  it just authenticated, forever.

### Task 11 — backup off, and it takes two mechanisms (commit `039d0ed`)

`android:allowBackup="false"` verified in the merged manifest via prebuild. But on Android 12+
that disables cloud backup and **not** device-to-device transfer. What covers D2D is
`expo-secure-store`'s own `secure_store_data_extraction_rules.xml`, which includes only the
`sharedpref` domain — so the `database` and `file` domains, where the SQLCipher file lives, are
outside both. The previous handoff ledgered those rules as an incidental side effect of
`expo install`; they are load-bearing. Full detail in `docs/deploy.md` § "Backup and transfer
are OFF".

`apps/mobile/android/` and `ios/` are now gitignored — this is a CNG project and the prebuild
this task requires would otherwise have dropped hundreds of untracked files into the repo.

### Task 13 — sign-out wipes (commit `3dd191e`)

The plan's third test contradicted the plan's implementation: it called `wipeLocalData(db)` with
a throwing database and asserted only that the key was cleared, but the `finally` re-raises, so
that test failed against the very code it shipped with. Propagation was kept and the test fixed
— `signOut` awaits this before `supabase.auth.signOut()`, so a caller that cannot distinguish a
partial wipe from a complete one reports "signed out" over a device it did not finish cleaning.
A fourth test covers the dangerous direction: a failure to clear the key itself.

`signOut` passes `null` until Task 17 exists to hand over a database. Task 17 Step 6 already
carries the replacement step.

### Task 12 — sync-rule isolation, and the publication in version control (commit `8623a52`)

Mostly test repair. **Four of the plan's tests could not do their job**, which matters more here
than anywhere else on the branch: logical replication bypasses RLS, so these are the only checks
standing between two users' notes.

- **The two dynamic tests could not fail.** `.eq("user_id", alice.id)` then asserting every
  returned row is alice's restates the query instead of testing it — green with the sync rules
  deleted, the publication widened to `FOR ALL TABLES`, or no rules file at all. They now execute
  the predicate the YAML *declares* (table and column parsed out of it) and assert both
  directions against named seeded ids. "Bob absent" alone is satisfied by a predicate returning
  nothing, which is how a rule scoped on the wrong column would have passed.
- **The publication test could not run.** It skipped on `PGRST202` when the RPC was missing and
  again when the publication was empty. Both conditions held *everywhere* — neither
  `_test_publication_tables` nor a local publication had ever existed — so it would have passed
  by skipping forever, on the property keeping `integrations.credentials` out of the stream.
- **Two static assertions were wrong, not the rules.** `sync-rules.yaml`'s comments name
  `bucket_definitions` and every server-only table in order to record *why* they are absent, so
  `expect(rules).not.toContain(...)` over the raw file fails on exactly those explanations.
  Staying green would have meant deleting the most useful comments in the file. The assertions
  now run against the file with comments stripped.

**New coverage a rules file structurally cannot give you.** `note_tags` and `links` each carry
their own `user_id` **and** a foreign key into `notes`. A child row whose `user_id` says alice
while its parent note belongs to bob is bucketed straight into alice's stream, carrying bob's
note id, and lands on her device as a dangling reference. Every static check passes in that
state, and so does every predicate execution, because the row's `user_id` genuinely is alice's.

**Both new guards were proven to bite**, not just observed passing:

- Inserted exactly such a cross-owner `note_tags` row → the ownership test failed and named it,
  while the predicate test passed, confirming the gap it fills. Row removed.
- Added `note_chunks` to the publication → the six-table equality failed with `note_chunks` in
  the diff. Reverted; publication verified back at exactly six tables.

Migration `00016_powersync_publication.sql` puts the publication under version control. It
creates it only `if not exists`, so it is a **no-op on the hosted project**, which got its
publication by hand in Stage 1 — and it deliberately does *not* follow with
`alter publication ... add table`, which errors on a relation already present. The
`_test_publication_tables` helper follows the `_test_has_table_privilege` precedent from `00001`:
SECURITY DEFINER, read-only schema metadata, revoked from PUBLIC, granted to `service_role` only.
**This migration still needs pushing to the hosted project** — see "Outstanding actions" above.

---

## Stage 1 — what shipped, and how it was verified

Production is **live and verified with a real write**, not a `/health` probe. Details in
`docs/deploy.md` § "Phase 1b — PowerSync Cloud setup", subsection 5.

- Migration `00015_conflict_copy_link_kind.sql` applied to the hosted project;
  `supabase migration list` shows local == remote.
- `railway up` deployed; `POST /sync/upload` verified by the human running three curls with
  their own browser-session JWT (no `service_role` key ever entered the session):
  PUT → `201 applied:["1"]`; PATCH → `conflict_copies:[]`; **replay of op 1 verbatim →
  `applied:["1"]`, not `failed`**. Cleanup 200/200.
- That third request is the load-bearing one: it is the Task 5 retry deadlock. A deploy
  missing the idempotent `createWithId` answers it with `failed` + `kind: "conflict"` while
  the first two still look correct.

### PowerSync Cloud

Instance provisioned by the user and reachable:
`https://6a6f37fb1f143dce98f2e70f.powersync.journeyapps.com`. `apps/mobile/.env`
(gitignored) carries `EXPO_PUBLIC_POWERSYNC_URL` and `EXPO_PUBLIC_API_URL`. Not needed
again until Task 17.

Three facts that cost real time to establish, all now in `docs/deploy.md`:

- The Supabase connection uses port **5432 direct, not the 6543 pooler**.
- The **JWT secret field must stay empty** — the project signs with asymmetric ES256 keys,
  verified by curling the JWKS endpoint. Pasting the legacy HS256 secret fails silently.
- Sync rules use **Sync Streams edition 3** (`auth.user_id()`). `bucket_definitions` is
  legacy.
- The publication is **scoped to 6 tables**, not `FOR ALL TABLES` as PowerSync's own setup
  guide says. Logical replication bypasses RLS, so the default would have put
  `integrations.credentials` into the replication stream. This is a third isolation layer
  independent of RLS and sync rules.

---

## Carried context for later tasks

- **Any mobile suite:** an `apps/mobile` test that reaches a real native module dies under
  `environment: "node"` with a Rollup **Flow parse error**, not a useful message. Every native
  module a suite touches must be `vi.mock`ed. Anything importing from `app/` (RN components)
  hits this immediately — which is why `AppLockGate` has no test and all testable lock logic
  lives in `app-lock.ts`.
- ~~Task 17's four notes — `strongBiometrics`, the `lost`-key file delete, the pnpm dedupe
  check — are **discharged**; see "Stage 4 — what shipped".~~ The **dev-client rebuild is
  still outstanding** and is now item 0 under "Outstanding actions". PowerSync, SQLCipher and
  op-sqlite are native modules; a dev client built before phase 1b is a compiled binary and
  cannot load them, and Expo Go cannot run this app at all.
- **Any Stage 4 task:** `packages/sync` still imports from `@powersync/common`, not
  `@powersync/react-native`, because the RN package cannot parse under node. Both are pinned at
  `^2.0.0` now and must move together — dropping either back below 2 silently re-splits the
  `Schema` class identity.
- **Task 13's wipe** is done, but `secure-storage.ts`'s orphan probe is what stops a wipe
  missing stranded chunks. Do not replace it with a fixed bound.
- **`expo-secure-store` behaviour:** it returns null and self-deletes an entry it cannot decrypt
  after reinstall (`SecureStoreModule.kt`, `BadPaddingException` path). For the session that
  degrades to a re-login, which is intended; for the database key it is the invalidation-recovery
  path, with very different severity.
- ~~**Task 19 must add `@cortex/shared` to `apps/mobile`'s dependencies.**~~ **Done in Task 17.**
  `@cortex/shared` and `@cortex/sync` are both dependencies now. Still import
  `noteFiltersToSql`/`toSqlitePlaceholders` from shared, never from `@cortex/core`.
- **Task 19 must create `notes_fts` as `fts5(id UNINDEXED, content)`** and keep it in step with
  `notes`. The clause `noteFiltersToSql` emits selects `id` from it; a rowid-keyed table returns
  nothing for every search without erroring. See Stage 3 above. The **native** half is done and
  verified in the built APK — Task 17 set `fts5: true`, and `unindexed`/`bm25`/`fts5vocab` are
  present in `libop-sqlite.so` on all four ABIs. A failure here is the SQL, not the flag.
- **`supabase migration up`, not `db reset`.** A reset breaks Kong→auth routing with stale
  Docker DNS, which surfaces as `AuthRetryableFetchError` and reads like a code regression. If it
  happens, restart the kong container rather than the stack.
- **The generated `apps/mobile/android/` tree defeats repo-wide `grep`** (it timed out a
  `grep -rn` across the repo). Use the Grep tool or scope the path.

## Deferred minors, for the whole-branch review after Task 23

Each was judged non-blocking at the time and ledgered rather than fixed:

- `packages/shared/src/dto/sync.ts` — a comment says "matching tags.ts and media.ts"; only
  tags.ts uses `z.uuid()`, media.ts uses `z.iso.date()`. No behaviour.
- `NoteService.updateWithConflictCopy` — TOCTOU between the read and the metadata
  `update()` in the conflict branch. Consistent with the already-accepted race in
  `update()`'s own domain_meta path.
- `MediaService.resolveNoteMediaLink` — the notes update lacks `.is("deleted_at", null)`,
  unlike `NoteService.update`/`getById`/`softDelete`. A soft-deleted note could receive a
  media link. One-word fix.
- A malformed-but-present `pending_item` returns `null` identically to a genuinely absent
  one, so a client bug produces silent no-op linking rather than a signal.
- `CheckinService.createWithId`'s 23505 fallback read does not filter `deleted_at`, unlike
  `NoteService.createWithId`'s. A replayed PUT for a soft-deleted checkin returns the
  deleted row as applied rather than not_found. Two functions built to mirror each other,
  now slightly out of step.
- `secure-storage.ts` — no test covers `getItem` racing a concurrent `setItem` on the same
  key; the per-key queue covers it structurally but nothing proves it.
- **`packages/sync` declares `updated_at` on `checkins`; `public.checkins` has no such
  column** (migration 00013). Nothing reads it and the router ignores it, so it is inert — but
  it is a column that can never hold a value, which is a trap for the next person writing
  check-in code. The local schema is what should lose it.
- **One pending edit base is attached to every queued notes PATCH for that note.** The
  connector keys bases by note id, so if a body edit and a lifecycle change are both queued for
  one note, the archive op carries the body's base too and can manufacture a second conflict
  copy for a change that never touched the body. Narrow (it needs both queued before an upload)
  but real; the fix is probably to attach the base only to ops whose data contains `content`.
- **A sync op the server rejects inside a 200 is now logged, but still lost.** The router
  applies ops independently and reports casualties in `failed`; the batch completes either way,
  so the op leaves the device's queue while its row stays in local SQLite and never reaches the
  server. Retrying cannot help — these are validation failures, not transient ones — so the fix
  is a policy decision (dead-letter table? surface to the user? mark the row?) rather than a
  code change, which is why Task 18 only made the loss visible instead of choosing one.
- **Resolved by Task 11**, kept here for the trail: the `expo-secure-store` config plugin's
  backup rules arrived as a side effect of `expo install`. They turned out to be the only thing
  covering device-to-device transfer on Android 12+, and are now documented as such.

---

## Process rules this run established the hard way

- **Every implementer dispatch must require `pnpm turbo run typecheck lint test` across the
  whole repo, with the output part of the report contract.** Tasks 3 and 4 shipped with a
  red lint gate that went unnoticed for two tasks because dispatches said "run the full
  suite" meaning tests.
- **An implementer claiming a gate failure is "pre-existing" must prove it against `main`,
  not against branch tip** — branch tip cannot distinguish the two. Task 5's implementer
  made exactly this error.
- **A new test suite must be named in `.github/workflows/ci.yml` in the same task that
  creates it.** The `checks` job filters per package, so an unnamed suite runs nowhere but
  the implementer's machine. This happened twice: `@cortex/sync` (fixed in Task 7) and
  `apps/mobile` (caught in Task 8's pre-flight). `apps/mobile` is now wired, so Tasks 10 and 13
  needed no CI change.
- **Pre-flight scan each task's tests for assertions the query or the mock guarantees.** Nine
  caught so far: one before Stage 1, two in Task 9's pre-flight, Task 13's self-contradicting
  third test, Task 12's `.eq(...)`-then-assert-the-same **pair**, its publication test that
  skipped everywhere, and its two static assertions that failed on the file's own explanatory
  comments. A test that cannot fail is worse than no test — and the density of them in Task 12,
  the isolation suite, is the argument for doing this scan every time.
- **Prove a new guard bites before believing it.** Task 12's two genuinely new tests were each
  verified by introducing the exact defect they exist to catch (a cross-owner `note_tags` row; a
  server-only table added to the publication) and watching them fail with a message that named
  the problem. A green test nobody has tried to break is an assertion, not evidence.
- **Verify library behaviour against the installed source, not the docs.** Three decisions on
  this branch turned on reading `expo-secure-store` and `expo-local-authentication` Kotlin:
  writes prompt as well as reads, reads ignore the caller's `requireAuthentication`, and
  `isEnrolledAsync` asks a weaker question than `assertBiometricsSupport` answers.
- Never `pnpm --filter <pkg> test`; always `pnpm turbo run test --filter=<pkg>`.
- Docker Desktop is frequently down on this machine — see "Verification state" above for what
  that does to the gate and how it must be reported.
- **Verify library behaviour against the installed source, not the docs, and check the merged
  artifact rather than the config that should produce it.** `allowBackup` was confirmed in the
  generated `AndroidManifest.xml`, not in `app.json`; the publication scope is asserted from
  `pg_publication_tables`, not from the migration that writes it.
- Commit messages go through a scratchpad file and `git commit -F` — backticks in bash
  heredocs trigger command substitution and mangle the message.
