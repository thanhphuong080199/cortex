create table public.digests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period text not null check (period in ('weekly','monthly')),
  period_start date not null,
  period_end date not null,
  status text not null default 'pending' check (status in ('pending','ready','failed')),
  content_md text,
  clusters jsonb,
  model_meta jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, period, period_start)
  -- Spec §6.7 lists digests as synced, but it's effectively append-only: a digest is
  -- generated once per (user, period, period_start) and only transitions
  -- pending -> ready/failed in place -- it is never hard-deleted by any planned Phase 0/1
  -- flow, so there is no tombstone state for PowerSync to represent. Intentionally no
  -- deleted_at; revisit if a future delete/retention flow is added for digests.
);
alter table public.digests enable row level security;
create policy digests_read_own on public.digests
  for select to authenticated using (user_id = (select auth.uid()));

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.chat_sessions enable row level security;
create policy chat_sessions_own on public.chat_sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create trigger chat_sessions_set_updated_at before update on public.chat_sessions
  for each row execute function extensions.moddatetime(updated_at);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  citations jsonb,
  retrieval_meta jsonb,
  created_at timestamptz not null default now()
  -- Spec §6.7 lists chat_messages as synced, but it's append-only within a session:
  -- individual messages are never edited or hard-deleted by any planned Phase 0/1 flow
  -- (only the parent chat_sessions row can be deleted, which cascades here). Intentionally
  -- no deleted_at; revisit if per-message deletion/redaction is added later.
);
create index chat_messages_session_idx on public.chat_messages (session_id, created_at);
alter table public.chat_messages enable row level security;
create policy chat_messages_own on public.chat_messages for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ============ Data API grants ============
-- Two independent layers: PostgREST needs a table-level GRANT before RLS is even
-- evaluated. digests is client read-only (select policy only), so authenticated
-- gets ONLY select -- the missing insert/update/delete grant enforces the read-only
-- intent at the privilege layer as well as the policy layer. chat_sessions and
-- chat_messages are client-writable (owner-scoped via RLS), so authenticated gets
-- full CRUD grants matching their "own" policies.
grant select on public.digests to authenticated;
grant select, insert, update, delete on public.chat_sessions to authenticated;
grant select, insert, update, delete on public.chat_messages to authenticated;

grant select, insert, update, delete on public.digests to service_role;
grant select, insert, update, delete on public.chat_sessions to service_role;
grant select, insert, update, delete on public.chat_messages to service_role;
