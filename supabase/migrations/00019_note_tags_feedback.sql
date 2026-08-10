-- Derives a feedback_events row from a note_tags status transition.
--
-- A TRIGGER rather than application code, because accepting a suggestion reaches this table
-- on at least three paths -- web writes it directly through PostgREST, mobile writes locally
-- and uploads through POST /sync/upload, and phase 9 adds MCP -- and a path that forgets
-- loses the signal permanently. The parent spec wants this accumulating from day one so the
-- phase-8 memory layer starts with months of it.
--
-- This does NOT contradict parent §9's "why not DB-trigger-driven", which is about where job
-- ENQUEUEING lives. Deriving an audit row from a status transition is bookkeeping, the same
-- category as moddatetime.
--
-- Consequence worth stating: mobile suggestion review works OFFLINE. It is a local UPDATE
-- riding sync like everything else, and this fires when the router writes it down.
create or replace function public.note_tags_record_feedback()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.feedback_events (user_id, subject_type, subject_id, action, payload)
  values (
    new.user_id,
    'tag',
    new.id,
    case new.status when 'accepted' then 'accept' else 'reject' end,
    jsonb_build_object('note_id', new.note_id, 'tag_id', new.tag_id, 'confidence', new.confidence)
  );
  return new;
end;
$$;

-- The WHEN clause is the whole guard: only a transition OUT OF 'suggested' INTO a decision
-- counts. Re-saving a suggestion, or updating an already-accepted row, must record nothing --
-- otherwise the signal phase 8 reads is inflated by ordinary writes.
create trigger note_tags_feedback
  after update on public.note_tags
  for each row
  when (old.status = 'suggested' and new.status in ('accepted', 'rejected'))
  execute function public.note_tags_record_feedback();
