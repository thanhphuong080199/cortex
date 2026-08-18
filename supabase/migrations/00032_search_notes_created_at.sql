-- search_notes returns the note's own created_at, so the assistant can anchor relative time.
--
-- WHY THIS DROPS INSTEAD OF REPLACING. `create or replace function` cannot change a function's
-- return type -- Postgres answers `cannot change return type of existing function` -- and this
-- adds a column to `returns table`. Every prior change to this function (00024, 00026, 00031)
-- could use replace because none of them touched the signature; this one cannot.
--
-- DROPPING DISCARDS THE ACL. 00026's footer called this exact case: "a future change that has
-- to DROP and recreate it would otherwise silently ship a function granted to public." The
-- revoke/grant pair at the bottom is therefore load-bearing here in a way it was not there --
-- without it this function is executable by `anon`, and it is SECURITY DEFINER over note_chunks.
--
-- The body is 00031 verbatim apart from the two added lines. See 00022's header for why this is
-- SECURITY DEFINER and why the parameter type stays written as `extensions.vector(1536)`;
-- 00024's for the recency clamp; 00031's for the chitchat exclusion.
drop function if exists public.search_notes(uuid, text, extensions.vector(1536), int);

create function public.search_notes(
  p_user_id uuid,
  p_query text,
  p_embedding extensions.vector(1536),
  p_limit int
)
returns table (
  note_id uuid, title text, snippet text, created_at timestamptz, score real, matched_by text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with vector_arm as (
    select c.note_id,
           row_number() over (order by c.embedding <=> p_embedding) as rank
    from public.note_chunks c
    join public.notes n on n.id = c.note_id
    where c.user_id = p_user_id
      and n.deleted_at is null
      and n.source_type <> 'chitchat'
      and c.embedding is not null
    order by c.embedding <=> p_embedding
    limit 40
  ),
  -- One row per note: a long note with three matching chunks must not out-rank a short one
  -- three times over.
  vector_best as (
    select note_id, min(rank) as rank from vector_arm group by note_id
  ),
  -- Postgres evaluates window functions before the statement's own ORDER BY/LIMIT, so an
  -- unordered `limit 40` over a row_number() column takes an ARBITRARY 40 rows, not the
  -- top 40 by rank. Rank first, then limit.
  fts_ranked as (
    select n.id as note_id,
           row_number() over (
             order by ts_rank(to_tsvector('simple', public.immutable_unaccent(n.content_text)),
                              websearch_to_tsquery('simple', public.immutable_unaccent(p_query))) desc
           ) as rank
    from public.notes n
    where n.user_id = p_user_id
      and n.deleted_at is null
      and n.source_type <> 'chitchat'
      and to_tsvector('simple', public.immutable_unaccent(n.content_text))
          @@ websearch_to_tsquery('simple', public.immutable_unaccent(p_query))
  ),
  fts_arm as (
    select note_id, rank from fts_ranked order by rank limit 40
  ),
  fused as (
    select coalesce(v.note_id, f.note_id) as note_id,
           -- Reciprocal Rank Fusion, k = 60. RRF needs no score normalisation between the two
           -- arms, which is the point: cosine distance and ts_rank are not comparable
           -- quantities. The SUM is the whole claim: two arms agreeing at rank 2 beats one arm
           -- alone at rank 1, and because every rank here is <= 40 that holds for EVERY
           -- combination of ranks (2/100 > 1/61).
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + f.rank), 0) as base,
           case
             when v.note_id is not null and f.note_id is not null then 'both'
             when v.note_id is not null then 'vector'
             else 'fts'
           end as matched_by
    from vector_best v
    full outer join fts_arm f on f.note_id = v.note_id
  )
  select n.id,
         n.title,
         left(n.content_text, 240) as snippet,
         -- The addition. Aliased to nothing: the column name in `returns table` is what the
         -- RPC's JSON keys off, and `n.created_at` already matches it.
         n.created_at,
         (
           fused.base
           -- Recency. tau = 180 days for search (parent §6.8), clamped to [0 days, 100 years]
           -- because created_at comes from the device; see 00024's header.
           * exp(
               -least(greatest(extract(epoch from (now() - n.created_at)) / 86400.0, 0), 36525.0)
               / 180.0
             )
           -- Provenance. A saved answer is not the user's own thinking, so it ranks below an
           -- own note of equal relevance rather than being hidden. 'chat' is EXCLUDED: a
           -- question the user typed is their own words. 'chitchat' never reaches this select.
           * case when n.source_type in ('assistant', 'web_search') then 0.8 else 1.0 end
         )::real as score,
         fused.matched_by
  from fused
  join public.notes n on n.id = fused.note_id
  -- Redundant with the per-arm filters above, and nearly free. p_user_id is the ONLY thing
  -- separating two users' corpora -- a redundant predicate here turns a future missing filter
  -- in just ONE arm into a no-op instead of a cross-user leak.
  where n.user_id = p_user_id
    and n.deleted_at is null
    and n.source_type <> 'chitchat'
  order by score desc, n.created_at desc, n.id
  limit p_limit;
$$;

-- NOT a no-op this time. `drop function` above took the ACL with it, so without these two lines
-- the function is recreated with PostgreSQL's default EXECUTE grant to public -- on a SECURITY
-- DEFINER function that reads note_chunks, a table with RLS enabled and no policies precisely
-- because nothing but this function should ever read it.
revoke execute on function public.search_notes(uuid, text, extensions.vector(1536), int) from public;
grant execute on function public.search_notes(uuid, text, extensions.vector(1536), int) to service_role;

-- Test-support introspection helper, companion to 00001's _test_has_table_privilege but for
-- functions rather than tables. Added here, not invented as a one-off in the test file, because
-- the drop above is the one risk this migration introduces that no test running as service_role
-- would ever catch: packages/db's suite talks to Postgres only through PostgREST, with no direct
-- psql connection, so proving the revoke/grant pair actually landed needs a narrow, read-only
-- pg_catalog lookup exposed the same way 00001's helpers are. Revoked from PUBLIC and granted to
-- service_role only, same reasoning as 00001.
create or replace function public._test_has_function_privilege(p_role text, p_function text, p_privilege text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select has_function_privilege(p_role, p_function::regprocedure, p_privilege);
$$;
revoke execute on function public._test_has_function_privilege(text, text, text) from public;
grant execute on function public._test_has_function_privilege(text, text, text) to service_role;
