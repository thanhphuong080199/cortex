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

## B. Open

### B1. The API has not been redeployed — new routes 404 in production

**This is the one that matters.** The hosted schema is now ahead of the hosted code.

`POST /checkins`, `DELETE /checkins/:id` and `POST /media-log` do not exist on the running
container. The web UI built in this phase cannot work against production until:

```bash
railway up --service cortex-api --detach --yes
```

Verify with a **write**, not `/health` — `/health` touches no Supabase credential and
returns 200 even when the API cannot serve a single request:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "$API_URL/checkins" -H "Authorization: Bearer <a real user JWT>" \
  -H 'Content-Type: application/json' -d '{"mood":4}'
# 201 = working · 404 = old code still deployed · 500 = env var missing
```

Schema-ahead-of-code is the safe direction (the reverse breaks live users), so there is
no urgency beyond wanting to use the feature.

### B2. No browser click-through of the three web flows

Verified: unit/integration logic, API e2e, and a clean production build (7 routes).
**Not verified: that any of it renders and behaves correctly in a browser.**

Blocked because `apps/web/.env.local` points at the hosted Supabase project *and* the
Railway API, while the login page offers Google OAuth only — so pointing it at the local
stack has no sign-in path. Unblocking needs either B1 (redeploy, then click through
production) or a local email/password sign-in path for dev.

Affected: mood widget, media log form + autocomplete, domain chips and `?domain=` filter.

### B3. `domain_meta` is not re-validated when `domain` changes

**Latent, no impact yet.** `NoteService.create` validates `domain_meta` against its
domain's schema. `update` passes `domain` through but does not re-check existing meta
against the new domain — so a media note carrying `{rating: 5}`, patched to
`domain: "health"`, keeps meta that the health schema would reject.

Harmless today: nothing reads `domain_meta` before phase 2, and `domain_meta` is not
settable over HTTP at all (deliberately — only `MediaService` and, later, enrichment
write it). It becomes real when phase 2 starts extracting and reading meta.

Options when it matters: clear meta on domain change, re-validate and 400, or make the
pair updatable together. Not decided.

### B4. Railway free trial lapses around 2026-08-31

$5 of credit, 30 days from 2026-08-01 (`docs/deploy.md`). When it lapses the API stops
answering and every 1c write path dies with it — check-ins, media logs, and note
creation. Hobby is $5/month; the Free plan's $1/month credit will not keep an always-on
container running. **This month.**

### B5. Shared-package `dist/` staleness has no guard

A7 will recur. Nothing fails loudly when a dependent package tests against a stale build
of `@cortex/shared`/`@cortex/core` — the assertion just reports the old value, which
reads as "my edit didn't work". Candidate fixes: a `test` task `dependsOn: ["^build"]` in
`turbo.json`, or pointing the dependent packages' vitest at source. Not attempted here —
it touches build config for every package.

### B6. `00012` becomes unsafe once embeddings exist

`alter column ... type vector(1536)` works today only because both columns hold zero
rows. Any environment that already has 1024-dim embeddings needs a re-embed, not a type
change. Applies to any new environment provisioned after phase 2 replays migrations from
scratch — the file will not fail, but it also will not be the same operation. Noted in
`docs/deploy.md`.

### B7. Media autocomplete fetches the whole library

`MediaLogForm` selects every live `media_items` row for its `<datalist>`, unbounded and
on every mount. Fine at a few hundred items, wasteful past that. No limit, no search,
no caching.

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

## D. Verification state at time of writing

| Check | Result |
|---|---|
| `pnpm turbo run typecheck lint test` | 232 tests, 21/21 tasks green |
| `@cortex/db` | 72/72, green twice back-to-back without a reset |
| `@cortex/core` | 48/48 |
| `@cortex/api` | 56/56 |
| `@cortex/shared` | 27/27 |
| `@cortex/web` | 29/29 |
| Web production build | clean, 7 routes |
| Hosted migrations `00012`+`00013` | applied and verified against the catalog |
| Hosted API redeploy | **not done** (B1) |
| Browser click-through | **not done** (B2) |
