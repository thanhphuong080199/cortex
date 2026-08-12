# Phase 2 + 3 (stages A/B) — issue log

Everything that went wrong, was wrong, or is still open, from implementing
`docs/superpowers/plans/2026-08-10-phase-2-3-stages-a-b.md`.

Written for review, not as a changelog: each entry records the **symptom you would actually
see**, the cause, and what was done — because most of the entries below share one shape, and
it is the shape that makes them dangerous.

> **The theme of this phase: the pipeline stops working and looks healthy doing it.**
> A sweep that enriches nothing logs the same line as one that enriches twenty. A search over a
> corpus with no embeddings returns `{"results": []}`, which is indistinguishable from "no
> matches". A note that will never be retried looks exactly like a note that is about to be. Of
> the fourteen defects in section A, **eleven produced no error anywhere** — not in a log, not
> in a response, not in a test.

Branch `feat/phase-2-ai-enrichment` · PR #10 · 43 commits · deployed to production 2026-08-12.

---

## A. Resolved — found by the final whole-branch review

The review ran after all 17 tasks were complete and every per-task review had passed. It found
2 criticals and 8 important issues, and ruled on 22 deferred items the per-task reviews had
accumulated. **Both criticals were invisible to the local gate by construction** — which is the
entire argument for having a whole-branch pass at all.

### A1. CI could not pass — CRITICAL

| | |
|---|---|
| **Symptom** | Nothing locally. `pnpm turbo run typecheck lint test` → 26/26 green, indefinitely. CI would have gone red on the first push. |
| **Cause** | This branch made `DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_TIER` and `ENRICH_MONTHLY_BUDGET_USD` required in `apps/api/src/env.ts`. All four were declared in `turbo.json`'s `test.env` — but that only lets turbo *pass a var through*. `ci.yml`'s "Export local Supabase keys as app env vars" step must actually *set* it, and was never touched. |
| **Why local stayed green** | Every vitest config sets `setupFiles: ["dotenv/config"]`, so `apps/api/.env` backfills anything missing on a developer machine. The `db-tests` job deliberately asserts **no `.env` exists on the runner**, precisely so it cannot. The local gate was green for exactly the reason CI would be red. |
| **Fix** | Commit `36b670a` — export `DB_URL`→`DATABASE_URL` (the names differ) plus dummy Gemini/budget vars. |
| **Status** | **Resolved, but the fix was narrower than this entry claimed — see G1.** CI green on PR #10, all three jobs; the `Assert no .env files` step passing alongside the tests is what proves the vars came from CI's export and not a backfill. What that did *not* prove is the other two workflows that boot the same API: `e2e-web.yml` and `e2e-mobile.yml` were missed here and took the post-merge run red. Same family as 1c's E8. Saved to project memory. |

### A2. `docs/deploy.md` documented the opposite of what the code requires — CRITICAL

| | |
|---|---|
| **Symptom** | An operator following the deploy doc sets no `SUPABASE_SERVICE_ROLE_KEY`. `parseApiEnv` throws → `main.ts` calls `process.exit(1)` → the container never listens. Railway shows a crash loop, not a bad config. |
| **Cause** | The variable table read *"Tests only. No service-role key belongs on a request path; RLS is the enforcement (spec §4.1)."* That was a **security rule**, and phase 2 overrides it deliberately: `note_chunks` has RLS enabled with no policies, so a per-request user client reads back exactly zero rows and semantic search returns "no matches" over a full corpus. The justification existed only in a source comment. |
| **Fix** | Commit `36b670a` — the row is rewritten, with a section covering what forced the change, why it is safe (the `SECURITY DEFINER` boundary and the JWT-only `p_user_id`), and the four things that would make it unsafe. |
| **Status** | **Resolved.** `apps/api/.env.example` carried the same stale claim and was fixed separately in `f7b129c`. |

### A3. A short `embeddings` array wrote NULL embeddings **uniformly**

| | |
|---|---|
| **Severity** | Highest-impact defect of the branch. Semantic search drops to zero corpus-wide, permanently, with a green log. |
| **Symptom** | Nothing. Usage is billed, `embedded_hash` is stamped, the sweep logs `processed=N failed=0`, and search returns `{"results": []}` forever. |
| **Cause** | `gemini.ts` did `(json.embeddings ?? []) as {values:number[]}[]`. A short response makes `vectors[i]` `undefined` on **every** row uniformly, so `JSON.stringify` drops the key from all of them, PostgREST accepts the batch (the keys match), and the rows land with NULL embeddings. `search_notes` filters on `c.embedding is not null`, so they are invisible — and the `embedded_hash` predicate guarantees the notes are never claimed again. |
| **Why nothing caught it** | `SupabaseClient` is ungeneric, so `.upsert(rows)` takes `any` and `noUncheckedIndexedAccess` has no typed destination to complain about. |
| **Fix** | Commit `dec0bb0` — `extractVectors()` in the Gemini client, plus a second independent length/hole check in `embedNote` (the two protect different things: one the client, one the write). |
| **Status** | **Resolved.** Verified in production: `select count(*) from note_chunks where embedding is null` → **0**. |

### A4. One over-budget user starved the **global** sweep

| | |
|---|---|
| **Symptom** | Enrichment stops for **every** user. The cron still fires and one warning prints, so the deployment looks alive. |
| **Cause** | The claim is deliberately global and ordered `updated_at asc`. An over-budget note was skipped *after* claiming, which increments no counter and writes nothing to `notes` — so its `updated_at` never advances and it stays at the head of the ordering forever. If user A is over budget and owns the 20 oldest notes, every sweep claims A's 20, skips all 20, and processes nothing until the month rolls over. |
| **Fix** | Commit `dec0bb0` — `claim_notes_for_enrichment` gains `p_exclude_user_ids` and the service does a bounded re-claim excluding over-budget users. The exclusion is a parameter rather than a predicate because `usage_month_to_date_usd` is an aggregate and VOLATILE, so Postgres would evaluate it per candidate row. |
| **Status** | **Resolved** (migration `00023`). |

### A5. Every PostgREST failure was persisted as literally `[object Object]`

| | |
|---|---|
| **Symptom** | `note_enrichment.last_error` reads `[object Object]`. Zero diagnostic for any production failure. |
| **Cause** | `err instanceof Error ? err.message : String(err)`. PostgREST errors are **plain objects** (`{message, details, hint, code}`), not `Error`s — a fact `search.controller.ts` already documented and had fixed for itself. |
| **Fix** | Commit `dec0bb0` — `errorMessage()` in `packages/core/src/errors.ts`, rendering `code: message`. It deliberately **drops `details`**, which carries the offending row's values — and a tag name is model output derived from note content (spec §15.6 rule 1). |
| **Status** | **Resolved.** Confirmed live during the search-metering test, which logged `22P02: invalid input syntax for type integer` instead of `[object Object]`. |

### A6. `attempts` was never reset when the note's content changed

| | |
|---|---|
| **Symptom** | A note that failed 5× stays tombstoned **forever**, even after the user rewrites it. Never embedded, never findable by meaning, and `note_enrichment` has RLS with no policies so nothing surfaces why. |
| **Cause** | `00018` gated the claim on `coalesce(e.attempts, 0) < 5`, and the service reset `attempts` only on success. Everywhere else in this design "the text changed" is the reset event — that is the whole reason the predicate keys on `md5(content_text)`. |
| **Fix** | Commit `dec0bb0` — `attempts_hash` records *which text* the count was accumulated against; a note whose text has moved on is claimable again. Remediation and migration become the same action. |
| **Status** | **Resolved** (migration `00023`). |

### A7. The tag vocabulary read was unbounded — the `max_rows` trap, again

| | |
|---|---|
| **Symptom** | Intermittent enrichment failures for users with many tags, then a tombstoned note. |
| **Cause** | `extract.ts` did `.select("id, name").eq("user_id", …)` with no `.limit()`. `config.toml`'s `max_rows = 1000` truncates the response with **no error** and no signal short of reading `Content-Range`. |
| **Correction to the original brief** | I wrote that a tag outside the truncated slice "reads as novel" and inserts as a near-duplicate. **Wrong** — `tags_user_name_uidx` is unique on `(user_id, lower(name)) where deleted_at is null`, so the common case (the model naming the tag exactly, or in different case) **raises**, the note fails 5×, and A6 tombstones it. Capping alone would have turned a rare failure into a routine one. |
| **Fix** | Commit `dec0bb0` — bounded read plus conflict-tolerant insert. |
| **Status** | **Resolved.** Third time this trap has appeared in this repo (see `00021`, and 1c's log). |

### A8. The RRF sum had no test

| | |
|---|---|
| **Symptom** | None. Ten `search_notes` tests, all green, none pinning the one claim hybrid retrieval actually makes. |
| **Cause** | `matched_by` is a separate `case` expression, four tests are single-arm by design, and the rest assert containment only. **Confirmed by execution, not by reading:** with the FTS term deleted from `base`, all ten original tests stayed green. |
| **Fix** | Commit `44a1e8d` — a test pinning agreement at rank 2 beating one arm at rank 1 (`1/62 + 1/62 > 1/61`). |
| **Status** | **Resolved.** |

### A9. Client-supplied `created_at` turned the recency decay into an **amplifier**

| | |
|---|---|
| **Symptom** | A note dated two years in the future scores **57×** and pins rank 1 for every query the user makes. A far-future date could 500 the whole endpoint. |
| **Cause** | `exp(-age_days/180)` with no clamp; `created_at` is client-writable. |
| **Correction to the original brief** | I gave the overflow threshold as ~709.78 (float8's `dexp` limit). **Wrong** — `extract(epoch from interval)` returns **numeric** in PG14+, so it is `numeric_exp` and the real threshold is `exp(6000::numeric)`, i.e. `created_at` ~2957 years ahead — which is `9999-12-31`, the sentinel a botched date parse writes. Corollary I had missed: because it is numeric, the symmetric **past-side underflow does not exist**; had it been float8, any note dated before ~1659 would also have 500'd. |
| **Fix** | Commit `44a1e8d`, migration `00024` — `least(greatest(age, 0), 36525)`. |
| **Status** | **Resolved.** |

### A10. Both enrichment suites' backdating strategy was broken

| | |
|---|---|
| **Symptom** | A suite green on a fresh database, then failing on every subsequent run. This was the root cause of the earlier Task 15 red gate. |
| **Cause** | A fixed offset (`now − 10y`) does **not** anchor a fixture at the head of a global ordering — each run lands slightly newer than the last, so a suite's own leftovers queue in front of it permanently. Measured: 9 tombstoned notes at the head plus 1001 rows already satisfying the predicate, against a `claim(1000)` helper where PostgREST's `max_rows` caps the *response* regardless of `p_limit` — the A7 trap living inside a test helper. |
| **Fix** | Commit `dec0bb0` — both suites now anchor to the oldest row that already exists. |
| **Status** | **Resolved.** Found by the implementing agent, not by my brief. |

### A11. The budget test failed on ~5 calendar days a year

| | |
|---|---|
| **Symptom** | A test that passes 360 days a year and fails on the 31st. |
| **Cause** | `setMonth(-1)` on the 31st normalises back into *this* month. |
| **Fix** | Commit `36b670a`. |
| **Status** | **Resolved.** |

### A12. The search result type was hand-copied in three packages

| | |
|---|---|
| **Symptom** | Renaming a column compiles clean everywhere and renders `undefined` on web and mobile. |
| **Cause** | Three independent copies of the result shape with nothing binding them. |
| **Fix** | Commit `36b670a` — one type in `@cortex/shared`; api/web/mobile all alias it. |
| **Status** | **Resolved.** |

### A13. Mobile never got web's 500-character cap

| | |
|---|---|
| **Symptom** | A pasted article comes back as `search failed (400)` — a **validation** problem wearing a **request failure's** clothes, with nothing in it the user can act on. |
| **Cause** | Web fixed exactly this one round earlier (`maxLength={500}` plus `validated(searchInput, …)` in its `api.ts`); mobile shipped with neither. |
| **Correction to the original brief** | I said web's `search-form.tsx` validates against `searchInput`. It does not — it only has `maxLength={500}`; the validation lives in `apps/web/src/lib/api.ts`. The agent matched the real two-layer arrangement rather than the one I described. |
| **Fix** | Commit `36b670a` — `SearchInputError` + local validation, message quoting the schema's own limit. |
| **Status** | **Resolved.** |

### A14. `createFakeAi` returned non-unit vectors while `gemini.ts` guarantees unit length

| | |
|---|---|
| **Symptom** | Nothing today — `00012` indexes with `vector_cosine_ops`, and cosine divides out each vector's norm, so ranking is scale-invariant. |
| **Cause** | Every stored test vector contradicted a contract the real client documents as safe to assume (‖v‖ ≈ 11.3 rather than 1). The first consumer to use inner product or raw L2 would pass its entire suite and be wrong only in production. |
| **Fix** | Commit `36b670a` — the fake imports the real `normalizeEmbedding` rather than carrying a second copy of the math. |
| **Status** | **Resolved.** A fake that contradicts the real client's guarantee is a fake that lies. |

---

## B. Found by deploying (2026-08-12)

None of these were reachable from a test run. They are the argument for treating the first
deploy as part of the work rather than as an afterthought.

### B1. The hosted database was seven migrations behind — the quiet failure

| | |
|---|---|
| **Symptom** | Would have been: the API boots perfectly, `/health` returns 200, every route maps — and then every sweep and every search fails, because `note_enrichment` and `search_notes` do not exist. |
| **Why it matters more than the env vars** | A missing variable crashes the container at boot: loud, unmissable, a crash loop in the Railway UI. A missing migration fails silently at runtime. |
| **Fix** | `supabase db push` — `00018`–`00024`, then `00025`. Verified in `pg_proc`/`pg_class`, not from the CLI's exit code. |
| **Status** | **Resolved.** `docs/deploy.md`'s phase-2 section now leads with migration order for this reason. |

### B2. The hosted project granted every client role full DML on every table

| | |
|---|---|
| **Symptom** | None — and that is why it survived. |
| **Cause** | On hosted, `anon` **and** `authenticated` held `INSERT/SELECT/UPDATE/DELETE` on all 23 tables in `public`, including `note_chunks`, `note_enrichment` and `usage_ledger`, whose own grant-block comments say they get no client DML at all. Locally those tables grant nothing. **Not one-off drift:** `pg_default_acl` for schema `public`, owner `postgres`, granted `arwd` to both roles on hosted and had no entry at all locally — so every table a future migration created was born client-writable there. `00009` had already reached this template (hosted's `arwd` is exactly `arwdDxtm` minus the `Dxtm` it revoked); it simply never covered the DML half. |
| **Exploitable?** | **No**, and this was verified against the live project *before* writing the migration: RLS on for all 23 tables; all 15 policies target `authenticated`, **zero** target `anon` or `PUBLIC` (so every anon grant was inert); the 8 zero-policy tables blocked `authenticated` too; `digests`/`memory_facts` have `for select` policies only. Every privilege revoked was already unusable. |
| **Why fix it then** | `00007` describes **two** independent layers — "a table-level GRANT before RLS is even evaluated" — and production had one. One future policy written `for all` instead of `for select` was the whole distance between a server-only table and a client-writable one. It also means `packages/db`'s isolation suite had been proving a stricter configuration than production ran. |
| **Fix** | Commit `b99c642`, migration `00025` — revokes the grants **and** the default-privileges template, applied locally first (gate 26/26, proving a no-op) and only then pushed. |
| **Status** | **Resolved.** Hosted now matches local on all 23 tables, zero drift rows. Visible improvement: a client hitting a server-only table gets `42501 permission denied` at the grant layer instead of a silent empty result from RLS. |
| **Residual** | The `supabase_admin`-owned default ACL still grants `arwdDxtm` to `anon`/`authenticated` — but **identically in local and hosted**, so it is not drift, and our migrations create `postgres`-owned tables. Documented, not "fixed". |

### B3. No `.dockerignore` — `railway up` would have uploaded `.env`

| | |
|---|---|
| **Symptom** | None visible. Credentials in the build context and the build stage's filesystem. |
| **Cause** | `railway up` uploads the working tree and `apps/api/Dockerfile` does `COPY apps/api ./apps/api`. `apps/api/.env` holds the hosted `DATABASE_URL` with its password, the hosted service-role key and the Gemini key. The published image was clean **only by accident of layering** — the runtime stage happens to copy just `package.json`, `node_modules` and `dist`. |
| **Fix** | Commit `6d2cfe1` — repo-root `.dockerignore`. One `COPY --from=build /repo/apps/api` in a later refactor would otherwise bake real credentials into a layer, and nothing in the repo would notice. |
| **Status** | **Resolved.** |

### B4. Railway's `DATABASE_URL` held a pre-rotation password

| | |
|---|---|
| **Symptom** | Would have been: the container boots (the string is well-formed, so `parseApiEnv` passes), then pg-boss cannot connect and no sweep ever runs. |
| **Cause** | The Postgres password was rotated during this session; Railway's copy was not updated with it. Confirmed by connecting: `28P01 password authentication failed`. |
| **Fix** | Set from the verified local value via `railway variable set --stdin --skip-deploys`, then re-verified by connecting (`select current_user` → `postgres`). |
| **Status** | **Resolved.** `docs/deploy.md` now documents the stdin pattern so a secret never lands in shell history. |

### B5. `.env.example` still called the service-role key "tests only"

| | |
|---|---|
| **Symptom** | A developer sets up the repo, trusts the line, leaves the var unset, and gets a boot failure rather than a degraded mode. |
| **Cause** | Same class as A2 — a repo document stating the opposite of what the code requires. Caught while writing the PR, four commits after A2 fixed the same claim in `deploy.md`. |
| **Fix** | Commit `f7b129c`. |
| **Status** | **Resolved.** Two copies of one claim; fixing one did not fix the other. |

---

## C. Decisions taken, not defects

Recorded because each one has a defensible alternative and the reasoning matters more than the
choice.

### C1. Search spend is **metered but not gated** — `fdd5b1d`

Every `POST /search` embeds its query, so it is a billable path, and it wrote nothing to
`usage_ledger` — the only place that spend appeared was Google's console. `isOverBudget` is
deliberately fail-**closed** so an outage in the spend query cannot become unlimited spend, a
guarantee worth nothing for a path the ledger never sees.

It is **not** gated: refusing to let someone search their own notes because a *background* job
overspent is the wrong trade, and gating would put a second round trip in front of an
interactive request. The budget bounds what Cortex spends on its own initiative; a search is the
user asking.

A failed ledger write **never** fails the search — the accepted cost is a silent under-count.
So `usage_ledger` is a monitoring signal for search, not an audit-grade meter. **Still open by
design:** `POST /search` has no rate limit. Metering makes abuse visible; it does not stop it.

### C2. An advisory lock, not `policy: 'singleton'` — `1d6788e`

pg-boss's `work()` defaults keep *one process* from sweeping twice at once and nothing more: the
queue uses the default `standard` policy, and `SKIP LOCKED` inside the claim releases its row
locks the moment that transaction commits — long before the AI calls return. Two containers
would claim disjoint notes and bill for both. Until this commit the only thing preventing that
was "there is exactly one API instance", which Railway's default rolling redeploy violates by
design for ~30 seconds per deploy.

Both a singleton queue and a lock stop the overlap; they differ when a sweep runs **long**. A
singleton queue holds at most one job, so a tick arriving mid-sweep is silently dropped —
throughput falls with nothing in the logs. With a lock the loser returns immediately and the next
tick tries again. Session-scoped rather than `_xact_`, because a transaction lock releases at
commit — the exact gap `SKIP LOCKED` already leaves. Over a lease row, because an advisory lock
has no TTL to guess: if the process dies its connection dies and Postgres drops the lock.

### C3. The legacy `service_role` JWT, not the newer `sb_secret_…`

The project offers both. `SUPABASE_ANON_KEY` is the legacy anon JWT and every local and CI run
exercises legacy keys, so mixing key generations was an extra variable on the one deploy that
first puts a service-role key on a request path.

---

## D. Controller errors — mine

Recorded deliberately. Every one was caught by an agent or a test with evidence, and every
correction was right.

| # | What I claimed | What was true | Caught by |
|---|---|---|---|
| 1 | A truncated tag list makes a tag "read as novel" and insert as a near-duplicate | `tags_user_name_uidx` makes it **raise**; capping alone would have made a rare failure routine | implementing agent (A7) |
| 2 | The `exp()` overflow threshold is ~709.78 | numeric in PG14+, so `exp(6000::numeric)`; and the past-side underflow does not exist | implementing agent (A9) |
| 3 | `budget.test.ts` lives in `src/usage/` | `src/enrich/` | implementing agent |
| 4 | Web's `search-form.tsx` validates against `searchInput` | It has only `maxLength`; validation is in `lib/api.ts` | implementing agent (A13) |
| 5 | `deploy.md` had wrong pg-boss pooler guidance | It had **none** — the 5432/6543 text there is PowerSync logical replication, a *different* rule with a different hostname | implementing agent |
| 6 | `0x434F5254` = 1129270868 | 1129271892 | the key-constant test, on its first run |
| 7 | "Something keeps bumping `updated_at`, which would starve this note forever" | One sample is not a trend. Sampled twice 45s apart: identical. It was the deliberate 90-second claim debounce | myself, same turn |
| 8 | An anon probe of `note_chunks` returning no error was labelled `<-- PROBLEM` | Vacuous — the hosted table is **empty**, so `count=0` proves nothing either way. Replaced with a data-independent catalog query | myself, same turn |

Two further process failures worth recording:

- **Credential exposure, twice.** The hosted Postgres password reached a transcript twice on
  2026-08-12 and was rotated twice. The second time, the "redaction" regex was the cause: it
  masked up to the *first* `@`, and the password itself contained one. A password is exactly the
  field most likely to contain the delimiter you are matching on, so a redaction regex is a
  credential-handling decision, not a formatting one. Rule adopted: never print any line of
  `apps/api/.env`, even masked; pass values by shell substitution that never reaches stdout.
- **Absolute row counts in a test against a shared database.** The first draft of the
  search-metering tests asserted `toHaveLength(1)`. `makeUser` signs the *same* fixture users
  back in on every run, so their `usage_ledger` rows accumulate: green once locally, red forever
  after, green on a fresh CI database. Rewritten as deltas off a measured baseline — the same
  lesson A10 teaches.

---

## E. Still open

### E1. One transient `@cortex/api` gate failure — NOT root-caused

A single run failed between two clean 26/26 runs and the assertion was not captured before it
passed again. Suspected contention on the shared local Postgres, since turbo runs the api and db
suites in parallel against one stack. **This is a hypothesis, not a diagnosis** — stated as such
in PR #10 rather than omitted.

### E2. `GEMINI_TIER=paid` asserts intent and cannot verify it — USER ACTION

No Google endpoint exposes a key's billing tier. The key was validated against the free
`/v1beta/models` metadata endpoint (valid, and both `gemini-embedding-001` and
`gemini-3.5-flash-lite` available) — which proves the credential, not the plan. **If the project
is actually on the free tier, every enrichment sends mood, health and finance notes to a tier
Google trains on** (spec §15.6 rule 2). Confirm in the Google Cloud console.

### E3. Web and mobile are not deployed — USER ACTION

The API has been serving `/search` since 2026-08-12; the **UI is not live until web redeploys**
and a new APK is installed. No new client env vars are required — web still needs only its three
`NEXT_PUBLIC_*` and mobile its existing `EXPO_PUBLIC_*`.

### E4. `POST /search` has no rate limit — BY DESIGN, see C1

### E5. Railway has `PORT=3001` set by hand

`docs/deploy.md` says to leave it to the platform; setting it only creates a way to disagree.
Working today.

### E6. Deferred, ruled fine to leave

- ~~**The ASCII-only sentence-boundary regex**~~ — **fixed 2026-08-12**, taken first for the
  reason given here: it is much cheaper before there is a corpus to re-embed. `\p{Lu}` replaces
  `A-Z` and a second arm handles the full-width `。！？`, which have no whitespace after them.
  `\p{Lu}` is a strict superset of `A-Z`, so ASCII notes chunk byte-identically and **nothing
  already embedded needs re-embedding** — the pre-existing resynchronisation test, which pins
  exact chunk counts, is unchanged and still green.
- Surrogate-pair slicing in `hardSplit`; raw error strings reaching the mobile UI; result
  elements unvalidated past `Array.isArray`; ~15 cosmetic items the review listed individually.

  `hardSplit` is worth a second look now rather than later: with sentence boundaries fixed it
  fires less often for CJK, but a wall of emoji or ideographs with no punctuation still reaches
  it, and a fixed-offset slice can cut a surrogate pair in half. Still deferred — it is a
  separate defect from the one above, not a loose end of it.

---

## F. Verification state (2026-08-12)

| Check | Result |
|---|---|
| `pnpm turbo run typecheck lint test --force` | **26/26**, `Cached: 0 cached` |
| `pnpm turbo run bundle --filter=@cortex/mobile --force` | 3/3, Metro clean |
| CI on PR #10 | **all 3 jobs green** — including `CI gate`, the required check |
| Hosted migrations | `00025` head; `migration list` local == remote |
| Hosted schema verified in catalog | `note_enrichment` present; `search_notes`, `claim_notes_for_enrichment`, `usage_month_to_date_usd` all `SECURITY DEFINER` |
| Railway variables | all 8 required present; verified by piping `railway variables --json` through the compiled `parseApiEnv` |
| Unauthenticated `POST /notes` | `401` — i.e. not a stale container |
| Authenticated `POST /notes` | `201` |
| Enrichment sweep in production | `processed=16 failed=0 skippedOverBudget=0` |
| End-to-end semantic search | a new note embedded, `domain=life` extracted, returned by `POST /search` with `matchedBy=vector` |
| `count(*) from note_chunks where embedding is null` | **0** |
| `usage_ledger` search metering | `gemini-embedding-001`, 6 input tokens, `$0.0000009` |
| Post-`00025` production re-smoke | `/notes` 201, `/tags` 201, `/me` 200, `/search` 201; server-only tables `42501` to `authenticated` |
| Server-only tables in a replication publication | **none** — `note_chunks`/`note_enrichment` absent from both `powersync` and `supabase_realtime` |
| Browser and device click-through | **open** (E3) |
| Post-merge E2E on `main` | **red on the first run** — see G1 |

---

## G. Found by the first post-merge run (2026-08-12)

A discovery channel of its own, and the reason this section exists rather than folding into A:
**PR #10 was merged green and the suites that caught this had not run yet.** PR #9 moved E2E
behind the merge, so `post-merge.yml` is the first thing on this branch's path that ever booted
the API outside a vitest process.

### G1. A1's fix covered one of the three workflows that boot the API

| | |
|---|---|
| **Symptom** | Nothing on the PR — all 3 CI jobs green, merged clean. The post-merge run then failed **both** E2E Web and E2E Mobile at the same step, `Seed the E2E user and corpus`, with two lines and no stack: `[seed] allow-listed e2e@cortex.test` / `[seed] fetch failed`. It reads like a broken seed script or a dead Supabase auth container. Neither is involved. |
| **Cause** | The same four required vars as A1. A1 fixed `ci.yml` — but `e2e-web.yml` and `e2e-mobile.yml` each run `node apps/api/dist/main.js` too, and their "Export Supabase keys as app env vars" step set only `ANON_KEY`/`SERVICE_ROLE_KEY`. `main.ts` calls `parseApiEnv` **before** `NestFactory.create`, so the API `exit(1)`s at boot and never binds `:3001`. |
| **Why the error named the wrong file** | `createUser` and `signIn` log nothing on success, so the next output after "allow-listed" came from `seedCorpus`'s first `POST /notes` — undici's bare `fetch failed` on ECONNREFUSED. Every fetch in `seed.mjs` before that one goes to Supabase and succeeded, which is what makes the message point at auth. |
| **Why nothing went red at the actual failure** | `Start the API` reported **green**. Its wait loop was `for i in $(seq 1 30); do curl … && break; sleep 2; done` — the loop's exit status is the last command's, i.e. the `sleep`. A boot that never happened is indistinguishable from a healthy one except by duration: the step took exactly 60s (30 × 2s) instead of ~2s. |
| **Fix** | Export `DB_URL`→`DATABASE_URL` plus the dummy Gemini/budget vars in both E2E workflows, and end the wait loop with `exit 1` so a dead API fails at `Start the API` instead of two steps later. |
| **Status** | **Resolved.** Verified locally rather than by inference: the built API run with exactly the E2E job's environment prints a `ZodError` naming all four vars and exits 1; with the patched environment it answers `/health`, and `seed.mjs --reset` completes with the full corpus, exit 0. |
| **What A1 should have said** | A1's status — "Resolved and proven, CI green on PR #10, all three jobs" — was true and insufficient. Green CI proved the `ci.yml` half. The generalisation to check is **every workflow that boots the API**, not "the workflow that runs the tests"; grep `.github/` for a newly-required var and expect three hits. Project memory updated accordingly. |
