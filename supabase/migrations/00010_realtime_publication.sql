-- Supabase ships supabase_realtime as an EMPTY publication; without this no
-- postgres_changes events broadcast at all (spec §3).
--
-- Guarded rather than a bare ALTER: CI starts the stack with `-x realtime` and the
-- publication is created by the Postgres image's init scripts, not by this repo, so a
-- bare ALTER would hard-fail on any environment where that assumption ever changes.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime add table public.notes, public.tags, public.note_tags;
