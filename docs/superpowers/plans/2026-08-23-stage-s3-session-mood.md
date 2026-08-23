# Stage S3: Session Mood Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An hourly job that summarises each idle chat session into one `mood_readings` row, which nothing reads yet.

**Architecture:** A second pg-boss cron beside `enrich.sweep`, holding its own advisory lock. A pure-`select` claim RPC finds sessions whose newest message is older than the idle window and which have no reading yet; the service checks the budget, writes a `pending` row, calls Flash once, and resolves the row to `ok` or `no_reading`. An idle session is immutable, so `unique (session_id)` is the whole of the idempotency mechanism.

**Tech Stack:** Postgres/Supabase migrations, PostgREST RPCs, NestJS, pg-boss, Vitest, Gemini via the existing `AiClient` interface.

**Spec:** `docs/superpowers/specs/2026-08-23-stage-s3-session-mood-design.md`

## Global Constraints

- **`mood_readings` is server-only.** No RLS policy, no grant block, no PowerSync replication, no client read. Service role is the only path.
- **Nothing may read `mood_readings` in this stage.** No change to `retrieve.ts`, to any prompt, or to any client.
- **No change to `turn.ts`.** The `checkins` writer at `turn.ts:226` stays exactly as it is (spec §7.1).
- **`status = 'no_reading'` is a success.** It is never retried and never becomes `failed`.
- **A budget skip must write nothing at all** — in particular it must not increment `attempts`.
- **The 4-hour idle window is derived from `SESSION_IDLE_RESET_MS`** (`packages/shared/src/assistant/session.ts:5`), never typed a second time. It reaches SQL as a parameter.
- **The mood job's advisory lock id must differ from `SWEEP_LOCK_ID = 1`.**
- **Migrations run `--local` first.** `supabase db push` with no flag targets the hosted project.
- **Tests run through turbo:** `pnpm turbo run test --filter=<pkg>`, never `pnpm --filter <pkg> test`.
- **No new CI step is needed.** `ci.yml:197-203` already runs `@cortex/db`, `@cortex/api` and `@cortex/core`. Do not create a new package.
- Migration numbering continues from `00035`. This plan adds `00036`, `00037`, `00038`.

---

### Task 1: The `mood_readings` table

**Files:**
- Create: `supabase/migrations/00036_mood_readings.sql`
- Create: `packages/db/src/test/mood-readings-schema.test.ts`
- Modify: `packages/shared/src/dto/sync.ts:41-48` (add to `SERVER_ONLY_TABLES`)
- Modify: `packages/shared/src/dto/sync.test.ts:96-110` (the exhaustive list fixture)
- Modify: `packages/db/src/test/default-grants.test.ts:13-16` (import the list instead of re-declaring it)

**Interfaces:**
- Consumes: nothing.
- Produces: the `public.mood_readings` table; the `public._test_policy_count(p_table text) returns int` RPC; `"mood_readings"` as a member of `SERVER_ONLY_TABLES`.

- [ ] **Step 1: Add the table to `SERVER_ONLY_TABLES`**

In `packages/shared/src/dto/sync.ts`, add `"mood_readings"` to the array. The surrounding comment already explains why this list exists; add one line inside the array:

```ts
export const SERVER_ONLY_TABLES = [
  "note_chunks",
  "usage_ledger",
  "integrations",
  // S3's per-session mood readings. Server-written, server-read, and read by nothing at all
  // today -- see the S3 spec §6. Listed here so schema.test.ts's "never declares a server-only
  // table" assertion covers it without anyone remembering to add it.
  "mood_readings",
  // ... leave the remaining existing entries untouched
] as const;
```

- [ ] **Step 2: Run `@cortex/shared` to see the exhaustive fixture fail**

Run: `pnpm turbo run test --filter=@cortex/shared`
Expected: FAIL in `sync.test.ts:97` — `names every table deliberately excluded from replication` compares the whole sorted list against a literal, so it goes red the moment a name is added.

That failure is wanted: it is what makes adding a server-only table a deliberate edit in two places rather than something that slides in. Update the fixture by inserting `"mood_readings"` in sorted position:

```ts
    expect([...SERVER_ONLY_TABLES].sort()).toEqual(
      [
        "feedback_events",
        "flashcards",
        "ingest_inbox",
        "mood_readings",
        // ... the remaining existing entries, unchanged
      ],
    );
```

Re-run `pnpm turbo run test --filter=@cortex/shared`; expected: PASS.

- [ ] **Step 3: Remove the duplicate list in `default-grants.test.ts`**

`default-grants.test.ts:13` declares its own hardcoded copy of the same names. Two hand-maintained copies of one list is the trap `sync.ts:38` records this repo already shipped. Replace the local constant with the shared one:

```ts
import { describe, expect, it } from "vitest";
import { SERVER_ONLY_TABLES } from "@cortex/shared";
import { admin } from "./clients.js";

// (keep the existing comment block above the list -- it explains the pg_default_acl mechanism)
// The list is imported rather than restated: a server-only table added to @cortex/shared and not
// to this file used to be a silently unchecked table.
```

Then delete the `const SERVER_ONLY_TABLES = [...]` declaration. The `it.each(SERVER_ONLY_TABLES)` calls below need no change.

- [ ] **Step 4: Run the two suites to see them fail**

Run: `pnpm turbo run test --filter=@cortex/db --filter=@cortex/sync`
Expected: FAIL. `@cortex/sync`'s `schema.test.ts` still passes (it asserts *absence*, and the table is absent from `AppSchema`), but `@cortex/db`'s `default-grants.test.ts` now fails on `mood_readings` with a privilege-lookup error or a `false`/`null` mismatch, because the table does not exist yet.

- [ ] **Step 5: Write the schema test**

Create `packages/db/src/test/mood-readings-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { admin } from "./clients.js";
import { makeUser } from "./clients.js";

const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"];

describe("mood_readings (00036)", () => {
  // The load-bearing assertion of the whole stage. After 00025 §4 a new table is born with no
  // client grants on either stack, so this passes the day it is written -- its value is that it
  // turns red the day someone adds a grant block or a policy to a table the S3 spec §6 says
  // nothing may read.
  it.each(PRIVILEGES)("authenticated holds no %s on mood_readings", async (privilege) => {
    const { data, error } = await admin.rpc("_test_has_table_privilege", {
      p_role: "authenticated", p_table: "mood_readings", p_privilege: privilege,
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it.each(PRIVILEGES)("anon holds no %s on mood_readings", async (privilege) => {
    const { data, error } = await admin.rpc("_test_has_table_privilege", {
      p_role: "anon", p_table: "mood_readings", p_privilege: privilege,
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  // Positive control, in the shape default-grants.test.ts already uses: without it, a broken
  // privilege lookup that always returned false would make every assertion above false-pass.
  it("service_role does hold SELECT (positive control)", async () => {
    const { data, error } = await admin.rpc("_test_has_table_privilege", {
      p_role: "service_role", p_table: "mood_readings", p_privilege: "SELECT",
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  // A grant test alone cannot see a policy: a policy without a grant is inert, so adding one
  // would not turn the assertions above red. This is the half that does.
  it("has RLS enabled and exactly zero policies", async () => {
    const { data, error } = await admin.rpc("_test_policy_count", { p_table: "mood_readings" });
    expect(error).toBeNull();
    expect(data).toBe(0);
  });

  it("rejects a second reading for the same session", async () => {
    const { id: userId } = await makeUser("s3-unique@example.com");
    const sessionId = crypto.randomUUID();
    const row = {
      user_id: userId, session_id: sessionId, message_count: 4,
      session_start: new Date().toISOString(), session_end: new Date().toISOString(),
    };
    const first = await admin.from("mood_readings").insert(row);
    expect(first.error).toBeNull();
    const second = await admin.from("mood_readings").insert(row);
    // 23505 unique_violation. This constraint IS the idempotency mechanism (spec §1), so a
    // migration that dropped it would leave the job re-reading sessions forever with nothing
    // else to stop it.
    expect(second.error?.code).toBe("23505");
  });

  it.each([0, 6])("rejects valence %i", async (valence) => {
    const { id: userId } = await makeUser("s3-valence@example.com");
    const { error } = await admin.from("mood_readings").insert({
      user_id: userId, session_id: crypto.randomUUID(), message_count: 1,
      session_start: new Date().toISOString(), session_end: new Date().toISOString(),
      valence,
    });
    expect(error?.code).toBe("23514"); // check_violation
  });

  it("rejects an unknown status", async () => {
    const { id: userId } = await makeUser("s3-status@example.com");
    const { error } = await admin.from("mood_readings").insert({
      user_id: userId, session_id: crypto.randomUUID(), message_count: 1,
      session_start: new Date().toISOString(), session_end: new Date().toISOString(),
      status: "archived",
    });
    expect(error?.code).toBe("23514");
  });

  it("defaults status to pending and attempts to zero", async () => {
    const { id: userId } = await makeUser("s3-defaults@example.com");
    const { data, error } = await admin.from("mood_readings").insert({
      user_id: userId, session_id: crypto.randomUUID(), message_count: 1,
      session_start: new Date().toISOString(), session_end: new Date().toISOString(),
    }).select("status, attempts, topics").single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "pending", attempts: 0, topics: [] });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/db`
Expected: FAIL — the table and the `_test_policy_count` RPC do not exist.

- [ ] **Step 7: Write the migration**

Create `supabase/migrations/00036_mood_readings.sql`:

```sql
-- ============ Stage S3: one mood reading per idle chat session ============
--
-- NOT a second checkins writer. turn.ts:226 already writes a check-in whenever extractNote reads
-- a mood out of a single message, while the user is looking at the screen and with a `mood` event
-- yielded so the UI can show it. turn.ts:223-225 records why a JOB must not write that table: it
-- would write at arbitrary times, for old content, with no screen to undo it on. This table is
-- how S3 obeys that constraint rather than working around it.
--
-- SERVER-ONLY, and deliberately WITHOUT a grant block. Since 00025 §4 ran `alter default
-- privileges in schema public revoke all on tables from anon, authenticated`, a new table is born
-- with no client privileges on the hosted project as well as locally. The trap now runs the other
-- way -- a CLIENT-facing table added without an explicit grant fails with 42501 before RLS is ever
-- consulted -- so the omission below is stated rather than left to be "fixed" by a later reader.
-- memory_revisions (00005:28) is the precedent: RLS on, zero policies, service role only.

create table public.mood_readings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- UNIQUE is the entire idempotency mechanism, and it is only sound because an idle session is
  -- immutable: resolveCurrentSession (packages/shared/src/assistant/session.ts:31) returns null
  -- once the newest message is older than SESSION_IDLE_RESET_MS, and the caller then mints a
  -- fresh uuid -- so a session past the window can never receive another message. No claim
  -- table, no lease row, no row-level lock.
  --
  -- No FK: session_id is a plain column on chat_messages, not a table (there is no chat_sessions).
  session_id    uuid not null unique,
  -- 'no_reading' is a SUCCESS, not a failure: a session of "ok cảm ơn" must be allowed to
  -- conclude that nothing is readable, and must never be retried. Keeping that distinction in the
  -- schema rather than in the prompt means a prompt regression cannot quietly turn a null reading
  -- into an invented number.
  status        text not null default 'pending'
                check (status in ('pending','ok','no_reading','failed')),
  -- 1..5, the same scale as checkins.mood (00013:55), so the two are comparable if anything ever
  -- wants to compare them. Null whenever status is not 'ok'.
  valence       smallint check (valence between 1 and 5),
  summary       text,
  topics        text[] not null default '{}',
  confidence    real check (confidence >= 0 and confidence <= 1),
  -- The chat_messages ids the reading was computed from, written by the job from the rows it
  -- actually loaded. Never echoed back from the model: asking a model to reproduce uuids
  -- reliably is asking for corrupted audit data.
  evidence      jsonb not null default '[]',
  message_count int not null,
  session_start timestamptz not null,
  session_end   timestamptz not null,
  attempts      smallint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index mood_readings_user_end_idx on public.mood_readings (user_id, session_end desc);

-- The claim groups chat_messages by session_id, which has no index today: chat_messages_user_idx
-- (00027) is (user_id, created_at desc) and does not serve a group-by. See the S3 spec §3 for the
-- volume at which the grouped scan needs replacing outright rather than indexing.
create index chat_messages_session_idx on public.chat_messages (session_id);

alter table public.mood_readings enable row level security;

create trigger mood_readings_set_updated_at before update on public.mood_readings
  for each row execute function extensions.moddatetime(updated_at);

-- ---- test helper ----
-- A grant test cannot see a policy: with zero grants a policy is inert, so adding one would not
-- turn a has_table_privilege assertion red. This is what lets mood-readings-schema.test.ts assert
-- "and exactly zero policies" -- the other half of "nothing may read this table".
create or replace function public._test_policy_count(p_table text)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from pg_policies
  where schemaname = 'public' and tablename = p_table;
$$;
revoke execute on function public._test_policy_count(text) from public;
grant execute on function public._test_policy_count(text) to service_role;
```

- [ ] **Step 8: Apply the migration locally and run the tests**

Run:
```bash
pnpm supabase db push --local
pnpm turbo run test --filter=@cortex/db --filter=@cortex/sync --filter=@cortex/shared
```
Expected: PASS. If `db push` reports nothing to do, the local stack is out of sync — `pnpm supabase db reset` and re-run. (If the API then throws `AuthRetryableFetchError`, restart the Kong container; that is stale Docker DNS, not a code regression.)

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/00036_mood_readings.sql packages/db/src/test/mood-readings-schema.test.ts packages/db/src/test/default-grants.test.ts packages/shared/src/dto/sync.ts packages/shared/src/dto/sync.test.ts
git commit -m "feat(db): add mood_readings, a server-only table nothing reads yet"
```

---

### Task 2: `usage_ledger` learns the `mood` kind

**Files:**
- Create: `supabase/migrations/00037_usage_kind_mood.sql`
- Modify: `packages/shared/src/enums.ts` (the `usageLedgerKind` enum)
- Modify: `packages/core/src/enrich/budget.ts:34` (the `kind` union on `recordUsage`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `recordUsage(db, { kind: "mood", ... })` type-checks and inserts without violating the CHECK.

- [ ] **Step 1: Add `'mood'` to the zod enum**

In `packages/shared/src/enums.ts`, append `"mood"` to `usageLedgerKind`'s options, keeping the existing order and adding it last — `enum-parity.test.ts` compares the SQL constraint's values to the zod options **in order**, so appending is the only edit that keeps the two comparable without also reordering the constraint.

- [ ] **Step 2: Run the parity test to see it fail**

Run: `pnpm turbo run test --filter=@cortex/db`
Expected: FAIL in `enum-parity.test.ts` — `usage_ledger.usage_ledger_kind_check matches its zod enum exactly`, with the SQL side missing `mood`.

This failure is the point of the task: the parity test is what makes it impossible to ship one half of this change.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00037_usage_kind_mood.sql`:

```sql
-- ============ Stage S3's per-session mood job needs its own ledger kind ============
--
-- Same shape as 00029, which added 'grounding'. Dropped and re-added rather than altered: a CHECK
-- constraint has no in-place edit.
--
-- Its own kind rather than reusing 'tag': the S3 job and the enrichment sweep share
-- ENRICH_MONTHLY_BUDGET_USD, so the only way to answer "what did mood synthesis cost" after the
-- fact is for its rows to say so. packages/db's enum-parity suite reads this constraint out of
-- pg_constraint and compares it to usageLedgerKind, so the two cannot drift apart silently.
alter table public.usage_ledger drop constraint usage_ledger_kind_check;
alter table public.usage_ledger add constraint usage_ledger_kind_check
  check (kind in ('embed','chat','tag','digest','memory','transcribe','grounding','mood'));
```

- [ ] **Step 4: Widen `recordUsage`'s `kind` union**

In `packages/core/src/enrich/budget.ts:34`, change:

```ts
    kind: "embed" | "tag" | "chat" | "grounding" | "mood";
```

- [ ] **Step 5: Apply and run**

Run:
```bash
pnpm supabase db push --local
pnpm turbo run test --filter=@cortex/db --filter=@cortex/core --filter=@cortex/shared
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00037_usage_kind_mood.sql packages/shared/src/enums.ts packages/core/src/enrich/budget.ts
git commit -m "feat(db): meter the mood job under its own usage_ledger kind"
```

---

### Task 3: The claim RPC

**Files:**
- Create: `supabase/migrations/00038_claim_sessions_for_mood.sql`
- Create: `packages/db/src/test/claim-sessions-for-mood.test.ts`

**Interfaces:**
- Consumes: `public.mood_readings` (Task 1).
- Produces: the RPC

  ```
  claim_sessions_for_mood(p_limit int, p_idle_ms bigint, p_exclude_user_ids uuid[] default '{}')
  returns table (user_id uuid, session_id uuid, session_start timestamptz,
                 session_end timestamptz, message_count int, prior_attempts smallint)
  ```

  It is a **pure select**: it writes nothing. The caller writes the `pending` row after its budget check.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/test/claim-sessions-for-mood.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

const HOUR_MS = 60 * 60 * 1000;
const IDLE_MS = 4 * HOUR_MS;

/** Inserts one chat_messages row at an explicit time. The table is server-written, so admin is
 *  the honest client here -- this is exactly how turn.ts writes it. */
async function seedMessage(
  userId: string, sessionId: string, role: "user" | "assistant", content: string, at: Date,
) {
  const { error } = await admin.from("chat_messages").insert({
    user_id: userId, session_id: sessionId, role, content, created_at: at.toISOString(),
  });
  if (error) throw error;
}

async function claim(limit: number, exclude: string[] = []) {
  const { data, error } = await admin.rpc("claim_sessions_for_mood", {
    p_limit: limit, p_idle_ms: IDLE_MS, p_exclude_user_ids: exclude,
  });
  expect(error).toBeNull();
  return (data ?? []) as {
    user_id: string; session_id: string; session_start: string;
    session_end: string; message_count: number; prior_attempts: number;
  }[];
}

describe("claim_sessions_for_mood (00038)", () => {
  let userId: string;

  beforeEach(async () => {
    ({ id: userId } = await makeUser("s3-claim@example.com"));
    // Each test builds its own sessions; clear anything a previous one left so the assertions
    // below can be about counts rather than about "contains".
    await admin.from("mood_readings").delete().eq("user_id", userId);
    await admin.from("chat_messages").delete().eq("user_id", userId);
  });

  // BOTH sides of the boundary. A one-sided test passes against an implementation that claims
  // every session in the table, which is the failure that matters here.
  it("does not claim a session idle for less than the window", async () => {
    const sessionId = crypto.randomUUID();
    await seedMessage(userId, sessionId, "user", "chào", new Date(Date.now() - IDLE_MS - HOUR_MS));
    await seedMessage(userId, sessionId, "user", "ừ", new Date(Date.now() - IDLE_MS + 60_000));

    expect(await claim(10)).toHaveLength(0);
  });

  it("claims a session idle for longer than the window", async () => {
    const sessionId = crypto.randomUUID();
    const start = new Date(Date.now() - IDLE_MS - 2 * HOUR_MS);
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "hôm nay mệt", start);
    await seedMessage(userId, sessionId, "assistant", "sao vậy", end);

    const rows = await claim(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: userId, session_id: sessionId, message_count: 2, prior_attempts: 0,
    });
    expect(new Date(rows[0]!.session_start).getTime()).toBe(start.getTime());
    expect(new Date(rows[0]!.session_end).getTime()).toBe(end.getTime());
  });

  it("does not claim a session that already has a resolved reading", async () => {
    const sessionId = crypto.randomUUID();
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "xong rồi", end);
    const { error } = await admin.from("mood_readings").insert({
      user_id: userId, session_id: sessionId, status: "ok", valence: 4,
      message_count: 1, session_start: end.toISOString(), session_end: end.toISOString(),
    });
    expect(error).toBeNull();

    expect(await claim(10)).toHaveLength(0);
  });

  // The guard that stops the job re-reading a session forever for free. 'no_reading' is a
  // success (spec §1); this test is red if the claim ever treats a null valence as unfinished.
  it("does not claim a session whose reading is no_reading", async () => {
    const sessionId = crypto.randomUUID();
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "ok", end);
    await admin.from("mood_readings").insert({
      user_id: userId, session_id: sessionId, status: "no_reading",
      message_count: 1, session_start: end.toISOString(), session_end: end.toISOString(),
    });

    expect(await claim(10)).toHaveLength(0);
  });

  it("re-claims a pending row left stale by a crash, carrying its attempt count", async () => {
    const sessionId = crypto.randomUUID();
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "mệt quá", end);
    await admin.from("mood_readings").insert({
      user_id: userId, session_id: sessionId, status: "pending", attempts: 1,
      message_count: 1, session_start: end.toISOString(), session_end: end.toISOString(),
      // Backdated past the 10-minute staleness threshold. moddatetime only fires on UPDATE, so
      // an explicit updated_at on INSERT survives.
      updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    const rows = await claim(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prior_attempts).toBe(1);
  });

  it("does not re-claim a pending row that is still fresh", async () => {
    const sessionId = crypto.randomUUID();
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "mệt quá", end);
    await admin.from("mood_readings").insert({
      user_id: userId, session_id: sessionId, status: "pending", attempts: 1,
      message_count: 1, session_start: end.toISOString(), session_end: end.toISOString(),
    });

    expect(await claim(10)).toHaveLength(0);
  });

  it("gives up on a pending row that has already failed three times", async () => {
    const sessionId = crypto.randomUUID();
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "mệt quá", end);
    await admin.from("mood_readings").insert({
      user_id: userId, session_id: sessionId, status: "pending", attempts: 3,
      message_count: 1, session_start: end.toISOString(), session_end: end.toISOString(),
      updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    expect(await claim(10)).toHaveLength(0);
  });

  it("returns the oldest sessions first and respects the limit", async () => {
    const ends = [4, 3, 2].map((h) => new Date(Date.now() - IDLE_MS - h * HOUR_MS));
    const ids = ends.map(() => crypto.randomUUID());
    for (let i = 0; i < ids.length; i++) {
      await seedMessage(userId, ids[i]!, "user", `tin ${i}`, ends[i]!);
    }

    const rows = await claim(2);
    // Oldest first: the 4-hours-older session, then the 3-hours-older one. Backfill drains from
    // the far end (spec §3), and the order is what makes that testable at all.
    expect(rows.map((r) => r.session_id)).toEqual([ids[0], ids[1]]);
  });

  it("skips every session belonging to an excluded user", async () => {
    const sessionId = crypto.randomUUID();
    await seedMessage(userId, sessionId, "user", "mệt", new Date(Date.now() - IDLE_MS - HOUR_MS));

    expect(await claim(10, [userId])).toHaveLength(0);
    // And the exclusion is not simply "return nothing": the same session claims fine without it.
    expect(await claim(10, [])).toHaveLength(1);
  });

  it("treats a null exclusion array as no exclusions", async () => {
    const sessionId = crypto.randomUUID();
    await seedMessage(userId, sessionId, "user", "mệt", new Date(Date.now() - IDLE_MS - HOUR_MS));

    const { data, error } = await admin.rpc("claim_sessions_for_mood", {
      p_limit: 10, p_idle_ms: IDLE_MS, p_exclude_user_ids: null,
    });
    expect(error).toBeNull();
    // `x <> all (null)` is NULL, not true, so a bare `<> all` would filter out every row and the
    // job would silently claim nothing -- 00023 records the same trap on the enrichment claim.
    expect(data).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/db`
Expected: FAIL with PostgREST reporting that the function `claim_sessions_for_mood` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00038_claim_sessions_for_mood.sql`:

```sql
-- ============ Stage S3's claim: which idle sessions still need a mood reading ============
--
-- A PURE SELECT. It writes nothing, deliberately: the caller checks ENRICH_MONTHLY_BUDGET_USD
-- after claiming, and a budget skip must leave the world exactly as it found it (S3 spec §3). A
-- claim that incremented `attempts` itself would retire a healthy session after three quiet ticks
-- for a reason that has nothing to do with that session. claim_notes_for_enrichment (00023) has
-- the same shape for the same reason.
--
-- p_idle_ms rather than a literal `interval '4 hours'`: the window belongs to
-- SESSION_IDLE_RESET_MS (packages/shared/src/assistant/session.ts:5), which is what
-- resolveCurrentSession uses to decide a session has ended. Two hand-maintained copies of one
-- constant is how the job and the app come to disagree about where a session stops -- and it also
-- lets the test drive the boundary from both sides without waiting four hours.
--
-- SECURITY DEFINER with service_role-only EXECUTE: chat_messages is client-readable under RLS,
-- and this function deliberately reads across ALL users in one call.

create function public.claim_sessions_for_mood(
  p_limit int,
  p_idle_ms bigint,
  p_exclude_user_ids uuid[] default '{}'::uuid[]
)
returns table (
  user_id uuid,
  session_id uuid,
  session_start timestamptz,
  session_end timestamptz,
  message_count int,
  prior_attempts smallint
)
language sql
stable
security definer
set search_path = public
as $$
  with idle as (
    select
      m.user_id,
      m.session_id,
      min(m.created_at) as session_start,
      max(m.created_at) as session_end,
      count(*)::int     as message_count
    from public.chat_messages m
    -- coalesce, not a bare `<> all(p_exclude_user_ids)`: `x <> all (null)` is NULL rather than
    -- true, so an explicit null would filter out every row and the job would claim nothing while
    -- looking perfectly healthy. 00023 records the identical trap on the enrichment claim.
    where m.user_id <> all (coalesce(p_exclude_user_ids, '{}'::uuid[]))
    group by m.user_id, m.session_id
    having max(m.created_at) < now() - make_interval(secs => p_idle_ms / 1000.0)
  )
  select
    i.user_id, i.session_id, i.session_start, i.session_end, i.message_count,
    coalesce(r.attempts, 0::smallint) as prior_attempts
  from idle i
  left join public.mood_readings r on r.session_id = i.session_id
  where
    -- Never been read.
    r.id is null
    -- Or: a previous run claimed it and died before resolving the row. The 10-minute threshold
    -- must stay BELOW the job's cadence (hourly) -- at or above it, a row left pending by a crash
    -- would skip ticks instead of being retried on the very next one.
    or (
      r.status = 'pending'
      and r.updated_at < now() - interval '10 minutes'
      and r.attempts < 3
    )
  -- Oldest first, so the backfill drains from the far end. Nothing reads mood_readings (spec §6),
  -- so today's session waiting behind the backlog costs nothing, and ascending order is
  -- deterministic and therefore testable.
  order by i.session_end asc
  limit p_limit;
$$;

revoke execute on function public.claim_sessions_for_mood(int, bigint, uuid[]) from public;
grant execute on function public.claim_sessions_for_mood(int, bigint, uuid[]) to service_role;
```

- [ ] **Step 4: Apply and run**

Run:
```bash
pnpm supabase db push --local
pnpm turbo run test --filter=@cortex/db
```
Expected: PASS, all eleven cases.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00038_claim_sessions_for_mood.sql packages/db/src/test/claim-sessions-for-mood.test.ts
git commit -m "feat(db): claim idle chat sessions that still need a mood reading"
```

---

### Task 4: Give the mood job its own advisory lock

**Files:**
- Modify: `apps/api/src/queue/sweep-lock.ts:10-11,58-90`
- Modify: `apps/api/src/enrich/enrich.module.ts` (the `withSweepLock` call)
- Modify: `apps/api/test/sweep-lock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `withSweepLock<T>(session: LockSession, lockId: number, fn: () => Promise<T>): Promise<SweepLockOutcome<T>>` and the exported constant `MOOD_LOCK_ID = 2`. `SWEEP_LOCK_ID = 1` and `SWEEP_LOCK_NAMESPACE` keep their current values and names.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/sweep-lock.test.ts`, inside the existing `describe("withSweepLock")` block:

```ts
  // The whole reason this parameter exists. The enrichment sweep ticks every 60 seconds and runs
  // long because it awaits AI calls; an hourly job sharing its lock id would lose most hours and
  // simply never read a session, with "sweep skipped" in the log as the only sign. Asserting on
  // the ARGUMENTS is what rules that out -- a version that ignores lockId and always locks 1
  // passes every other test in this file.
  it("locks and unlocks the id it is given", async () => {
    const calls: unknown[][] = [];
    const session: LockSession = {
      async query(sql: string, values?: unknown[]) {
        calls.push(values ?? []);
        return { rows: sql.includes("pg_try_advisory_lock") ? [{ locked: true }] : [{}] };
      },
      async end() {},
    };

    await withSweepLock(session, MOOD_LOCK_ID, async () => "read");

    expect(calls[0]).toEqual([SWEEP_LOCK_NAMESPACE, MOOD_LOCK_ID]);
    expect(calls[1]).toEqual([SWEEP_LOCK_NAMESPACE, MOOD_LOCK_ID]);
  });

  it("keeps the two jobs on different ids", () => {
    expect(MOOD_LOCK_ID).not.toBe(SWEEP_LOCK_ID);
  });
```

Extend the file's import to pull in `MOOD_LOCK_ID`, and update every existing `withSweepLock(session, fn)` call in the file to `withSweepLock(session, SWEEP_LOCK_ID, fn)`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/api`
Expected: FAIL — `MOOD_LOCK_ID` is not exported, and the arity change breaks compilation.

- [ ] **Step 3: Parameterise the lock**

In `apps/api/src/queue/sweep-lock.ts`, add beside `SWEEP_LOCK_ID`:

```ts
export const SWEEP_LOCK_ID = 1;
/**
 * S3's hourly mood job. A DIFFERENT id from the enrichment sweep, and that is the entire point:
 * the sweep ticks every 60 seconds and holds its lock across AI calls, so a mood job sharing id 1
 * would lose the lock on most hours and read nothing, logging "skipped" as though that were
 * healthy. Advisory locks are per (namespace, id), so two ids never contend.
 */
export const MOOD_LOCK_ID = 2;
```

Change the signature and both statement bodies:

```ts
export async function withSweepLock<T>(
  session: LockSession,
  lockId: number,
  fn: () => Promise<T>,
): Promise<SweepLockOutcome<T>> {
  try {
    const res = await session.query("select pg_try_advisory_lock($1, $2) as locked", [
      SWEEP_LOCK_NAMESPACE,
      lockId,
    ]);
    const locked = (res.rows[0] as { locked?: unknown } | undefined)?.locked;
    if (locked !== true) return { ran: false };

    try {
      return { ran: true, result: await fn() };
    } finally {
      await session.query("select pg_advisory_unlock($1, $2)", [SWEEP_LOCK_NAMESPACE, lockId]);
    }
  } finally {
    await session.end();
  }
}
```

Leave every existing comment in the function body exactly where it is — none of it is invalidated by the parameter.

- [ ] **Step 4: Update the enrichment caller**

In `apps/api/src/enrich/enrich.module.ts`, change the call to pass the existing id explicitly:

```ts
      const outcome = await withSweepLock(
        await createPgLockSession(env.DATABASE_URL),
        SWEEP_LOCK_ID,
        () => runSweep(deps),
      );
```

and add `SWEEP_LOCK_ID` to the import from `../queue/sweep-lock`.

- [ ] **Step 5: Run the tests**

Run: `pnpm turbo run test --filter=@cortex/api`
Expected: PASS, including the existing integration describe at the bottom of `sweep-lock.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/queue/sweep-lock.ts apps/api/src/enrich/enrich.module.ts apps/api/test/sweep-lock.test.ts
git commit -m "refactor(api): let each scheduled job hold its own advisory lock"
```

---

### Task 5: Reading a session's mood

**Files:**
- Create: `packages/core/src/mood/read.ts`
- Create: `packages/core/src/mood/read.test.ts`
- Modify: `packages/core/src/index.ts` (export the new module)

**Interfaces:**
- Consumes: `AiClient` (`packages/core/src/ai/client.ts`), `recordUsage` (Task 2).
- Produces:

  ```ts
  export interface SessionMessage { id: string; role: "user" | "assistant"; content: string }
  export interface MoodReading {
    valence: number | null; summary: string | null;
    topics: string[]; confidence: number | null;
  }
  export const MIN_USER_MESSAGES = 2;
  export function hasReadableContent(messages: SessionMessage[]): boolean;
  export function buildMoodPrompt(messages: SessionMessage[]): string;
  export function readSessionMood(
    deps: { db: SupabaseClient; ai: AiClient },
    args: { userId: string; messages: SessionMessage[] },
  ): Promise<MoodReading>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/mood/read.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { AiClient } from "../ai/client.js";
import {
  buildMoodPrompt, hasReadableContent, MIN_USER_MESSAGES, readSessionMood,
  type SessionMessage,
} from "./read.js";

const msg = (
  role: "user" | "assistant", content: string, id = crypto.randomUUID(),
): SessionMessage => ({ id, role, content });

/** A db stand-in that records the usage_ledger insert without a database. */
function fakeDb() {
  const inserted: Record<string, unknown>[] = [];
  return {
    inserted,
    from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }),
  } as never;
}

function fakeAi(value: unknown): AiClient {
  return {
    embed: vi.fn(),
    generateStream: vi.fn(),
    generateJson: vi.fn().mockResolvedValue({
      value, inputTokens: 400, outputTokens: 60, model: "gemini-2.5-flash",
    }),
  } as unknown as AiClient;
}

describe("hasReadableContent", () => {
  it("rejects a session with fewer than the floor of user messages", () => {
    expect(hasReadableContent([msg("user", "ok"), msg("assistant", "vâng")])).toBe(false);
  });

  it("accepts a session at the floor", () => {
    expect(hasReadableContent([msg("user", "mệt"), msg("assistant", "sao"), msg("user", "deadline")]))
      .toBe(true);
  });

  // The floor counts USER messages only. Red if it ever counts rows: a one-line session with a
  // long assistant reply would then buy a model call for nothing, on every such session forever.
  it("does not count assistant messages towards the floor", () => {
    const messages = [msg("user", "ok"), ...Array.from({ length: 9 }, () => msg("assistant", "…"))];
    expect(hasReadableContent(messages)).toBe(false);
    expect(MIN_USER_MESSAGES).toBe(2);
  });
});

describe("buildMoodPrompt", () => {
  it("labels the two roles differently so the model can tell them apart", () => {
    const prompt = buildMoodPrompt([msg("user", "hôm nay mệt"), msg("assistant", "sao vậy")]);
    expect(prompt).toContain("User: hôm nay mệt");
    expect(prompt).toContain("You: sao vậy");
  });

  // The rule that keeps the two mood readers in this system agreeing with each other. extract.ts:130
  // carries the same sentence; if one drifts, a note and its session disagree about what mood is.
  it("carries the difficult-topic guard verbatim from extract.ts", () => {
    expect(buildMoodPrompt([msg("user", "x")]))
      .toContain("A note about a difficult topic is not a bad mood");
  });

  it("says the assistant's own replies are context and not evidence", () => {
    expect(buildMoodPrompt([msg("user", "x")])).toContain("Score the USER's mood only");
  });

  it("asks for Vietnamese topics", () => {
    expect(buildMoodPrompt([msg("user", "x")])).toContain("Vietnamese");
  });
});

describe("readSessionMood", () => {
  it("returns the model's reading", async () => {
    const db = fakeDb();
    const ai = fakeAi({
      valence: 2, summary: "mệt vì deadline", topics: ["công việc"], confidence: 0.8,
    });

    const reading = await readSessionMood({ db, ai }, {
      userId: "u1", messages: [msg("user", "mệt quá"), msg("user", "deadline dí")],
    });

    expect(reading).toEqual({
      valence: 2, summary: "mệt vì deadline", topics: ["công việc"], confidence: 0.8,
    });
  });

  // The anti-fabrication path. Red if the code coerces a null valence into a number, or treats
  // it as an error -- both of which would manufacture the mood history the S3 spec forbids.
  it("passes a null valence through instead of inventing one", async () => {
    const db = fakeDb();
    const ai = fakeAi({ valence: null, summary: null, topics: [], confidence: 0.1 });

    const reading = await readSessionMood({ db, ai }, {
      userId: "u1", messages: [msg("user", "1111"), msg("user", "ok")],
    });

    expect(reading.valence).toBeNull();
  });

  it("clamps a valence the model returned outside 1..5 to null", async () => {
    const db = fakeDb();
    const ai = fakeAi({ valence: 9, summary: "x", topics: [], confidence: 0.5 });

    const reading = await readSessionMood({ db, ai }, {
      userId: "u1", messages: [msg("user", "a"), msg("user", "b")],
    });

    // Not clamped to 5: an out-of-range answer is an answer the model did not understand, and
    // the CHECK on mood_readings.valence would reject it anyway -- turning a bad reading into a
    // failed row rather than an absent one.
    expect(reading.valence).toBeNull();
  });

  it("caps topics at five", async () => {
    const db = fakeDb();
    const ai = fakeAi({
      valence: 3, summary: "x", confidence: 0.5,
      topics: ["a", "b", "c", "d", "e", "f", "g"],
    });

    const reading = await readSessionMood({ db, ai }, {
      userId: "u1", messages: [msg("user", "a"), msg("user", "b")],
    });

    expect(reading.topics).toHaveLength(5);
  });

  it("meters the call under the mood kind and the sweep source", async () => {
    const db = fakeDb();
    const ai = fakeAi({ valence: 3, summary: "x", topics: [], confidence: 0.5 });

    await readSessionMood({ db, ai }, {
      userId: "u1", messages: [msg("user", "a"), msg("user", "b")],
    });

    expect((db as never as ReturnType<typeof fakeDb>).inserted[0]).toMatchObject({
      user_id: "u1", kind: "mood", source: "sweep", input_tokens: 400, output_tokens: 60,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: FAIL — `./read.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/mood/read.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiClient } from "../ai/client.js";
import { recordUsage } from "../enrich/budget.js";

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface MoodReading {
  /** 1..5, the checkins.mood scale. Null means "not readable" -- see the S3 spec §1. */
  valence: number | null;
  summary: string | null;
  topics: string[];
  confidence: number | null;
}

/**
 * How many of the user's own messages a session needs before it is worth a model call.
 *
 * USER messages, not rows: an "ok" answered by a long assistant reply is still a session with
 * nothing to read, and counting rows would buy a Flash call for every one of them forever.
 */
export const MIN_USER_MESSAGES = 2;

/** At most this many topics survive, however many the model returns. */
const MAX_TOPICS = 5;

export function hasReadableContent(messages: SessionMessage[]): boolean {
  return messages.filter((m) => m.role === "user").length >= MIN_USER_MESSAGES;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    // Nullable and expected to BE null often. The prompt below only allows a number when the
    // session actually shows how the person felt.
    valence: { type: "integer", nullable: true },
    summary: { type: "string", nullable: true },
    topics: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: ["valence", "summary", "topics", "confidence"],
};

/** Exported for read.test.ts: the prompt's rules are the design, and drift in them is silent. */
export function buildMoodPrompt(messages: SessionMessage[]): string {
  return [
    "You read one person's chat session and report how THEY seemed. Return JSON only.",
    "",
    "Rules:",
    "- Score the USER's mood only. The assistant's replies are shown for context — so that a",
    "  short answer has something to refer back to — and are never evidence of how the user",
    "  feels.",
    "- valence is 1 to 5, and ONLY when the session shows how the person feels. A note about a",
    "  difficult topic is not a bad mood. Return null if you are inferring rather than reading:",
    "  a session with nothing personal in it has no reading, and that is a correct answer.",
    "- summary is one or two sentences in Vietnamese saying what you read and why.",
    "- topics are Vietnamese, at most " + MAX_TOPICS + ", naming what the session was about.",
    "- confidence is 0 to 1. When it is low, hedge the summary to match — do not write a",
    "  confident sentence beside a low number.",
    "",
    "The session:",
    ...messages.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.content}`),
  ].join("\n");
}

interface RawReading {
  valence?: unknown;
  summary?: unknown;
  topics?: unknown;
  confidence?: unknown;
}

/**
 * One Flash call per idle session, metered under its own ledger kind.
 *
 * Does NOT check the floor itself -- the caller does, before deciding whether to spend anything.
 * Keeping `hasReadableContent` separate is what lets the job write a `no_reading` row for a
 * one-line session without a model call at all.
 */
export async function readSessionMood(
  deps: { db: SupabaseClient; ai: AiClient },
  args: { userId: string; messages: SessionMessage[] },
): Promise<MoodReading> {
  const { db, ai } = deps;

  const { value, inputTokens, outputTokens, model } = await ai.generateJson<RawReading>({
    prompt: buildMoodPrompt(args.messages),
    schema: RESPONSE_SCHEMA,
  });

  await recordUsage(db, {
    userId: args.userId, kind: "mood", model, inputTokens, outputTokens,
    // "sweep", not a new source: usage_ledger.source (00027) answers "which part of the system
    // spent this", and this is a scheduled background job like the enrichment sweep. `kind`
    // already separates the two.
    source: "sweep",
  });

  // An out-of-range valence becomes null rather than being clamped into range. The model
  // returning 9 did not mean 5 -- it did not answer the question, and mood_readings.valence's
  // CHECK would reject the row outright, turning a bad reading into a FAILED session that gets
  // retried twice more for nothing.
  const rawValence = value.valence;
  const valence =
    typeof rawValence === "number" && Number.isInteger(rawValence) && rawValence >= 1 && rawValence <= 5
      ? rawValence
      : null;

  const rawConfidence = value.confidence;
  const confidence =
    typeof rawConfidence === "number" && rawConfidence >= 0 && rawConfidence <= 1
      ? rawConfidence
      : null;

  return {
    valence,
    summary: typeof value.summary === "string" && value.summary.trim() !== "" ? value.summary : null,
    topics: (Array.isArray(value.topics) ? value.topics : [])
      .filter((t): t is string => typeof t === "string" && t.trim() !== "")
      .slice(0, MAX_TOPICS),
    confidence,
  };
}
```

No `MOOD_MODEL` constant. `generateJson` takes no model argument — it runs on whatever the
`AiClient` implementation is configured with and reports it back as `model`, which is the value
`recordUsage` writes. An exported constant here would be a decision nothing acts on, and the
ledger would still record the real model beside it.

- [ ] **Step 4: Export it from the package**

In `packages/core/src/index.ts`, add beside the other enrich/assistant exports:

```ts
export {
  buildMoodPrompt, hasReadableContent, MIN_USER_MESSAGES, readSessionMood,
  type MoodReading, type SessionMessage,
} from "./mood/read.js";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/mood/ packages/core/src/index.ts
git commit -m "feat(core): read one chat session's mood, or decline to"
```

---

### Task 6: The sweep

**Files:**
- Create: `apps/api/src/mood/mood.service.ts`
- Create: `apps/api/test/mood-sweep.test.ts`

**Interfaces:**
- Consumes: `claim_sessions_for_mood` (Task 3), `readSessionMood` / `hasReadableContent` (Task 5), `isOverBudget` from `@cortex/core`.
- Produces:

  ```ts
  export interface MoodSweepDeps {
    db: SupabaseClient; ai: AiClient; budgetUsd: number; limit: number;
  }
  export interface MoodSweepResult {
    processed: number; noReading: number; failed: number; skippedOverBudget: number;
  }
  export function runMoodSweep(deps: MoodSweepDeps): Promise<MoodSweepResult>;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/mood-sweep.test.ts`. This is a unit test against a scripted Supabase client — the claim RPC's own behaviour is already pinned in Task 3 against a real database, and what is under test here is the sweep's control flow:

```ts
import { describe, expect, it, vi } from "vitest";
import { runMoodSweep } from "../src/mood/mood.service";

interface Claimed {
  user_id: string; session_id: string; session_start: string;
  session_end: string; message_count: number; prior_attempts: number;
}

/**
 * A scripted Supabase client. `upserts` and `updates` are what the assertions read: the whole
 * point of this sweep is WHICH rows it writes and which it deliberately leaves alone.
 */
function fakeDb(opts: {
  claims: Claimed[][];
  messages?: Record<string, { id: string; role: string; content: string }[]>;
  monthToDate?: Record<string, number>;
}) {
  const state = {
    upserts: [] as Record<string, unknown>[],
    updates: [] as { id: unknown; patch: Record<string, unknown> }[],
    claimCalls: [] as Record<string, unknown>[],
    round: 0,
  };
  const db = {
    async rpc(fn: string, params: Record<string, unknown>) {
      if (fn === "usage_month_to_date_usd") {
        return { data: opts.monthToDate?.[params.p_user_id as string] ?? 0, error: null };
      }
      state.claimCalls.push(params);
      return { data: opts.claims[state.round++] ?? [], error: null };
    },
    from(table: string) {
      if (table === "chat_messages") {
        return {
          select: () => ({
            eq: (_col: string, sessionId: string) => ({
              order: () => ({ data: opts.messages?.[sessionId] ?? [], error: null }),
            }),
          }),
        };
      }
      // mood_readings
      return {
        upsert: (row: Record<string, unknown>) => {
          state.upserts.push(row);
          return { select: () => ({ single: async () => ({ data: { id: `row-${state.upserts.length}` }, error: null }) }) };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: unknown) => { state.updates.push({ id, patch }); return { error: null }; },
        }),
      };
    },
  };
  return { db: db as never, state };
}

const ai = (value: unknown) => ({
  embed: vi.fn(), generateStream: vi.fn(),
  generateJson: vi.fn().mockResolvedValue({
    value, inputTokens: 100, outputTokens: 20, model: "gemini-2.5-flash",
  }),
}) as never;

const claimed = (over: Partial<Claimed> = {}): Claimed => ({
  user_id: "u1", session_id: "s1", message_count: 3, prior_attempts: 0,
  session_start: "2026-08-20T01:00:00Z", session_end: "2026-08-20T02:00:00Z", ...over,
});

describe("runMoodSweep", () => {
  it("resolves a readable session to ok, carrying the message ids as evidence", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed()], []],
      messages: { s1: [
        { id: "m1", role: "user", content: "mệt quá" },
        { id: "m2", role: "assistant", content: "sao vậy" },
        { id: "m3", role: "user", content: "deadline dí" },
      ] },
    });

    const result = await runMoodSweep({
      db, ai: ai({ valence: 2, summary: "mệt vì deadline", topics: ["công việc"], confidence: 0.8 }),
      budgetUsd: 10, limit: 20,
    });

    expect(result).toMatchObject({ processed: 1, noReading: 0, failed: 0, skippedOverBudget: 0 });
    // Claimed first as pending with the attempt counted, THEN resolved. A crash between the two
    // is what the stale-pending branch of the claim exists to recover.
    expect(state.upserts[0]).toMatchObject({ session_id: "s1", status: "pending", attempts: 1 });
    expect(state.updates[0]!.patch).toMatchObject({
      status: "ok", valence: 2, summary: "mệt vì deadline", topics: ["công việc"],
      evidence: ["m1", "m2", "m3"],
    });
  });

  // The anti-fabrication path end to end: a session the model declined to score is FINISHED, not
  // failed. Red if the sweep maps a null valence onto 'failed' -- which would retry it twice more
  // and then leave a permanently failed row for a session that was simply unremarkable.
  it("resolves a session the model declined to score as no_reading", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed()], []],
      messages: { s1: [
        { id: "m1", role: "user", content: "1111" },
        { id: "m2", role: "user", content: "ok" },
      ] },
    });

    const result = await runMoodSweep({
      db, ai: ai({ valence: null, summary: null, topics: [], confidence: 0.1 }),
      budgetUsd: 10, limit: 20,
    });

    expect(result).toMatchObject({ processed: 0, noReading: 1, failed: 0 });
    expect(state.updates[0]!.patch).toMatchObject({ status: "no_reading", valence: null });
  });

  it("writes no_reading without a model call when the session is below the floor", async () => {
    const generateJson = vi.fn();
    const { db, state } = fakeDb({
      claims: [[claimed({ message_count: 1 })], []],
      messages: { s1: [{ id: "m1", role: "user", content: "ok" }] },
    });

    const result = await runMoodSweep({
      db, ai: { embed: vi.fn(), generateStream: vi.fn(), generateJson } as never,
      budgetUsd: 10, limit: 20,
    });

    expect(result).toMatchObject({ noReading: 1 });
    expect(generateJson).not.toHaveBeenCalled();
    expect(state.updates[0]!.patch).toMatchObject({ status: "no_reading" });
  });

  // Spec §3's hard rule. Red the moment the pending upsert moves above the budget check: a user
  // over budget would then burn one of their three attempts on every tick, and a session would be
  // permanently 'failed' after three hours for a reason that has nothing to do with it.
  it("writes nothing at all for a user over budget", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed()], []],
      monthToDate: { u1: 999 },
    });

    const result = await runMoodSweep({ db, ai: ai({}), budgetUsd: 10, limit: 20 });

    expect(result).toMatchObject({ skippedOverBudget: 1, processed: 0 });
    expect(state.upserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("re-claims past an over-budget user so one user cannot starve the rest", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed({ user_id: "poor", session_id: "s-poor" })], [claimed({ user_id: "u2", session_id: "s2" })], []],
      messages: { s2: [
        { id: "m1", role: "user", content: "vui" }, { id: "m2", role: "user", content: "lắm" },
      ] },
      monthToDate: { poor: 999 },
    });

    const result = await runMoodSweep({
      db, ai: ai({ valence: 5, summary: "vui", topics: [], confidence: 0.9 }),
      budgetUsd: 10, limit: 20,
    });

    expect(result).toMatchObject({ processed: 1, skippedOverBudget: 1 });
    // The second claim must EXCLUDE the user the first round found over budget, or the claim is
    // ordered oldest-first and would hand back the same sessions forever.
    expect(state.claimCalls[1]!.p_exclude_user_ids).toEqual(["poor"]);
  });

  it("marks a session failed when the model throws, and keeps sweeping", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed(), claimed({ session_id: "s2" })], []],
      messages: {
        s1: [{ id: "m1", role: "user", content: "a" }, { id: "m2", role: "user", content: "b" }],
        s2: [{ id: "m3", role: "user", content: "c" }, { id: "m4", role: "user", content: "d" }],
      },
    });
    const generateJson = vi.fn()
      .mockRejectedValueOnce(new Error("429 rate limited"))
      .mockResolvedValueOnce({
        value: { valence: 4, summary: "ổn", topics: [], confidence: 0.7 },
        inputTokens: 10, outputTokens: 5, model: "gemini-2.5-flash",
      });

    const result = await runMoodSweep({
      db, ai: { embed: vi.fn(), generateStream: vi.fn(), generateJson } as never,
      budgetUsd: 10, limit: 20,
    });

    expect(result).toMatchObject({ processed: 1, failed: 1 });
    // Left 'pending', not 'failed': the claim's `attempts < 3` is what retires it, and writing
    // 'failed' here would retire it after ONE transient 429.
    expect(state.updates.find((u) => u.id === "row-1")?.patch).toMatchObject({ status: "pending" });
  });

  it("counts a re-claimed session's prior attempts rather than restarting at one", async () => {
    const { db, state } = fakeDb({
      claims: [[claimed({ prior_attempts: 2 })], []],
      messages: { s1: [
        { id: "m1", role: "user", content: "a" }, { id: "m2", role: "user", content: "b" },
      ] },
    });

    await runMoodSweep({
      db, ai: ai({ valence: 3, summary: "x", topics: [], confidence: 0.5 }),
      budgetUsd: 10, limit: 20,
    });

    expect(state.upserts[0]).toMatchObject({ attempts: 3 });
  });

  // Spec §8's backfill case. One tick is bounded by `limit` and by MAX_CLAIM_ROUNDS' early break
  // -- a round that did real work STOPS, deliberately, and leaves the rest to the next tick. So a
  // backlog larger than one page is only drained across ticks, and this asserts that it actually
  // is: two successive runMoodSweep calls, each seeing the next page.
  //
  // Red against an implementation that keeps looping until the claim is empty (which would let one
  // tick spend the whole month's budget in a single hour), and red against one that re-reads page
  // A on the second tick -- the fixture's second claim returns page B precisely because the real
  // claim excludes sessions that now hold a resolved row.
  it("drains a backlog larger than one page across two ticks", async () => {
    const pageA = [claimed({ session_id: "s1" }), claimed({ session_id: "s2" })];
    const pageB = [claimed({ session_id: "s3" })];
    const two = (id: string) => [
      { id: `${id}-m1`, role: "user", content: "a" },
      { id: `${id}-m2`, role: "user", content: "b" },
    ];
    const { db, state } = fakeDb({
      // Tick 1 claims page A and breaks (work happened). Tick 2 claims page B, then empty.
      claims: [pageA, pageB, []],
      messages: { s1: two("s1"), s2: two("s2"), s3: two("s3") },
    });
    const deps = {
      db, ai: ai({ valence: 3, summary: "x", topics: [], confidence: 0.5 }),
      budgetUsd: 10, limit: 2,
    };

    const first = await runMoodSweep(deps);
    expect(first).toMatchObject({ processed: 2, failed: 0 });
    // One claim only. A tick that kept looping would have consumed page B here too.
    expect(state.claimCalls).toHaveLength(1);

    const second = await runMoodSweep(deps);
    expect(second).toMatchObject({ processed: 1, failed: 0 });

    // Every session resolved exactly once across the two ticks -- no page reprocessed.
    expect(state.upserts.map((u) => u.session_id)).toEqual(["s1", "s2", "s3"]);
    expect(state.updates).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/api`
Expected: FAIL — `../src/mood/mood.service` does not exist.

- [ ] **Step 3: Write the sweep**

Create `apps/api/src/mood/mood.service.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { SESSION_IDLE_RESET_MS } from "@cortex/shared";
import {
  type AiClient, errorMessage, hasReadableContent, isOverBudget, readSessionMood,
  type SessionMessage,
} from "@cortex/core";

export interface MoodSweepDeps {
  db: SupabaseClient;
  ai: AiClient;
  budgetUsd: number;
  limit: number;
}

export interface MoodSweepResult {
  processed: number;
  noReading: number;
  failed: number;
  skippedOverBudget: number;
}

/**
 * Same bound, and for the same reason, as enrich.service.ts's MAX_CLAIM_ROUNDS: the claim is
 * global and ordered `session_end asc`, so an over-budget user holding the oldest unread sessions
 * sits permanently at the head of it. Each round can only run if EVERY session the last round
 * claimed was skipped for budget, which puts all of their owners in the exclusion set, which makes
 * the next claim strictly narrower -- the loop self-terminates and this caps the WORK.
 */
const MAX_CLAIM_ROUNDS = 5;

interface ClaimedSession {
  user_id: string;
  session_id: string;
  session_start: string;
  session_end: string;
  message_count: number;
  prior_attempts: number;
}

/**
 * Reads every idle session that has no mood reading yet.
 *
 * The claim is a pure select (00038) and this function does all the writing, in two steps: a
 * `pending` row with the attempt counted, then a resolution to 'ok' or 'no_reading'. Splitting
 * them is what makes a crash recoverable -- the claim's stale-pending branch picks the row back
 * up ten minutes later -- and it is also why the budget check has to come FIRST: a skip must
 * leave the world exactly as it found it, attempts included (S3 spec §3).
 */
export async function runMoodSweep(deps: MoodSweepDeps): Promise<MoodSweepResult> {
  const { db, ai, budgetUsd, limit } = deps;

  const result: MoodSweepResult = { processed: 0, noReading: 0, failed: 0, skippedOverBudget: 0 };
  const budgetChecked = new Map<string, boolean>();
  const overBudgetUsers = new Set<string>();

  for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
    const { data, error } = await db.rpc("claim_sessions_for_mood", {
      p_limit: limit,
      // Derived, never a second literal: resolveCurrentSession decides a session has ended by
      // this same constant, and a job that disagreed with it would read sessions the app still
      // considers open.
      p_idle_ms: SESSION_IDLE_RESET_MS,
      p_exclude_user_ids: [...overBudgetUsers],
    });
    if (error) throw error;

    const claimed = (data ?? []) as ClaimedSession[];
    if (claimed.length === 0) break;

    let attemptedAny = false;

    for (const session of claimed) {
      let over = budgetChecked.get(session.user_id);
      if (over === undefined) {
        over = await isOverBudget(db, session.user_id, budgetUsd, "sweep");
        budgetChecked.set(session.user_id, over);
      }
      if (over) {
        result.skippedOverBudget += 1;
        overBudgetUsers.add(session.user_id);
        continue;
      }
      attemptedAny = true;

      // Claim the row before doing anything expensive, counting the attempt. prior_attempts comes
      // from the claim's left join, so this needs no second read.
      const { data: row, error: claimErr } = await db.from("mood_readings").upsert(
        {
          user_id: session.user_id,
          session_id: session.session_id,
          status: "pending",
          attempts: session.prior_attempts + 1,
          message_count: session.message_count,
          session_start: session.session_start,
          session_end: session.session_end,
        },
        { onConflict: "session_id" },
      ).select("id").single();
      if (claimErr || !row) {
        result.failed += 1;
        console.error(`[mood] session ${session.session_id} claim failed: ${errorMessage(claimErr)}`);
        continue;
      }

      try {
        const { data: messageRows, error: msgErr } = await db.from("chat_messages")
          .select("id, role, content")
          .eq("session_id", session.session_id)
          .order("created_at", { ascending: true });
        if (msgErr) throw msgErr;
        const messages = (messageRows ?? []) as SessionMessage[];

        // The floor is checked HERE rather than inside readSessionMood so a one-line session
        // resolves without a model call at all.
        const reading = hasReadableContent(messages)
          ? await readSessionMood({ db, ai }, { userId: session.user_id, messages })
          : { valence: null, summary: null, topics: [], confidence: null };

        // A null valence is a FINISHED session, not a failed one. This mapping is the whole
        // anti-fabrication guarantee: nothing anywhere turns "nothing to read" into a number.
        const status = reading.valence === null ? "no_reading" : "ok";
        const { error: resolveErr } = await db.from("mood_readings").update({
          status,
          valence: reading.valence,
          summary: reading.summary,
          topics: reading.topics,
          confidence: reading.confidence,
          evidence: messages.map((m) => m.id),
        }).eq("id", row.id);
        if (resolveErr) throw resolveErr;

        if (status === "ok") result.processed += 1;
        else result.noReading += 1;
      } catch (err) {
        result.failed += 1;
        // Deliberately left 'pending' rather than written 'failed'. The claim's `attempts < 3` is
        // what retires a poison session; marking it failed here would retire it after ONE
        // transient 429, and nothing would ever look at it again.
        //
        // Never log message text -- the session id and the message only.
        console.error(
          `[mood] session ${session.session_id} failed: ${errorMessage(err).slice(0, 500)}`,
        );
      }
    }

    if (attemptedAny) break;
  }

  if (result.skippedOverBudget > 0) {
    console.warn(`[mood] ${result.skippedOverBudget} session(s) skipped -- monthly budget exceeded`);
  }
  return result;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm turbo run test --filter=@cortex/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mood/mood.service.ts apps/api/test/mood-sweep.test.ts
git commit -m "feat(api): sweep idle chat sessions into mood readings"
```

---

### Task 7: Schedule it

**Files:**
- Create: `apps/api/src/mood/mood.module.ts`
- Modify: `apps/api/src/root.module.ts` (register `MoodModule`)
- Modify: `apps/api/src/root.module.test.ts` (assert it is registered)

**`RootModule`, not `AppModule`.** `root.module.ts:6-10` states the rule directly: `AppModule` is
the module every e2e suite boots (`test/harness.ts`), and a cron module starts a real pg-boss
worker against a real Gemini client the moment it initialises. `RootModule` is what puts a cron in
the deployed process while keeping it out of every test's module graph — `main.ts` is its only
importer. Registering `MoodModule` in `AppModule` would give every e2e run an hourly job and a live
AI client.

**Interfaces:**
- Consumes: `runMoodSweep` (Task 6), `MOOD_LOCK_ID` (Task 4).
- Produces: the `mood.sweep` pg-boss queue, scheduled `0 * * * *`.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/root.module.test.ts`, extend the existing `imports both AppModule and
EnrichModule` case rather than adding a second one beside it — one assertion over the whole
`imports` array is what makes a *removal* red too:

```ts
import { MoodModule } from "./mood/mood.module";

  // A cron that is never registered is a feature that silently does not exist: nothing else in
  // the system references MoodModule, and it reads no table any other test touches, so without
  // this line the whole stage could ship dark and every suite would still be green.
  it("imports AppModule, EnrichModule and MoodModule", () => {
    const imports = Reflect.getMetadata("imports", RootModule) as unknown[];
    expect(imports).toContain(AppModule);
    expect(imports).toContain(EnrichModule);
    expect(imports).toContain(MoodModule);
  });
```

Rename the `it` title as shown; the two existing `toContain` lines stay exactly as they are.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/api`
Expected: FAIL — `./mood/mood.module` does not exist.

- [ ] **Step 3: Write the module**

Create `apps/api/src/mood/mood.module.ts`:

```ts
import { Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { assertTierAllowsRealData, createGeminiAi, createServiceClient } from "@cortex/core";
import { createBoss, startBoss, stopBoss } from "../queue/boss";
import { createPgLockSession, MOOD_LOCK_ID, withSweepLock } from "../queue/sweep-lock";
import { parseApiEnv } from "../env";
import { runMoodSweep } from "./mood.service";

const QUEUE = "mood.sweep";

/**
 * Stage S3's hourly job, deliberately its own module rather than a second schedule inside
 * EnrichModule: different cadence, different lock, different failure mode, and one onModuleInit
 * owning two schedules is how the second one comes to be forgotten.
 */
@Module({})
export class MoodModule implements OnModuleInit, OnApplicationShutdown {
  private boss?: PgBoss;

  async onModuleInit(): Promise<void> {
    const env = parseApiEnv(process.env);
    assertTierAllowsRealData(env.GEMINI_TIER, env.SUPABASE_URL);

    this.boss = createBoss(env.DATABASE_URL);
    await startBoss(this.boss);
    await this.boss.createQueue(QUEUE);

    const deps = {
      db: createServiceClient(),
      ai: createGeminiAi(env.GEMINI_API_KEY),
      budgetUsd: env.ENRICH_MONTHLY_BUDGET_USD,
      limit: 20,
    };

    await this.boss.work(QUEUE, async () => {
      const outcome = await withSweepLock(
        await createPgLockSession(env.DATABASE_URL),
        // NOT SWEEP_LOCK_ID. The enrichment sweep ticks every 60 seconds and holds its lock
        // across AI calls, so sharing an id would make this job lose most hours and read nothing,
        // logging "skipped" as though that were healthy.
        MOOD_LOCK_ID,
        () => runMoodSweep(deps),
      );
      if (!outcome.ran) {
        console.log("[mood] sweep skipped: another instance holds the mood lock");
        return;
      }
      const r = outcome.result;
      // The only evidence the job ran at all: a healthy hour and a dead cron are otherwise
      // identical in the logs, and at one tick an hour a dead cron takes a long time to notice.
      console.log(
        `[mood] sweep complete: processed=${r.processed} noReading=${r.noReading} ` +
          `failed=${r.failed} skippedOverBudget=${r.skippedOverBudget}`,
      );
    });

    // Hourly, not every minute. A session becomes eligible only four hours after its last
    // message, and nothing reads mood_readings (S3 spec §6), so the up-to-one-hour delay has no
    // consequence -- while a per-minute schedule would be 59 wasted full scans of chat_messages
    // every hour.
    await this.boss.schedule(QUEUE, "0 * * * *");
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.boss) await stopBoss(this.boss);
  }
}
```

- [ ] **Step 4: Register it**

In `apps/api/src/root.module.ts`, add `MoodModule` to the `imports` array beside `EnrichModule`:

```ts
import { MoodModule } from "./mood/mood.module";

@Module({ imports: [AppModule, EnrichModule, MoodModule] })
export class RootModule {}
```

Leave the file's doc comment in place and extend its first sentence to name both cron modules —
the reason it gives ("EnrichModule starts a real pg-boss worker … the moment it initialises") is
now true of two modules, and a reader who only sees one named will assume the other belongs in
`AppModule`.

- [ ] **Step 5: Run the tests**

Run: `pnpm turbo run test --filter=@cortex/api`
Expected: PASS.

- [ ] **Step 6: Verify against the real stack**

With the local Supabase stack and the API running, confirm the job actually fires and claims. The fastest honest check is to seed one idle session and wait for the top of the hour, or to invoke the sweep once directly:

```bash
pnpm --filter @cortex/api exec tsx -e "
  import { createServiceClient, createGeminiAi } from '@cortex/core';
  import { runMoodSweep } from './src/mood/mood.service';
  const r = await runMoodSweep({
    db: createServiceClient(), ai: createGeminiAi(process.env.GEMINI_API_KEY!),
    budgetUsd: 10, limit: 20,
  });
  console.log(r);
"
```

Expected: a `MoodSweepResult` with non-zero `processed` or `noReading` if any idle session exists, and rows in `mood_readings` to match. **Read the numbers before claiming the stage works** — a `{ processed: 0, noReading: 0, failed: 0, skippedOverBudget: 0 }` means the claim returned nothing, not that the job succeeded.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/mood/mood.module.ts apps/api/src/root.module.ts apps/api/src/root.module.test.ts
git commit -m "feat(api): run the mood sweep hourly on its own lock"
```

---

### Task 8: Deploy notes

**Files:**
- Modify: `docs/deploy.md` (the migration runbook section that `00034`/`00035` already use)

**Interfaces:**
- Consumes: migrations `00036`–`00038`.
- Produces: nothing code-level.

- [ ] **Step 1: Record the hosted migration step**

In `docs/deploy.md`, following the shape of the existing `00034`/`00035` entries, add:

```markdown
### Stage S3 (`00036`–`00038`)

Three migrations, all additive and all safe to apply to a live project:

- `00036_mood_readings.sql` — creates `mood_readings` (server-only: no policy, no grant block —
  see the file's header for why the omission is deliberate), an index on
  `chat_messages (session_id)`, and the `_test_policy_count` helper.
- `00037_usage_kind_mood.sql` — re-states `usage_ledger_kind_check` with `'mood'` added.
- `00038_claim_sessions_for_mood.sql` — creates the claim RPC, granted to `service_role` only.

Apply to the hosted project after the PR merges:

```bash
pnpm supabase db push          # no --local: this targets HOSTED
```

**Before the first hosted run**, count what the backfill will process and record the number here,
so the first hour's spend is a known quantity rather than a surprise:

```sql
select count(*) from (
  select session_id from public.chat_messages
  group by session_id
  having max(created_at) < now() - interval '4 hours'
) s;
```

No new environment variable. The job shares `ENRICH_MONTHLY_BUDGET_USD` with the enrichment sweep
and is distinguishable in `usage_ledger` by `kind = 'mood'`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/deploy.md
git commit -m "docs: record stage S3's hosted migration step"
```

---

## Verification before calling the stage done

Run the full gate and **read the `Cached:` line** — a turbo run reporting `N/N successful` can be
mostly replays, and with Docker down the database suites replay a previous green rather than
running at all:

```bash
pnpm turbo run test lint typecheck
```

Then confirm, by reading output rather than by assertion:

- [ ] `packages/db`'s suites ran against a live local stack (not replayed).
- [ ] `mood_readings` holds rows with a mix of `ok` and `no_reading` after a real sweep.
- [ ] `usage_ledger` holds rows with `kind = 'mood'` and a non-zero `cost_usd`.
- [ ] No row in `mood_readings` has `status = 'failed'` for a reason other than a genuine model error.

**What this stage cannot prove:** whether the readings are any good. No test asserts that a model
correctly identified a mood, and none can. That is a judgement over sustained use — the same kind
`2026-08-22` §11.4 describes — and it should be made deliberately later rather than assumed from a
green suite.
