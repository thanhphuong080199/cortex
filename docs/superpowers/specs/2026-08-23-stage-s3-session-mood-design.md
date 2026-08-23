# Stage S3: mood synthesised per chat session

Status: designed 2026-08-23, not yet implemented.

The first of the three stages `2026-08-22-chat-only-shell-design.md` §10 left as decisions. The
order agreed there was S3 → S2 → S4, and it holds: S3 touches no prompt, no client and no
existing write path.

## Problem

`2026-08-22` §10's framing: gather the data first and decide how to use it later, so that months
of history exist by the time the question is asked. A scheduled job summarises a chat session
that has gone idle into a mood reading.

### What §10 got wrong, and why the framing changes

§10 justifies the separate table by saying a job writing `checkins` "would manufacture mood
history the user never reported". **Inferred mood is not new, and the user does not report it.**
`packages/core/src/assistant/turn.ts:226` already writes a check-in every time `extractNote`
reads a mood out of a message, with `createdAt` set to the note's timestamp rather than `now()`.

The comment that actually guards this sits at `turn.ts:223-225`, and it says something narrower:

> Written by the TURN, not by extractNote, and the distinction matters: the 60-second sweep runs
> extractNote too, and a sweep that wrote check-ins would manufacture mood history for old notes
> at arbitrary times, **with no screen to undo it on**.

The constraint is about **timing and undo**, not about who did the inferring. The turn writes
while the user is looking at the screen, and yields a `mood` event so the UI can show it. A job
writes whenever, for whatever, unseen.

That is still a binding constraint on S3 — it just means something more specific than §10 said,
and S3 inherits it as: *this job's output must never enter a table the turn also writes.*

## Current architecture (verified against `942d910`, 2026-08-23)

- **There is no `chat_sessions` table.** `session_id` is a column on `chat_messages`, derived by
  `resolveCurrentSession` (`packages/shared/src/assistant/session.ts:31`) against
  `SESSION_IDLE_RESET_MS = 4 * 60 * 60 * 1000` (`session.ts:5`). When the newest message is older
  than that, the function returns `null` and the caller mints a fresh uuid.
- **An idle session is therefore immutable.** A `session_id` whose newest message is more than 4
  hours old can never receive another message, because the next turn will not resolve to it. This
  is the single property the whole design rests on: it makes `unique (session_id)` a complete
  idempotency mechanism, with no claim table and no row-level lock.
- **`checkins` is a write-only table.** Written by `turn.ts:226`; replicated down by
  `sync-rules.yaml` and `SYNCED_TABLES`; read by `packages/core/src/export/service.ts` alone — and
  S1 §1 deleted `export-button` on both clients, so that reader has no caller. Nothing in the
  assistant reads it: neither `retrieve.ts` nor `prompts.ts` mentions it. See §7.1.
- **The enrichment cron is the pattern to copy.** `apps/api/src/enrich/enrich.module.ts` runs
  `enrich.sweep` on `* * * * *` through pg-boss, wrapped in `withSweepLock`, calling `runSweep`,
  which claims through the `claim_notes_for_enrichment` RPC with `p_limit` and
  `p_exclude_user_ids` and holds the budget check in TypeScript (`enrich.service.ts:38-53`).
- **`withSweepLock` is not reusable as written.** `SWEEP_LOCK_ID = 1` is a module constant baked
  into the two `pg_try_advisory_lock` calls (`apps/api/src/queue/sweep-lock.ts:11,65,81`).
- **`usage_ledger.kind` is a hardcoded CHECK list** — `('embed','chat','tag','digest','memory',
  'transcribe','grounding')`, last altered by `00029`. `packages/db`'s
  enum-parity suite reads `usage_ledger_kind_check` out of `pg_constraint` and asserts against it.
- **New tables are born with no client grants, on both stacks.** `00025` §4 ran
  `alter default privileges in schema public revoke all on tables from anon, authenticated`, which
  closed the hosted/local divergence at the template. The trap now runs the other way: a
  *client-facing* table added without an explicit grant block fails with `42501` before RLS is
  consulted. A server-only table needs no grant block at all — which is what S3 wants.
- **The three sync lists were split by S1** into `UPLOADABLE_TABLES`, `SYNCED_TABLES` and
  `SERVER_ONLY_TABLES` (`packages/shared/src/dto/sync.ts:12,28,41`), with an assertion that they
  do not drift. S3 is the first table added since the split.

## Design

### 1. `mood_readings` (migration `00036`)

```sql
create table public.mood_readings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  session_id    uuid not null unique,
  status        text not null default 'pending'
                check (status in ('pending','ok','no_reading','failed')),
  valence       smallint check (valence between 1 and 5),
  summary       text,
  topics        text[] not null default '{}',
  confidence    real check (confidence >= 0 and confidence <= 1),
  evidence      jsonb not null default '[]',
  message_count int not null,
  session_start timestamptz not null,
  session_end   timestamptz not null,
  attempts      smallint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index mood_readings_user_end_idx on public.mood_readings (user_id, session_end desc);
alter table public.mood_readings enable row level security;
create trigger mood_readings_set_updated_at before update on public.mood_readings
  for each row execute function extensions.moddatetime(updated_at);
```

**No policy and no grant block, deliberately.** After `00025` §4 a new table grants nothing to
`anon` or `authenticated` on either stack, so the service role is the only reachable path. Stating
the omission here means a later reader does not "fix" it. `memory_revisions` (`00005:28`) is the
precedent: RLS on, zero policies, server-only.

Three decisions worth naming:

**`session_id unique` is the entire idempotency mechanism.** Because an idle session is immutable
(see Current architecture), the claim is a single atomic statement — `insert ... on conflict
(session_id) do nothing returning id` — and needs no separate claim table, no lease row and no
row-level lock.

**`status = 'no_reading'` is a success, not a failure.** A session of "ok cảm ơn" must be allowed
to conclude that nothing is readable, and must never be retried. This is the anti-fabrication
guard, and it lives in the schema rather than in the prompt so that a prompt regression cannot
quietly turn a null reading into an invented number.

**`mood_readings` goes in `SERVER_ONLY_TABLES` and in neither of the other two lists.** S1 split
those lists and asserted they do not drift; S3 is that assertion's first real exercise.

### 2. `usage_ledger` gains a `'mood'` kind (migration `00037`)

Drop and re-add `usage_ledger_kind_check` with `'mood'` appended, following `00029`'s shape, and
extend `packages/db`'s enum-parity fixture in the same commit. Kept separate from `00036` because
it changes a table S3 does not own.

### 3. The job

A second pg-boss cron beside `enrich.sweep`, in its own module — `apps/api/src/mood/` — rather
than inside `EnrichModule`. Different cadence, different budget accounting, different failure
mode; sharing a module would mean one `onModuleInit` owning two schedules and two locks.

**Cadence: hourly (`0 * * * *`).** The input changes only every four hours, so a minute-by-minute
schedule would be 59 wasted scans an hour. Nothing reads `mood_readings` (§6), so the up-to-one-hour
delay between a session becoming eligible and being read has no consequence at all.

**A distinct advisory lock.** `withSweepLock` must be parameterised to take a lock id, and the mood
job must pass a different one from `SWEEP_LOCK_ID = 1`. Sharing the id would make the two jobs
contend: the enrichment sweep ticks every 60 seconds and runs long because it awaits AI calls, so
the hourly mood job would routinely lose the lock and skip a whole hour. The refactor is small and
mechanical — a parameter with the existing constant as the enrichment caller's argument — and
`sweep-lock.ts`'s existing tests cover the behaviour that must not change.

**Claim: `claim_sessions_for_mood(p_limit, p_exclude_user_ids)`**, mirroring
`claim_notes_for_enrichment`:

```
from chat_messages
group by (user_id, session_id)
having max(created_at) < now() - interval '4 hours'
left join mood_readings on session_id
where no row exists,
   or (status = 'pending' and updated_at < now() - interval '10 minutes' and attempts < 3)
order by session_end asc
limit p_limit
```

- `p_limit` is **20**, matching enrichment. At hourly ticks that drains 480 sessions a day, far
  above any real volume, and the backfill (§4) finishes in hours.
- The 4-hour interval must be derived from `SESSION_IDLE_RESET_MS`, not typed twice. A second
  hand-maintained copy of a constant is the exact trap `sync.ts:38` records this repo already
  shipped once.
- **The 10-minute staleness threshold must stay below the cadence.** At or above 60 minutes, a row
  left `pending` by a crash would skip ticks instead of being retried on the next one.
- `order by session_end asc` drains oldest first. With no reader, the fact that today's session
  waits behind the backfill costs nothing, and ascending order is deterministic and easier to test.

**Budget reuses `isOverBudget` / `recordUsage`** from `packages/core/src/enrich/budget.js` against
the same `ENRICH_MONTHLY_BUDGET_USD`, and reuses the `p_exclude_user_ids` round loop from
`runSweep`. `enrich.service.ts:20-37` records why that loop exists and the reasoning transfers
without modification: a claim ordered oldest-first means one user over budget, holding the oldest
unprocessed sessions, stalls every other user permanently.

**A budget skip must not increment `attempts`.** It leaves the world exactly as it found it, so it
is the one outcome that must be re-claimable without limit. Counting it would retire a healthy
session after three quiet ticks for a reason that has nothing to do with that session.

**Model: `CLASSIFY_MODEL`.** Summarising ~20 messages is a Flash job.

**Floor: fewer than 2 user messages writes `no_reading` without an AI call.** A one-line session is
not worth an API round trip, and the row still records that the session was seen.

**A known cost, stated rather than discovered later.** `group by session_id` over `chat_messages`
is a full scan every hour. At current volume — `chat_messages` has only been written since stage
C1, around 2026-08-12, though the row count was not measured — this is negligible, and after the
backfill drains the *result* set is tiny even though the *scan* is not.
Add an index on `chat_messages (session_id)`. The threshold at which this needs revisiting is
roughly a million rows in `chat_messages`; past that, the claim wants a materialised session table
rather than a grouped scan, and that is a change for whoever crosses the line.

### 4. Backfill

The job draws no distinction between old sessions and new ones: every session that is idle and has
no reading is eligible, oldest first, subject to the same limit and the same budget. On the day it
first runs, every session written since 2026-08-12 qualifies.

This is deliberate and it is the cheapest option, not merely the simplest: it removes the "is this
session old?" branch entirely, and §10's whole argument for building S3 early is that history is
worth having sooner. The volume was estimated from dates rather than counted, so the plan should
count the idle sessions before the first hosted run and record the number.

### 5. The extraction contract

Structured output in the shape `packages/core/src/enrich/extract.ts` already uses — a JSON schema
with nullable fields and an explicit `required` list. Four rules in the prompt:

1. **Score the USER's mood only.** The assistant's replies are supplied for context, because
   without them a curt answer has no referent — the same reason `extractNote` receives
   `EnrichTarget.history`. They are not evidence of how the user feels.
2. **`null` is a permitted answer**, carrying `extract.ts:130`'s guard verbatim: *"A note about a
   difficult topic is not a bad mood."* Two mood readers in one system that disagree about what
   mood means is a defect nobody would ever notice.
3. **`topics` are Vietnamese, at most five.** The corpus is Vietnamese; forcing English labels
   invents a translation layer nobody asked for.
4. **Low `confidence` must produce a hedged `summary`**, not a confident sentence beside a 0.3.

**`evidence` is written by the code, not returned by the model.** The job knows exactly which rows
it loaded; asking a model to echo uuids back reliably is asking for corrupted audit data.

### 6. Nothing reads this table

No client, no API endpoint, no retrieval path, no prompt. `mood_readings` is server-only and
S3 ships no consumer for it. This is the decision that keeps S3 cheap and independent, and it is
the reason the hourly cadence and the ascending drain order are free.

It also means **S3 creates a second write-only table**, which is a real cost and is accepted with
open eyes — see §7.1, where the same shape is already a problem.

### 7. Findings recorded for later stages

Neither is S3's to fix. Both were found while verifying this design against the code on
2026-08-23, and both are recorded here rather than in a plan, on `2026-08-22` §11's reasoning that
a debt living in a finished plan is a debt that gets lost.

**7.1 The orphaned `checkins` writer.** `turn.ts:226` writes check-ins from the model's inference.
The widget that displayed them and the list that surfaced them were both deleted by S1 §1; the
only reader left, `export/service.ts`, has had no caller since the same stage. So the model writes
mood rows the user cannot see, cannot remove, and which nothing consumes. S1 §9.4 recorded that the
mood *accelerator* was removed; it did not record that the automatic *writer* survived it.

Once S3 ships there are two mood writers at different granularities, one of them unread. The real
problem is that there is no way to remove a wrong one, which makes it S4's subject rather than
S3's. Decided with the user on 2026-08-23: record it, do not touch `turn.ts` in this stage.

**7.2 S4 is not shaped the way §10 describes.** Three things were verified on 2026-08-23:

- **`memory_facts` is also write-only.** The only code that touches it is `offer.ts` and
  `decline.ts`, both writers, plus schema tests. Nothing reads it — not `retrieve.ts`, not
  `prompts.ts`. So retiring a fact today changes nothing the user can perceive, and §10's
  "archive the fact in the same turn" is bookkeeping on data with no consumer. **This is also why
  §11.2 cannot close inside a stage that only manages lifecycles**: proving a declined offer is
  excluded still requires something to exclude it from.
- **`lifecycle = 'archived'` does not remove a note from retrieval.** `search_notes` (`00035`)
  filters `n.deleted_at is null` on all three branches and never reads `lifecycle`. A retraction
  implemented through `lifecycle` would leave the note being retrieved and quoted. The real choice
  is `deleted_at` — a soft delete, so it satisfies §10's "nothing may be hard deleted" — or a
  `search_notes` migration teaching it about `lifecycle`.
- **The split in §10 is along the wrong axis.** §10 divides by how a retirement is discovered
  (said aloud / noticed by a job). The axis that decides which table moves is *what stopped being
  true*: **no longer true** ("giờ tôi không còn chạy bộ nữa") retires a `memory_facts` row and must
  leave the note alone, because the note is a true record of a past utterance; **never true** ("tôi
  ghi nhầm") and **true but unwanted** ("xoá cái vừa nãy") both have to remove the note from
  retrieval, and both need confirmation in chat because chat is the only surface left. §10's fear
  that "both, always" would archive a month of work is a consequence of splitting on the wrong
  axis.

The consequence for sequencing: **S1 §9.1 — no way to retract a note — closes without touching
`memory_facts` at all.** It is the second and third cases only, it touches `notes` and
`search_notes`, and it is the sole part a user can perceive today. Everything about `memory_facts`
is a larger and separate question: whether that subsystem should have a consumer at all. A
scheduled review job, whenever it is built, should only lower `salience` and never archive —
`memory_revisions.action` lists `'decay'` and `'archive'` as distinct verbs, time is not evidence,
and S1 removed every screen on which a wrongly archived fact could have been caught.

Left for S4's own brainstorm; the user chose on 2026-08-23 to record it and proceed with S3.

**7.3 Two findings from the final whole-branch review, 2026-08-23.**

- **Budget sharing has no reservation or priority between the two sweeps.** Both the mood job and
  the enrichment sweep call `isOverBudget(..., "sweep")` against the same
  `ENRICH_MONTHLY_BUDGET_USD` pool, with no reservation between them. Mood synthesis (a stage
  nothing reads yet, per §6) can exhaust the budget of note enrichment (a feature the user directly
  sees), and which one wins depends entirely on which cron happens to tick first in a given month.
  Not worth a new environment variable for this stage, but worth stating as a known, accepted
  tradeoff rather than leaving it implicit.
- **A deleted or soft-deleted chat session's mood reading is never cleaned up.**
  `mood_readings.session_id` deliberately has no FK to `chat_sessions` (see `00036`'s own comments
  for why). If a hard-delete path is ever added for `chat_sessions`, the cascade would remove
  `chat_messages` but leave the `mood_readings` row — which contains a natural-language summary of
  the deleted conversation — orphaned. Separately, `chat_sessions.deleted_at` (a soft-delete column
  that exists today but is never written by any app code) is not filtered by the claim RPC at all,
  so a future soft-delete feature would have the sweep read and summarise sessions the user already
  asked to delete. No delete path exists in the app today, so this is forward-looking, not an
  active bug — recorded here so whoever adds session deletion inherits the requirement rather than
  discovering it.

### 8. Testing

This repo's recurring defect is a test that cannot fail. Each case below is listed with the change
that turns it red; a case without one does not belong in the suite.

| Test | What turns it red |
|---|---|
| A session idle 3h59m is not claimed; 4h01m is | Flipping the comparison, or hardcoding a second copy of the interval |
| Backfill spans more than one claim: fixtures exceeding `p_limit`, run two ticks | Dropping `on conflict do nothing` — tick two reprocesses tick one's sessions |
| A chitchat session yields `no_reading` and is not re-claimed on the next tick | Treating a null valence as a failure |
| A budget skip leaves `attempts` unchanged | Incrementing `attempts` before the budget check |
| `anon` and `authenticated` hold zero privileges on `mood_readings`; RLS on, zero policies | Adding a policy or a grant block |
| `mood_readings` ∈ `SERVER_ONLY_TABLES`, ∉ `SYNCED_TABLES`, ∉ `UPLOADABLE_TABLES` | A later stage widening the wrong list |
| `usage_ledger` accepts `kind = 'mood'` | Shipping `00036` without `00037` |
| The mood job's advisory lock id differs from `SWEEP_LOCK_ID` | Reusing the enrichment lock, which would silently starve the hourly job |

The fixtures for the first case must include both sides of the boundary. One-sided boundary tests
pass against an implementation that claims everything.

**This suite does not prove the readings are any good.** No test can assert that a model correctly
identified a mood. That is a judgement made by a person over sustained use, in exactly the sense
`2026-08-22` §11.4 describes, and it is stated here so the table above is not mistaken for
coverage of it.

### 9. Deploy

- **Two migrations, and `supabase db push` targets the hosted project by default.** Run `--local`
  first, then record the hosted step in `docs/deploy.md` the way `00034` and `00035` did.
- **No new environment variable.** The budget is shared with enrichment. If a later stage splits
  them, the new variable has to be declared in `turbo.json`, in `ci.yml` **and** in both
  `e2e-*.yml` workflows — passing it through turbo alone leaves the API dead behind a green step.
- **If a new test suite lands in a package `ci.yml` does not already name, the CI step is part of
  the task that creates the suite.** An unnamed suite runs on the author's machine and nowhere
  else.
- Package tests run through turbo: `pnpm turbo run test --filter=<pkg>`.

## Out of scope

- No client reads `mood_readings`: no UI, no API endpoint, no PowerSync replication, no RLS read
  policy.
- No change to `retrieve.ts`, to any prompt, or to any part of the assistant turn.
- No change to `turn.ts` — the `checkins` writer in §7.1 stays exactly as it is.
- No embedding column on `mood_readings`. Adding one would be speculative: nothing searches it.
- No change to `checkins`, to `memory_facts`, or to anything in §7.2. Those are S4's.
- No aggregation, trend or "how was my month" surface of any kind. §10's instruction is to gather
  first and decide later, and this stage is the gathering.
