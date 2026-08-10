# Phase 2 — AI enrichment v1 — design, 2026-08-10

Roadmap §13 row 2: `pg-boss` + `note.enrich` (chunk/embed via Gemini), auto-tag suggestions
with `feedback_events` from day one, hybrid semantic search, usage ledger. The demo is one
sentence: type "that idea about pricing psychology" and find the note that never says
"pricing psychology".

Four PRs, because the first one carries a risk the other three depend on and nothing else
should be blocked behind discovering it late:

| PR | Contents | Deploy? |
| --- | --- | --- |
| 1 | pg-boss connection proof, env + guards, service-role client, migration `00018`, server-only list hoist | **yes** — new Railway variables |
| 2 | Pipeline: chunker, AI client, embed + tag steps, budget, `usage_ledger` | no |
| 3 | Search: `search_notes()`, `POST /search`, web + mobile UI | no |
| 4 | Tag review UI: web + mobile | no |

## What already exists

Phase 0 laid almost the entire schema for this phase, which is why the migration here is
small. Confirmed against the tree at `ab25e33`:

| Piece | Where |
| --- | --- |
| `note_chunks`, `extensions.vector(1536)`, HNSW cosine index | `00002_content.sql`, retyped by `00012_embedding_dims_gemini.sql` |
| `notes.enriched_at`; `notes.content_text` generated from `strip_markdown(content)` | `00002_content.sql:17` |
| `notes_fts_idx` — GIN `to_tsvector('english', content_text)`, the keyword arm of hybrid search | `00002_content.sql` |
| `note_tags.source` / `.status` / `.confidence` — exactly the auto-tag shape | `00003_organization.sql:15-26`, synced to devices since phase 1b `6ed69bc` |
| `feedback_events`, server-only, `subject_type` already includes `'tag'` | `00005_memory_feedback.sql:39` |
| `usage_ledger`, server-only, `kind` already includes `'embed'` and `'tag'` | `00007_integrations_ops.sql:30` |
| `EMBEDDING_MODEL = "gemini-embedding-001"`, `EMBEDDING_DIM = 1536` | `packages/shared/src/enums.ts:60-61` |

Missing entirely: pg-boss, any worker, any AI client, `search_notes()`, the search and
tag-review endpoints, both UIs, and per-user budgets.

**No code in this repo has ever opened a direct Postgres connection.** `packages/core`,
`apps/api` and even `packages/db`'s tests reach Postgres only through PostgREST. That is
why `00012` had to add the `_test_column_vector_dim` SECURITY DEFINER helper — through
PostgREST a column's declared vector dimension is "otherwise unobservable". pg-boss changes
this, and §3 treats it as the phase's leading risk.

**No service-role client exists either.** `createUserClient` is the only constructor in
`packages/core/src/supabase.ts`, and the deployed Railway service holds only an anon key.
Phase 2 introduces the first code path that bypasses RLS.

## Scope decisions taken before design

Ruled by the human on 2026-08-10, recorded so a later session does not reopen them.

1. **`note.enrich` is chunk → embed → auto-tag, and stops there.** §9's table also lists
   link suggestion and task extraction, but roadmap §13 places those in phases 5 and 6.
   Link suggestion wants an already-embedded corpus, so it belongs after this phase rather
   than being cut from it.
2. **Both clients get both surfaces.** Web and mobile each get tag review and semantic
   search. Mobile is the daily driver, and `note_tags` already carries
   `source`/`status`/`confidence` to the device.
3. **Tag vocabulary: prefer existing, at most one new tag per note.** The prompt receives
   the user's current tag list and must reuse a match. A proposed new tag becomes real only
   when the user accepts it. Rejected alternatives: a closed vocabulary (the first note on
   any new topic gets nothing, and the user must seed by hand) and unconstrained proposal
   (which is how "pricing", "pricing-psychology" and "psychology-of-pricing" become three
   tags).
4. **Budget blocks enrichment, never search.** Enrichment is automatic and unbounded;
   search is bounded by a human typing. Blocking search to save a few cents removes a
   feature for no meaningful saving. The limit is one figure per calendar month, summed per
   user from `usage_ledger`.

## 1. Architecture

One Railway service, one process. pg-boss starts inside the Nest bootstrap, per §9's
"workers run inside the NestJS process". No second service, no second image.

```
apps/api/src/
├── main.ts                    ← boss starts with the app
├── enrich/enrich.module.ts    ← registers the cron and the handler; wiring only
└── search.controller.ts       ← POST /search

packages/core/src/enrich/
├── pipeline.ts                ← orchestrator: the embed step, the tag step
├── tagger.ts                  ← prompt construction, parsing, note_tags upsert
└── budget.ts                  ← usage_ledger rollup and the gate

packages/core/src/ai/
├── client.ts                  ← interface: embed(texts), generateJson(prompt, schema)
└── gemini.ts                  ← the real implementation; tests always use a fake

packages/shared/src/enrich/chunk.ts   ← pure, dependency-free, no Docker to test
```

The `packages/core` / `apps/api` boundary is the phase 1b one: logic in core, wiring in
api. The reason is concrete rather than aesthetic — phase 1b established that code left in
a file the test runner cannot import is code that does not get tested
(`docs/superpowers/plans/2026-08-03-phase-1b-HANDOFF.md`, Task 18 and Task 20).

Keeping the embedding client behind an interface is the parent spec's own instruction
(§4 item 1, "so you can swap").

## 2. What wakes the worker

**A cron sweep, not an enqueue at write time.** Every 60 seconds a scheduled job claims
eligible notes from one SQL predicate. Nothing in any controller calls `boss.send`.

The alternative — §9's `boss.send('note.enrich', …)` at commit time with a 90-second
`startAfter` — gives a steadier latency and was rejected for one reason: it requires a hook
on **every** write path, and notes arrive by two (`POST /notes` for web, `POST /sync/upload`
for mobile) with more to come in phase 4. Missing the second write path is the single
failure shape phase 1b hit repeatedly: the trash-as-PATCH bug (`9f7088d`), the check-in
resurrection (`445139d`), and the closeout's sharpest finding, where a fix landed on the
`DELETE` branch for a case mobile barely uses and missed the `PATCH` branch it actually
takes (`867d3b1`). A sweep cannot miss a write path, because its source of truth is the
`notes` table rather than a controller remembering to call something.

Cost: mean latency rises from ~90s to ~120s. The parent spec's own target is "tag
suggestions appearing ~2 min after you stop typing", so this is inside the budget it set.

## 3. The leading risk, and why it is task 1

pg-boss needs a `pg` connection. This repo has never opened one, and Supabase's direct host
`db.<ref>.supabase.co` is exactly the connection `docs/deploy.md:924` warns about: "if the
connection test fails while resolving the address rather than authenticating, that is the
Supabase direct-connection networking issue". This is the failure class that let `00012` and
`00016` pass locally and fail only against the hosted project.

Two facts reduce the risk considerably, both established on 2026-08-10:

- `supabase/.temp/pooler-url` already names the Supavisor pooler at
  `aws-0-ap-southeast-1.pooler.supabase.com` **port 5432**, which is session mode — what
  pg-boss needs, and IPv4-reachable. Transaction mode on 6543 is not usable: pg-boss relies
  on session state and advisory locks.
- The hosted connection string is set as a Railway variable (`DATABASE_URL`), and
  `apps/api/.env` points at the local stack's Postgres on 54322.

**Task 1 of the plan is therefore to prove the connection, not to build a feature**: bring
up pg-boss against the session pooler, confirm it creates its `pgboss` schema, and round-trip
one job — first locally, then from Railway. If session mode is refused, the architecture
falls back to a claim sweep driven through a PostgREST RPC (no new connection type at all,
at the cost of hand-rolled retry and backoff), and that is discovered on day one rather than
in week three.

## 4. Data model

Migration `00018_enrichment.sql`. It does not alter the `notes` table, does not touch the
sync rules, and does not require a PowerSync redeploy.

### 4.1 The sweep predicate keys on a content hash, not on timestamps

The obvious predicate is `enriched_at < updated_at`. It is wrong twice, and both faults cost
real money.

`notes` carries `notes_set_updated_at`, a `moddatetime` trigger that fires on **every**
UPDATE (`00002_content.sql`, the trigger immediately below the `notes` DDL — cited by name
rather than by line so it cannot rot). Therefore:

1. Writing `enriched_at` pushes `updated_at` forward, which re-satisfies the predicate. That
   is a self-feeding loop re-enriching every note every sweep, forever.
2. Pinning a note, archiving it, or accepting a tag all push `updated_at` without changing a
   character of content — and each would trigger a full re-embed plus an LLM call.

`md5(content_text)` is immune to both. It closes the loop by construction rather than by two
clocks happening to agree, and it makes "the content changed" mean exactly that.

It is also what makes an edit arriving *during* enrichment safe. The steps record the hash of
the content they actually read, so a note edited mid-job ends with a recorded hash that no
longer matches the current text, and the next sweep picks it up. A timestamp predicate
writing `now()` would have marked that edit as already enriched and silently dropped it.

### 4.2 Enrichment bookkeeping must not live on `notes`

`notes` is client-**writable**: PowerSync uploads PATCHes against it and the sync router's
generic writer upserts `{...op.data, id, user_id}`. A modified client could PATCH a hash
column and make its own note skip enrichment forever, or re-enrich forever. That is the
shape of phase 1b's round-2 finding #1 (client-chosen values on client-writable tables),
which `00017_child_row_owner_fk.sql` exists to close.

So the bookkeeping goes in a server-only table:

```sql
create table public.note_enrichment (
  note_id uuid primary key references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  embedded_hash text,      -- md5(content_text) at the last successful embed
  tagged_hash   text,      -- same, for the tag step: two independently idempotent steps
  attempts int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
```

RLS enabled with no policies and no grant to `authenticated`, matching `note_chunks`.

`notes.enriched_at` keeps the role §8.2 assigned it — the client-visible "pending enrichment"
flag — and remains the only thing about enrichment a device ever sees. It already exists and
already flows through `SELECT * FROM notes`, so no sync-rule change is needed.

### 4.3 `feedback_events` is written by a trigger, not by any client

Accepting a tag happens on at least three paths: web writes `note_tags` directly through
supabase-js (`apps/web/src/app/notes/[id]/page.tsx:24` already reads it that way, and
`packages/core/src/organize/service.ts:63,76` writes it), mobile writes locally and uploads
through `POST /sync/upload`, and phase 9 adds MCP. If the client is responsible for writing
the feedback event, any path that forgets loses the signal permanently — and the parent spec
wants this signal accumulating **from day one** so phase 8 starts with months of it
(§13, dependencies note).

An `after update on note_tags` trigger firing on `suggested → accepted|rejected` cannot be
bypassed by any path, and it keeps `feedback_events` genuinely server-only: clients hold no
DML grant on it (`00005_memory_feedback.sql`, Data API grants).

This does not contradict §9's "why not DB-trigger-driven". That paragraph is about where job
*enqueueing* lives. Deriving an audit row from a status transition is bookkeeping, the same
category as `moddatetime` itself.

Consequence worth stating: **mobile tag review works offline.** It is a local UPDATE that
rides sync like everything else, and the trigger fires when the router writes it down.

### 4.4 The server-only table list is hoisted

Two hand-maintained copies of the server-only table list exist:
`packages/db/src/test/sync-rules-isolation.test.ts:196-206` and
`packages/sync/src/schema.test.ts:12-18`, seven identical names each. `note_enrichment` must
appear in both, or the new server-only table is unguarded by precisely the tests written to
guard it.

A hand-written parallel list is what phase 1b's Task 22 found and fixed — a duplicated status
list written directly beneath the comment warning against duplicating it. Phase 2 is the
first phase to add a server-only table since these lists were written, so it hoists them into
`@cortex/shared` next to `SYNC_TABLES` and points both tests at the single copy.

The header comment in `packages/sync/src/sync-rules.yaml` names the server-only tables
explicitly, because "server-only tables are absent by omission, which is load-bearing".
`note_enrichment` is added to that sentence.

## 5. The pipeline

`claim_notes_for_enrichment(p_limit int)` — SECURITY DEFINER, `for update skip locked`:

```sql
where n.deleted_at is null
  and n.updated_at < now() - interval '90 seconds'          -- debounce
  and coalesce(e.attempts, 0) < 5                            -- a poison note stops
  and (e.embedded_hash is distinct from md5(n.content_text)
    or e.tagged_hash   is distinct from md5(n.content_text))
```

Debouncing is a consequence of the predicate rather than a separate mechanism.

**Embed step.** Chunk `content_text` → compare each chunk's `content_hash` against the
existing `note_chunks` rows → embed only new or changed chunks, so editing paragraph three
does not re-embed one, two and four → delete chunks whose index is beyond the new count →
write `usage_ledger(kind='embed')` → set `embedded_hash`. Commit.

**Tag step.** Read the user's existing tags → one call with a structured-output schema →
upsert `note_tags(source='ai', status='suggested', confidence)`, at most one **not-yet-existing
tag per run** → write `usage_ledger(kind='tag')` → set `tagged_hash` and `notes.enriched_at`.

The two steps commit independently on purpose. If tagging fails, the embedding work is
already durable and the next sweep re-runs only the step that is still missing. This is the
concrete shape of §9's "per-step idempotency".

**Chunking** splits on blank lines and greedily packs paragraphs up to a character budget,
never splitting mid-paragraph unless a single paragraph exceeds it. Deterministic, pure, and
testable without a tokenizer dependency. Most quick-capture notes produce one chunk.

**Case-insensitive tag reuse.** When the model returns a name that matches an existing tag
under a different casing, the existing tag id is reused rather than a near-duplicate created.
This is the `findOrCreate` precedent already in the repo — phase 1b's media check, "log a
film that already exists in the library under different casing → one media item".

**Model ids and prices** are pinned as constants in `@cortex/shared` beside `EMBEDDING_MODEL`,
and `usage_ledger` records the model with each row so a later price change edits a constant
without rewriting history. The exact ids are confirmed against current Gemini documentation
during implementation rather than asserted here.

## 6. Search

One SQL function, shared by the API and (phase 9) MCP, as §6.8 requires:

`search_notes(p_user_id uuid, p_query text, p_embedding vector(1536), p_limit int)` —
pgvector cosine top-40 over `note_chunks`, Postgres FTS top-40 over `notes.content_text`,
combined by Reciprocal Rank Fusion, multiplied by a recency factor `exp(-age_days/180)`,
deduplicated by note.

`POST /search` embeds the query, then calls the function with the service-role client.

**The user id comes from the verified JWT and never from the request body.** `note_chunks`
has RLS enabled with no policies, so it is unreadable by `authenticated` by design; the
search necessarily runs as `service_role`, which bypasses RLS entirely. That parameter is
then the only thing separating two users' corpora, and it gets the same treatment §15.5
gives sync rules: its own isolation test, with real rows belonging to the other user.

Search is submit-driven, not search-as-you-type: every query costs an embedding call.

## 7. Surfaces

**Tag review.** Tags with `source='ai'` and `status='suggested'` render as pending chips with
their confidence. Accept sets `accepted`; reject sets `rejected` and **does not delete the
row** — the persisted rejection is what stops the tag being suggested again, because the
tagger excludes every tag already attached to the note in any status. Cross-note suppression
keyed on topic embedding (§10.4) is phase 8's job and is deliberately not built here.

**Semantic search.** Web gets a search box. Mobile keeps its local FTS5 index (phase 1b Task
19) as the instant and offline path, and adds a "search by meaning" action that calls the API
when online; offline it says plainly that only local search is available.

**Pending enrichment.** A null `notes.enriched_at` renders as a subtle processing state. The
column already syncs.

## 8. Security

Three new exposures, each with its own control:

1. **`service_role` enters the codebase.** It bypasses RLS. It is confined to the enrichment
   pipeline and the search RPC; every existing user-facing path keeps `createUserClient` and
   keeps RLS as the enforcement, per §8.2.
2. **A paid Gemini tier is a hard requirement**, §15.6 rule 2. Google's API terms confirm the
   distinction is current: free-tier content is used to "provide, improve, and develop Google
   products", human reviewers may read inputs and outputs, and the terms themselves say not to
   submit sensitive or personal information to the unpaid services. Cortex carries mood,
   health and finance notes.

   This is made **enforceable rather than documented**: `GEMINI_TIER=free|paid` is validated
   at boot, and the sweep refuses to claim anything when the tier is `free` and `SUPABASE_URL`
   is not local. Free-tier keys stay usable for local development against seeded data, which
   is where they are legitimate.
3. **A split-brain configuration is rejected at boot.** `DATABASE_URL` and `SUPABASE_URL`
   must resolve to the same database. Found on 2026-08-10 in `apps/api/.env`, where they did
   not: notes would have been read from the local stack while pg-boss created its `pgboss`
   schema inside the production database and shared one queue between dev and production.
   Both are now correct, and the boot assertion keeps them that way.

## 9. Error handling

| Condition | Behaviour |
| --- | --- |
| Gemini 429 / 5xx | pg-boss retries with backoff; `attempts` increments |
| Malformed structured output | Treated as a failed tag step; no partial tags are ever written |
| `attempts` reaches 5 | `last_error` recorded, the note leaves the sweep's predicate |
| Note trashed mid-job | The job writes nothing that resurrects it — the guard phase 1b added twice (`e59c91b`, `1583d69`) |
| Budget exceeded | The sweep claims nothing, and **logs that it did so** — silent permanent stoppage is indistinguishable from a bug |

**Inherited, not introduced:** mobile's tag accept rides `POST /sync/upload`, and an op the
server rejects inside a 200 is still logged and lost (`apps/mobile/src/lib/connector.ts:139-147`).
That is phase 1b's one remaining open item; phase 2 does not worsen it and does not fix it.

## 10. Testing

| Unit | Where | The assertion that matters |
| --- | --- | --- |
| Chunker | `packages/shared`, no Docker | Pure function, deterministic boundaries |
| AI client | fake everywhere | Plus a test proving CI never reaches the real API |
| `claim_notes_for_enrichment` | `packages/db` via PostgREST | **A note that was only pinned is not claimed** — the cost regression |
| Feedback trigger | `packages/db` | Both transitions, and via a direct PostgREST update as the user, proving no path bypasses it |
| `search_notes` | `packages/db` | Cross-user isolation **with real rows for the other user** — §15.5 and issue-log E3: "bob reads zero rows" stays green with the policy deleted if alice has none either |
| Pipeline | `packages/core`, fake AI + real Supabase | Unchanged chunk keeps its embedding; a shortened note drops extra chunks; a failed tag step leaves the embed committed; a second run is a no-op |
| Budget | unit + integration | Rollup arithmetic, and the sweep claiming nothing when over |
| Tier guard | unit | `free` + non-local `SUPABASE_URL` refuses |

**Every new suite is named in `ci.yml` by the task that creates it.** The `checks` job
filters per package, so an unnamed suite runs on no runner at all.

## 11. Human prerequisites

All discharged on 2026-08-10 except the last:

- [x] Postgres password, `DATABASE_URL` set as a Railway variable and pointed at the local
      stack in `apps/api/.env`
- [x] `GEMINI_API_KEY` on the **paid** tier, in `apps/api/.env`
- [x] Docker Desktop running
- [ ] The remaining Railway variables at PR 1's deploy: `SUPABASE_SERVICE_ROLE_KEY`,
      `GEMINI_API_KEY`, `GEMINI_TIER`, `ENRICH_MONTHLY_BUDGET_USD`. Railway currently holds
      neither a service-role key nor a Gemini key.

## 12. Out of scope

Link suggestion and task extraction (phases 5 and 6), cross-note tag suppression and few-shot
exemplars (phase 8), digests (phase 7), re-embedding drifted chunks and the dead-letter
dashboard (`maintenance` cron, phase 10), and per-user budget rows — phase 2 uses one
configured limit, applied per user because `usage_ledger` is already per user.
