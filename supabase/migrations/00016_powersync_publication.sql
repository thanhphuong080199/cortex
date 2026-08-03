-- The PowerSync replication publication, and the introspection helper that lets the test
-- suite prove what is in it (phase 1b spec §7.8).
--
-- WHY THIS IS A MIGRATION AND NOT A DASHBOARD STEP
--
-- PowerSync's own setup guide says to run `CREATE PUBLICATION powersync FOR ALL TABLES`.
-- For cortex that would put integrations.credentials, note_chunks, usage_ledger and
-- memory_revisions into the replication stream. Logical replication BYPASSES RLS, so those
-- rows would leave Postgres and be filtered only afterwards, by the sync rules. Scoping the
-- publication by name is a third isolation layer that does not depend on the sync rules being
-- correct -- and a layer that lives only in someone's dashboard session is a layer nobody can
-- review, diff, or restore.
--
-- Guarded rather than a bare CREATE: the hosted project's publication was created by hand
-- during Stage 1 (docs/deploy.md § "Phase 1b — PowerSync Cloud setup"), so this must be a
-- no-op there rather than an error. It is the local stack that gains the publication here.
-- If the two ever diverge, sync-rules-isolation.test.ts fails against whichever it runs on.
--
-- Deliberately NOT followed by `alter publication ... add table`: that errors on a relation
-- already in the publication, which is exactly the hosted case. Membership is asserted by the
-- test, not forced by the migration.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'powersync') then
    create publication powersync for table
      public.notes,
      public.tags,
      public.note_tags,
      public.links,
      public.media_items,
      public.checkins;
  end if;
end $$;

-- ============ Test-support introspection helper (service_role only) ============
-- Same rationale and shape as _test_has_table_privilege in 00001: packages/db's suite reaches
-- Postgres only through PostgREST, and pg_publication_tables is not reachable that way. Narrow,
-- read-only, schema metadata never row data, revoked from PUBLIC.
--
-- This is the assertion that makes the scoping above enforceable rather than aspirational: if
-- anyone widens the publication to FOR ALL TABLES, the six-table equality fails loudly.
create or replace function public._test_publication_tables(p_pub text)
returns table (tablename text)
language sql
security definer
set search_path = public
as $$
  select pt.tablename::text
  from pg_publication_tables pt
  where pt.pubname = p_pub
    and pt.schemaname = 'public';
$$;
revoke execute on function public._test_publication_tables(text) from public;
grant execute on function public._test_publication_tables(text) to service_role;
