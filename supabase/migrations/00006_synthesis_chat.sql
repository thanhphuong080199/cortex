create table public.digests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  period text not null check (period in ('weekly','monthly')),
  period_start date not null,
  period_end date not null,
  status text not null default 'pending' check (status in ('pending','ready','failed')),
  content_md text,
  clusters jsonb,
  model_meta jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, period, period_start)
);
alter table public.digests enable row level security;
create policy digests_read_own on public.digests
  for select to authenticated using (user_id = (select auth.uid()));

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.chat_sessions enable row level security;
create policy chat_sessions_own on public.chat_sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  citations jsonb,
  retrieval_meta jsonb,
  created_at timestamptz not null default now()
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
