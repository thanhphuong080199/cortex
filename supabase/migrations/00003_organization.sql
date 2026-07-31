create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  name text not null,
  color text,
  created_by text not null default 'user' check (created_by in ('user','ai')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index tags_user_name_uidx on public.tags (user_id, lower(name)) where deleted_at is null;
alter table public.tags enable row level security;
create policy tags_own on public.tags for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.note_tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  note_id uuid not null references public.notes(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  source text not null check (source in ('user','ai')),
  status text not null default 'accepted' check (status in ('suggested','accepted','rejected')),
  confidence real,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (note_id, tag_id)
);
create index note_tags_user_note_idx on public.note_tags (user_id, note_id);
alter table public.note_tags enable row level security;
create policy note_tags_own on public.note_tags for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  from_note_id uuid not null references public.notes(id) on delete cascade,
  to_note_id uuid not null references public.notes(id) on delete cascade,
  kind text not null default 'semantic' check (kind in ('semantic','manual','reference')),
  status text not null default 'suggested' check (status in ('suggested','accepted','dismissed')),
  similarity real,
  rationale text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, from_note_id, to_note_id)
);
alter table public.links enable row level security;
create policy links_own on public.links for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ============ Data API grants ============
-- Two independent layers: PostgREST needs a table-level GRANT before RLS is even
-- evaluated. All three tables here are client-writable (owner-scoped via RLS), so
-- authenticated gets full CRUD grants matching its "own" policy; service_role gets
-- full CRUD grants too since server-side jobs manage these rows as well.
grant select, insert, update, delete on public.tags to authenticated;
grant select, insert, update, delete on public.note_tags to authenticated;
grant select, insert, update, delete on public.links to authenticated;

grant select, insert, update, delete on public.tags to service_role;
grant select, insert, update, delete on public.note_tags to service_role;
grant select, insert, update, delete on public.links to service_role;
