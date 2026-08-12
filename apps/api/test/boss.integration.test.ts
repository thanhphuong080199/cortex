// Hosted-pooler probe -- run by hand, once, against the Railway `DATABASE_URL`
// (session pooler, port 5432). This is the only way to learn whether Supavisor session
// mode accepts pg-boss before anything depends on it. Do not commit the hosted connection
// string anywhere.
//
//   DATABASE_URL='<the hosted pooler string from the Railway variable>' \
//     npx vitest run --root apps/api test/boss.integration.test.ts
//
// If it fails, read the error before changing anything:
//
// | Symptom                                              | Meaning                          | Action |
// | ----------------------------------------------------- | -------------------------------- | ------ |
// | `ENOTFOUND` / `EAI_AGAIN`                              | address does not resolve --      | Confirm the host is |
// |                                                         | `deploy.md:924`'s case            | `*.pooler.supabase.com`, not `db.<ref>.supabase.co` |
// | `password authentication failed`                       | wrong password                   | Reset it in the Supabase dashboard; `powersync_role` is unaffected, it has its own |
// | `prepared statement ... already exists`, or             | transaction pooler               | The port is 6543; it must be 5432 |
// | advisory-lock errors                                   |                                   | |
// | Anything else                                          | unknown                          | STOP and report. Do not proceed to Task 3 -- the fallback architecture in spec §5 may be required |
//
// After a hosted PASS, drop the schema the probe created back out of production:
//
//   -- Supabase dashboard, SQL editor
//   drop schema if exists pgboss cascade;

import { afterAll, beforeAll, describe, expect, it } from "vitest";
// pg-boss 12 ships as ESM with no default export -- `PgBoss` is a named export.
import type { PgBoss } from "pg-boss";
import { createBoss, startBoss, stopBoss } from "../src/queue/boss";

// Runs against whatever DATABASE_URL names -- the local stack in dev, and (run by hand,
// once) the hosted pooler, which is the only way to learn whether Supavisor session mode
// accepts pg-boss before anything depends on it.
describe("pg-boss against the configured database", () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = createBoss(process.env.DATABASE_URL!);
    await startBoss(boss);
  }, 60_000);

  afterAll(async () => {
    if (boss) await stopBoss(boss);
  });

  it("creates its own schema", async () => {
    const rows = await boss.getQueues();
    expect(Array.isArray(rows)).toBe(true);
  });

  it("round-trips a job", async () => {
    const queue = `probe-${Date.now()}`;
    await boss.createQueue(queue);

    const seen: string[] = [];
    await boss.work<{ marker: string }>(queue, async ([job]) => {
      // noUncheckedIndexedAccess types a destructured array element as possibly undefined;
      // pg-boss always calls the handler with at least one job.
      seen.push(job!.data.marker);
    });

    await boss.send(queue, { marker: "hello" });

    await expect
      .poll(() => seen, { timeout: 30_000, interval: 250 })
      .toEqual(["hello"]);
  }, 45_000);
});
