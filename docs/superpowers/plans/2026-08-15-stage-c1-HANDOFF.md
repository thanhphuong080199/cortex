# Stage C1 — closeout

**Date:** 2026-08-15
**Branch:** `feat/stage-c1-assistant`, at `010c050` (merge of `main`, on top of `e2efa47`).
**Status:** all 10 tasks complete, final whole-branch review APPROVED after one fix round. **PR
[#15](https://github.com/thanhphuong080199/cortex/pull/15) is open against `main`, not yet
merged.**
**Plan:** `docs/superpowers/plans/2026-08-12-stage-c1-assistant-box.md` (10 tasks).
**Mode:** subagent-driven development — a brief per task, an implementer, an independent
reviewer, fix rounds to a clean re-review, then a final whole-branch review, then the ledger.

> The SDD ledger (`.superpowers/sdd/2026-08-12-stage-c1-assistant-box/progress.md`) holds the
> blow-by-blow but is **gitignored** (`.gitignore:21`), so it does not survive a clone.
> Everything below is the part that must, plus the small handful of process lessons worth
> keeping regardless of this branch's fate.

---

## Where the work stands

All 10 tasks complete and independently reviewed. Two fix loops ran:

| Task | State |
|---|---|
| 1. `00027` ledger attribution migration | complete, review clean |
| 2. `recordUsage` carries attribution | complete, review clean |
| 3. `generateStream` + `usageMetadata` | complete, 1 fix round |
| 4. `extractNote` gains intent/complexity/language | complete, 1 fix round |
| 5. rolling context window + 4-hour reset | complete, 2 fix rounds |
| 6. retrieval and the two prompts | complete, 1 fix round |
| 7. pin the answer model, orchestrate the turn | complete, review clean (0 Critical/Important) |
| 8. `POST /assistant` SSE controller | complete, review clean |
| 9. the box replaces quick capture | complete, review clean — 3 pre-dispatch rulings (Citation placement, `createNote` typing, jsdom docblock), 2 post-implementation concerns routed into Task 10 |
| 10. E2E: capture survives a dead assistant | complete, 1 fix round (stale `"Quick capture"` label in 2 sibling specs, a flaky default E2E timeout) |

Then a **final whole-branch review** (Opus, spanning the full `f2086da..304b44f` range) found 0
Critical, 5 Important, 9 Minor. 4 Important findings were fixed in one more round
(`e2efa47`), independently re-reviewed and approved. The 5th was deliberately deferred — see
below.

Gates at `e2efa47` (and reconfirmed at `304b44f`/HEAD after the merge from `main`), all
`0 cached`: `@cortex/web` 34/34, `@cortex/core` 228/228, `@cortex/shared`/`@cortex/db`/others
all green, lint all packages, typecheck all packages. A live local Playwright run (`apps/web/e2e`)
hit 19/19 on its final pass — see Task 10's fix-round report for the harness used (never
touches `apps/web/.env.local`, which points at the hosted prod project).

---

## Rulings and fixes worth knowing about (Tasks 7–10 and the final review)

**Task 9 — `Citation` lives in two places on purpose.** `apps/web` depends on `@cortex/shared`
but not `@cortex/core`, so a structurally-identical `Citation` interface was added to
`packages/shared/src/dto/assistant.ts` rather than adding the dependency. `packages/core/src/
assistant/retrieve.ts`'s own `Citation` was left untouched. The final review confirmed the two
still agree exactly — if you touch either shape, check the other.

**Task 9/10 — a `POST /notes` failure used to lie.** `AssistantBox`'s `submit()` originally had
one `try/catch` around both the note save and the SSE stream, so a save failure (nothing
actually persisted) showed the same "Saved. No answer right now." text as a real post-save
streaming failure. Fixed in Task 10's fix round: `createNote` now has its own `try/catch`,
rendering `QuickCapture`'s original "Couldn't save" + Retry pattern, ported forward.

**Final review — a retrieval failure used to be indistinguishable from "no notes."**
`runTurn`'s `Promise.allSettled` swallowed a rejected `retrieve()` into `citations: []`, and the
prompt rendered "The user has no notes matching this" — a false claim on a search failure, never
logged. Fixed in `e2efa47`: `renderCitations` gained a distinct `"failed"` state, and both a
rejected retrieval and a rejected/timed-out extraction now log with the turn's `requestId`. The
SSE wire event (`{ citations: [], degraded: true }`) is unchanged — this was a prompt/log-only
fix.

**Final review — the current note was echoing into its own prompt.** `turn.ts` inserted the
user's `chat_messages` row, then read history back with no exclusion of that row — so every
turn's prompt contained the current note twice, once mislabeled as "earlier in this
conversation." Fixed by reading history before inserting.

**Final review — assistant-turn classification spend was misfiled as sweep spend.**
`extractNote`'s `recordUsage` call hardcoded `source: "sweep"` with no `requestId`, so every
live assistant turn's classification call was indistinguishable from the 60-second background
sweep and unjoinable to that turn's own answer row. `EnrichTarget` gained optional
`source`/`requestId`, defaulting to today's behavior; `runTurn` now passes `source: "assistant"`
and its own `requestId`. The sweep's own call site (`apps/api/src/enrich/enrich.service.ts`)
needed no changes.

**Final review — deploy.md's required-env-var table was missing the new var.** Fixed: a row for
`ASSISTANT_MONTHLY_BUDGET_USD` was added to the Railway table.

**Final review — DEFERRED, not fixed.** `usage_month_to_date_usd` (migration `00021`) sums
`cost_usd` across **all** `kind`/`source` for a user with no filter, so
`ENRICH_MONTHLY_BUDGET_USD` and `ASSISTANT_MONTHLY_BUDGET_USD` are two thresholds on one shared
spend total, not independent budgets. `00027` added the `source` column specifically to make
this separable; the RPC doesn't use it yet. Both failure directions are fail-safe (spend stops,
nothing overspends) — the visible symptom if this bites is enrichment quietly stopping because
assistant use ate the shared budget, with no error anywhere but
`[enrich] N note(s) skipped -- monthly budget exceeded`. Needs a new migration (`00021`'s
function predates this branch), so it's a follow-up, not part of this PR.

---

## After the branch merges

Two of the three original items are **already done**, run ahead of the PR merging (against the
live hosted project, from this session):

- [x] `supabase db push` — done 2026-08-15. Also picked up `00026` (`vietnamese_fts`, an
  unrelated already-merged `main` fix that had never been pushed either). Confirmed local ==
  remote through `00027`.
- [x] `ASSISTANT_MONTHLY_BUDGET_USD` set on Railway (`cortex-api`, production, value `5`,
  matching `ENRICH_MONTHLY_BUDGET_USD` — see the deferred shared-budget finding above for why
  that specific value was chosen). Set with `--skip-deploys`, so the **API has NOT been
  redeployed** — it's still running pre-Stage-C1 code. `/assistant` does not exist on the live
  API yet.
- [ ] **Redeploy the API and web app** with this branch's code, then confirm the first real
  `usage_ledger` row has non-zero `input_tokens` (zero means `usageMetadata` is being dropped —
  the exact defect Task 3 existed to prevent). As of this handoff, deploys are still manual
  (`railway up` / `vercel deploy --prod`) **unless [PR #16](https://github.com/thanhphuong080199/cortex/pull/16)
  has merged** — see below, it automates exactly this step.
- [ ] Pin the Vercel Build Command (`docs/deploy.md`, "Web — Vercel deploy checklist") — blocked
  by this session's own policy against live-infra dashboard mutations, needs a human via
  dashboard or CLI.

## A second PR landed alongside this one: automatic deploys

[PR #16](https://github.com/thanhphuong080199/cortex/pull/16), branched from `main` (not from
`feat/stage-c1-assistant`), adds `deploy-api`/`deploy-web` jobs to `post-merge.yml`: after
`e2e-web` passes on a push to `main`, and only when the relevant paths changed, it runs
`railway up` / `vercel deploy --prod` automatically. Migrations are deliberately **not**
automated — `supabase db push` stays a manual, pre-merge step by design (see that PR's body and
`docs/deploy.md`'s rewritten "Is there CI/CD?" section for the full reasoning).

Both `RAILWAY_TOKEN` and `VERCEL_TOKEN` repo secrets are set (confirmed 2026-08-15). Neither
could be minted from an already-authenticated CLI session — both platforms require the
dashboard for this:

- Railway: `Not Authorized` from the GraphQL API on both `projectTokenCreate` (project-scoped)
  and `apiTokenCreate` (account-scoped) when called via the CLI's own session token.
- Vercel: `vercel tokens add` returned `Cannot create tokens for this app (403)`. Vercel *does*
  support project-scoped tokens despite this — [vercel.com/docs/accounts/access-tokens](https://vercel.com/docs/accounts/access-tokens)
  — but only from the dashboard, with the scope selector set to the personal account (not a
  team) before "Account Tokens" is reachable; and per that same doc, minting a new token via
  CLI/API requires a full-account token in the first place, so a restricted CLI session
  couldn't have done this regardless of project vs. account scope.

Once #16 merges, the manual "redeploy the API and web app" step above happens automatically on
the next push to `main` that touches `apps/api`/`apps/web`/shared deps and passes `e2e-web`.

---

## Deferred, deliberately (pre-existing or out of scope, not Stage C1 regressions)

- `gemini.ts` batch cap ≤100 — separate PR.
- Failure-class-aware retry; model routing. `complexity` is recorded by Task 4 and read by
  nothing — the final review confirmed this is still true and flagged it as a real (Minor) cost:
  it's paid for on every classification and persisted nowhere.
- `ON DELETE SET NULL` on `00027` has no functional test; `usage_ledger_request_idx`/`note_idx`
  existence is untested because PostgREST does not expose `pg_indexes`.
- No regression test pins `cancel()` vs `releaseLock()` on the stream reader; CRLF normalisation
  and the `decoder.decode()` flush are untested.
- `isStale`'s exact `>=` boundary is untested, and `SESSION_IDLE_RESET_MS` is pinned only to a
  31-minute window by the 3h30m/4h01m fixtures.
- `CoreErrorFilter` logs `JSON.stringify(cause)`, including PostgREST `details`/`hint` — fields
  `errors.ts` deliberately excludes because they can carry note content. Pre-existing
  app-wide, not a Stage C1 regression. Worth a dedicated security pass.
- Prompt injection: both prompt builders interpolate user text and retrieved snippets with no
  delimiting. Blast radius is nil while the corpus is first-party; becomes necessary the moment
  `source_type: 'web_search'` rows actually exist.
- The shared-budget-aggregate finding above (final review, deferred).
- `sessionId` from the request body is never checked for ownership (Minor, final review — no
  cross-user *read* is possible since history reads are RLS-filtered, so this is a data-hygiene
  gap, not a disclosure one). No retrieval-side deadline/abort (`extractNote` has one,
  `retrieve()` doesn't). No SSE heartbeat / `X-Accel-Buffering: no`.

---

## Process notes that keep costing rounds (evergreen — keep these regardless of this branch)

- **Run gates through turbo with `--force`, and read the `Cached:` line.** `pnpm --filter <pkg>
  test` resolves `@cortex/shared` and `@cortex/core` as compiled `dist/`, so it tests stale code.
  `26/26 successful` can be 23 replays.
- **Docker up is not the same as Docker healthy.** This session hit real, reproducible
  intermittent flakiness even with the stack running — random, different, pre-existing tests in
  `@cortex/core`/`@cortex/db` hitting a bare 30s hook timeout, never the same file twice, never a
  file the active diff touched, alongside a `supabase_vector_*` sidecar continuously
  crash-looping on "Network unreachable" reaching the Docker socket. Diagnosed as sandbox
  Docker/WSL networking instability, not a code regression — confirmed by re-running the same
  suite in isolation and getting a clean pass. If you hit an isolated, unrelated 30s timeout,
  retry once before treating it as real; if it's in a file your diff touches, don't wave it away.
- **Commit messages go through a heredoc**, never PowerShell here-strings or multi-line `-m` —
  both have corrupted messages in this repo.
- **The repo is `core.autocrlf=true`.** Use the Edit/Write tools, never a shell or script
  whole-file rewrite — invisible LF→CRLF corruption doesn't show in `git diff`.
- **The plan's `git add` lists are incomplete** wherever a required field breaks existing callers
  or a new module needs a barrel export.
- **`scripts/task-brief` is unreliable** — it swallowed later tasks into one file, and exited 3
  with "task N not found" for a heading that existed. Extract with `sed -n 'START,ENDp'` against
  `^## Task N:` line numbers instead.
- **Live-infra mutations from CLI get refused, and it's worth trying anyway.** This session hit
  it three separate times — `vercel project update` (Task 10, build command), and twice more
  minting deploy tokens for PR #16 (Railway: `Not Authorized`; Vercel: `403`). All three were
  legitimate refusals, not bugs to route around — the answer each time was to hand the exact
  dashboard/CLI step to a human, with enough detail (exact URL, exact scope selector gotcha) that
  it took one try.

## The recurring defect: tests that cannot fail

Every task shipped at least one, start to finish, and a reviewer caught each only by asking what
one-line implementation change would turn it red — never by reading the assertion in isolation.

- **Task 4** asserted `complexity` by feeding the function its own default value, so a hardcoded
  constant survived all 183 tests.
- **Task 5**'s over-budget fixture put the oversized turn at index 0, the last iteration — so
  `break` and `continue` were behaviourally identical across all six tests.
- **Task 6**'s brief hardcoded `error: null` in its DB double, so deleting `if (error) throw
  error` passed all four of its tests. A broken search would have handed the answer prompt an
  empty corpus, and the model would have answered from general knowledge dressed as the user's
  own notes — the exact failure mode the final review later found a live path to (see above).
- **Task 6**'s acknowledge prompt could render domain and tags **swapped** and all 13 prompt
  tests still passed, because they asserted presence rather than pairing. Assert the pairing
  (`toContain("You filed it under: health")`) in every prompt test from here.
- **Task 9/10** avoided this pattern proactively: the `dbs()` double in `turn.test.ts` was
  hardened during the final review's fix round specifically because the original version
  couldn't see the current-note-echo bug — it returned a static history fixture regardless of
  insert order. The fix made insert order actually observable to the test, which is what let the
  new regression test genuinely fail red before the fix landed.
