create table public.integrations (      -- SERVER-ONLY (credentials never reach clients)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  provider text not null check (provider in ('telegram','google_calendar','slack','email_alias')),
  external_id text not null,
  credentials jsonb,                    -- encrypt via Supabase Vault when first real secret lands (phase 4)
  status text not null default 'active' check (status in ('active','revoked','error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, external_id)
);
alter table public.integrations enable row level security;

create table public.calendar_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  note_id uuid not null references public.notes(id) on delete cascade,
  event_id text not null,
  event_meta jsonb,
  event_start timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.calendar_links enable row level security;
create policy calendar_links_own on public.calendar_links for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.usage_ledger (      -- SERVER-ONLY cost control
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  kind text not null check (kind in ('embed','chat','tag','digest','memory','transcribe')),
  model text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric,
  created_at timestamptz not null default now()
);
create index usage_ledger_user_idx on public.usage_ledger (user_id, created_at desc);
alter table public.usage_ledger enable row level security;

-- ============ Data API grants ============
-- Two independent layers: PostgREST needs a table-level GRANT before RLS is even
-- evaluated. integrations and usage_ledger are server-only: authenticated gets NO
-- grant at all, so a policy accidentally added later cannot expose rows to
-- authenticated on its own. calendar_links is client-writable (owner-scoped via
-- RLS), so authenticated gets full CRUD grants matching its "own" policy.
grant select, insert, update, delete on public.calendar_links to authenticated;

grant select, insert, update, delete on public.integrations to service_role;
grant select, insert, update, delete on public.calendar_links to service_role;
grant select, insert, update, delete on public.usage_ledger to service_role;
