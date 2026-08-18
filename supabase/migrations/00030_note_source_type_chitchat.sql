-- packages/db's enum-parity test reads notes_source_type_check out of pg_constraint and asserts
-- it matches @cortex/shared's noteSourceType exactly, IN ORDER, so these two move together or
-- the suite fails. 'chitchat' is appended LAST on both sides. See 00020, which set up this
-- mechanism, and the header of packages/shared/src/enums.ts.
--
-- 'chitchat' is a turn with nothing to file: "hello", "haha ok", "1111". It is still SAVED --
-- a capture surface that silently discards captures on a classifier's judgment is one you
-- cannot trust (stage C4 spec §6) -- but it is excluded from every note list (00031 and
-- packages/shared/src/notes/filters.ts) and from retrieval, so it never becomes a citation.
alter table public.notes drop constraint notes_source_type_check;
alter table public.notes add constraint notes_source_type_check
  check (source_type in (
    'quick','web_clip','voice','email','telegram','import',
    'chat','assistant','web_search','chitchat'
  ));
