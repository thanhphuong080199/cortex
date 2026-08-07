-- supabase/migrations/00015_conflict_copy_link_kind.sql
-- Phase 1b: offline edits that diverge from the server produce a conflict COPY -- a new
-- note holding the losing text -- linked back to the note that won. Without this kind the
-- copy would be an orphan the user cannot trace to its original.
--
-- 00003 created links.kind as a bare check constraint rather than an enum, so widening it
-- is a constraint swap, not a type change. Existing rows all hold one of the three
-- original values, so the new constraint validates without a rewrite.

alter table public.links drop constraint if exists links_kind_check;

alter table public.links add constraint links_kind_check
  check (kind in ('semantic', 'manual', 'reference', 'conflict_copy'));
