# Phase 1b — handoff, 2026-08-03

Stopped mid-flight on a token budget. This is everything needed to resume without
re-deriving it. Plan: `docs/superpowers/plans/2026-08-02-phase-1b-mobile-offline-sync.md`
(23 tasks, 4 stages). Execution method: `superpowers:subagent-driven-development`.

Branch `feat/phase-1b-mobile-offline-sync`, head **1ba9453**, working tree clean, nothing
pushed. The SDD ledger lives at
`.superpowers/sdd/2026-08-02-phase-1b-mobile-offline-sync/progress.md` and holds the
per-task detail — but `.superpowers/` is **gitignored**, so it exists only on this machine.
This file is the committed copy of what matters.

---

## Where execution stopped

| Stage | Tasks | State |
| --- | --- | --- |
| 1 — server + shared | 1–7 | **Complete.** Every task reviewed clean. Shipped to production. |
| 2 — security baseline | 8–13 | Task 8 complete. **Task 9 implemented but NOT reviewed.** 10–13 not started. |
| 3 — shared filters | 14–16 | Not started. |
| 4 — mobile parity | 17–23 | Not started. |

### The one thing to do first on resume

**Task 9's review never ran.** The code is committed (1ba9453) and its 12 tests pass, but
it has had no independent review, and the implementer made **three deviations from the
brief that were never adjudicated**. Do not build Task 10 on top of it until that review
happens — Task 10 and Task 17 both consume this module's contract.

The review prompt was fully written and is worth reconstructing rather than improvising.
The three deviations it must adjudicate:

- **D1 — a Critical data-loss bug the implementer found in the plan, and their fix.** The
  plan wrote the SQLCipher key first and the init flag second. They claim a crash between
  the two leaves key-on-disk/flag-absent permanently (the load path never repaired the
  flag), so a later biometric enrollment sees null key + no flag — the exact first-run
  signature — and reports `created` over a live database, silently destroying local data.
  They reproduced it against the plan's verbatim code (`expected 'created' to be 'lost'`)
  before changing anything, then reordered to flag-first and added flag repair on the load
  path. **The review must check what NEW crash window flag-first opens** (flag written, key
  not) and whether a false `lost` can ever land on a run where the user has local unsynced
  data — which would make it more than the "just a resync" the asymmetry argument assumes.
- **D2 — writing an auth-gated value also prompts.** They traced `setItemImpl` →
  `createEncryptedItem` → `authenticateCipher` → `BiometricPrompt` in the installed
  expo-secure-store Android source, concluding a cancelled prompt rejected the *creation*
  path with a raw platform error, and wrapped it to map to `biometric_prompt_failed` like
  the read path. Verify the wrap does not swallow a genuine storage failure into a
  misleading "user cancelled" signal — a caller must handle those differently.
- **D3 — they challenge one of my plan corrections.** I had changed
  `simulateBiometricEnrollment` to drop names from `authGated` as well as from the store.
  They argue it is not load-bearing: the mock's own `else authGated.delete(k)` branch
  already catches an un-gated recovery write, and the remaining wrong implementation is
  caught by the `store.get(DB_KEY_NAME)` assertion on the preceding line. **Adjudicate
  independently.** They separately confirm the distinct-bytes RNG correction IS
  load-bearing, which matches what I found.

Two open questions the review should also settle, both cheap now and expensive later:

- `lost` is a destructive signal nothing enforces. `const { key } = await
  getOrCreateDatabaseKey()` compiles fine and silently skips the required wipe. Task 13
  wires this to a real wipe and Task 17 consumes it — decide now whether documentation is
  enough or the type shape should make the dangerous path unrepresentable.
- Risk 3: `requireAuthentication: true` throws when no biometric is enrolled, on both the
  read and write paths. Task 10 builds the mandatory-biometric gate, but nothing orders the
  two at runtime, and the flag-first reordering adds a wrinkle Task 10 must handle.

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

## Action required from the human — Task 8's security claim depends on it

Task 8 moved the Supabase session out of AsyncStorage into Android Keystore. But **the old
session is still on any device that already had one**, in plaintext, and this build can no
longer delete it (the `@react-native-async-storage/async-storage` dependency is gone). It is
also inside whatever Auto Backup snapshots Google already took. A Supabase refresh token is
long-lived and does not expire on its own.

One-time fix, server-side, which kills the stale token wherever copies exist:
**Supabase Dashboard → Authentication → Users → your account → revoke / sign out all
sessions.** Stronger than deleting the local file, because it also invalidates the copies
already on Drive.

Not blocking any task. Blocking the claim that the refresh token is out of Auto Backup.

---

## Carried context for later tasks

- **Task 10 / any mobile suite:** an `apps/mobile` test that reaches a real native module
  dies under `environment: "node"` with a Rollup **Flow parse error**, not a useful message.
  Every native module a suite touches must be `vi.mock`ed. Anything importing from `app/`
  (RN components) hits this immediately.
- **Task 13 (sign-out wipes the device):** `secure-storage.ts`'s orphan probe exists
  precisely so a wipe cannot miss stranded chunks. Do not replace it with a fixed bound.
- **Task 17:** verify `@powersync/react-native` and `@powersync/common` dedupe to **one**
  physical install under pnpm. Two copies means `AppSchema` built from one `Schema` class
  handed to a `PowerSyncDatabase` constructed against another — failing far from its cause.
  `packages/sync` deliberately imports from `@powersync/common`, because
  `@powersync/react-native` cannot parse under node.
- **Task 17:** the Android dev client must be **rebuilt**. PowerSync and SQLCipher are
  native modules; a dev client built before phase 1b is a compiled binary and cannot load
  them. Expo Go cannot run this app at all.
- **Task 9's `expo-secure-store` behaviour:** it returns null and self-deletes an entry it
  cannot decrypt after reinstall (`SecureStoreModule.kt`, `BadPaddingException` path). For
  the session that degrades to a re-login, which is intended; for the `requireAuthentication`
  database key it is the invalidation-recovery path, with very different severity.

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
- The `expo-secure-store` config plugin replaced the app's default Auto Backup behaviour
  with `include domain="sharedpref"` only, so the `database` and `file` domains are now
  excluded from cloud backup and device transfer app-wide. Good for Stage 3's local corpus,
  but it arrived as a side effect of `expo install` and belongs in spec §7.2 deliberately.

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
  `apps/mobile` (caught in Task 8's pre-flight, before it could bite Tasks 9–23).
- **Pre-flight scan each task's tests for assertions the mock guarantees.** Three vacuous
  tests have been caught so far — one before Stage 1, two in Task 9's pre-flight, and the
  implementers caught more. A test that cannot fail is worse than no test.
- Never `pnpm --filter <pkg> test`; always `pnpm turbo run test --filter=<pkg>`.
- Docker Desktop is frequently down on this machine, which makes `@cortex/db`, `@cortex/api`
  and `@cortex/core` **turbo cache replays rather than fresh runs**. Acceptable for a diff
  confined to `apps/mobile`, but it must be stated explicitly, never implied as a run.
- Commit messages go through a scratchpad file and `git commit -F` — backticks in bash
  heredocs trigger command substitution and mangle the message.
