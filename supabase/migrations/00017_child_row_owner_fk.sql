-- note_tags and links each carry their own user_id AND a foreign key into notes (and, for
-- note_tags, into tags). FK checks bypass RLS, so the single-column FKs let a client-writable
-- row point at another user's note: the sync rule buckets the child on its own user_id, so a
-- cross-owner row ships another user's note id straight into the wrong device. 00014 fixed this
-- exact shape for notes.media_item_id; it was never extended to these four columns, which is
-- what phase 1b made client-writable with client-chosen FK values.
--
-- Same technique as 00014: a unique index on the referenced (id, user_id) pair, then a composite
-- FK. Unlike media_item_id, all four columns here are NOT NULL with an unconditional
-- `on delete cascade` already, so the composite version keeps that -- no column-list needed.

create unique index notes_id_user_uidx on public.notes (id, user_id);
create unique index tags_id_user_uidx on public.tags (id, user_id);

alter table public.note_tags drop constraint note_tags_note_id_fkey;
alter table public.note_tags
  add constraint note_tags_note_id_fkey
  foreign key (note_id, user_id) references public.notes (id, user_id)
  on delete cascade;

alter table public.note_tags drop constraint note_tags_tag_id_fkey;
alter table public.note_tags
  add constraint note_tags_tag_id_fkey
  foreign key (tag_id, user_id) references public.tags (id, user_id)
  on delete cascade;

alter table public.links drop constraint links_from_note_id_fkey;
alter table public.links
  add constraint links_from_note_id_fkey
  foreign key (from_note_id, user_id) references public.notes (id, user_id)
  on delete cascade;

alter table public.links drop constraint links_to_note_id_fkey;
alter table public.links
  add constraint links_to_note_id_fkey
  foreign key (to_note_id, user_id) references public.notes (id, user_id)
  on delete cascade;
