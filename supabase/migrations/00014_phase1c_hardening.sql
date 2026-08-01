-- Phase 1c hardening: two omissions from 00013 that get more expensive to fix the
-- longer they wait.
--
-- 1. checkins/flashcards get updated_at + moddatetime, per 00002's rule: PowerSync
--    ordering (phase 1b) depends on updated_at advancing on EVERY update. Both tables
--    are mutable state -- checkins are soft-deleted via UPDATE, flashcards get their
--    whole SM-2 scheduling block rewritten on every review (phase 6). Without the
--    column, an incremental sync cursor has nothing to order on. media_items stays
--    without one deliberately: append-mostly, same as tags/links.
--
-- 2. notes.media_item_id becomes owner-scoped. FK checks bypass RLS, so the 00013
--    single-column FK let a note reference another user's media_items row. The
--    composite FK (media_item_id, user_id) -> media_items (id, user_id) makes
--    cross-user references impossible at the constraint level. `on delete set null
--    (media_item_id)` (PG 15+ column list) nulls only the FK column -- a bare
--    `set null` would null user_id too.

-- ============ updated_at ============
alter table public.checkins
  add column updated_at timestamptz not null default now();
create trigger checkins_set_updated_at before update on public.checkins
  for each row execute function extensions.moddatetime(updated_at);

alter table public.flashcards
  add column updated_at timestamptz not null default now();
create trigger flashcards_set_updated_at before update on public.flashcards
  for each row execute function extensions.moddatetime(updated_at);

-- ============ owner-scoped media_item_id ============
-- The FK needs a unique index on the referenced column pair; (id) alone is already
-- unique, so (id, user_id) is too -- this index exists purely to satisfy the FK.
create unique index media_items_id_user_uidx on public.media_items (id, user_id);

alter table public.notes drop constraint notes_media_item_id_fkey;
alter table public.notes
  add constraint notes_media_item_id_fkey
  foreign key (media_item_id, user_id) references public.media_items (id, user_id)
  on delete set null (media_item_id);
