-- Stage C4 §5.3: chitchat is EXCLUDED from search_notes, not down-weighted.
--
-- The 0.8 multiplier below covers 'assistant' and 'web_search' -- material the user chose to
-- save, which should rank low but stay reachable. A multiplier is the wrong tool for banter: it
-- still lets "haha ok" win when nothing else matches, which is exactly the turn where a citation
-- does the most damage. Excluded from retrieval, the model is never fed the small talk it just
-- produced; excluded from /search, "what was that joke I made last month" does not come back.
-- That second cost is accepted and recorded (spec §5.3, §15) -- if it turns out wrong, the
-- reversal is to down-weight instead, which is a decision rather than a discovery.
--
-- The predicate is repeated in BOTH arms and in the final select. Not redundancy for its own
-- sake: the arms are joined with a full outer join, so a clause present in one arm only still
-- returns the row, and the final `where` is the same defence-in-depth the p_user_id predicate
-- already documents below.
--
-- Everything else is 00026 verbatim. See 00022's header for why this is SECURITY DEFINER, why
-- `set search_path` must name `extensions`, and why the parameter type stays written as
-- `extensions.vector(1536)`; see 00024's for the recency clamp.
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
  -- top 40 by rank -- for a user with more than 40 keyword matches the highest-ranked notes
  -- could be dropped entirely. Rank first (ranked CTE, ordered `order by rank`), then limit.
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
           -- quantities and any attempt to scale them into each other is a fudge factor.
           -- The SUM is the whole claim: two arms agreeing at rank 2 (1/62 + 1/62) beats one
           -- arm alone at rank 1 (1/61), and because every rank here is <= 40, a note in both
           -- arms beats a note in one arm for EVERY combination of ranks (2/100 > 1/61).
           -- packages/db's "fuses both arms" test pins that inequality in both directions.
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
           -- Recency. tau = 180 days for search (parent §6.8). The age is clamped to
           -- [0 days, 100 years] because created_at comes from the device; see 00024's
           -- header for the amplification and the numeric overflow that motivated each bound.
           * exp(
               -least(greatest(extract(epoch from (now() - n.created_at)) / 86400.0, 0), 36525.0)
               / 180.0
             )
           -- Provenance. A saved answer is not the user's own thinking, so it ranks below an
           -- own note of equal relevance rather than being hidden (life-domains spec §6.3,
           -- "provenance, not prohibition"). 'chat' is EXCLUDED: a question the user typed is
           -- their own words. 'chitchat' is not down-weighted here at all -- it never reaches
           -- this select.
           * case when n.source_type in ('assistant', 'web_search') then 0.8 else 1.0 end
         )::real as score,
         fused.matched_by
  from fused
  join public.notes n on n.id = fused.note_id
  -- Redundant with the per-arm `c.user_id = p_user_id` / `n.user_id = p_user_id` filters
  -- above, and nearly free here. p_user_id is the ONLY thing separating two users' corpora --
  -- a redundant predicate on the final select turns a future missing filter in just ONE arm
  -- into a no-op instead of a cross-user leak. The chitchat predicate rides along for exactly
  -- the same reason.
  where n.user_id = p_user_id
    and n.deleted_at is null
    and n.source_type <> 'chitchat'
  -- Deterministic tiebreaker: `score desc` alone leaves ties (e.g. two notes with identical
  -- RRF base, recency and provenance) in an unspecified order, which matters once Task 15
  -- exposes this over an API -- a non-reproducible top-N cut is a bad API contract even
  -- before it's a UX problem.
  order by score desc, n.created_at desc, n.id
  limit p_limit;
$$;
-- `create or replace` preserves the existing ACL, so these are no-ops today. Restated so the
-- current definition of this function is readable in one file: a future change that has to DROP
-- and recreate it (adding a parameter creates an overload rather than replacing -- 00023's
-- lesson) would otherwise silently ship a function granted to public.
revoke execute on function public.search_notes(uuid, text, extensions.vector(1536), int) from public;
grant execute on function public.search_notes(uuid, text, extensions.vector(1536), int) to service_role;
