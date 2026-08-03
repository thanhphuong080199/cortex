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
| 3 — shared filters | 14–16 | Task 14 complete (`282666d`). **Resume at Task 15.** |
| 4 — mobile parity | 17–23 | Not started. |

### Resume here: Task 15

`noteFiltersToSql` and the equivalence test. **Read "Task 14 changed where the filters live"
below before starting** — Task 15's plan text puts the SQLite translation in
`packages/core/src/notes/filters.ts`, and that is no longer where the module is.

### Verification state — the full gate has been run

Docker was down for Tasks 9–13, so every gate in that stretch was 26/26 with **23 cached**; only
the three `@cortex/mobile` tasks ran fresh. Docker has been up since; the gate after Task 14 was
`pnpm turbo run typecheck lint test --force` → **26/26 fresh, 0 cached, 380 tests**
(mobile 47, shared 54, sync 4, api 68, core 85, web 29, db 93). Every Supabase-backed suite ran
rather than replayed.

Docker Desktop is frequently down on this machine. When it is, `@cortex/db`, `@cortex/api` and
`@cortex/core` are **turbo cache replays, not runs**. That is acceptable for a diff confined to
`apps/mobile` provided it is stated explicitly, and never implied as a run.

---

## Outstanding actions for the human

**None. Both cleared 2026-08-03**, recorded here so a later session does not re-raise them.

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

Task 14 was implemented inline rather than by a subagent (the session harness forbids
dispatching agents unasked), so **it has had no independent review**. Fold it into the
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
- **Task 17:** `getOrCreateDatabaseKey` now requires `{ strongBiometrics }`. Pass
  `hasStrongBiometrics()` from `app-lock.ts`. Hardcoding `true` reintroduces the PIN-only
  lockout; hardcoding `false` drops the auth binding on devices that could have had it.
- **Task 17:** on `lost`, delete the database **file** (and its `-wal`/`-shm` siblings) before
  constructing `PowerSyncDatabase`. `wipeLocalData` is **not** that path — `disconnectAndClear()`
  needs to open the database in order to clear it, which is precisely what a lost key prevents.
  Resolve the file's actual location against the installed `@powersync/react-native`; a wrong
  path deletes nothing and fails silently.
- **Task 17:** verify `@powersync/react-native` and `@powersync/common` dedupe to **one**
  physical install under pnpm. Two copies means `AppSchema` built from one `Schema` class
  handed to a `PowerSyncDatabase` constructed against another — failing far from its cause.
  `packages/sync` deliberately imports from `@powersync/common`, because
  `@powersync/react-native` cannot parse under node.
- **Task 17:** the Android dev client must be **rebuilt**. PowerSync and SQLCipher are
  native modules; a dev client built before phase 1b is a compiled binary and cannot load
  them. Expo Go cannot run this app at all.
- **Task 13's wipe** is done, but `secure-storage.ts`'s orphan probe is what stops a wipe
  missing stranded chunks. Do not replace it with a fixed bound.
- **`expo-secure-store` behaviour:** it returns null and self-deletes an entry it cannot decrypt
  after reinstall (`SecureStoreModule.kt`, `BadPaddingException` path). For the session that
  degrades to a re-login, which is intended; for the database key it is the invalidation-recovery
  path, with very different severity.
- **Stage 3 needs Docker** for the `@cortex/core` half only. Task 14 moved the pure tests into
  `@cortex/shared`, which runs without it; Task 15's equivalence test needs both Postgres and
  `better-sqlite3`, so it needs Docker.
- **Task 19 must add `@cortex/shared` to `apps/mobile`'s dependencies.** It has none of the
  workspace packages today (only `@cortex/config`, as a devDependency).
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
