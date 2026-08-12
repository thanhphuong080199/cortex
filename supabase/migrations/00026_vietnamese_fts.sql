-- The keyword arm, in the language the corpus is actually written in.
--
-- 00002's notes_fts_idx and 00022/00024's search_notes all used `to_tsvector('english', ...)`.
-- Both of Cortex's users write Vietnamese, and that configuration breaks it three ways. Each
-- was measured against this database before this migration was written, and each has a test in
-- packages/db/src/test/search-notes.test.ts:
--
--   1. English STOPWORDS delete Vietnamese words.
--        to_tsvector('english', 'an toàn do ta la no be') -> 'la' 'ta' 'toàn'
--      Four of seven words gone. The drop is symmetric (the query loses them too), so recall
--      survives -- what dies is PRECISION: "an toàn" degrades to a one-word search for 'toàn'
--      and matches every note merely containing it.
--
--   2. The English SNOWBALL STEMMER mangles and CONFLATES Vietnamese tokens.
--        to_tsvector('english', 'bảy') -> 'bải'
--        to_tsvector('english', 'bải') -> 'bải'
--      Searching "bải" returned a note about seven o'clock -- a confirmed false positive.
--
--   3. Diacritics were load-bearing. Typing Vietnamese without them is ordinary, not sloppy,
--      and it is precisely where the VECTOR arm is weakest -- so the keyword arm has to carry
--      it, and under 'english' it did not.
--
-- 'simple' + unaccent fixes all three. Note that unaccenting is NOT stemming and so does not
-- reintroduce (2): "bảy" folds to `bay` and "bải" to `bai`, which stay distinct. The collisions
-- it does create are exactly the words that differ only by tone mark (bay/bày/bảy -> `bay`),
-- which is the trade being bought deliberately -- recall over precision on ONE of two arms,
-- with RRF fusion and the vector arm still supplying the other signal.
--
-- ACCEPTED COST: 'simple' has no stopword list at all, so "của", "và", "là" are indexed and
-- contribute to ts_rank. Mild ranking noise, in exchange for never silently deleting a word.
create extension if not exists unaccent with schema extensions;

-- WHY A WRAPPER. `extensions.unaccent(text)` -- the ONE-argument form -- resolves its
-- dictionary through the search_path at call time, so Postgres types it STABLE, and a STABLE
-- function may not appear in an index expression:
--
--   ERROR:  functions in index expression must be marked IMMUTABLE
--
-- The TWO-argument form takes the dictionary explicitly, which removes that dependency and
-- makes IMMUTABLE an honest declaration rather than a lie told to get the index created. The
-- consequence of lying here would be an index silently inconsistent with the data after any
-- dictionary change, which no test would catch.
--
-- Lives in `public`, not `extensions`: search_notes runs `set search_path = public, extensions`
-- and notes_fts_idx must resolve it at index-build time too.
create or replace function public.immutable_unaccent(text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select extensions.unaccent('extensions.unaccent', $1)
$$;

-- No backfill needed: an expression index is computed by CREATE INDEX over every existing row.
drop index if exists public.notes_fts_idx;
create index notes_fts_idx on public.notes
  using gin (to_tsvector('simple', public.immutable_unaccent(content_text)));

-- Everything below is 00024 verbatim EXCEPT the three text-search calls in fts_ranked --
-- `create or replace` needs the whole body. The index above and all three calls below must name
-- the SAME configuration and the SAME wrapper: if they drift, the index stops being usable and
-- the results go quietly wrong rather than failing. See 00022's header for why this is SECURITY
-- DEFINER, why `set search_path` must name `extensions`, and why the parameter type stays
-- written as `extensions.vector(1536)`; see 00024's for the recency clamp.
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
             order by ts_rank(to_tsvector('simple', public.immutable_unaccent(n.content_text)),
                              websearch_to_tsquery('simple', public.immutable_unaccent(p_query))) desc
           ) as rank
    from public.notes n
    where n.user_id = p_user_id
      and n.deleted_at is null
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

-- immutable_unaccent KEEPS its default PUBLIC EXECUTE, deliberately.
--
-- The first draft of this migration revoked it, reasoning that a client role has no use for a
-- text helper. That took 17 db tests red at once with `permission denied for function
-- immutable_unaccent` and a pile of 42501s on plain `insert into notes`. The reason is that an
-- index expression is evaluated with the privileges of whichever role is WRITING the row, not
-- the index owner's and not a SECURITY DEFINER's -- so every role that can insert or update a
-- note must be able to execute it, or the write fails. `authenticated` writes notes on every
-- capture.
--
-- Nothing is exposed by this: the function reads no table, takes a string and returns a string.
-- unaccent itself, which it wraps, is PUBLIC-executable for the same reason.
