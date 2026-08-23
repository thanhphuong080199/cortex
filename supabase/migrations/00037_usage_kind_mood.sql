-- ============ Stage S3's per-session mood job needs its own ledger kind ============
--
-- Same shape as 00029, which added 'grounding'. Dropped and re-added rather than altered: a CHECK
-- constraint has no in-place edit.
--
-- Its own kind rather than reusing 'tag': the S3 job and the enrichment sweep share
-- ENRICH_MONTHLY_BUDGET_USD, so the only way to answer "what did mood synthesis cost" after the
-- fact is for its rows to say so. packages/db's enum-parity suite reads this constraint out of
-- pg_constraint and compares it to usageLedgerKind, so the two cannot drift apart silently.
alter table public.usage_ledger drop constraint usage_ledger_kind_check;
alter table public.usage_ledger add constraint usage_ledger_kind_check
  check (kind in ('embed','chat','tag','digest','memory','transcribe','grounding','mood'));
