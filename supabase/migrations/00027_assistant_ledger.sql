-- usage_ledger answered two of the nine cost questions this project needs. The gap that
-- matters most: 'embed' is written by BOTH the enrichment sweep (embed.ts) and by every
-- search (search.controller.ts), so "cost per search" was unanswerable, and stage C is about
-- to add a third writer that costs ~6x the whole pipeline.
--
-- `kind` is deliberately NOT touched. packages/shared/src/enums.ts mirrors its CHECK
-- constraint and packages/db's enum-parity test fails if the two drift; 'chat' is already in
-- the vocabulary, which is what the assistant writes.
--
-- Every column is nullable. Existing rows predate stage C and must stay valid, and a ledger
-- write must never be the thing that fails a working request.
alter table public.usage_ledger
  add column note_id uuid references public.notes(id) on delete set null,
  -- `set null`, not `cascade`: deleting a note must not erase the record that money was
  -- spent on it. The spend happened whatever became of the note.
  add column source text,
  add column request_id uuid,
  add column attempt int,
  add column latency_ms int,
  -- Not a cost column. The token counts for `kind='embed'` are a chars/4 ESTIMATE, and that
  -- ratio is an English one -- Vietnamese runs nearer 2-3 chars per token, so embedding spend
  -- is under-reported by roughly 40-60% for the primary corpus language. Storing the character
  -- count makes the ratio recalibratable later from data, which beats replacing a known-wrong
  -- divisor with an unknown-wrong one.
  add column content_chars int;

alter table public.usage_ledger
  add constraint usage_ledger_source_check
  check (source is null or source in ('sweep', 'assistant', 'search'));

-- Grouping: "cost per answered question" sums the classify row and the answer row of one turn.
create index usage_ledger_request_idx on public.usage_ledger (request_id)
  where request_id is not null;
create index usage_ledger_note_idx on public.usage_ledger (note_id)
  where note_id is not null;

-- gemini.ts attaches `status` to its errors specifically so a caller can tell a 429 from a
-- 400. No caller does yet. Recording it costs nothing and makes the retry mix measurable
-- without parsing error strings.
alter table public.note_enrichment add column last_error_status int;

-- The 4-hour context reset reads the user's most recent chat message ACROSS sessions.
-- chat_messages_session_idx is (session_id, created_at) -- wrong leading column for that.
create index chat_messages_user_idx on public.chat_messages (user_id, created_at desc);

-- usage_ledger and note_enrichment stay server-only: no grant to authenticated, here or
-- anywhere. 00007 and 00018 established that and nothing in stage C changes it.
