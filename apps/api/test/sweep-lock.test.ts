import { describe, expect, it, vi } from "vitest";
import {
  createPgLockSession,
  SWEEP_LOCK_ID,
  SWEEP_LOCK_NAMESPACE,
  withSweepLock,
  type LockSession,
} from "../src/queue/sweep-lock";

/**
 * A scripted session, so the CONTROL FLOW below is tested without a database: which statements
 * are issued, in what order, and whether the session is closed on every path. The Postgres
 * semantics this all rests on -- that two sessions cannot hold the same advisory lock -- are a
 * claim about Postgres, not about this code, so they are pinned separately in the integration
 * describe at the bottom against a real connection. Neither test substitutes for the other:
 * a fake would happily "prove" mutual exclusion this module does not actually have.
 */
function scriptedSession(locked: unknown): LockSession & { sql: string[]; ended: number } {
  const s = {
    sql: [] as string[],
    ended: 0,
    async query(sql: string) {
      s.sql.push(sql);
      return { rows: sql.includes("pg_try_advisory_lock") ? [{ locked }] : [{}] };
    },
    async end() {
      s.ended++;
    },
  };
  return s;
}

describe("withSweepLock", () => {
  it("runs the sweep and returns its result when it wins the lock", async () => {
    const session = scriptedSession(true);
    const outcome = await withSweepLock(session, async () => "swept");

    expect(outcome).toEqual({ ran: true, result: "swept" });
    expect(session.sql[0]).toContain("pg_try_advisory_lock");
  });

  // The point of the whole module: the LOSER must not sweep. Asserting `not.toHaveBeenCalled` is
  // what rules out the failure that matters -- two instances each enriching, each billing.
  it("does not run the sweep when another session holds the lock", async () => {
    const session = scriptedSession(false);
    const fn = vi.fn().mockResolvedValue("swept");
    const outcome = await withSweepLock(session, fn);

    expect(outcome).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    // No unlock: this session never held it, and pg_advisory_unlock on a lock you do not own
    // logs a warning server-side and returns false. Releasing something you never took is a
    // decent way to release someone else's after a refactor.
    expect(session.sql.some((s) => s.includes("pg_advisory_unlock"))).toBe(false);
  });

  // node-postgres decodes `bool` to a real boolean. Anything else means the query shape changed
  // underneath us, and "assume we hold it" is the one wrong answer -- it sweeps on every
  // instance at once, which is precisely what this function exists to prevent. Fail closed.
  it.each([[null], [undefined], ["t"], [1], [{}]])(
    "treats a non-boolean lock result (%s) as NOT acquired",
    async (value) => {
      const fn = vi.fn();
      expect(await withSweepLock(scriptedSession(value), fn)).toEqual({ ran: false });
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it("releases the lock after a successful sweep", async () => {
    const session = scriptedSession(true);
    await withSweepLock(session, async () => "ok");
    expect(session.sql.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
  });

  // A sweep that throws is the case that actually strands a lock. Without the `finally`, one
  // failed sweep would wedge enrichment for every instance until that process restarted -- and
  // runSweep's own per-note try/catch means a throw out of it is exactly the rare, unexpected
  // kind of failure nobody is watching for.
  it("releases the lock when the sweep throws, and propagates the error", async () => {
    const session = scriptedSession(true);
    await expect(withSweepLock(session, async () => { throw new Error("sweep exploded"); }))
      .rejects.toThrow("sweep exploded");

    expect(session.sql.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);
    expect(session.ended).toBe(1);
  });

  // One tick a minute forever: a connection leaked on any path exhausts the pooler within the
  // hour, and the symptom (new connections refused) points at everything except this function.
  it.each([
    ["won the lock", true],
    ["lost the lock", false],
  ])("closes the session when it %s", async (_label, locked) => {
    const session = scriptedSession(locked);
    await withSweepLock(session, async () => "ok");
    expect(session.ended).toBe(1);
  });

  it("closes the session even when the lock query itself fails", async () => {
    let ended = 0;
    const session: LockSession = {
      query: async () => { throw new Error("connection reset"); },
      end: async () => { ended++; },
    };
    await expect(withSweepLock(session, async () => "ok")).rejects.toThrow("connection reset");
    expect(ended).toBe(1);
  });
});

// The claim the fake above CANNOT make. Everything else in this file tests our control flow;
// this tests Postgres, which is where the mutual exclusion actually lives. Runs against whatever
// DATABASE_URL names -- the local stack in dev and CI.
describe("advisory lock against the configured database", () => {
  it("lets exactly one of two concurrent sessions sweep", async () => {
    const [a, b] = await Promise.all([
      createPgLockSession(process.env.DATABASE_URL!),
      createPgLockSession(process.env.DATABASE_URL!),
    ]);

    // Deliberately NOT run in parallel: the winner must be deterministic so the assertion is
    // about exclusion, not about a race. `a` sweeps while holding the lock, and `b` tries for it
    // from inside that sweep -- the real shape of a redeploy overlap, where the second container
    // ticks while the first is mid-sweep, not one where both start at the same instant.
    let bOutcome: { ran: boolean } | undefined;
    const aOutcome = await withSweepLock(a, async () => {
      bOutcome = await withSweepLock(b, async () => "b swept");
      return "a swept";
    });

    expect(aOutcome).toEqual({ ran: true, result: "a swept" });
    expect(bOutcome).toEqual({ ran: false });
  }, 30_000);

  // A lock that is never released is worse than no lock: enrichment stops repo-wide and the logs
  // say "skipped", not "broken". This proves the release is real at the Postgres level, not just
  // that we sent the statement -- a fresh session must be able to take the lock afterwards.
  it("frees the lock for the next session once the sweep ends", async () => {
    const first = await withSweepLock(
      await createPgLockSession(process.env.DATABASE_URL!),
      async () => "first",
    );
    expect(first).toEqual({ ran: true, result: "first" });

    const second = await withSweepLock(
      await createPgLockSession(process.env.DATABASE_URL!),
      async () => "second",
    );
    expect(second).toEqual({ ran: true, result: "second" });
  }, 30_000);

  // The key is a constant in two places (this repo, and any future SQL that inspects
  // pg_locks). Pinning the values means changing them is a deliberate act with a failing test,
  // not a silent one that leaves an old deployment and a new one holding DIFFERENT locks and
  // sweeping concurrently -- the exact failure the lock exists to prevent, reintroduced by the
  // fix for it.
  it("uses a stable, documented key", () => {
    expect(SWEEP_LOCK_NAMESPACE).toBe(1129271892); // 0x434F5254, ASCII "CORT"
    expect(SWEEP_LOCK_ID).toBe(1);
    expect(SWEEP_LOCK_NAMESPACE).toBeLessThanOrEqual(2147483647); // must fit int4
  });
});
