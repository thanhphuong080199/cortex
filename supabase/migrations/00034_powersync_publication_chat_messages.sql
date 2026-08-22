-- chat_messages joins the SCOPED powersync publication so the mobile chat can be read offline.
--
-- The publication is the layer BENEATH the sync rules: it is scoped by name rather than
-- FOR ALL TABLES precisely so a mistake in the rules cannot leak a server-only table
-- (docs/deploy.md §1). A table absent here replicates nothing no matter how correct its rule
-- looks, which is the failure this migration exists to prevent -- and
-- packages/db/src/test/sync-rules-isolation.test.ts asserts the publication's contents
-- directly, with no skip guard, so a missing ALTER is a red test rather than a silent
-- empty screen.
--
-- MUST ALSO BE APPLIED TO THE HOSTED PROJECT. `supabase db push` without --local targets
-- production; running it here is deliberate and is a deploy step, not a code change.
--
-- Guarded rather than a bare `alter publication ... add table`, following 00016's own
-- convention: that errors on a relation already in the publication, which is exactly what a
-- re-run against an already-migrated hosted project would hit.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'powersync' and schemaname = 'public' and tablename = 'chat_messages'
  ) then
    alter publication powersync add table public.chat_messages;
  end if;
end $$;

-- FINAL WHOLE-BRANCH REVIEW FINDING, CRITICAL: being in the publication is necessary but not
-- sufficient. Logical replication still requires the replicating role to have a table-level
-- SELECT grant -- the publication controls WHAT streams, GRANT controls WHO may read it, and
-- `bypassrls` (docs/deploy.md §1) only bypasses row-security policies, not this. Without this
-- grant, the hosted PowerSync connection (which replicates AS powersync_role) silently sees
-- zero rows from this table forever -- no error, just an empty transcript on every device --
-- and nothing in this repo's own tests could ever catch it: `powersync_role` does not exist
-- locally or in CI (e2e/powersync/up.sh replicates as postgres), so this table is guarded the
-- same way 00016's publication-creation block is, rather than a bare GRANT that would error on
-- the local/CI stack where the role is absent.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'powersync_role') then
    grant select on public.chat_messages to powersync_role;
  end if;
end $$;
