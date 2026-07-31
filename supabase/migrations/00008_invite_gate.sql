create table public.allowed_emails (
  -- Trigger below compares case-insensitively; normalize storage too so an allow-list
  -- entry can't silently fork into two rows ("Foo@Bar.com" vs "foo@bar.com").
  email text primary key check (email = lower(email)),
  note text,
  created_at timestamptz not null default now()
);
alter table public.allowed_emails enable row level security;  -- no policies: server-only

-- Trigger-based gate. (Supabase "before user created" auth hooks exist, but a trigger
-- is testable locally and sufficient at this scale; revisit if Supabase deprecates it.)
create or replace function public.check_email_allowed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.allowed_emails where lower(email) = lower(new.email)) then
    raise exception 'Signup not allowed for %', new.email;
  end if;
  return new;
end;
$$;

create trigger check_email_allowed_trigger
  before insert on auth.users
  for each row execute function public.check_email_allowed();

-- ============ Data API grants ============
-- allowed_emails is server-only: it holds the invite allow-list, never client data.
-- Grants and RLS are two independent layers (see 00002_content.sql). Here authenticated
-- gets no DML grant (select/insert/update/delete) at all, so PostgREST denies access at
-- the privilege layer before RLS is ever evaluated -- a future policy accidentally added
-- to this table cannot expose it to clients on its own. Only service_role (used by
-- makeUser/tests and by Task 12's seeding) can read or write it. (Supabase's default ACL
-- separately grants TRUNCATE/REFERENCES/TRIGGER/MAINTAIN to authenticated on every new
-- table; see 00009_revoke_default_grants.sql, which revokes those.)
grant select, insert, update, delete on public.allowed_emails to service_role;

-- check_email_allowed() is security definer and only ever invoked by the
-- check_email_allowed_trigger above (fired by auth.users inserts, which run as
-- supabase_auth_admin). It has no legitimate direct caller from the Data API, so strip
-- the default PUBLIC execute grant Postgres attaches to every new function -- unlike
-- strip_markdown() (00001_extensions_helpers.sql), which backs a generated column that
-- `authenticated` genuinely needs to read/recompute, this function must not be directly
-- invocable by anon/authenticated/PUBLIC at all.
revoke execute on function public.check_email_allowed() from public;
