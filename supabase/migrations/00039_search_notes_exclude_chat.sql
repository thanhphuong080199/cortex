-- search_notes stops recalling the user's own questions back at them.
--
-- THE REPORT (2026-08-23). Asked "Game này có hướng dẫn gì không", the assistant answered partly
-- out of "liet ke vai cach di", "Tìm đi" and "thông tin này có cập nhật mới nhất chưa vậy" --
-- three fragments from unrelated conversations. Its own reply names what they are: "bạn có nhắn
-- mình 'liet ke vai cach di' và 'Tìm đi'" -- you MESSAGED me. Every one of them is something the
-- user said TO the assistant, not something they recorded, and turn.ts stamps exactly those
-- `source_type = 'chat'`. 00031 already decided small talk is not recallable; a question the user
-- asked is no more a thing they wrote down than "haha ok" is, and it has been in the corpus at
-- full weight ever since 00020 introduced the value.
--
-- WHY NOT A DISTANCE FLOOR, which is what this migration was originally going to be. The three
-- strings were embedded against that question with the exact model, dimensionality and
-- normalisation gemini.ts uses (gemini-embedding-001, 1536 dims, L2-normalised) and compared by
-- cosine similarity:
--
--     0.745  true positive   hỏi cách build nhân vật trong game
--     0.669  FALSE POSITIVE  liet ke vai cach di
--     0.648  FALSE POSITIVE  Tìm đi
--     0.648  true positive   dạo này đang chơi game mobile, định tải Genshin Impact về chơi thử
--     0.626  FALSE POSITIVE  thông tin này có cập nhật mới nhất chưa vậy
--     0.598  unrelated       hôm nay trời đẹp quá
--     0.488  unrelated       cá hồi giàu omega-3, tốt cho mắt
--
-- A false positive outscores a true positive, so NO threshold separates them: any floor that
-- drops "liet ke vai cach di" also drops the Genshin note the question was actually about.
-- (Asymmetric taskType, which this repo does not send, separates them by 0.001; SEMANTIC_
-- SIMILARITY by 0.015. Both are noise on a nine-string fixture, not a mechanism.) Distance was
-- never the signal. WHAT THE NOTE IS is the signal, and that is a column, not a metric.
--
-- The prompt still sees recent questions, and sees them correctly: selectContext feeds them in
-- as conversation history, dated and in order. Retrieval delivering them a SECOND time, undated
-- and stripped of the exchange they belonged to, is the whole defect.
--
-- PAIRED WITH A turn.ts CHANGE, and it is not optional. `source_type = 'chat'` was written for
-- `wantsAnswer`, which is also true for a statement that happens to ask something ("Các loại
-- thực phẩm nào tốt cho mắt, dạo này hơi mỏi mắt"). That note records a fact about the user, and
-- with this migration in place stamping it 'chat' would silently make it unrecallable forever.
-- turn.ts now stamps 'chat' for a PURE question only. Deploying this migration without that
-- change loses recall on every dual-intent note the corpus already has.
--
-- CREATE OR REPLACE, not drop-and-create: the return type is unchanged (00032 and 00035 had to
-- drop precisely because theirs was not), so the ACL survives and the revoke/grant pair those
-- two migrations needed is neither present nor required here. packages/db's
-- default-grants.test.ts runs against whatever signature is live and covers this either way.
--
-- The body is 00035 verbatim apart from the three `source_type` predicates. See 00022's header
-- for why this is SECURITY DEFINER and why the parameter type stays written as
-- `extensions.vector(1536)`; 00024's for the recency clamp; 00031's for the chitchat exclusion;
-- 00032's for created_at; 00035's for source_type.

create or replace function public.search_notes(
  p_user_id uuid,
  p_query text,
  p_embedding extensions.vector(1536),
  p_limit int
)
returns table (
  note_id uuid, title text, snippet text, created_at timestamptz, score real, matched_by text,
  source_type text
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
      -- 00039. 'chat' joins 'chitchat': neither is something the user recorded.
      and n.source_type not in ('chitchat', 'chat')
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
      and n.source_type not in ('chitchat', 'chat')
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
           -- own note of equal relevance rather than being hidden. 'chat' and 'chitchat' never
           -- reach this select at all as of 00039, so this `case` is now only about saved
           -- answers -- 00035's note about 'chat' being deliberately excluded from the
           -- down-weight is obsolete, not because the reasoning changed but because the rows
           -- are gone.
           * case when n.source_type in ('assistant', 'web_search') then 0.8 else 1.0 end
         )::real as score,
         fused.matched_by,
         n.source_type
  from fused
  join public.notes n on n.id = fused.note_id
  -- Redundant with the per-arm filters above, and nearly free. p_user_id is the ONLY thing
  -- separating two users' corpora -- a redundant predicate here turns a future missing filter
  -- in just ONE arm into a no-op instead of a cross-user leak. The source_type predicate is
  -- here for the same belt-and-braces reason.
  where n.user_id = p_user_id
    and n.deleted_at is null
    and n.source_type not in ('chitchat', 'chat')
  order by score desc, n.created_at desc, n.id
  limit p_limit;
$$;
