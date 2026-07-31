create extension if not exists vector;

-- Plain-text projection of markdown for FTS. IMMUTABLE so it can back a generated column.
create or replace function public.strip_markdown(md text)
returns text
language sql
immutable
as $$
  select trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(coalesce(md, ''), '```[^`]*```', ' ', 'g'),  -- fenced code blocks
            '!?\[([^\]]*)\]\([^)]*\)', '\1', 'g'),                      -- links/images -> keep label
          '^#{1,6}\s+', '', 'gm'),                                       -- heading markers
        '[*_~`>#|]', '', 'g'),                                           -- inline md punctuation
      '\s+', ' ', 'g')                                                   -- collapse whitespace
  );
$$;
