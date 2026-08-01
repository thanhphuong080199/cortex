create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid references public.notes(id) on delete set null,
  title text not null,
  details text,
  status text not null default 'suggested' check (status in ('suggested','todo','doing','done','dropped')),
  source text not null default 'user' check (source in ('user','ai')),
  source_span jsonb,
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index tasks_user_status_idx on public.tasks (user_id, status);
alter table public.tasks enable row level security;
create policy tasks_own on public.tasks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function extensions.moddatetime(updated_at);

create table public.review_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references public.notes(id) on delete cascade unique,
  due_at timestamptz not null,
  interval_days real not null default 3,
  ease real not null default 2.0,
  last_result text check (last_result in ('kept','snoozed','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Synced table (spec §6.7) -- PowerSync needs a tombstone for deletes rather than a
  -- hard DELETE, matching the Global Constraint that synced tables carry deleted_at.
  deleted_at timestamptz
);
create index review_queue_user_due_idx on public.review_queue (user_id, due_at);
alter table public.review_queue enable row level security;
create policy review_queue_own on public.review_queue for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create trigger review_queue_set_updated_at before update on public.review_queue
  for each row execute function extensions.moddatetime(updated_at);

-- ============ Data API grants ============
-- Two independent layers: PostgREST needs a table-level GRANT before RLS is even
-- evaluated. Both tables here are client-writable (owner-scoped via RLS), so
-- authenticated gets full CRUD grants matching its "own" policy; service_role gets
-- full CRUD grants too since server-side jobs manage these rows as well.
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert, update, delete on public.review_queue to authenticated;

grant select, insert, update, delete on public.tasks to service_role;
grant select, insert, update, delete on public.review_queue to service_role;
