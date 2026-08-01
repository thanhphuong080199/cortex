-- Provider switch Voyage -> Gemini (life-domains spec §1): voyage-3.5 (1024-dim) is
-- replaced by gemini-embedding-001 at 1536-dim (MRL truncation; MTEB-equal to the full
-- 3072-dim output at half the storage). No enrichment pipeline exists yet, so both
-- columns are empty and this is a pure type change -- no re-embedding, no backfill.
--
-- `vector` and `vector_cosine_ops` are SCHEMA-QUALIFIED here, unlike the unqualified
-- `vector(1024)` in 00002/00005. This is not style -- it is the failure 00001's comment
-- predicted, hit for real on the first hosted push of this file:
--
--   LegacyDbPushApplyError ... At statement: 1
--   alter table public.note_chunks alter column embedding type vector(1536)
--
-- `supabase db push` logs "Initialising login role..." and applies migrations as a
-- dedicated role whose search_path does NOT include `extensions`, where 00001 installs
-- pgvector. Local `supabase db reset` resolves it fine via config.toml's
-- extra_search_path, so this fails ONLY against the hosted project -- and only at deploy
-- time. Qualifying is the fix 00001 itself prescribes; do not "simplify" it back.

-- note_chunks: the HNSW index is bound to the column's dimension, so it must be dropped
-- before the type change and rebuilt after. (hnsw supports up to 2000 dims; 1536 is fine.)
drop index if exists public.note_chunks_embedding_idx;
alter table public.note_chunks
  alter column embedding type extensions.vector(1536);
create index note_chunks_embedding_idx on public.note_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- memory_facts has NO index on `embedding` (00005 creates only memory_facts_user_status_idx)
-- and nothing queries it until the phase-8 memory layer. Adding one here would be new
-- schema smuggled into a type-change migration, so this stays a bare column alter; the
-- index belongs in the phase that first does vector search over facts.
alter table public.memory_facts
  alter column embedding type extensions.vector(1536);

-- ============ Test-support introspection helper (service_role only) ============
-- Third of the narrow SECURITY DEFINER readers described in 00001. packages/db's tests
-- reach Postgres only through PostgREST, so a column's *declared* vector dimension is
-- otherwise unobservable -- and an embedding-width switch that lands in the migration but
-- not in @cortex/shared (or vice versa) would be silent until the first real embed call.
-- pgvector stores the declared dimension directly in pg_attribute.atttypmod, with none of
-- the +4 header offset varchar/numeric typmods carry.
create or replace function public._test_column_vector_dim(p_table text, p_column text)
returns int
language sql
security definer
set search_path = public
as $$
  select a.atttypmod
  from pg_attribute a
  where a.attrelid = ('public.' || p_table)::regclass
    and a.attname = p_column
    and a.attnum > 0
    and not a.attisdropped;
$$;
revoke execute on function public._test_column_vector_dim(text, text) from public;
grant execute on function public._test_column_vector_dim(text, text) to service_role;
