# Cleanup batch, doc reconciliation, and post-merge E2E — design, 2026-08-07

Closes out phase 1b before phase 2 (AI enrichment v1) starts. Three independent pieces of
work, deliberately kept in separate PRs because exactly one of them carries a deploy:

| PR | Contents | Deploy? |
| --- | --- | --- |
| 1 | 14 ledgered minors, all code-local, plus every doc change | no |
| 2 | `checkins` sync rule gains a `deleted_at` filter | **yes** — PowerSync Cloud |
| 3 | E2E moves to post-merge; APK gated behind it | no |

## Why now

Phase 0, 1a, 1c and 1b are all merged, and the E2E plan (`2026-08-06-e2e-testing.md`, 11
tasks) shipped complete and green. What remains from phase 1b is a ledger of ~19 items in
`docs/superpowers/plans/2026-08-03-phase-1b-HANDOFF.md` that were judged non-blocking and
recorded rather than fixed. Phase 2 will touch `notes`, `note_tags`, `domain_meta` and the
sync router directly, so several of these stop being latent the moment it starts.

Two sections of that handoff are also now actively misleading, which is worse than
incomplete — a session that reads them will re-investigate work that is already done:

- **"Round 2 — open findings, ranked. None of these is fixed."** All nine are fixed:
  #1+#2 in `ab4c4ea`, #3/#5/#7/#8/#9 in `03b5676`, #4 in `7b030a4`, #6 in `5e0352e`.
- **"STILL OPEN — server-to-device sync does not run."** It runs.
  `.maestro/03-server-to-device.yaml` executes in CI (`e2e/scripts/run-maestro.sh:105`)
  and the suite is green.

## Scope decisions taken before design

Three ledgered items are **not** actioned, and the reason is recorded so the next session
does not rediscover the argument:

1. **`packages/sync` declaring `updated_at` on `checkins` is NOT a bug.** The ledger says
   `public.checkins` has no such column. `00014_phase1c_hardening.sql:19-21` added it with a
   `moddatetime` trigger, explicitly for PowerSync ordering. `schema.ts:57` is correct;
   removing the column would be the regression. This entry is marked **WRONG** in the
   handoff rather than deleted — see item B1, where the same false claim has leaked into
   code.
2. **Web's refetch keeps its client-side `matchesFilters` pass** (`apps/web/src/app/note-list.tsx`).
   A strict no-op today, knowingly kept as a net in Task 16, and both directions have a
   failure mode.
3. **`updateWithConflictCopy`'s TOCTOU** between the read and the metadata `update()` is
   consistent with the race already accepted in `update()`'s own `domain_meta` path.
   Changing one without the other would leave the codebase less coherent, not more.

One further item is **deferred, not dropped**: a sync op the server rejects inside a 200
response is logged (`apps/mobile/src/lib/connector.ts:139-141`) but still lost. The batch
completes either way, so the op leaves the device's queue while its row stays in local
SQLite and never reaches the server. Retrying cannot help — these are validation failures,
not transient ones — so the fix is a policy choice (dead-letter table? surface to the user?
mark the row?) rather than a code change. It needs its own design and is out of scope here.

One entry has expired on its own: `CheckinService.createWithId`'s 23505 fallback not
filtering `deleted_at` was recorded as an inconsistency with `NoteService.createWithId`.
Round 2 finding #9 changed `NoteService` to stop filtering, so the two now agree. Removed
from the ledger with a note saying why.

---

## PR 1 — the twelve

> **Correction, 2026-08-09 — this said "fourteen".** Twelve clear by commits on PR 1, a
> thirteenth clears in PR 2, one entry expired on its own, and one was wrong and is marked
> rather than actioned. See the same note in
> `docs/superpowers/plans/2026-08-07-phase-1b-closeout.md`.

### A. Correctness on synced data

**A1. A soft-deleted note can still receive a media link.**
`packages/core/src/media/service.ts:140-143` updates `notes` with only `.eq("id")` and
`.eq("user_id")`. `NoteService.update`, `getById` and `softDelete` all additionally carry
`.is("deleted_at", null)`. Add it here. The compensation path below it (which deletes a
just-created `media_items` row when the note update matches nothing) already handles the
zero-row case correctly, so this change turns a wrong success into an existing, tested
failure mode.

**A2. `domain_meta` is written unvalidated on the PATCH path.**
Same function, line 141: `cleaned` is the client's object with `pending_item` stripped, and
it goes straight into the column. Every other write path runs `validateDomainMeta`. Route
this one through it too, so a device cannot store metadata the domain's schema rejects.

**A3. A conflict copy loses `domain`, `domain_meta` and `media_item_id`.**
`packages/core/src/notes/service.ts:214-217` builds the copy from `content` and `title`
only. The copy is the user's offline text; dropping its domain means it does not appear
under any domain filter, which is where the user would look for it. Widen the `select` at
line 197 to include the three columns and pass them through to `createWithId`.

**A4. `trashNote` has no `deleted_at IS NULL` guard.**
`apps/mobile/src/lib/note-edits.ts:31`. Trashing an already-trashed note re-stamps both
`deleted_at` and `updated_at`, which PowerSync emits as a PATCH — a server round trip for a
change that changes nothing, and a fresh `updated_at` that reorders the row against genuine
edits. `RESTORE_NOTE_SQL` on line 33 has the mirror-image gap; both get the guard, matching
what `NoteService.softDelete` and `restore` already enforce server-side.

**A5. One edit base is attached to every queued `notes` PATCH for that note.**
`apps/mobile/src/lib/connector.ts:70-90` keys bases by note id, and line 104 hands
`bases.get(e.id)` to every op. `crudEntryToSyncOp:38` guards on table and op kind but not on
what the op actually changes, so if a body edit and a lifecycle change are both queued for
one note, the archive op carries the body's base and can manufacture a conflict copy for a
change that never touched the body. Attach the base only to ops whose `data` contains
`content`.

### B. Claims in the code that are no longer true

**B1. `apps/mobile/src/lib/checkins.ts:10-13` instructs a regression.**
The comment states that `public.checkins` has no `updated_at` column, cites migration
`00013`, and concludes "the local schema is what should lose the column." `00014:19-21`
added the column with a `moddatetime` trigger. Anyone acting on this comment would delete a
column PowerSync needs for ordering. Rewrite it to say what is true, and cite `00014`.

**B2. `apps/mobile/src/lib/connector.ts:142-144` cites a resolved bug.**
It refers to "the STILL OPEN question... whether a completed upload is what nudges a stalled
download stream." The download stream is not stalled. The `console.log` on line 145 stays —
`e01cb03` made it permanent on purpose — but the justification is rewritten.

**B3. Two device-schema columns do not match Postgres.**
`packages/sync/src/schema.ts:38-41` declares `note_tags` as `note_id, tag_id, created_at,
deleted_at`. Postgres (`00003_organization.sql:15-26`) also has `source text not null`,
`status text not null` and `confidence real`. PowerSync's local schema is a view, so the
missing columns are invisible rather than an error — but `source` is `NOT NULL` with no
default, so the first device-originated INSERT into `note_tags` fails server-side with a
23502 that nothing on the device explains.

Separately, `media_items.external_meta` is `column.text` locally (line 51) against `jsonb
not null default '{}'` in `00013:20`. That is the same jsonb-arrives-as-a-string situation
`notes.domain_meta` carries a comment for on line 26 — here it is undocumented, and
`readDomainMeta`'s equivalent does not exist for this column.

Phase 2 is what starts writing `note_tags` from a client (auto-tag accept/reject). Add the
three missing columns to the local schema and document the `external_meta` encoding, so the
trap is disarmed before the phase that springs it.

### C. Observability

**C1. Benign duplicate DELETEs pollute the `failed` channel.**
`apps/api/src/sync/router.ts:109` and `:135` route DELETEs to `softDelete`, whose
`.is("deleted_at", null)` guard makes a repeat delete a `not_found` — which lands in
`result.failed` (line 124). `failed` is the only surface that reveals a genuinely lost op,
so filling it with harmless replays is what makes a real loss easy to miss. A DELETE for a
row that is already tombstoned is the desired end state; report it as applied.

**C2. A malformed `pending_item` is indistinguishable from an absent one.**
`packages/core/src/media/service.ts:129-130` returns `null` on `safeParse` failure, exactly
as it does when the key is missing. A client that serialises the field wrongly produces
silent no-op linking. Return the parse failure as a `validation` error so it reaches
`media_unresolved`, which exists for precisely this class of outcome.

### D. Export

**D1. A failed download leaves a truncated zip in the cache.**
`apps/mobile/src/lib/export.ts:40-44`. `File.downloadFileAsync` streams into the file; if it
throws partway, the partial file survives. Line 38 deletes a same-day leftover before
downloading, so the next export recovers — but between the two, the user has a corrupt
archive in cache that the share sheet would happily hand to another app. Delete it in a
`catch` before rethrowing.

**D2. The share-sheet availability check runs after the download.**
Lines 48-50 throw "sharing is not available on this device" only once a multi-megabyte
archive has already been fetched over the network. `isAvailableAsync()` is a cheap local
call. Move it above line 40.

### E. Cosmetic

**E1.** `packages/shared/src/dto/sync.ts:26` — the comment says "matching tags.ts and
media.ts". Only `tags.ts` uses `z.uuid()`; `media.ts` uses `z.iso.date()`. No behaviour.

**E2.** `apps/web/src/app/note-list.tsx:27` — `refetch`'s `useCallback` keys on object
identity, so it is rebuilt on every render whose filter object is recreated.

---

## PR 2 — the `checkins` sync rule

`packages/sync/src/sync-rules.yaml:36` reads:

```yaml
- SELECT * FROM checkins WHERE user_id = auth.user_id()
```

Undo is a local hard `DELETE` (`apps/mobile/src/lib/checkins.ts:40`) against a server-side
soft delete (`CheckinService.softDelete`). The tombstoned row therefore still satisfies this
query and replicates back down, so the check-in the user undid returns to the device. It is
latent only because nothing reads `checkins` locally yet — the widget writes and never
queries. Phase 2's mood charts are the first reader.

Fix: `AND deleted_at IS NULL`.

**Why this is its own PR.** Sync rules are deployed to PowerSync Cloud from outside this
repo (`docs/deploy.md`), so no CI gate can catch a bad one — the same shape of gap that let
`00012` pass locally and fail only against the hosted project. Isolated, a failed deploy
implicates one line instead of fifteen.

`notes` deliberately keeps no `deleted_at` filter: the device renders a trash view and needs
the tombstones. The asymmetry is intentional and gets a comment saying so, because the next
reader will otherwise "fix" the inconsistency.

**Verification.** `packages/db/src/test/sync-rules-isolation.test.ts` gains a case that is
red before the change and green after. Note the standing rule from §15.5 of the parent spec:
an isolation assertion must contain real rows for the *other* condition, or it stays green
with the rule deleted. The case therefore seeds one live and one soft-deleted check-in and
asserts the query returns exactly the live one. After merge, the rule is deployed and the
result confirmed against the hosted instance, since the automated test covers only the local
stack and CI.

---

## PR 3 — E2E after merge, APK behind it

### The change

Today both E2E workflows run `on: pull_request`. E2E Mobile takes ~30 minutes (the two most
recent green runs: `30m25s`, `30m28s`), which is most of an hour added to a PR round trip on
a solo project. They move to `push: [main]`, and the APK build is chained after them.

E2E Web is not the problem — its three most recent runs were `3m21s`, `3m14s` and `3m0s`.
It moves anyway, because one rule for where E2E runs is worth more than three minutes of
pre-merge coverage.

Branch protection was checked before designing this: `main` requires exactly one status
check, **`CI gate`** — the job at `.github/workflows/ci.yml:83-89`. Neither E2E workflow is a
required check, so removing them from `pull_request` does not strand PRs behind a check that
never reports. That failure mode is real and documented in `docs/ci.md`; this change avoids
it by luck of the existing configuration, not by design, and the fact is recorded here so a
future change to protection knows what it would break.

### Shape

Three existing workflows become reusable; one new file orchestrates them.

```
e2e-web.yml      on: workflow_call, workflow_dispatch    (pull_request removed)
e2e-mobile.yml   on: workflow_call, workflow_dispatch    (pull_request + paths removed)
android-apk.yml  on: workflow_call, workflow_dispatch    (push removed, dispatch KEPT)
post-merge.yml   on: push [main]                         (new — orchestration only)
```

`workflow_dispatch` on `android-apk.yml` is load-bearing and must survive: today an APK can
be built from the Actions tab against *any* branch. Folding the job body into `post-merge.yml`
would destroy that, because a manual run would then drag 30 minutes of E2E with it.

```yaml
jobs:
  changes:
    # dorny/paths-filter -> outputs.mobile, outputs.apk
  e2e-web:
    uses: ./.github/workflows/e2e-web.yml
  e2e-mobile:
    uses: ./.github/workflows/e2e-mobile.yml
    needs: changes
    if: needs.changes.outputs.mobile == 'true'
  apk:
    uses: ./.github/workflows/android-apk.yml
    needs: [changes, e2e-web, e2e-mobile]
    if: >-
      always()
      && needs.changes.outputs.apk == 'true'
      && needs.e2e-web.result == 'success'
      && (needs.e2e-mobile.result == 'success' || needs.e2e-mobile.result == 'skipped')
```

### Three things this shape has to get right

**`always()` plus an explicit assertion on each `result` is mandatory, not defensive.**
Without it a skipped `needs` skips its dependents, so a docs-only push — which correctly
skips `e2e-mobile` — would also silently skip the APK build forever. `CI gate` in `ci.yml`
already uses exactly this pattern, so the idiom has an in-repo precedent to match.

**Path filtering has to move from `on.push.paths` into a `changes` job**, because path
filters are workflow-scoped and cannot gate an individual job. The APK's path set is a
subset of E2E Mobile's *except* for `.github/workflows/android-apk.yml` — editing that file
alone must build an APK while legitimately skipping the mobile suite. That single case is
the entire reason for the `|| result == 'skipped'` branch.

**No `secrets.*` appears in any of the three workflows** — only `vars.*`, and repository
variables are visible to reusable workflows without being passed. `secrets: inherit` is
therefore not needed, and adding it would imply a dependency that does not exist.

### The trade this accepts

Moving E2E after the merge means `main` is where breakage is discovered, and where it gets
fixed. The phase-1b branch spent eleven `fix(e2e)` commits converging the Maestro suite
(`ec033e1`..`4d1a34c`); under this arrangement all eleven would have landed on `main`. This
is a deliberate trade of `main`'s cleanliness for PR latency on a single-developer project,
taken with the cost understood.

A related choice, also deliberate: **a red Playwright web suite blocks the Android APK
build.** "If everything passes, build the APK" is the requested semantics and this
implements it literally. The coupling is arguable — a web regression has no bearing on
whether an Android artifact is sound — and undoing it is deleting the
`needs.e2e-web.result == 'success'` line.

---

## Documentation

**`docs/superpowers/plans/2026-08-03-phase-1b-HANDOFF.md`** gets a ~15-line status header at
the top: phase 1b closed, all nine round-2 findings fixed with their commit SHAs, the
twelve minors cleared, and exactly one item still open (the rejected-op policy). Someone
opening a 1200-line file should not have to read it to learn what is still owed. The two
stale sections are corrected in place, and the ledger entries this batch clears are marked
with their outcome — including the one marked **WRONG** and the one that expired.

**`docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md`** loses Voyage. The
provider switch was decided in `2026-08-01-life-domains-web-search-design.md` §1 ("supersedes
parent §4") and has been true in code since `00012`: `packages/shared/src/enums.ts:60-61` is
`EMBEDDING_DIM = 1536` / `EMBEDDING_MODEL = "gemini-embedding-001"`, and
`packages/db/src/test/embedding-dims.test.ts` locks the constant to the live column width.
Only the parent spec still says otherwise, in nine places: lines 11, 77, 113-114, 158, 250,
374, 514, 536, 566. Each is corrected in place to Gemini / 1536, and one amendment line is
added pointing at the life-domains spec as the deciding document — matching the existing
"Amendment 2026-08-02 — phase 1 was split as built" convention on line 548.

**The completed plan documents are not touched.** `2026-07-31-phase-0-foundations.md` says
`EMBEDDING_DIM = 1024` / `voyage-3.5` because that is what was built at the time, and
`00012`'s own comment is the record of the switch. Editing an execution record to match
today's state would make that migration comment incoherent.

**`docs/ci.md`** documents the new post-merge shape, the `always()` + per-result idiom, and
the fact that `CI gate` remains the only required status check.

## Testing

Every code item in PR 1 follows the repo's established order: a failing test first, then the
fix. Three carry a real risk of a test that cannot fail, which is the specific defect round 2
finding #2 was about — those get an explicit red-before/green-after confirmation recorded in
the commit message:

- **A5** (base attached to the wrong op) needs two ops queued for one note before an upload.
  A test that queues only one passes with the bug present.
- **B3** (`note_tags` missing columns) needs an actual device-originated INSERT reaching
  Postgres. Asserting the local schema's shape against itself proves nothing.
- **C1** (duplicate DELETE in `failed`) needs the *second* delete. The first one succeeds
  either way.

The full gate is `pnpm turbo run typecheck lint test --force`, and the `Cached:` line is read
before the result is reported — a run with replays is not a run. Per the standing rule,
package tests go through turbo (`pnpm turbo run test --filter=<pkg>`), never
`pnpm --filter <pkg> test`, which resolves stale `dist/`.

PR 3 cannot be verified before it merges: its trigger is `push` to `main`, so the first real
evidence is the run that fires on merge. `actionlint` covers the syntax beforehand; the
merge itself is the functional test, and the run is watched rather than assumed.

## Definition of done

- [ ] Twelve items fixed here and a thirteenth in PR 2; Tasks 4, 5 and 7 confirmed red first
      (the other nine were not red-before-green tasks)
- [ ] `pnpm turbo run typecheck lint test --force` green, 0 cached
- [ ] `checkins` sync rule filtered, isolation test red-then-green, deployed to PowerSync
      Cloud and confirmed against the hosted instance
- [ ] E2E runs on push to `main`; APK builds only after both suites pass; `workflow_dispatch`
      still builds an APK from an arbitrary branch
- [ ] `CI gate` still the only required check, and still passing on PRs
- [ ] Handoff doc has a status header and no stale claims; parent spec says Gemini everywhere
- [ ] One open item remains, named and scoped: the policy for ops the server rejects
