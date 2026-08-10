-- packages/db's enum-parity test reads notes_source_type_check out of pg_constraint and
-- asserts it matches @cortex/shared's noteSourceType exactly, so these two move together or
-- the suite fails. See the header of packages/shared/src/enums.ts.
alter table public.notes drop constraint notes_source_type_check;
alter table public.notes add constraint notes_source_type_check
  check (source_type in (
    'quick', 'web_clip', 'voice', 'email', 'telegram', 'import',
    'chat', 'assistant', 'web_search'
  ));
