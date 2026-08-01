-- Supabase's pg_default_acl grants TRUNCATE, REFERENCES, TRIGGER, and (on Postgres 17+)
-- MAINTAIN to `anon` and `authenticated` on every newly created table in `public` --
-- independent of, and in addition to, whatever this repo's own migrations GRANT
-- explicitly. RLS does NOT apply to TRUNCATE (or MAINTAIN), so this silently defeats
-- the "no DML grant at all" isolation layer that 00002/00005/00007/00008's grant-block
-- comments describe for server-only tables (note_chunks, ingest_inbox, memory_revisions,
-- feedback_events, integrations, usage_ledger, allowed_emails) -- verified live: both
-- allowed_emails and integrations showed authenticated:TRUNCATE despite those tables'
-- comments claiming zero grant.
--
-- Not exploitable through PostgREST today (it never issues TRUNCATE/MAINTAIN), but it
-- silently applies to every table Phase 1 adds unless the default ACL itself is fixed.
--
-- Two separate statements are required:
--   1. `revoke ... on all tables` fixes every table these migrations already created.
--   2. `alter default privileges` changes the *default* ACL template so future
--      `create table` statements (Phase 1+) don't get these grants either.
revoke truncate, references, trigger, maintain on all tables in schema public from anon, authenticated;

alter default privileges in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;
