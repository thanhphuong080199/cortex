-- packages/db's enum-parity test reads usage_ledger_kind_check out of pg_constraint and asserts
-- it matches @cortex/shared's usageLedgerKind exactly, IN ORDER, so these two move together or
-- the suite fails. See the header of packages/shared/src/enums.ts.
--
-- 'grounding' is a Gemini Grounding with Google Search query. It is priced per query rather than
-- per token, so its rows carry 0 input and 0 output tokens and a cost_usd that recordUsage is
-- told rather than computes -- see budget.ts's costUsd override.
alter table public.usage_ledger drop constraint usage_ledger_kind_check;
alter table public.usage_ledger add constraint usage_ledger_kind_check
  check (kind in ('embed','chat','tag','digest','memory','transcribe','grounding'));
