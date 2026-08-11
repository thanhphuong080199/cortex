-- ============ The recency decay was an amplifier for any note the device dated forward ============
--
-- 00022 scored recency as `exp(-age / 180 days)` with age taken straight from `n.created_at`.
-- `created_at` is CLIENT-SUPPLIED: apps/api/src/sync/router.ts's notes PUT path passes
-- `data.created_at` from the device through to `notes.createWithId`, because the device owns the
-- id and the creation time of a note written offline. Nothing between the device and this
-- expression bounds it, and a negative age turns the decay's own arithmetic inside out.
--
-- Two failures, both reachable from one field:
--
-- 1. Amplification. A note dated two years ahead has age = -730 days, so the factor is
--    exp(+4.05) ~= 57, not a number in (0, 1]. That note sits at rank 1 of EVERY query that user
--    runs, ahead of any genuinely relevant note, and nothing in the result explains why -- the
--    score is a single opaque real. A sync bug that skews clocks forward (or one user who works
--    out that the field is writable) silently owns the top of their own search results.
--
-- 2. A 500 on every search that user makes. `extract(epoch from interval)` returns NUMERIC in
--    PG 14+, so this whole expression is numeric arithmetic and the exponent lands in
--    numeric_exp, which raises "value overflows numeric format" above ~6000. 6000 * 180 days is
--    ~2957 years, so the date has to be extreme -- but `9999-12-31` is exactly the sentinel a
--    bad import or a "no expiry" default writes, and it produces an exponent of ~16179. One such
--    row anywhere in the corpus poisons the whole function: the error is raised while projecting
--    the final select over `fused`, so the user's every POST /search returns 500 until someone
--    finds and edits that one note. (Note the double-precision limit of ~709.78 does NOT apply
--    here; verified against the local stack, exp(5999.7::numeric) succeeds and
--    exp(6000::numeric) raises.)
--
-- The fix is to clamp the age rather than to validate created_at at the write path. This
-- function is the thing that cannot survive a bad value, it is called by stage B, stage C and
-- phase 9's MCP server, and rows dated forward already exist in any database that has run the
-- old sync path -- a write-path check would protect none of them.
--
-- The lower bound (0) is the defect. The upper bound (100 years) is free: `score` is cast to
-- `real`, whose smallest denormal is ~1e-45, and `base` never exceeds ~0.033, so any note older
-- than ~48 years already scores exactly 0.0 and is already ordered by the `created_at desc`
-- tiebreaker. Clamping at 100 years therefore cannot change a single row's position -- what it
-- removes is the work: numeric exp() computes to full numeric precision, so a note dated year 1
-- (age/180 ~= 4100) makes Postgres materialise a 4100-digit number, per row, per query, for a
-- value that rounds to zero on the next line. Same client-controlled field, same reason to
-- bound it.
--
-- Everything else here is 00022 verbatim -- `create or replace` needs the whole body, and the
-- comments describe the body, so they travel with it. See 00022's header for why this is
-- SECURITY DEFINER, why `set search_path` must name `extensions` (pgvector's `<=>` lives there
-- and a SECURITY DEFINER search_path REPLACES the caller's rather than extending it), and why
-- the parameter type stays written as `extensions.vector(1536)`.
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
           -- [0 days, 100 years] because created_at comes from the device; see this file's
           -- header for the amplification and the numeric overflow that motivated each bound.
           * exp(
               -least(greatest(extract(epoch from (now() - n.created_at)) / 86400.0, 0), 36525.0)
               / 180.0
             )
           -- Provenance. A saved answer is not the user's own thinking, so it ranks below an
           -- own note of equal relevance rather than being hidden (life-domains spec §6.3,
           -- "provenance, not prohibition"). 'chat' is EXCLUDED: a question the user typed is
           -- their own words.
           * case when n.source_type in ('assistant', 'web_search') then 0.8 else 1.0 end
         )::real as score,
         fused.matched_by
  from fused
  join public.notes n on n.id = fused.note_id
  -- Redundant with the per-arm `c.user_id = p_user_id` / `n.user_id = p_user_id` filters
  -- above, and nearly free here. p_user_id is the ONLY thing separating two users' corpora --
  -- a redundant predicate on the final select turns a future missing filter in just ONE arm
  -- into a no-op instead of a cross-user leak.
  where n.user_id = p_user_id
    and n.deleted_at is null
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
