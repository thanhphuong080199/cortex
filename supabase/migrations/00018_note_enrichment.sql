-- ============ note_enrichment (SERVER-ONLY: the sweep's bookkeeping) ============
--
-- Deliberately NOT columns on `notes`. `notes` is client-writable: PowerSync uploads PATCHes
-- against it and the sync router's generic writer upserts {...op.data, id, user_id}, so a
-- modified client could PATCH a hash and pin its own note out of the pipeline forever, or
-- into it forever. That is the shape of phase 1b's round-2 finding #1, which 00017 closes for
-- child-row ownership.
--
-- `notes.enriched_at` stays where it is and keeps its own job: the client-visible "pending
-- enrichment" flag (design spec §8.2). It is the only thing about enrichment a device sees.
create table public.note_enrichment (
  note_id uuid primary key references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- md5(content_text) at the last success of each step. TWO hashes, because the steps commit
  -- independently: if extraction fails the embedding work is already durable, and the next
  -- sweep re-runs only the step still missing (parent spec §9, "per-step idempotency").
  -- The box (stage C) stamps extracted_hash synchronously; the sweep stamps embedded_hash.
  embedded_hash text,
  extracted_hash text,
  attempts int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
create index note_enrichment_user_idx on public.note_enrichment (user_id);
alter table public.note_enrichment enable row level security;  -- no policies: server-only
create trigger note_enrichment_set_updated_at before update on public.note_enrichment
  for each row execute function extensions.moddatetime(updated_at);

-- No grant to `authenticated`: PostgREST needs a table-level GRANT before RLS is even
-- evaluated, so the missing grant is a second, independent layer (see 00009).
grant select, insert, update, delete on public.note_enrichment to service_role;

-- ============ The sweep ============
--
-- Keyed on md5(content_text), NOT on `enriched_at < updated_at`. `notes_set_updated_at`
-- (00002) fires moddatetime on EVERY update, so a timestamp predicate:
--   1. re-satisfies itself the moment enrichment writes -- a loop that re-enriches every note
--      every sweep, forever; and
--   2. bills a full re-embed plus a model call when a note is merely pinned or archived.
-- The hash form is also what makes an edit arriving DURING enrichment safe: each step records
-- the hash of the text it actually read, so a note edited mid-job ends with a hash that no
-- longer matches and the next sweep takes it. A timestamp form writing now() would mark that
-- edit as already done and drop it silently.
create or replace function public.claim_notes_for_enrichment(p_limit int)
returns table (note_id uuid, user_id uuid, content_text text, content_hash text)
language sql
security definer
set search_path = public
as $$
  select n.id, n.user_id, n.content_text, md5(n.content_text)
  from public.notes n
  left join public.note_enrichment e on e.note_id = n.id
  where n.deleted_at is null
    and n.updated_at < now() - interval '90 seconds'
    and coalesce(e.attempts, 0) < 5
    and (e.embedded_hash  is distinct from md5(n.content_text)
      or e.extracted_hash is distinct from md5(n.content_text))
  order by n.updated_at asc
  limit p_limit
  for update of n skip locked;
$$;
revoke execute on function public.claim_notes_for_enrichment(int) from public;
grant execute on function public.claim_notes_for_enrichment(int) to service_role;

-- ============ Test-support helper (service_role only) ============
-- Fourth of the narrow SECURITY DEFINER readers 00001 describes. packages/db's tests reach
-- Postgres only through PostgREST, so md5() over a GENERATED column is otherwise
-- unobservable -- a test would have to reimplement strip_markdown() in TypeScript to predict
-- it, which would assert the reimplementation rather than the column.
create or replace function public._test_md5_content_text(p_note_id uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select md5(content_text) from public.notes where id = p_note_id;
$$;
revoke execute on function public._test_md5_content_text(uuid) from public;
grant execute on function public._test_md5_content_text(uuid) to service_role;

-- Fifth: backdating a note's updated_at for the debounce-window fixtures below.
--
-- `notes_set_updated_at` (00002) is unconditional -- it overwrites updated_at with now() on
-- EVERY update to the row, including one that explicitly sets updated_at to a chosen value in
-- the same statement. (Proven directly: `update notes set updated_at = <5 min ago> where id =
-- ...` through PostgREST leaves updated_at at now(), not 5 minutes ago.) That's the trigger
-- doing its job (updated-at.test.ts pins it down), but it means note-enrichment.test.ts's
-- fixtures -- which must age a note past claim_notes_for_enrichment's 90-second debounce
-- window WITHOUT touching its content, in order to isolate the hash predicate from the
-- timestamp one -- cannot do that through an ordinary PostgREST update. `SET LOCAL
-- session_replication_role = replica` disables user-defined triggers (moddatetime included)
-- for the one statement inside this function only, and reverts automatically at the end of the
-- RPC's transaction.
create or replace function public._test_backdate_note(p_note_id uuid, p_when timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  set local session_replication_role = replica;
  update public.notes set updated_at = p_when where id = p_note_id;
end;
$$;
revoke execute on function public._test_backdate_note(uuid, timestamptz) from public;
grant execute on function public._test_backdate_note(uuid, timestamptz) to service_role;
