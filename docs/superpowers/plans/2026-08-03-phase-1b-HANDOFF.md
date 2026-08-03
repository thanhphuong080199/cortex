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
| 4 — mobile parity | 17 | **Task 17 complete** (`c6757f9`), not independently reviewed. |
| 4 — mobile parity | 18–23 | **Not started. Resume here.** |

### Resume here: Task 18

Quick capture. Read "Stage 4 — what shipped" below first: Task 17 changed which PowerSync major
the app is on, pinned where the database file lives, and already added the `fts5` native flag
Task 19 needs.

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

**One open, from Task 17.** The two below were cleared 2026-08-03 and are kept so a later
session does not re-raise them.

0. **OPEN — rebuild the Android dev client, and read the Gradle output when you do.**
   Two native flags now ride on `apps/mobile/package.json`'s `op-sqlite` block, and **neither
   can be verified on this machine — there is no Android SDK installed**, so no Gradle
   configure can run. They take effect at configure time and print their own confirmation:

   ```
   [OP-SQLITE] Detected op-sqlite config from package.json at: <path>
   [OP-SQLITE] using sqlcipher.
   [OP-SQLITE] FTS5 enabled
   ```

   All three lines must appear. If the first names a different `package.json` than
   `apps/mobile/package.json`, move the `op-sqlite` block to the file it names (PowerSync's
   docs warn the monorepo hoisting can do this) and rebuild.

   **Do not accept the plan's check for this.** It says to grep `apps/mobile/android/*.gradle`
   for `sqlcipher`; that matches nothing whether or not the flag is set, because the flag is
   consumed in op-sqlite's own `build.gradle` under `node_modules`. A green grep there would be
   an unencrypted database that looks configured — the exact failure the step exists to prevent.

   Missing `sqlcipher` means the local corpus is **unencrypted**. Missing `fts5` means Task 19's
   `notes_fts` fails at runtime with "no such module: fts5".

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
dev-client rebuild, so it went in here, with the rebuild this task already needs.
Neither it nor `sqlcipher` is verified yet; see "Outstanding actions" item 0.

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
  nothing for every search without erroring. See Stage 3 above. The **native** half is already
  done — Task 17 set `fts5: true` — but it is unverified until the dev-client rebuild, so if
  `notes_fts` fails with "no such module: fts5", that is the flag, not the SQL.
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
