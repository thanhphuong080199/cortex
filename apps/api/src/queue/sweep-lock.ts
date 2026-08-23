import { Client } from "pg";

/**
 * Two-int advisory lock key. Postgres keeps ONE global advisory-lock space per database, shared
 * by everything connected to it -- including pg-boss, which takes its own locks in the `pgboss`
 * schema. The two-argument form `pg_try_advisory_lock(int4, int4)` occupies a different key
 * space from the one-argument bigint form, and namespacing the first int makes an accidental
 * collision with another library's key vanishingly unlikely. 0x434F5254 is ASCII "CORT".
 */
export const SWEEP_LOCK_NAMESPACE = 0x434f5254; // 1129271892, comfortably inside int4
export const SWEEP_LOCK_ID = 1;
/**
 * S3's hourly mood job. A DIFFERENT id from the enrichment sweep, and that is the entire point:
 * the sweep ticks every 60 seconds and holds its lock across AI calls, so a mood job sharing id 1
 * would lose the lock on most hours and read nothing, logging "skipped" as though that were
 * healthy. Advisory locks are per (namespace, id), so two ids never contend.
 */
export const MOOD_LOCK_ID = 2;

/**
 * The slice of a `pg.Client` this module needs, named as an interface so the behaviour below can
 * be tested against a scripted session instead of a live Postgres connection. `query` is a
 * structural subset of node-postgres's own signature.
 */
export interface LockSession {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export type SweepLockOutcome<T> = { ran: true; result: T } | { ran: false };

/**
 * Runs `fn` only if this process wins a SESSION-level advisory lock, and always closes the
 * session afterwards.
 *
 * WHY THIS EXISTS. enrich.module.ts's `work()` defaults (localConcurrency: 1) guarantee that ONE
 * process never runs two sweeps at once, and that is all they guarantee. `createQueue` uses
 * pg-boss's default `standard` policy, so a SECOND process's worker can pick up its own job and
 * sweep concurrently -- and `SKIP LOCKED` inside `claim_notes_for_enrichment` does not help,
 * because that claim transaction commits (releasing its row locks) long before embedNote and
 * extractNote's AI calls return. Until now the only thing preventing that was "there is exactly
 * one API instance", which Railway's default rolling redeploy violates by design for the ~30s
 * two containers overlap, and which horizontal scaling violates permanently.
 *
 * WHY A LOCK RATHER THAN `policy: 'singleton'`. Both stop the overlap; they differ in what
 * happens when a sweep runs LONG. A singleton queue holds at most one job, so a tick arriving
 * mid-sweep is silently dropped -- throughput quietly falls and nothing in the logs says why.
 * With a lock, the loser returns immediately and the NEXT tick (60s later) tries again. Skipping
 * a tick because another process is mid-sweep is correct; skipping one because your own sweep
 * was slow is not.
 *
 * WHY SESSION-LEVEL, NOT `pg_try_advisory_xact_lock`. A transaction-scoped lock releases at
 * commit -- which is exactly the gap `SKIP LOCKED` already leaves. The lock has to be held across
 * the AI calls, so it has to outlive any transaction, so this needs a dedicated client held open
 * for the sweep's duration rather than a PostgREST call.
 *
 * WHY NOT A LEASE ROW. A row with an expiry needs a TTL long enough not to expire mid-sweep and
 * short enough to recover quickly from a crash, and picking that number wrong double-runs or
 * stalls. An advisory lock has no TTL to pick: if the process dies, its connection dies, and
 * Postgres drops the lock -- there is no state left behind to expire.
 *
 * Returns `{ ran: false }` rather than throwing when the lock is held: not acquiring it is the
 * expected, healthy outcome on the losing instance, not an error.
 */
export async function withSweepLock<T>(
  session: LockSession,
  lockId: number,
  fn: () => Promise<T>,
): Promise<SweepLockOutcome<T>> {
  try {
    const res = await session.query("select pg_try_advisory_lock($1, $2) as locked", [
      SWEEP_LOCK_NAMESPACE,
      lockId,
    ]);
    const locked = (res.rows[0] as { locked?: unknown } | undefined)?.locked;
    // Strict `=== true`, not truthiness: node-postgres decodes `bool` to a real boolean, so
    // anything else here means the query shape changed underneath us. Treating an unexpected
    // value as "we hold the lock" is the one wrong answer -- it would run the sweep on every
    // instance at once, which is the whole thing this function exists to prevent.
    if (locked !== true) return { ran: false };

    try {
      return { ran: true, result: await fn() };
    } finally {
      // Belt and braces: ending the session below releases the lock anyway. Unlocking explicitly
      // means a future refactor that pools this connection instead of closing it does not silently
      // start leaking locks.
      await session.query("select pg_advisory_unlock($1, $2)", [
        SWEEP_LOCK_NAMESPACE,
        lockId,
      ]);
    }
  } finally {
    // Runs on every path, including a failed `pg_try_advisory_lock` and a throwing `fn`. Leaking
    // one connection per 60s tick would exhaust the pooler within the hour.
    await session.end();
  }
}

/**
 * One short-lived connection per sweep, opened at tick time and closed when the sweep ends.
 *
 * Not a long-lived client: Supabase terminates idle connections (the same reason
 * queue/boss.ts caps pg-boss's pool and shortens its idle timeout), so a client held open across
 * a quiet night wakes to a dead socket -- and a dead socket is a released lock that this process
 * still believes it holds. A connection that only exists while a sweep is running cannot go
 * stale between sweeps.
 *
 * Against hosted Supabase this must be the SESSION pooler (5432), not the transaction pooler
 * (6543) -- session-level advisory locks do not survive a transaction pooler. That is the same
 * constraint pg-boss already imposes on DATABASE_URL, so there is no second string to configure.
 */
export async function createPgLockSession(databaseUrl: string): Promise<LockSession> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return {
    query: (sql, values) => client.query(sql, values as unknown[]),
    end: () => client.end(),
  };
}
