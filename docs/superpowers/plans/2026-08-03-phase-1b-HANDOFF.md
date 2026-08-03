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
| 2 — security baseline | 8–13 | **Complete except Task 12**, which is blocked on Docker. |
| 3 — shared filters | 14–16 | Not started. **Blocked on Docker.** |
| 4 — mobile parity | 17–23 | Not started. |

### The blocker: Docker Desktop is down on this machine

Everything still open needs the local Supabase stack, so nothing further can be gated honestly
until Docker Desktop is running:

- **Task 12** (sync-rule isolation) seeds real rows for two users through `makeUser`/`admin`.
- **Task 14** imports `createUserClient` and `makeUser` from the core test harness.
- Tasks 15–16 build on 14.

Every gate run recorded on this branch since Task 8 shows **26/26 turbo tasks green with 23
cached** — only the three `@cortex/mobile` tasks ran fresh. That is acceptable for diffs
confined to `apps/mobile`, and every commit message says so explicitly, but it must never be
reported as a full run. Once Docker is up, run `pnpm turbo run typecheck lint test --force`
once to re-verify the Supabase-backed suites against everything Stage 2 changed.

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

---

## The one thing to do first on resume

**Start Docker Desktop, then run `pnpm turbo run typecheck lint test --force` once.** Stage 2
changed `db-key.ts`'s exported signature; nothing outside `apps/mobile` imports it, but that has
only been verified by typecheck against cached Supabase suites.

Then **Task 12**, which has a pre-flight finding already written into the plan:

> The plan's dynamic half **cannot fail**. `.eq("user_id", alice.id)` filters to alice and the
> assertion then checks every row is alice's — green with the sync rules deleted, with the
> publication widened, with no rules file at all. It restates the query instead of testing it,
> while guarding the one property standing between two users' notes. The fix is spelled out in
> the plan at that test: execute the *rule's* predicate with alice's id substituted for
> `auth.user_id()`, and assert both directions — alice's row present, bob's absent.

---

## Action required from the human — Task 8's security claim depends on it

Still outstanding. Task 8 moved the Supabase session out of AsyncStorage into Android Keystore,
but **the old session is still on any device that already had one**, in plaintext, and this
build can no longer delete it (the `@react-native-async-storage/async-storage` dependency is
gone). It is also inside whatever Auto Backup snapshots Google already took. A Supabase refresh
token is long-lived and does not expire on its own.

One-time fix, server-side, which kills the stale token wherever copies exist:
**Supabase Dashboard → Authentication → Users → your account → revoke / sign out all sessions.**

Not blocking any task. Blocking the claim that the refresh token is out of Auto Backup.

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
- **Pre-flight scan each task's tests for assertions the query or the mock guarantees.** Five
  vacuous tests caught so far: one before Stage 1, two in Task 9's pre-flight, Task 13's
  self-contradicting third test, and Task 12's `.eq(...)`-then-assert-the-same pair. A test that
  cannot fail is worse than no test.
- **Verify library behaviour against the installed source, not the docs.** Three decisions on
  this branch turned on reading `expo-secure-store` and `expo-local-authentication` Kotlin:
  writes prompt as well as reads, reads ignore the caller's `requireAuthentication`, and
  `isEnrolledAsync` asks a weaker question than `assertBiometricsSupport` answers.
- Never `pnpm --filter <pkg> test`; always `pnpm turbo run test --filter=<pkg>`.
- Docker Desktop is frequently down on this machine, which makes `@cortex/db`, `@cortex/api`
  and `@cortex/core` **turbo cache replays rather than fresh runs**. Acceptable for a diff
  confined to `apps/mobile`, but it must be stated explicitly, never implied as a run.
- Commit messages go through a scratchpad file and `git commit -F` — backticks in bash
  heredocs trigger command substitution and mangle the message.
