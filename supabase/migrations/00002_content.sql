-- ============ notes (synced, client-writable) ============
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  content text not null default '',
  content_text text generated always as (public.strip_markdown(content)) stored,
  source_type text not null default 'quick'
    check (source_type in ('quick','web_clip','voice','email','telegram','import')),
  source_meta jsonb not null default '{}',
  lifecycle text not null default 'inbox'
    check (lifecycle in ('inbox','active','evergreen','archived')),
  para_category text check (para_category in ('project','area','resource','archive')),
  para_status text not null default 'none' check (para_status in ('none','suggested','accepted')),
  pinned boolean not null default false,
  word_count int,
  enriched_at timestamptz,
  last_reviewed_at timestamptz,
  review_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index notes_user_updated_idx on public.notes (user_id, updated_at desc);
create index notes_user_lifecycle_idx on public.notes (user_id, lifecycle);
create index notes_fts_idx on public.notes using gin (to_tsvector('english', content_text));

alter table public.notes enable row level security;
create policy notes_own on public.notes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- notes_user_updated_idx (above) and Phase 1's PowerSync ordering both depend on
-- updated_at actually advancing on every UPDATE -- nothing else in this schema does
-- that on its own, so maintain it with a trigger rather than trusting callers.
create trigger notes_set_updated_at before update on public.notes
  for each row execute function extensions.moddatetime(updated_at);

-- ============ note_chunks (SERVER-ONLY: embeddings) ============
create table public.note_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references public.notes(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  token_count int,
  content_hash text,
  embedding vector(1024),
  embedding_model text,
  embedded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (note_id, chunk_index)
);
create index note_chunks_user_note_idx on public.note_chunks (user_id, note_id);
create index note_chunks_embedding_idx on public.note_chunks
  using hnsw (embedding vector_cosine_ops);
alter table public.note_chunks enable row level security;  -- no policies: server-only

-- ============ attachments (synced metadata) ============
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references public.notes(id) on delete cascade,
  storage_path text not null,
  mime text,
  size_bytes bigint,
  kind text check (kind in ('audio','image','file')),
  transcript_status text not null default 'none'
    check (transcript_status in ('none','pending','done','failed')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index attachments_user_note_idx on public.attachments (user_id, note_id);
alter table public.attachments enable row level security;
create policy attachments_own on public.attachments
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ============ ingest_inbox (SERVER-ONLY: idempotent inbound) ============
create table public.ingest_inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('telegram','email','clipper')),
  external_id text not null,
  payload jsonb not null default '{}',
  status text not null default 'received' check (status in ('received','processed','failed')),
  note_id uuid references public.notes(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Per-user, not global: a global (channel, external_id) unique constraint would
  -- (a) block two different users from ever having the same channel external_id, and
  -- (b) leak cross-tenant existence via the unique-violation error itself.
  unique (user_id, channel, external_id)
);
alter table public.ingest_inbox enable row level security;  -- no policies: server-only

-- ============ Data API grants ============
-- The local Supabase CLI (matching the hosted/cloud default) does not auto-expose new
-- tables to the Data API roles; PostgREST needs table-level GRANTs before RLS is even
-- evaluated. Grants and RLS are two independent layers: client-writable tables (notes,
-- attachments) get both a grant AND a matching RLS policy. Server-only tables
-- (note_chunks, ingest_inbox) get no DML grant (select/insert/update/delete) at all
-- for authenticated — access is denied at the privilege layer before RLS is ever
-- evaluated, so a future policy accidentally added to one of those tables cannot
-- expose rows to authenticated on its own. Note that Supabase's default ACL still
-- grants TRUNCATE/REFERENCES/TRIGGER/MAINTAIN to authenticated on every new table
-- regardless of these explicit grants; 00009_revoke_default_grants.sql revokes those.
grant select, insert, update, delete on public.notes to authenticated;
grant select, insert, update, delete on public.attachments to authenticated;

-- service_role bypasses RLS but still needs table-level grants to be routed by PostgREST.
-- All four tables, including the server-only ones, are server-managed via service_role.
grant select, insert, update, delete on public.notes to service_role;
grant select, insert, update, delete on public.note_chunks to service_role;
grant select, insert, update, delete on public.attachments to service_role;
grant select, insert, update, delete on public.ingest_inbox to service_role;
