-- 00021 sums cost_usd across every kind and every source, so ENRICH_MONTHLY_BUDGET_USD and
-- ASSISTANT_MONTHLY_BUDGET_USD have always been two thresholds read off ONE total. 00027 added
-- usage_ledger.source to make the distinction possible; this is the half that uses it.
--
-- The visible failure without it: the assistant answers `declined: budget` while the enrichment
-- sweep is what spent the money, which on screen is indistinguishable from the assistant being
-- broken. Stage C2 is what makes that likely rather than theoretical -- it puts a classification
-- and a retrieval embedding behind every capture on the device where capture actually happens.
--
-- p_source is NULLABLE and defaults to null, which preserves 00021's exact behaviour for any
-- caller that wants the whole total. A new argument with a default, not a new function: two
-- functions would mean two places to keep the UTC month boundary correct.
--
-- security definer / set search_path / revoke-then-grant-service_role is unchanged from 00021:
-- usage_ledger is server-only and authenticated has no grant on it at all.
create or replace function public.usage_month_to_date_usd(p_user_id uuid, p_source text default null)
returns numeric
language sql
security definer
set search_path = public
as $$
  select coalesce(sum(cost_usd), 0)
  from public.usage_ledger
  where user_id = p_user_id
    and created_at >= (date_trunc('month', timezone('utc', now())) at time zone 'utc')
    and (p_source is null or source = p_source);
$$;

-- The one-argument signature from 00021 still exists as a separate overload after a
-- `create or replace` with a new defaulted parameter, and an overload PostgREST can resolve two
-- ways answers PGRST203 rather than picking one. Dropped explicitly so there is exactly one.
drop function if exists public.usage_month_to_date_usd(uuid);

revoke execute on function public.usage_month_to_date_usd(uuid, text) from public;
grant execute on function public.usage_month_to_date_usd(uuid, text) to service_role;
