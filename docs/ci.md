# CI

`ci.yml` runs on every PR to `main`; its jobs are the only checks a pull request sees. E2E and
the APK build run later, on push to `main` — see "Where each check runs" below for the full
shape.

| Workflow | Job (`name:`) | Trigger |
| --- | --- | --- |
| `ci.yml` | `build, typecheck, lint, stack-free tests` | every PR |
| `ci.yml` | `db + api tests (against local Supabase stack)` | every PR |
| `ci.yml` | **`CI gate`** | every PR |

`e2e-web.yml` and `e2e-mobile.yml` are documented in [`e2e.md`](./e2e.md). This page is about
`ci.yml` and about the two rules that have each silently disabled part of CI once already.

---

## Where each check runs (from 2026-08-07)

| Trigger | Workflow | Job name | Required? |
| --- | --- | --- | --- |
| pull request | `ci.yml` | `CI gate` | **yes — the only one** |
| push to `main` | `post-merge.yml` | `E2E Web`, `E2E Mobile`, `Android APK` | no |
| manual | `e2e-web.yml`, `e2e-mobile.yml`, `android-apk.yml` | — | no |

E2E moved behind the merge because the mobile suite is ~40-55 minutes cold (~20-28 warm) and
that is most of an hour on every PR round trip. The cost is that `main` is now where E2E
breakage is found and fixed.

**`post-merge.yml` is the only workflow with a trigger.** The other three are `workflow_call`
plus `workflow_dispatch`. Do not add a `paths:` filter to them expecting it to apply — path
filtering is workflow-scoped, so all of it lives in `post-merge.yml`'s `changes` job.

**The APK gate needs `always()` AND per-result assertions.** Without `always()` a skipped
dependency skips the APK job, so a docs-only push would silently stop producing APKs. Without
the result checks, `always()` alone would ship an APK from a commit whose suites failed. `CI
gate` uses the same idiom for the same reason.

**`workflow_dispatch` on `android-apk.yml` is load-bearing.** It is how an APK gets built from
a branch before merge; a manual run of `post-merge.yml` would drag 30 minutes of E2E with it.

---

## Rule 1 — branch protection may only ever require `CI gate`

Required status checks are matched **by job `name:`, as a literal string**. A required context
that never reports does not fail: it sits at *"Expected — waiting for status to be reported"*
and blocks the PR indefinitely.

That happened on PR #6. Commit `ab0a64c` — a **docs** commit, `docs(deploy): scope the Phase 1b
intro so the ship log is not skipped` — also changed one line of `ci.yml`:

```diff
-    name: build, typecheck, lint, shared tests
+    name: build, typecheck, lint, stack-free tests
```

Branch protection still required the old string. The result was the worst possible shape of
failure:

- all four checks reported **green**,
- the PR was **`BLOCKED`** and unmergeable,
- and the blocking check was **not in the checks list at all**, because a context that has never
  reported has nothing to render.

Nothing on the PR page names the problem. `gh pr checks 6` shows four passes. The only place the
truth is visible is the API:

```bash
gh api repos/<owner>/<repo>/branches/main/protection \
  --jq '.required_status_checks.contexts'
```

**The fix is the `gate` job in `ci.yml`**, which `needs: [checks, db-tests]` and fails if either
did not succeed. Branch protection requires *only* `CI gate`. Job names are then free to change
and new jobs are free to appear; the one load-bearing string says nothing that can go stale.

Two details in that job are not decoration:

- **`if: always()` is mandatory.** Without it a failing dependency *skips* the gate instead of
  failing it, and GitHub counts a skipped required check as satisfied. The gate would wave
  through exactly the runs it exists to stop.
- **The gate deliberately excludes the E2E workflows.** Neither runs on `pull_request` at all
  (see "Where each check runs" below) — requiring either is the same never-reporting trap in a
  different disguise. A workflow that does not trigger on every PR must never be a required
  check, directly or through a gate.

To repoint protection (needs admin; `enforce_admins` is on, so this cannot be clicked past):

```bash
gh api -X PATCH repos/<owner>/<repo>/branches/main/protection/required_status_checks \
  -F strict=true -f 'contexts[]=CI gate'
```

Do this **after** the gate has reported once on an open PR, or every PR blocks on a context that
does not exist yet — the same failure, in the other direction.

## Rule 2 — a new test suite runs nowhere until `ci.yml` names it

Both jobs run `test` **filtered per package**. There is no `pnpm turbo run test` over the whole
workspace anywhere in CI. So adding a package, or adding the first suite to a package, does not
put it in CI: it runs on the author's machine and nowhere else, indefinitely.

This has bitten three times — `@cortex/sync`, `apps/mobile`, and `apps/web`, the last of which
had a broken assertion in `note-views.test.ts` sitting green in CI because `build typecheck lint`
covered web but `test` did not.

Every package with a `test` script must appear in exactly one job:

| Package | Runs in | Why there |
| --- | --- | --- |
| `@cortex/shared` | `checks` | no external services |
| `@cortex/sync` | `checks` | no external services |
| `@cortex/mobile` | `checks` | mocks every native module |
| `@cortex/web` | `checks` | no Supabase stack needed |
| `@cortex/db` | `db-tests` | needs a live Supabase stack |
| `@cortex/api` | `db-tests` | needs a live Supabase stack |
| `@cortex/core` | `db-tests` | runs against RLS |
| `@cortex/config` | — | has no `test` script |

To audit the table against reality:

```bash
for d in packages/*/ apps/*/; do
  node -p "try{const p=require('./$d/package.json');p.name+' '+(p.scripts.test||'NONE')}catch(e){''}"
done
grep -c 'turbo run test --filter' .github/workflows/ci.yml
```

## Rule 3 — always the turbo form, never `pnpm --filter`

```bash
pnpm turbo run test --filter=@cortex/shared   # correct
pnpm --filter @cortex/shared test             # WRONG
```

`@cortex/shared` and `@cortex/core` are consumed by their dependants as compiled `dist/`. Only
turbo's `test` → `^build` edge rebuilds them first. The `pnpm --filter` form tests against
whatever stale `dist/` is lying around, which presents as "my edit didn't take".

The `--filter` also keeps the job boundary honest: turbo pulls in the target's own dependency
*builds* (`@cortex/config#build`, `@cortex/shared#build`), never another package's `test`, so a
stack-free job never accidentally starts needing Supabase.

## Also worth knowing

- **`Cached:` is the line to read, not `N/N successful`.** A run reporting `19 successful` can be
  19 replays that executed nothing. `pnpm turbo run build typecheck lint` in a clean CI job shows
  `Cached: 0 cached, 19 total`; anything else means the gate you think you just passed was a
  cache hit. Locally this is usually Docker being down.
- **`.env` files are banned on the runner**, and both jobs `find` for them and fail loudly. Every
  vitest config sets `setupFiles: ["dotenv/config"]`, so a stray `.env` backfills anything
  missing from the real environment and CI stops testing the path production uses. This is
  exactly what hid the turbo strict-env-mode bug in E8: locally dotenv refilled `SUPABASE_*` and
  the suites passed; only CI, with no `.env`, failed.
- **`SUPABASE_JWT_SECRET` is deliberately never exported.** As of Supabase CLI 2.x
  `supabase start` issues **ES256** tokens while `supabase status` still reports a legacy HS256
  `JWT_SECRET` that verifies nothing. Left unset, the API guard falls through to JWKS — which is
  what production does, so CI exercises the real path.
- **The `Bundle @cortex/mobile` step is not redundant with typecheck.** It is the only step that
  resolves modules the way Metro does. `tsc` accepts NodeNext's `./x.js` suffix and vitest
  resolves it too, but Metro looks for a file of that name and fails — so `apps/mobile` was
  unbundlable from Task 13 onward while typecheck, lint and every test stayed green, and the
  first sign was an EAS build failing 20 minutes in.
