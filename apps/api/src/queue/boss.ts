// pg-boss 12 ships as ESM with no default export -- `PgBoss` is a named export.
import { PgBoss } from "pg-boss";

/**
 * The FIRST direct Postgres connection in this repo -- everything else, including
 * packages/db's tests, reaches Postgres through PostgREST.
 *
 * Against hosted Supabase this must be the Supavisor SESSION pooler (port 5432 on
 * `*.pooler.supabase.com`), not the transaction pooler on 6543: pg-boss holds session state
 * and takes advisory locks, neither of which survives a transaction pooler. The direct host
 * `db.<ref>.supabase.co` also works where it resolves, but docs/deploy.md:924 records that it
 * does not resolve from every network -- if a connection test fails while resolving the
 * address rather than authenticating, that is the cause, not the password.
 */
export function createBoss(databaseUrl: string): PgBoss {
  return new PgBoss({
    connectionString: databaseUrl,
    // Supabase terminates idle connections; a small pool with a short idle timeout keeps the
    // worker from holding one open across a quiet night and waking to a dead socket.
    max: 4,
    // pg-boss owns this schema entirely. Naming it explicitly keeps it out of `public`, where
    // every migration in supabase/migrations/ lives.
    schema: "pgboss",
  });
}

export async function startBoss(boss: PgBoss): Promise<void> {
  boss.on("error", (err) => {
    // No note content ever reaches a log (spec §15.6 rule 1).
    console.error("[pgboss]", err instanceof Error ? err.message : err);
  });
  await boss.start();
}

export async function stopBoss(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: true });
}
