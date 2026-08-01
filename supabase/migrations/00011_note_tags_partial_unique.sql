-- Soft-deleting a tag link then re-adding the same tag violated the total
-- unique constraint. Mirror what `tags` already does: partial unique index.
alter table public.note_tags drop constraint note_tags_note_id_tag_id_key;
create unique index note_tags_note_tag_uidx
  on public.note_tags (note_id, tag_id) where deleted_at is null;
