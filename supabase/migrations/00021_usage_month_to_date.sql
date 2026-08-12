-- Task 12 review finding: packages/core's monthToDateUsd summed usage_ledger client-side with a
-- plain `select("cost_usd")`, no `.limit()`, no pagination. config.toml's `max_rows = 1000` is
-- PostgREST's `db-max-rows`, which SILENTLY truncates any response past 1000 rows -- no error,
-- no signal unless the caller reads Content-Range, which that code did not. recordUsage writes
-- one row per model call, so an active user crosses 1000 rows in a UTC month at roughly 34
-- processed notes a day; past that point the sum was computed over the first 1000 rows only,
-- isOverBudget returned false while the user was genuinely over, and the sweep never stopped
-- billing them.
--
-- Fixed with a SUM done in Postgres, not client-side pagination: one round trip, no row cap to
-- work around, and the IEEE-754 float-accumulation caveat monthToDateUsd's old JS reduce carried
-- disappears along with it -- numeric + numeric stays exact.
--
-- security definer / set search_path / revoke-then-grant-service_role follows the same pattern
-- as 00001's _test_has_table_privilege / _test_check_constraint_def and 00012's
-- _test_column_vector_dim: usage_ledger is SERVER-ONLY (00007's comment; authenticated has no
-- grant on it at all), so this function must not be reachable by anon/authenticated either.
-- Unlike those three, this one is NOT test-only -- packages/core's budget.ts calls it in
-- production via the service-role client -- but the same narrow-reader shape applies.
create or replace function public.usage_month_to_date_usd(p_user_id uuid)
returns numeric
language sql
security definer
set search_path = public
as $$
  -- UTC calendar month, matching the boundary budget.ts's monthToDateUsd already implemented in
  -- TS (Date.UTC(year, month, 1)): timezone('utc', now()) reinterprets the current instant as a
  -- UTC wall-clock timestamp, date_trunc('month', ...) truncates it to that month's first
  -- instant, and the trailing `at time zone 'utc'` converts that wall-clock value back into a
  -- timestamptz representing 00:00 UTC on the 1st -- comparable to usage_ledger.created_at
  -- (timestamptz) without relying on the session/database timezone setting.
  select coalesce(sum(cost_usd), 0)
  from public.usage_ledger
  where user_id = p_user_id
    and created_at >= (date_trunc('month', timezone('utc', now())) at time zone 'utc');
$$;
revoke execute on function public.usage_month_to_date_usd(uuid) from public;
grant execute on function public.usage_month_to_date_usd(uuid) to service_role;
