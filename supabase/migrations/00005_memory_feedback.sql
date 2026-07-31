create table public.memory_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in
    ('identity','preference','interest','project','habit','opinion','skill','relationship')),
  statement text not null,
  rationale text,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  salience real not null default 0.5,
  status text not null default 'proposed' check (status in ('proposed','active','archived','rejected')),
  evidence jsonb not null default '[]',
  embedding vector(1024),
  first_observed_at timestamptz,
  last_confirmed_at timestamptz,
  superseded_by uuid references public.memory_facts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index memory_facts_user_status_idx on public.memory_facts (user_id, status);
alter table public.memory_facts enable row level security;
-- Clients read their own facts; ALL mutations go through the API (service role).
create policy memory_facts_read_own on public.memory_facts
  for select to authenticated using (user_id = (select auth.uid()));
create trigger memory_facts_set_updated_at before update on public.memory_facts
  for each row execute function extensions.moddatetime(updated_at);

create table public.memory_revisions (   -- SERVER-ONLY audit log
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fact_id uuid not null references public.memory_facts(id) on delete cascade,
  action text not null check (action in ('propose','accept','reject','confirm','update','decay','archive')),
  actor text not null check (actor in ('agent','user')),
  diff jsonb,
  created_at timestamptz not null default now()
);
alter table public.memory_revisions enable row level security;

create table public.feedback_events (    -- SERVER-ONLY (write-through API)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_type text not null check (subject_type in
    ('tag','link','task','digest_item','memory_fact','chat_answer','para')),
  subject_id uuid,
  action text not null check (action in ('accept','reject','edit','thumbs_up','thumbs_down')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index feedback_events_user_idx on public.feedback_events (user_id, created_at desc);
alter table public.feedback_events enable row level security;

-- ============ Data API grants ============
-- Two independent layers: PostgREST needs a table-level GRANT before RLS is even
-- evaluated. memory_facts is client read-only (select policy only), so authenticated
-- gets ONLY select -- no insert/update/delete grant, which enforces the read-only
-- intent at the privilege layer as well as the policy layer. memory_revisions and
-- feedback_events are server-only: authenticated gets no DML grant at all, so a policy
-- accidentally added later cannot expose rows to authenticated on its own. (Supabase's
-- default ACL separately grants TRUNCATE/REFERENCES/TRIGGER/MAINTAIN to authenticated
-- on every new table; see 00009_revoke_default_grants.sql, which revokes those.)
grant select on public.memory_facts to authenticated;

grant select, insert, update, delete on public.memory_facts to service_role;
grant select, insert, update, delete on public.memory_revisions to service_role;
grant select, insert, update, delete on public.feedback_events to service_role;
