-- Installed into `extensions`, not `public`: pgvector's whole surface (the `vector`
-- type, operators, index access methods) should not land in the PostgREST-exposed
-- `public` schema, matching how Supabase itself places pgcrypto in `extensions`.
-- This also matters for hosted Supabase specifically: a hosted project may already
-- have `vector` installed in `extensions`, in which case an unqualified
-- `create extension if not exists vector` (no schema) would no-op against that
-- existing install rather than move it, silently leaving this repo's assumption
-- (that `vector(1024)` resolves via schema-qualification below) untested until the
-- very first hosted push. `supabase/config.toml`'s `extra_search_path = ["public",
-- "extensions"]` (and the matching default search_path for postgres/anon/authenticated)
-- means `vector(1024)` in table definitions below still resolves unqualified -- verified
-- after `supabase db reset` in this repo's CI/local runs; if that ever stops resolving,
-- qualify the column types (`extensions.vector(1024)`) rather than moving the extension
-- back to `public`.
create extension if not exists vector with schema extensions;

-- Plain-text projection of markdown for FTS. IMMUTABLE so it can back a generated column.
create or replace function public.strip_markdown(md text)
returns text
language sql
immutable
as $$
  select trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(coalesce(md, ''), '```[^`]*```', ' ', 'g'),  -- fenced code blocks
            '!?\[([^\]]*)\]\([^)]*\)', '\1', 'g'),                      -- links/images -> keep label
          '^#{1,6}\s+', '', 'gm'),                                       -- heading markers
        '[*_~`>#|]', '', 'g'),                                           -- inline md punctuation
      '\s+', ' ', 'g')                                                   -- collapse whitespace
  );
$$;
-- NOTE: this function backs a STORED GENERATED column (notes.content_text). A stored
-- generated column's value is computed once at INSERT/UPDATE time and persisted --
-- `create or replace function` here does NOT retroactively recompute existing rows'
-- content_text. Any future change to this function's logic must also run
-- `update notes set content = content;` (or an equivalent no-op write) to force
-- Postgres to recompute content_text for pre-existing rows.

-- moddatetime: Supabase ships this contrib extension, so it's preferred here over a
-- hand-rolled plpgsql trigger function. It maintains an `updated_at timestamptz` column
-- via `before update ... for each row execute function extensions.moddatetime(updated_at)`
-- triggers, attached per table in the migration where that table is defined (see notes
-- in 00002; tasks/review_queue in 00004; memory_facts in 00005; chat_sessions in 00006;
-- integrations in 00007). Installed into `extensions` for the same reason as `vector`
-- above -- keep extension surface out of the PostgREST-exposed `public` schema.
create extension if not exists moddatetime with schema extensions;

-- ============ Test-support introspection helpers (service_role only) ============
-- packages/db's test suite talks to Postgres only through PostgREST (SUPABASE_URL +
-- keys), with no direct psql/pg connection available. These two SECURITY DEFINER
-- functions expose narrow, read-only pg_catalog/information_schema lookups through
-- that same PostgREST/RPC path so tests can assert on *actual* live grants and check
-- constraint definitions -- not a hand-maintained mirror of them that could drift.
-- Both are revoked from PUBLIC and granted to service_role only: they read schema
-- metadata (never row data), but there's no reason for anon/authenticated to call them.
create or replace function public._test_has_table_privilege(p_role text, p_table text, p_privilege text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select has_table_privilege(p_role, ('public.' || p_table)::regclass, p_privilege);
$$;
revoke execute on function public._test_has_table_privilege(text, text, text) from public;
grant execute on function public._test_has_table_privilege(text, text, text) to service_role;

create or replace function public._test_check_constraint_def(p_table text, p_constraint text)
returns text
language sql
security definer
set search_path = public
as $$
  select pg_get_constraintdef(oid)
  from pg_constraint
  where connamespace = 'public'::regnamespace
    and conrelid = ('public.' || p_table)::regclass
    and conname = p_constraint
    and contype = 'c';
$$;
revoke execute on function public._test_check_constraint_def(text, text) from public;
grant execute on function public._test_check_constraint_def(text, text) to service_role;
