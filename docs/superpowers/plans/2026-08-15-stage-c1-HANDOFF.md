# Stage C1 — handoff at the end of Task 6

**Date:** 2026-08-15
**Branch:** `feat/stage-c1-assistant`, at `6c7eadb`, working tree clean, nothing pushed.
**Plan:** `docs/superpowers/plans/2026-08-12-stage-c1-assistant-box.md` (10 tasks).
**Mode:** subagent-driven development — a brief per task, an implementer, an independent
reviewer, fix rounds to a clean re-review, then the ledger.

> Read this before touching Stage C1. The SDD ledger
> (`.superpowers/sdd/2026-08-12-stage-c1-assistant-box/progress.md`) holds the blow-by-blow but
> is **gitignored** (`.gitignore:21`), so it does not survive a clone. Everything below is the
> part that must.

---

## Where the work stands

| Task | State |
|---|---|
| 1. `00027` ledger attribution migration | complete, review clean |
| 2. `recordUsage` carries attribution | complete, review clean |
| 3. `generateStream` + `usageMetadata` | complete, 1 fix round |
| 4. `extractNote` gains intent/complexity/language | complete, 1 fix round |
| 5. rolling context window + 4-hour reset | complete, 2 fix rounds |
| 6. retrieval and the two prompts | complete, 1 fix round |
| **7. pin the answer model, orchestrate the turn** | **not started — brief prepared, see below** |
| 8. `POST /assistant` SSE controller | not started |
| 9. the box replaces quick capture | not started |
| 10. E2E: capture survives a dead assistant | not started |

Commits on the branch, oldest first: `5c7455b` (plan) · `4a45c91` · `4c04961` · `6c2def5` ·
`750173f` · `54ae634` · `a46c9d4` · `55f5a66` · `cf4a990` · `89e1ad9` · `1d08522` · `c8bda79` ·
`54b68ff` · `0f761f6` · `6c7eadb`.

Gates at `6c7eadb`, all at `0 cached`: `@cortex/core` 21 files / 215 tests green; lint 7/7;
typecheck 12/12.

---

## Rulings made (these override the plan text)

**1. The reviewer governs over a plan snippet.** Task 3's review found the plan's own SSE reader
discarded its tail buffer — the buffer holding the final event, which is the one carrying
`usageMetadata`. The plan was corrected in `750173f` for both the server and client readers
rather than the implementation being bent to match it.

**2. The plan's `chars/4` rationale was inverted** (corrected in `c8bda79`, all three places it
appeared). The plan claimed under-counting Vietnamese means the context window "holds fewer real
tokens than budgeted, never more." It is the opposite: an estimate that reads low lets the filler
keep accepting turns while real tokens accumulate faster than the count. `docs/phase-2-issue-log.md`
H3 measures Vietnamese at 2–3 characters per token, so a full 2000-token window is nearer
**3300–4000 real tokens**. The uncharged per-turn framing the renderer adds pushes the same way.

The estimator stays `chars/4` — replacing a known-wrong divisor with a guessed one is the trade
H3 already rejected, and 2000 is a window we chose, not a model limit, so overshooting costs
input tokens rather than failing the request. **What must not survive is the reason:** treat 2000
as a soft target that runs over, never as headroom to spend.

**3. `retrieve` maps its PostgREST error** rather than rethrowing it raw. Every HTTP-facing core
module maps (`notes/`, `media/`, `organize/`, `checkins/`, `export/`); only the background sweep
(`budget.ts`, `embed.ts`, `extract.ts`) rethrows raw, and it never crosses `CoreErrorFilter`.
Verified: the filter's `KINDS` set includes `"internal"` and it logs `JSON.stringify(cause)`, so
mapping is precisely what replaces a logged `[object Object]` with real PostgREST detail.

**4. Lint is a dispatch requirement.** Task 3 shipped `@cortex/core` lint RED (three
`no-unused-vars` on `_` drain loops) because no implementer dispatch had asked for lint. Fixed at
the call site with `void chunk` in `55f5a66` — **not** by adding `varsIgnorePattern`, which
`packages/config/eslint.base.mjs` explicitly rejects with a comment explaining why. Every dispatch
since requires `pnpm turbo run lint --force` green across all 7 packages at `0 cached`.

---

## Blockers and constraints for the remaining tasks

**Task 7 — `runTurn`.** The brief is extracted to
`.superpowers/sdd/2026-08-12-stage-c1-assistant-box/task-7-brief.md` (plan lines 1461–1902).
I verified its assumptions against the code and schema before dispatching; these hold:

- `chat_sessions` and `chat_messages` exist (`00006_synthesis_chat.sql`) with every column the
  brief uses. Policy `chat_messages_own` is `for all to authenticated`, owner-scoped, with full
  CRUD grants — so inserting through the **user's** client is correct and passes RLS. Index is
  `(session_id, created_at)`.
- `isOverBudget(db, userId, limitUsd)` at `budget.ts:119`, comparing with strict `>`.
- `recordUsage`'s `kind` vocabulary includes `"chat"`.
- `extractNote` returns `{ tags, tagNames, domain, intent, complexity }`.

Six defects I found in that brief which have **not** been fixed — whoever dispatches Task 7 must
carry them:

1. **`withDeadline` leaks its timer.** `Promise.race([p, new Promise(r => setTimeout(...))])`
   never clears the timeout, so a pending 4-second timer keeps the event loop alive after the
   race settles. Clear or `unref` it.
2. **`crypto.randomUUID()` is used bare** while `createHash` comes from `node:crypto`. Import
   `randomUUID` from `node:crypto` too.
3. **`selectContext` now sorts internally** (Task 5's fix), so the brief's trailing `.reverse()`
   on the history array is redundant.
4. **The `dbs()` test double in Step 2 cannot support Step 6**, which needs `dbs({ history })`.
   It must serve three different query chains — the note lookup, the last-message lookup, and the
   history read — so a change for one must not silently satisfy another.
5. **"records the answer's usage even when the stream fails part-way" probably tests the fake,
   not the behaviour.** It scripts `usage: () => ({...})` returning a value after the stream
   throws. With the real Gemini client a socket death means the final SSE event carrying
   `usageMetadata` never arrived, so `usage()` returns `null` and nothing is recorded. You cannot
   invent a token count you never received — if mid-stream deaths are genuinely unmeterable, the
   comment must say so instead of implying billing always happens.
6. **`ANSWER_MODEL` without prices bills $0 silently.** `priceUsd` returns zero for an unknown
   model by design (`budget.ts:4-9`), so Step 1 must add the id **and** its entry in
   `MODEL_PRICES_USD_PER_MTOK`. Step 1 is a research step against
   `ai.google.dev/gemini-api/docs/models` and `/pricing` — it must not be guessed.

Also: `runTurn` is an **async generator**, and a generator's body does not run until the first
`next()`. A caller that awaits it without iterating opens nothing. That is Task 8's problem, but
it is the same laziness that bit Task 3.

**Task 8 — `POST /assistant`.** `retrieve` takes the **service-role** client, and `p_user_id` is
the only thing separating two users' corpora once `search_notes`' `SECURITY DEFINER` puts RLS out
of the picture. The controller's request body must be `.strict()` (as `searchInput` already is)
so `userId` can never be spread in from the body. It must come from the verified JWT.

**Task 9 — the box.** `apps/web` depends on `@cortex/shared` but **not** `@cortex/core`, so the
plan's `import { Citation }` in `assistant-box.tsx` will not resolve. Add the dependency, move
the type to `@cortex/shared`, or declare a local type — decide before dispatching.

**Task 7 barrel.** Task 8's controller imports `runTurn` from `@cortex/core`, so `turn.js` almost
certainly needs a barrel export — unlike Task 6's `retrieve`/`prompts` lines, which were added for
consistency and are not load-bearing (Task 7 imports those relatively). Note that TypeScript
silently **drops** an ambiguous name from `export *` rather than erroring, so a green typecheck
does not prove a name is reachable.

---

## After the branch merges

- `supabase db push` for migration `00027`.
- Set `ASSISTANT_MONTHLY_BUDGET_USD` on Railway; redeploy web.
- **Verify the first `usage_ledger` row has non-zero `input_tokens`.** Zero means `usageMetadata`
  is being dropped — the exact defect Task 3 existed to fix.

---

## Deferred, deliberately

- `gemini.ts` batch cap ≤100 — separate PR.
- Failure-class-aware retry; model routing. `complexity` is recorded by Task 4 and read by
  nothing; that is the point — it builds the dataset a future routing decision needs.
- `ON DELETE SET NULL` on `00027` has no functional test; `usage_ledger_request_idx`/`note_idx`
  existence is untested because PostgREST does not expose `pg_indexes`.
- No regression test pins `cancel()` vs `releaseLock()` on the stream reader; CRLF normalisation
  and the `decoder.decode()` flush are untested.
- `isStale`'s exact `>=` boundary is untested, and `SESSION_IDLE_RESET_MS` is pinned only to a
  31-minute window by the 3h30m/4h01m fixtures. An unparseable `lastMessageAt` returns `false`
  via `NaN` comparison — the unsafe default, opposite to the `null` branch.
- `selectContext`'s sort is stable, so turns sharing an identical `createdAt` keep input order; a
  `desc`-ordered caller still gets those pairs backwards. Unreachable through Task 7 as planned
  (separate inserts, separate transactions).
- `estimateTokens` is module-private, so Task 6's renderer duplicates `chars/4`.
- **`CoreErrorFilter` logs `JSON.stringify(cause)`, which includes PostgREST `details`/`hint`** —
  the two fields `errors.ts` deliberately excludes because they can carry note content (a 23505
  on `tags_user_name_uidx` puts a tag name in `details`). Pre-existing across the whole app, not
  a Stage C1 regression. Worth a dedicated security pass.
- **Prompt injection.** Both prompt builders interpolate user text and retrieved snippets with no
  delimiting. Blast radius is nil while the corpus is first-party: a user's own note can only
  mislead their own session, and the answer turn has no tool-calling to escalate into. But
  `source_type` already admits `'web_search'` (`00020`) and `search_notes` deliberately *ranks
  such notes lower rather than excluding them* (`00026:148`, "provenance, not prohibition"). The
  moment anything writes those rows, third-party text lands in `renderCitations` on the same
  footing as the user's own words, and a snippet beginning `[2] ` can forge a citation number.
  Delimiting becomes necessary in the stage that introduces web search.

---

## Process notes that keep costing rounds

- **Run gates through turbo with `--force`, and read the `Cached:` line.** `pnpm --filter <pkg>
  test` resolves `@cortex/shared` and `@cortex/core` as compiled `dist/`, so it tests stale code.
  `26/26 successful` can be 23 replays.
- **Docker down looks like a code regression.** 40 `@cortex/core` tests failing with
  `TypeError: fetch failed` were purely a stopped Docker Desktop; with the stack up the suite is
  194/194. Proven by stash-and-compare before it was believed. Start Docker before any task that
  touches DB-backed code, or those failures mask real ones.
- **Commit messages go through a file.** Write with a Bash heredoc, commit with `git commit -F`.
  PowerShell here-strings and multi-line `-m` have both corrupted messages in this repo.
- **The repo is `core.autocrlf=true`.** A reviewing agent silently converted two files LF→CRLF
  with a text-mode Python write — invisible to `git diff`, a real byte change. Use the Edit/Write
  tools, never a shell or Python whole-file rewrite.
- **The plan's `git add` lists are incomplete** wherever a required field breaks existing callers
  or a new module needs a barrel export.
- **`scripts/task-brief` is unreliable** — it swallowed Tasks 4–10 into one file, and exited 3
  with "task 5 not found" for a heading that existed. Extract with `sed -n 'START,ENDp'` against
  the `^## Task N:` line numbers instead.

## The recurring defect: tests that cannot fail

Every task so far has shipped at least one, and the reviewer caught each only by mutation. Ask of
every test what one-line change to the implementation it would turn red.

- **Task 4** asserted `complexity` by feeding the function its own default value, so a hardcoded
  constant survived all 183 tests.
- **Task 5**'s over-budget fixture put the oversized turn at index 0, the last iteration — so
  `break` and `continue` were behaviourally identical across all six tests, and the plan's most
  emphasised invariant was protected by nothing.
- **Task 6**'s brief hardcoded `error: null` in its DB double, so deleting `if (error) throw
  error` passed **all four** of its tests. A broken search would have handed the answer prompt an
  empty corpus, and the model would have answered from general knowledge dressed as the user's
  own notes.
- **Task 6**'s acknowledge prompt could render domain and tags **swapped** — "filed under thể
  dục, tagged health" — and all 13 prompt tests still passed, because they asserted presence
  (`toContain("health")`) rather than pairing. **Assert the pairing**
  (`toContain("You filed it under: health")`) in every prompt test from here.
