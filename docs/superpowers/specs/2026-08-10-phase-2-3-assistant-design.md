# Phase 2+3 — the assistant: enrichment, retrieval, and one input — design, 2026-08-10

**Supersedes the first draft of this file (`2e24415`), which specified enrichment alone.**
That draft was under-scoped in a way worth recording: it delivered auto-tagging but not the
domain and `domain_meta` extraction that `2026-08-01-life-domains-web-search-design.md` §2
had already committed to, and it assumed the capture UI stays a set of forms.

The target, ruled on 2026-08-10: **one input box.** You type. It saves instantly, offline,
always. When you are online it answers you, and it attaches domain, mood, media and tags
itself. This merges roadmap §13 rows 2 and 3, plus row 5's "you wrote about this before".

## 1. Delivery stages

The box is useless before the pipeline and retrieval exist beneath it, so the work is
staged and each stage is independently valuable. **You can stop after B without waste.**

| Stage | Contents | What becomes visible |
| --- | --- | --- |
| A | pg-boss, embed, extract (domain + `domain_meta` + tags), budget, `usage_ledger` | nothing yet |
| B | `search_notes()`, `POST /search`, search UI on both clients | search by meaning |
| C | The unified box: intent routing, RAG answers, streaming, citations, save-as-note | **the assistant** |
| D | Review surfaces: suggested chips for tag/domain/meta, accept/reject | the feedback loop closes |

Stage A is roughly two PRs (infrastructure, then the pipeline); B, C and D one or two each.
**This spec is the design for all four. The implementation plan is written per stage** —
A+B first, C+D once A+B has landed — because one plan covering 2.5 roadmap phases would be
unreviewable.

## 2. What already exists

Phase 0 laid nearly all of the schema, which is why the migration here is small. Confirmed
against `ab25e33`:

| Piece | Where |
| --- | --- |
| `note_chunks`, `extensions.vector(1536)`, HNSW cosine | `00002_content.sql`, retyped by `00012` |
| `notes.enriched_at`; `content_text` generated from `strip_markdown(content)` | `00002_content.sql:17` |
| `notes_fts_idx` — GIN `to_tsvector('english', content_text)`, the keyword arm | `00002_content.sql` |
| `notes.domain`, `notes.domain_meta` + per-domain zod schemas | `00013_life_domains.sql`, `packages/shared/src/dto/domains.ts` |
| `note_tags.source` / `.status` / `.confidence` | `00003_organization.sql:15-26`, on devices since `6ed69bc` |
| `feedback_events`, server-only, `subject_type` includes `'tag'` | `00005_memory_feedback.sql:39` |
| `usage_ledger`, server-only, `kind` includes `'embed'` and `'tag'` | `00007_integrations_ops.sql:30` |
| **`chat_sessions`, `chat_messages` — with `citations jsonb` and `retrieval_meta jsonb`** | `00006_synthesis_chat.sql:23,37` |
| `EMBEDDING_MODEL`, `EMBEDDING_DIM = 1536` | `packages/shared/src/enums.ts:60-61` |

Missing: pg-boss, any worker, any AI client, `search_notes()`, every endpoint, both UIs,
per-user budgets.

Two gaps found while writing this spec, both latent until now:

- **`notes.source_type` still holds only the original six values**
  (`00002_content.sql:9`). The life-domains spec §6.3 already requires `'web_search'` for
  saved answers, and no migration ever added it — phase 3 would have hit a check-constraint
  violation. This spec adds `'chat'`, `'assistant'` and `'web_search'` together.
  `packages/shared/src/enums.ts:8` documents the `noteSourceType ↔ notes.source_type_check`
  pairing, and `packages/db/src/test/enum-parity.test.ts` enforces it, so both sides move
  together or the suite fails.
- **No code in this repo has ever opened a direct Postgres connection**, and no
  service-role client exists — `createUserClient` is the only constructor, and the deployed
  Railway service holds only an anon key. §5 and §11 treat both as first-time exposures.

## 3. Decisions taken before design

Ruled by the human on 2026-08-10. Recorded so a later session does not reopen them.

1. **The enrich job is chunk → embed → extract.** Extract means domain suggestion,
   `domain_meta` fill, and tags — not tags alone. Link suggestion (phase 5) and task
   extraction (phase 6) stay out.
2. **Both clients get every surface.** Web and mobile.
3. **Tag vocabulary: prefer existing, at most one not-yet-existing tag per run.** A proposed
   new tag becomes real only on accept. Rejected: a closed vocabulary (the first note on a
   new topic gets nothing) and unconstrained proposal (which is how "pricing",
   "pricing-psychology" and "psychology-of-pricing" become three tags).
4. **Budget blocks enrichment, never search.** Enrichment is automatic and unbounded; search
   is bounded by a human typing. One figure per calendar month, summed per user from
   `usage_ledger`.
5. **A cron sweep wakes the worker, not an enqueue at write time.** §5.
6. **One input box does both capture and query**, replacing the separate quick-capture,
   check-in and media forms as the primary path.
7. **Intent is classified by the model when online; offline always captures.**
8. **Everything typed becomes a note, whatever the intent.** This is what makes 7 safe: a
   misclassification costs you an answer, never a thought. It is also a requirement in its
   own right — asking about MCP in August must be findable in September through
   "what was I researching last month".
9. **An assistant answer becomes a note only when you tap save.** Handled by provenance,
   not prohibition — see §9.
10. **One rolling conversation, no session management.** ~2000-token window, context resets
    after 4 hours of silence. Sessions are still created in the database, just not surfaced.

## 4. Architecture

One Railway service, one process. pg-boss starts inside the Nest bootstrap, per parent §9.

```
apps/api/src/
├── main.ts                    ← boss starts with the app
├── enrich/enrich.module.ts    ← registers the cron and the handler; wiring only
├── assistant.controller.ts    ← POST /assistant  (the box's one endpoint)
└── search.controller.ts       ← POST /search

packages/core/src/enrich/
├── embed.ts                   ← chunk, embed only what changed, stamp embedded_hash
├── extract.ts                 ← intent + domain + domain_meta + tags, one schema
└── budget.ts                  ← usage_ledger rollup, pricing, and the tier guard

packages/core/src/assistant/
├── router.ts                  ← what to do with a classified input
├── answer.ts                  ← retrieval → prompt → streamed answer + citations
└── context.ts                 ← the rolling window and the 4-hour reset

packages/core/src/ai/
├── client.ts                  ← interface: embed, generateJson, generateStream
└── gemini.ts                  ← the real implementation; tests always use a fake

packages/shared/src/enrich/chunk.ts   ← pure, dependency-free, no Docker to test
```

Logic in `packages/core`, wiring in `apps/api`. Phase 1b established the reason concretely:
code left in a file the test runner cannot import is code that does not get tested (Tasks 18
and 20 of `docs/superpowers/plans/2026-08-03-phase-1b-HANDOFF.md`).

## 5. What wakes the worker

**A cron sweep every 60 seconds, claiming from one SQL predicate. No controller calls
`boss.send`.**

Parent §9's alternative — enqueue at commit time with a 90-second `startAfter` — was
rejected because it needs a hook on every write path, and notes arrive by two today
(`POST /notes`, `POST /sync/upload`) with four more in phase 4. Missing the second write path
is the exact failure phase 1b hit three times: trash-as-PATCH (`9f7088d`), the check-in
resurrection (`445139d`), and the closeout's sharpest finding, where a fix landed on the
`DELETE` branch for a case mobile barely uses and missed the `PATCH` branch it actually takes
(`867d3b1`). A sweep cannot miss a write path: its source of truth is the `notes` table, not
a controller remembering to call something.

```sql
where n.deleted_at is null
  and n.updated_at < now() - interval '90 seconds'          -- debounce
  and coalesce(e.attempts, 0) < 5                            -- a poison note stops
  and (e.embedded_hash is distinct from md5(n.content_text)
    or e.extracted_hash is distinct from md5(n.content_text))
```

**The leading risk, and why it is task 1.** pg-boss needs a `pg` connection this repo has
never opened, and `docs/deploy.md:924` records the trap: "if the connection test fails while
resolving the address rather than authenticating, that is the Supabase direct-connection
networking issue". That is the class that let `00012` and `00016` pass locally and fail only
against the hosted project. Two facts reduce it: `supabase/.temp/pooler-url` names the
Supavisor pooler at **port 5432**, which is session mode — what pg-boss needs, and IPv4 —
and the hosted string is already set as a Railway variable while `apps/api/.env` points at
the local stack on 54322. **Task 1 proves the connection rather than building a feature.** If
session mode is refused, the fallback is a claim sweep through a PostgREST RPC, discovered on
day one instead of week three.

## 6. The box

One endpoint, `POST /assistant`. The client's obligations are ordered, and the order is the
design:

1. **Write locally first, and never wait for the network.** Sub-second, offline-safe. This is
   phase 1b's guarantee and nothing here is allowed to weaken it.
2. **If online, send the text up.** One Flash call with a `responseSchema` returns intent,
   domain, `domain_meta` and tags together — one call, not four.
3. **Respond, always.**
   - *Question* → retrieve, answer with citations, stream it back.
   - *Statement* → acknowledge with what was just attached, plus related notes. That
     acknowledgement is roadmap row 5's "you wrote about this before", and it is what makes
     the thing feel like an assistant rather than an inbox.
4. **Offline** → the note is saved and the UI says plainly that there is no answer while
   offline. Answers are not backfilled: a reply to a question asked two days ago is noise.

**Every input becomes a note**, question or not, with `source_type='chat'` for questions.
They are filtered out of the inbox so they never demand triage, and they stay first-class in
search — which is what makes "what was I researching last month" work through
`search_notes()` with no second store and no separate embedding path.

**This is where the two-hash design pays off.** The box runs the *extract* step
synchronously, because its result is on screen in the reply. The *embed* step stays with the
sweep, because nobody should wait on it. Each side stamps its own hash, so the sweep skips
work the box already did and picks up everything the box never saw — mobile offline captures,
and every phase-4 channel. The "cannot miss a write path" property is intact.

## 7. Data model

Migration `00018_assistant.sql`. It does not alter the `notes` table's columns, does not
touch the sync rules, and needs no PowerSync redeploy. It does widen one check constraint.

### 7.1 The sweep predicate keys on a content hash, not on timestamps

The obvious predicate is `enriched_at < updated_at`. It is wrong twice, and both faults cost
money. `notes` carries `notes_set_updated_at`, a `moddatetime` trigger firing on **every**
UPDATE (`00002_content.sql`, cited by name rather than line so it cannot rot). Therefore:

1. Writing `enriched_at` pushes `updated_at` forward and re-satisfies the predicate — a
   self-feeding loop re-enriching every note every sweep, forever.
2. Pinning a note, archiving it, or accepting a tag each push `updated_at` without changing a
   character — and each would bill a full re-embed plus a model call.

`md5(content_text)` is immune to both, and closes the loop by construction rather than by two
clocks happening to agree. It also makes an edit arriving *during* enrichment safe: each step
records the hash of the content it actually read, so a note edited mid-job ends with a
recorded hash that no longer matches, and the next sweep takes it. A timestamp predicate
writing `now()` would have marked that edit as already done and silently dropped it.

### 7.2 Bookkeeping must not live on `notes`

`notes` is client-**writable**: PowerSync uploads PATCHes and the sync router's generic writer
upserts `{...op.data, id, user_id}`. A modified client could PATCH a hash column and pin its
own note out of the pipeline forever, or into it forever. That is the shape of phase 1b's
round-2 finding #1, which `00017_child_row_owner_fk.sql` exists to close.

```sql
create table public.note_enrichment (          -- SERVER-ONLY
  note_id uuid primary key references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  embedded_hash   text,   -- md5(content_text) at the last successful embed  (sweep)
  extracted_hash  text,   -- same, for intent/domain/meta/tags              (box or sweep)
  attempts int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
```

RLS on, no policies, no grant to `authenticated` — matching `note_chunks`.
`notes.enriched_at` keeps the role parent §8.2 assigned it: the client-visible "pending
enrichment" flag, and the only thing about enrichment a device ever sees.

### 7.3 `source_type` gains three values

`'chat'` (a question you typed), `'assistant'` (an answer you chose to save), `'web_search'`
(an answer with web citations you chose to save — required by the life-domains spec §6.3 and
never added). The constraint, `packages/shared/src/enums.ts` and
`packages/db/src/test/enum-parity.test.ts` move together.

### 7.4 `feedback_events` is written by a trigger

Accepting a suggestion happens on at least three paths: web writes `note_tags` directly
through supabase-js (`apps/web/src/app/notes/[id]/page.tsx:24` reads it that way;
`packages/core/src/organize/service.ts:63,76` writes it), mobile writes locally and uploads
through `POST /sync/upload`, and phase 9 adds MCP. If the client owns the write, any path
that forgets loses the signal permanently — and the parent spec wants it accumulating **from
day one** so phase 8 starts with months of it.

An `after update on note_tags` trigger firing on `suggested → accepted|rejected` cannot be
bypassed, and keeps `feedback_events` genuinely server-only (clients hold no DML grant,
`00005`). This does not contradict parent §9's "why not DB-trigger-driven", which is about
where job *enqueueing* lives; deriving an audit row from a status transition is bookkeeping,
the same category as `moddatetime` itself.

Consequence: **mobile suggestion review works offline.** It is a local UPDATE riding sync like
everything else, and the trigger fires when the router writes it down.

### 7.5 The server-only table list is hoisted

Two hand-maintained copies exist: `packages/db/src/test/sync-rules-isolation.test.ts:196-206`
and `packages/sync/src/schema.test.ts:12-18`, seven identical names each. `note_enrichment`
must appear in both or the new server-only table is unguarded by precisely the tests written
to guard it. A hand-written parallel list is what phase 1b's Task 22 found and fixed, so this
phase hoists the list into `@cortex/shared` beside `SYNC_TABLES` and points both tests at one
copy. The `sync-rules.yaml` header comment, which names the server-only tables because "absent
by omission is load-bearing", gains it too.

## 8. Retrieval

One SQL function, shared by the API, the assistant, and (phase 9) MCP, as parent §6.8
requires:

`search_notes(p_user_id uuid, p_query text, p_embedding vector(1536), p_limit int)` —
pgvector cosine top-40 over `note_chunks`, Postgres FTS top-40 over `notes.content_text`,
combined by Reciprocal Rank Fusion, then multiplied and deduplicated by note.

**Two multipliers, and the second one is built in stage B even though nothing uses it yet:**

- recency, `exp(-age_days/180)`
- **source provenance, ~0.8 for externally-sourced notes** — `web_search` and `assistant`
  only. A `chat` note is a question *you* typed, so it is your own words and carries no
  penalty; that is what keeps "what was I researching last month" ranking properly.

The provenance multiplier is the life-domains spec §6.3 mechanism. Building the hook in stage
B costs almost nothing; retrofitting it in stage C means rewriting the function that stages B,
C and phase 9 all depend on.

**The user id comes from the verified JWT and never from the request body.** `note_chunks` has
RLS enabled with no policies, so it is unreadable by `authenticated` by design and the search
necessarily runs as `service_role`, which bypasses RLS entirely. That parameter is then the
only thing separating two users' corpora, and it gets what parent §15.5 gives sync rules: its
own isolation test, with real rows belonging to the other user.

Search is submit-driven. Every query costs an embedding call.

## 9. The assistant

**Conversation context: one rolling thread.** A ~2000-token window of recent turns, whole
turns only, newest first — a token budget rather than a turn count, because one turn may be a
word and the next a pasted page. Context resets after **4 hours of silence**; an idle gap
rather than a calendar boundary, so someone writing at 1am is not cut mid-thought.

**Reset clears the prompt context, never data.** Every turn stays in `chat_messages`,
scrollable and searchable. A new `chat_sessions` row is created at each reset, so the database
is already multi-session — surfacing a session list later is pure UI, no migration. Chat is
**not** in the sync rules, so scrolling the thread on mobile is online-only; adding it would
cost publication, device schema, isolation tests and a PowerSync redeploy, and is deliberately
deferred.

**Provenance, not prohibition.** Assistant answers are never auto-saved — that is what breaks
the loop where a model retrieves text it wrote and treats it as your thinking. But a "save as
note" action is first-class, not a footnote: one tap creates a real, editable note in your
inbox, and you develop it from there. Its provenance is recorded in `source_type`, it is
down-weighted ~0.8 in retrieval, the note list gains a filter chip, and the assistant cites it
as "something you saved", never as your own words. The corpus is what you kept; the thread is
what was said.

**Answering never invents.** System-prompt policy, per life-domains §6.1: answer from the
user's notes first; say so when the notes cannot answer; never present outside content as the
user's own thinking. Web grounding (`google_search`) and the Search-Suggestions UI that
Google's terms require are phase-3 scope inside stage C.

## 10. Models

Life-domains spec §1 assigns the workloads. **Its names are model families, not API ids**, and
the current lineup differs — recorded here so implementation does not paste a name that does
not resolve:

| Workload | Spec says | Stage | Actual id |
| --- | --- | --- | --- |
| Embeddings | `gemini-embedding-001` @ 1536 | A | unchanged, still current |
| Classification: intent, domain, meta, tags | "Gemini 3 Flash" | A, C | `gemini-3.5-flash-lite` — docs describe it as the economical variant for high-volume execution |
| Reasoning: answering | "Gemini 3 Pro" | C | pinned at stage C against docs current then |

Ids and prices live as constants in `@cortex/shared` beside `EMBEDDING_MODEL`, and
`usage_ledger` records the model per row, so a price change edits a constant without
rewriting history.

## 11. Security

1. **`service_role` enters the codebase**, bypassing RLS. Confined to the enrichment pipeline
   and the search RPC; every user-facing path keeps `createUserClient` with RLS as the
   enforcement, per parent §8.2.
2. **A paid Gemini tier is required** (parent §15.6 rule 2). Google's terms confirm the
   distinction is current: free-tier content is used to "provide, improve, and develop Google
   products", human reviewers may read inputs and outputs, and the terms themselves say not to
   submit sensitive or personal information to the unpaid services. Cortex carries mood,
   health and finance notes. Made **enforceable rather than documented**: `GEMINI_TIER` is
   validated at boot, and the sweep refuses to claim anything when the tier is `free` and
   `SUPABASE_URL` is not local — leaving free keys usable for local development against
   seeded data, where they are legitimate.
3. **Split-brain configuration is rejected at boot.** `DATABASE_URL` and `SUPABASE_URL` must
   resolve to the same database. Found on 2026-08-10 in `apps/api/.env`, where they did not:
   notes would have been read from the local stack while pg-boss created its `pgboss` schema
   inside the production database and shared one queue between dev and production. Both are
   now correct, and the assertion keeps them so.

## 12. Error handling

| Condition | Behaviour |
| --- | --- |
| Gemini 429 / 5xx during the sweep | pg-boss retries with backoff; `attempts` increments |
| Gemini fails on the box's synchronous call | The note is already saved. The reply degrades to a plain acknowledgement; the sweep picks the extract step up later |
| Malformed structured output | Treated as a failed step; no partial tags or meta are ever written |
| `attempts` reaches 5 | `last_error` recorded, the note leaves the sweep's predicate |
| Note trashed mid-job | The job writes nothing that resurrects it — the guard phase 1b added twice (`e59c91b`, `1583d69`) |
| Budget exceeded | The sweep claims nothing and **logs that it did** — silent permanent stoppage is indistinguishable from a bug |

**Inherited, not introduced:** mobile's suggestion review rides `POST /sync/upload`, and an op
the server rejects inside a 200 is still logged and lost
(`apps/mobile/src/lib/connector.ts:139-147`). That is phase 1b's one remaining open item;
this phase neither worsens nor fixes it.

## 13. Testing

| Unit | Where | The assertion that matters |
| --- | --- | --- |
| Chunker | `packages/shared`, no Docker | Deterministic boundaries |
| AI client | fake everywhere | Plus a test proving CI never reaches the real API |
| `claim_notes_for_enrichment` | `packages/db` | **A note that was only pinned is not claimed** — the cost regression |
| Feedback trigger | `packages/db` | Both transitions, and via a direct PostgREST update as the user, proving no path bypasses it |
| `search_notes` | `packages/db` | Cross-user isolation **with real rows for the other user** — parent §15.5 and issue-log E3: "bob reads zero rows" stays green with the policy deleted if alice has none either |
| Provenance multiplier | `packages/db` | A saved answer ranks below an own note of equal relevance |
| Pipeline | `packages/core`, fake AI + real Supabase | Unchanged chunk keeps its embedding; a shortened note drops extra chunks; a failed extract leaves the embed committed; a second run is a no-op |
| Box routing | `packages/core` | Offline captures without a network call; a misclassified question is still stored as a note |
| Context window | `packages/core` | The 4-hour gap opens a new session; the window never exceeds its token budget |
| Budget + tier guard | unit + integration | The sweep claims nothing when over; `free` + non-local `SUPABASE_URL` refuses |

**Every new suite is named in `ci.yml` by the task that creates it.** The `checks` job filters
per package, so an unnamed suite runs on no runner at all.

## 14. Human prerequisites

- [x] `DATABASE_URL` set as a Railway variable, pointed at the local stack in `apps/api/.env`
- [x] `GEMINI_API_KEY` on the **paid** tier
- [x] Docker Desktop running
- [ ] Remaining Railway variables at stage A's deploy: `SUPABASE_SERVICE_ROLE_KEY`,
      `GEMINI_API_KEY`, `GEMINI_TIER`, `ENRICH_MONTHLY_BUDGET_USD`. Railway currently holds
      neither a service-role key nor a Gemini key.

## 15. Out of scope

Link suggestion (phase 5), task extraction (phase 6), cross-note tag suppression and few-shot
exemplars (phase 8), digests (phase 7), re-embedding drifted chunks and the dead-letter
dashboard (phase 10), per-user budget rows (one configured limit, applied per user because
`usage_ledger` is already per user), a chat session list, and chat sync to devices.

The mood and media widgets are **not deleted**. The box becomes the primary and sufficient
path, and the extractor can propose a check-in from "hôm nay mệt quá". But the life-domains
spec §3 recorded why those two are widgets — "friction kills mood logging; Daylio's entire
moat is two taps and no blank page", and media needs an entity link and a rating that free
text does not reliably yield — and those reasons survive. They stay as accelerators. Deciding
their final placement is a stage-C UI task, not a data-model question.
