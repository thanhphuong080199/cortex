-- Hybrid retrieval, parent spec §6.8. ONE function, so the API, the assistant (stage C) and
-- phase 9's MCP server all rank identically -- three implementations would drift.
--
-- SECURITY DEFINER and called with service_role, because note_chunks has RLS enabled with NO
-- policies and is invisible to `authenticated` by design. p_user_id is therefore the ONLY
-- thing separating two users' corpora, and callers MUST pass the id from a verified JWT and
-- never from a request body. packages/db's isolation test covers it with real rows for both
-- users -- an assertion that one user reads zero rows is vacuous if the other has none either
-- (§15.5, issue-log E3).
--
-- `set search_path = public, extensions`: pgvector's `<=>` operator lives in `extensions`
-- (00001_extensions_helpers.sql), not `public`. A SECURITY DEFINER function's `set search_path`
-- fully replaces the caller's search_path for the duration of the call -- it does not merely
-- extend it -- so `search_path = public` alone leaves the operator unresolvable and this
-- function fails at CREATE time with "operator does not exist: extensions.vector <=> extensions.vector".
-- Verified locally: `set search_path = public` alone does not apply (db reset errors out);
-- adding `extensions` fixes it. The parameter type stays schema-qualified as
-- `extensions.vector(1536)` regardless (00012's lesson): unqualified `vector(1536)` resolves
-- locally via config.toml's extra_search_path but fails against the hosted project, where the
-- migration-applying role's search_path does not include `extensions`.
create or replace function public.search_notes(
  p_user_id uuid,
  p_query text,
  p_embedding extensions.vector(1536),
  p_limit int
)
returns table (note_id uuid, title text, snippet text, score real, matched_by text)
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
  -- top 40 by rank -- for a user with more than 40 keyword matches the highest-ranked notes
  -- could be dropped entirely. Rank first (ranked CTE, ordered `order by rank`), then limit.
  fts_ranked as (
    select n.id as note_id,
           row_number() over (
             order by ts_rank(to_tsvector('english', n.content_text),
                              websearch_to_tsquery('english', p_query)) desc
           ) as rank
    from public.notes n
    where n.user_id = p_user_id
      and n.deleted_at is null
      and to_tsvector('english', n.content_text) @@ websearch_to_tsquery('english', p_query)
  ),
  fts_arm as (
    select note_id, rank from fts_ranked order by rank limit 40
  ),
  fused as (
    select coalesce(v.note_id, f.note_id) as note_id,
           -- Reciprocal Rank Fusion, k = 60. RRF needs no score normalisation between the two
           -- arms, which is the point: cosine distance and ts_rank are not comparable
           -- quantities and any attempt to scale them into each other is a fudge factor.
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
         (
           fused.base
           -- Recency. tau = 180 days for search (parent §6.8).
           * exp(-extract(epoch from (now() - n.created_at)) / 86400.0 / 180.0)
           -- Provenance. A saved answer is not the user's own thinking, so it ranks below an
           -- own note of equal relevance rather than being hidden (life-domains spec §6.3,
           -- "provenance, not prohibition"). 'chat' is EXCLUDED: a question the user typed is
           -- their own words.
           * case when n.source_type in ('assistant', 'web_search') then 0.8 else 1.0 end
         )::real as score,
         fused.matched_by
  from fused
  join public.notes n on n.id = fused.note_id
  where n.deleted_at is null
  order by score desc
  limit p_limit;
$$;
revoke execute on function public.search_notes(uuid, text, extensions.vector(1536), int) from public;
grant execute on function public.search_notes(uuid, text, extensions.vector(1536), int) to service_role;
