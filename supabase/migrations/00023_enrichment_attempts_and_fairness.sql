-- ============ Two ways the sweep could stop enriching and look healthy doing it ============
--
-- Both found by the whole-branch review of the phase 2 enrichment pipeline. They are in one
-- migration because they are both edits to claim_notes_for_enrichment (00018) and splitting them
-- would mean dropping and recreating that function twice.

-- ---------------------------------------------------------------------------------------------
-- 1. The attempt counter now belongs to the content it was counted against.
--
-- 00018 gated the claim on `coalesce(e.attempts, 0) < 5` and enrich.service.ts resets `attempts`
-- ONLY on a successful sweep. That reset can never happen for a note the predicate no longer
-- claims, so five failures tombstoned a note permanently: the user could rewrite it from
-- scratch, md5(content_text) would change, the hash half of the predicate would say "claim me",
-- and `attempts = 5` would still veto it forever. The note is never embedded, never findable by
-- meaning, and nothing surfaces why -- note_enrichment has RLS on with no policies, so the
-- evidence is invisible to the person who owns the note.
--
-- Everywhere else in this design "the text changed" is the reset event (that is the whole reason
-- the predicate is keyed on md5(content_text) rather than a timestamp -- see 00018's header).
-- `attempts` was the one piece of state that did not participate. It does now: attempts_hash
-- records WHICH text the count was accumulated against, and a note whose text has since moved on
-- is claimable regardless of how many times its previous text failed.
--
-- Nullable with no backfill, deliberately. A pre-existing row has attempts_hash = null, which
-- `is distinct from md5(n.content_text)` treats as "counted against different text" -- so every
-- note already tombstoned by the old predicate becomes claimable exactly once more, the sweep
-- re-stamps attempts_hash from enrich.service.ts's catch block, and a note that is genuinely
-- still poison re-accumulates its five and stops again. Remediation and migration are the same
-- action; there is nothing to run by hand.
alter table public.note_enrichment add column attempts_hash text;

-- ---------------------------------------------------------------------------------------------
-- 2. One over-budget user can no longer starve every other user's notes.
--
-- The claim is deliberately global and multi-user, ordered `updated_at asc`. enrich.service.ts
-- checked ENRICH_MONTHLY_BUDGET_USD per note AFTER claiming and `continue`d on an over-budget
-- one -- which increments no counter and writes nothing to `notes`, so that note's updated_at
-- never advances and it stays at the head of the ordering forever.
--
-- The failure: user A crosses the monthly budget holding 25 un-enriched notes older than any of
-- user B's. Every 60-second sweep claims A's oldest 20, skips all 20, and processes nothing. NO
-- note belonging to ANY user is enriched again until the UTC month rolls over. The cron keeps
-- firing and one warning prints, so the deployment looks alive while being completely dead.
--
-- The fix is an exclusion list rather than joining usage_month_to_date_usd(n.user_id) into the
-- predicate. That function is an aggregate over usage_ledger and is VOLATILE (00021 declares no
-- volatility, so it defaults to volatile and cannot be inlined), which means Postgres would
-- evaluate it once per CANDIDATE row -- every un-enriched note in the system, before the LIMIT
-- cuts it to 20 -- turning the cheapest predicate in the pipeline into a full aggregate scan per
-- row. It would also move the budget rule into a second place (it already lives in
-- packages/core's isOverBudget) and delete the SweepResult.skippedOverBudget counter, which is
-- the only operational signal that a user has hit their cap at all.
--
-- An array membership test is a linear scan over a handful of uuids, evaluated per candidate row
-- like any other cheap filter. enrich.service.ts re-claims with the users it just found over
-- budget, so the sweep reaches the next user's notes within the same tick -- see the bounded
-- loop and MAX_CLAIM_ROUNDS there for why this cannot spin.
--
-- Dropped and recreated rather than `create or replace`d: adding a parameter to a Postgres
-- function creates an OVERLOAD, it does not replace the original, and then PostgREST's
-- `rpc("claim_notes_for_enrichment", { p_limit })` -- which packages/db's own tests still call
-- in that one-argument form -- matches both candidates and fails with "function name is not
-- unique". The default on p_exclude_user_ids is what keeps that one-argument call working once
-- there is only one function left to match.
drop function public.claim_notes_for_enrichment(int);

create function public.claim_notes_for_enrichment(
  p_limit int,
  p_exclude_user_ids uuid[] default '{}'::uuid[]
)
returns table (note_id uuid, user_id uuid, content_text text, content_hash text)
language sql
security definer
set search_path = public
as $$
  select n.id, n.user_id, n.content_text, md5(n.content_text)
  from public.notes n
  left join public.note_enrichment e on e.note_id = n.id
  where n.deleted_at is null
    and n.updated_at < now() - interval '90 seconds'
    -- coalesce, not a bare `<> all(p_exclude_user_ids)`: `x <> all(null)` is NULL, not true, so
    -- a caller passing null explicitly (or a future caller that forgets the parameter exists)
    -- would filter out every row and the sweep would silently claim nothing at all -- the same
    -- shape of "looks alive, does nothing" failure this half of the migration exists to remove.
    -- `<> all` over an empty array is true, so the default is a no-op.
    and n.user_id <> all (coalesce(p_exclude_user_ids, '{}'::uuid[]))
    -- The second disjunct is what un-tombstones a rewritten note; see the attempts_hash comment
    -- above. Kept as `or` rather than folded into the hash clause below because the two
    -- conditions answer different questions: this one is "has this text earned its five
    -- strikes", the one below is "is there work left to do for this text".
    and (coalesce(e.attempts, 0) < 5 or e.attempts_hash is distinct from md5(n.content_text))
    and (e.embedded_hash  is distinct from md5(n.content_text)
      or e.extracted_hash is distinct from md5(n.content_text))
  order by n.updated_at asc
  limit p_limit
  for update of n skip locked;
$$;
revoke execute on function public.claim_notes_for_enrichment(int, uuid[]) from public;
grant execute on function public.claim_notes_for_enrichment(int, uuid[]) to service_role;
