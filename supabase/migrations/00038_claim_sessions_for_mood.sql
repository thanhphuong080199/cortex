-- ============ Stage S3's claim: which idle sessions still need a mood reading ============
--
-- A PURE SELECT. It writes nothing, deliberately: the caller checks ENRICH_MONTHLY_BUDGET_USD
-- after claiming, and a budget skip must leave the world exactly as it found it (S3 spec §3). A
-- claim that incremented `attempts` itself would retire a healthy session after three quiet ticks
-- for a reason that has nothing to do with that session. claim_notes_for_enrichment (00023) has
-- the same shape for the same reason.
--
-- p_idle_ms rather than a literal `interval '4 hours'`: the window belongs to
-- SESSION_IDLE_RESET_MS (packages/shared/src/assistant/session.ts:5), which is what
-- resolveCurrentSession uses to decide a session has ended. Two hand-maintained copies of one
-- constant is how the job and the app come to disagree about where a session stops -- and it also
-- lets the test drive the boundary from both sides without waiting four hours.
--
-- SECURITY DEFINER with service_role-only EXECUTE: chat_messages is client-readable under RLS,
-- and this function deliberately reads across ALL users in one call.

create function public.claim_sessions_for_mood(
  p_limit int,
  p_idle_ms bigint,
  p_exclude_user_ids uuid[] default '{}'::uuid[]
)
returns table (
  user_id uuid,
  session_id uuid,
  session_start timestamptz,
  session_end timestamptz,
  message_count int,
  prior_attempts smallint
)
language sql
stable
security definer
set search_path = public
as $$
  with idle as (
    select
      m.user_id,
      m.session_id,
      min(m.created_at) as session_start,
      max(m.created_at) as session_end,
      count(*)::int     as message_count
    from public.chat_messages m
    -- coalesce, not a bare `<> all(p_exclude_user_ids)`: `x <> all (null)` is NULL rather than
    -- true, so an explicit null would filter out every row and the job would claim nothing while
    -- looking perfectly healthy. 00023 records the identical trap on the enrichment claim.
    where m.user_id <> all (coalesce(p_exclude_user_ids, '{}'::uuid[]))
    group by m.user_id, m.session_id
    having max(m.created_at) < now() - make_interval(secs => p_idle_ms / 1000.0)
  )
  select
    i.user_id, i.session_id, i.session_start, i.session_end, i.message_count,
    coalesce(r.attempts, 0::smallint) as prior_attempts
  from idle i
  left join public.mood_readings r on r.session_id = i.session_id
  where
    -- Never been read.
    r.id is null
    -- Or: a previous run claimed it and died before resolving the row. The 10-minute threshold
    -- must stay BELOW the job's cadence (hourly) -- at or above it, a row left pending by a crash
    -- would skip ticks instead of being retried on the very next one.
    or (
      r.status = 'pending'
      and r.updated_at < now() - interval '10 minutes'
      and r.attempts < 3
    )
  -- Oldest first, so the backfill drains from the far end. Nothing reads mood_readings (spec §6),
  -- so today's session waiting behind the backlog costs nothing, and ascending order is
  -- deterministic and therefore testable.
  order by i.session_end asc
  limit p_limit;
$$;

revoke execute on function public.claim_sessions_for_mood(int, bigint, uuid[]) from public;
grant execute on function public.claim_sessions_for_mood(int, bigint, uuid[]) to service_role;
