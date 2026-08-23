import { Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { assertTierAllowsRealData, createGeminiAi, createServiceClient } from "@cortex/core";
import { createBoss, startBoss, stopBoss } from "../queue/boss";
import { createPgLockSession, SWEEP_LOCK_ID, withSweepLock } from "../queue/sweep-lock";
import { parseApiEnv } from "../env";
import { runSweep } from "./enrich.service";

const QUEUE = "enrich.sweep";

@Module({})
export class EnrichModule implements OnModuleInit, OnApplicationShutdown {
  private boss?: PgBoss;

  async onModuleInit(): Promise<void> {
    const env = parseApiEnv(process.env);
    // Refuses to start rather than processing hosted data on a free key (spec §15.6 rule 2).
    assertTierAllowsRealData(env.GEMINI_TIER, env.SUPABASE_URL);

    this.boss = createBoss(env.DATABASE_URL);
    await startBoss(this.boss);
    await this.boss.createQueue(QUEUE);

    const deps = {
      db: createServiceClient(),
      ai: createGeminiAi(env.GEMINI_API_KEY),
      budgetUsd: env.ENRICH_MONTHLY_BUDGET_USD,
      limit: 20,
    };
    // Every 60s, and serialized across PROCESSES by an advisory lock -- Task 4's parked
    // finding, closed 2026-08-12.
    //
    // Within one process, `work()`'s defaults (localConcurrency: 1, batchSize: 1 -- see
    // node_modules/pg-boss/dist/manager.js) already mean two sweep jobs never overlap:
    // Worker.run() (dist/worker.js) awaits the handler in full before its next fetch, so a job
    // arriving mid-sweep waits in the queue. That is NOT a singleton guarantee -- createQueue
    // above uses pg-boss's default 'standard' policy (dist/manager.js's QUEUE_POLICIES) -- and
    // `SKIP LOCKED` inside claim_notes_for_enrichment does not extend it, because that claim
    // transaction commits, releasing its row locks, long before embedNote/extractNote's AI
    // calls return. Two instances would therefore claim disjoint notes and bill for both.
    //
    // Until now the only thing preventing that was "there is exactly one API instance", which
    // Railway's default rolling redeploy violates for the ~30s two containers overlap.
    // withSweepLock makes the invariant hold in code instead of in the deploy settings; see
    // queue/sweep-lock.ts for why a lock rather than `policy: 'singleton'` (which would
    // silently drop a tick whenever a sweep runs long).
    await this.boss.work(QUEUE, async () => {
      const outcome = await withSweepLock(
        await createPgLockSession(env.DATABASE_URL),
        SWEEP_LOCK_ID,
        () => runSweep(deps),
      );
      if (!outcome.ran) {
        // Expected during a rolling redeploy, and it must be visible: a permanently-skipping
        // instance (a lock leaked by an earlier crash, a second service left running) otherwise
        // looks exactly like a healthy one that simply has nothing to do.
        console.log("[enrich] sweep skipped: another instance holds the sweep lock");
        return;
      }
      const result = outcome.result;
      // The only evidence a sweep ran at all, otherwise: per-note error output only fires on
      // failure, so a healthy deployment and a dead cron look identical in the logs.
      console.log(
        `[enrich] sweep complete: processed=${result.processed} failed=${result.failed} ` +
          `skippedOverBudget=${result.skippedOverBudget}`,
      );
    });
    await this.boss.schedule(QUEUE, "* * * * *");
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.boss) await stopBoss(this.boss);
  }
}
