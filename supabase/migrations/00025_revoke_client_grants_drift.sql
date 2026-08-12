-- ============ The hosted project grants every client role full DML on every table ============
--
-- Found on 2026-08-12 while verifying the phase 2 deploy. On the HOSTED project, both `anon`
-- and `authenticated` hold INSERT/SELECT/UPDATE/DELETE on all 23 tables in `public` --
-- including the server-only ones (note_chunks, note_enrichment, usage_ledger, integrations,
-- ingest_inbox, memory_revisions, feedback_events, allowed_emails) whose own grant-block
-- comments in 00002/00007/00008 state they get "no DML grant at all". On a LOCAL
-- `supabase db reset` those same tables grant nothing. The migrations are identical; the
-- baselines are not.
--
-- ROOT CAUSE, and why revoking the grants alone would have been cosmetic. It is not drift that
-- happened once -- it is regenerated on every `create table`. pg_default_acl for schema public,
-- owner `postgres`:
--
--   hosted:  anon=arwd/postgres   authenticated=arwd/postgres
--   local:   (no anon or authenticated entry at all)
--
-- `arwd` is exactly INSERT/SELECT/UPDATE/DELETE. So every table any future migration creates is
-- born with full client DML on the hosted project and with none locally. 00009 already proved
-- this template is reachable from a migration: it revoked truncate/references/trigger/maintain,
-- and hosted's `arwd` is precisely `arwdDxtm` minus the `Dxtm` it removed. This migration
-- finishes that job for the DML half, which 00009 never claimed to cover.
--
-- NOTHING BELOW IS EXPLOITABLE TODAY, and that is the reason to fix it now rather than at
-- incident time. Verified against the live project before writing this:
--   * RLS is enabled on all 23 tables.
--   * All 15 policies in `public` target `authenticated`. ZERO target `anon` or PUBLIC, so
--     every `anon` grant is inert: reads return no rows, writes are rejected.
--   * The 8 tables below have RLS on with ZERO policies, so `authenticated` is equally inert.
--   * digests and memory_facts have exactly one policy each, `for select` -- so their
--     INSERT/UPDATE/DELETE grants are inert too.
-- Every privilege revoked here is therefore already unusable. This cannot break a working code
-- path, because there is no working code path that uses one.
--
-- What it buys is the layer the design says exists. 00007's comment describes "two independent
-- layers: PostgREST needs a table-level GRANT before RLS is even evaluated", and in production
-- only one of the two has been present. One future policy written `for all` instead of
-- `for select`, or targeted at the wrong role, is currently the whole distance between a
-- server-only table and a client-writable one.
--
-- It also makes the test suite mean something. packages/db's cross-user isolation suite runs
-- against the LOCAL stack, so it has been proving a stricter configuration than production
-- runs. After this, hosted and local agree and those tests describe both.
--
-- CONSEQUENCE FOR FUTURE MIGRATIONS -- this is the load-bearing part. Once the default ACL
-- stops granting DML, a new client-facing table gets NO privileges until a migration grants
-- them explicitly, and `authenticated` then fails with `42501 permission denied` BEFORE RLS is
-- ever consulted -- which reads like an RLS misconfiguration and is not one. deploy.md already
-- records that trap for 00013's grant block ("load-bearing"); this makes it the rule everywhere
-- rather than a quirk of tables created after 00009. That is the same model local has always
-- had, which is why local is where it gets caught.

-- ---- 1. anon: no privileges on anything in public ----
-- Provably inert (no policy admits anon), and anon reaches PostgREST only before sign-in.
revoke all privileges on all tables in schema public from anon;

-- ---- 2. authenticated: no DML on the server-only tables ----
-- RLS-enabled with zero policies. Listed explicitly rather than as `all tables` so that adding
-- a table to this set is a deliberate edit, and so a future client-facing table is never swept
-- in by a wildcard.
revoke select, insert, update, delete on
  public.allowed_emails,
  public.feedback_events,
  public.ingest_inbox,
  public.integrations,
  public.memory_revisions,
  public.note_chunks,
  public.note_enrichment,
  public.usage_ledger
  from authenticated;

-- ---- 3. authenticated: read-only tables stay read-only in the grants, not just the policy ----
-- Both are server-written and client-read (digests_read_own / memory_facts_read_own are
-- `for select`). Keep SELECT; drop the writes the policy already refuses.
revoke insert, update, delete on public.digests, public.memory_facts from authenticated;

-- ---- 4. Stop the template from regenerating all of the above ----
-- Without this the next `create table` restores full client DML on the hosted project and the
-- three statements above become a one-off cleanup that silently stops being true.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- service_role is deliberately untouched everywhere above: it is the enrichment pipeline's and
-- search_notes' only route to the tables RLS hides, and revoking from it would take the API
-- down. `revoke ... from anon, authenticated` never implies it.
