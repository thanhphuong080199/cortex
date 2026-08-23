-- ============ Stage S3: one mood reading per idle chat session ============
--
-- NOT a second checkins writer. turn.ts:226 already writes a check-in whenever extractNote reads
-- a mood out of a single message, while the user is looking at the screen and with a `mood` event
-- yielded so the UI can show it. turn.ts:223-225 records why a JOB must not write that table: it
-- would write at arbitrary times, for old content, with no screen to undo it on. This table is
-- how S3 obeys that constraint rather than working around it.
--
-- SERVER-ONLY, and deliberately WITHOUT a grant to client roles. Since 00025 §4 ran `alter default
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
  -- No FK, despite chat_sessions being real: 00006 created public.chat_sessions and gave
  -- chat_messages.session_id an FK to it. Deliberately not mirrored here -- mood_readings is a
  -- server-only audit table with zero consumers this stage (S3 spec §6), so referential
  -- integrity buys nothing observable yet, and this table's own schema test inserts rows against
  -- session ids with no backing chat_sessions row at all (it only cares about the UNIQUE/CHECK
  -- constraints below), which an FK would turn into 23503 failures instead.
  session_id    uuid not null unique,
  -- 'no_reading' is a SUCCESS, not a failure: a session of "ok cảm ơn" must be allowed to
  -- conclude that nothing is readable, and must never be retried. Keeping that distinction in the
  -- schema rather than in the prompt means a prompt regression cannot quietly turn a null reading
  -- into an invented number.
  -- A session is retired once attempts >= 3 (see 00038's claim_sessions_for_mood), but its status
  -- stays 'pending' -- no code path in this stage ever writes 'failed' (mood.service.ts leaves a
  -- transient error 'pending' on purpose). A row with status='pending' and attempts>=3 IS the
  -- terminal/exhausted state, not one still in flight.
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

-- No new index on chat_messages here. chat_messages_session_idx (00006) is already
-- (session_id, created_at) -- session_id leading, so it already serves the claim's
-- group-by-session_id scan, and it already carries created_at for the min/max(created_at)
-- aggregates Task 3's claim RPC needs. A same-named second index would just collide; a
-- differently-named one would be a pure duplicate. See the S3 spec §3 for the volume at which
-- the grouped scan needs replacing outright rather than indexing.

alter table public.mood_readings enable row level security;

create trigger mood_readings_set_updated_at before update on public.mood_readings
  for each row execute function extensions.moddatetime(updated_at);

-- "Deliberately WITHOUT a grant block" above means no grant to anon/authenticated -- service_role
-- still needs its own explicit GRANT, same as every other server-only table (memory_revisions and
-- feedback_events at 00005:64-65, note_enrichment at 00018:31): a table's owner-only default ACL
-- covers the migrating role, not service_role, and BYPASSRLS only skips policies, not the
-- table-level privilege check PostgREST enforces first.
grant select, insert, update, delete on public.mood_readings to service_role;

-- ---- test helper ----
-- A grant test cannot see a policy: with no client grant a policy is inert, so adding one would not
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
