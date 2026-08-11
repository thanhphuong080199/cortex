import { Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { assertTierAllowsRealData, createGeminiAi, createServiceClient } from "@cortex/core";
import { createBoss, startBoss, stopBoss } from "../queue/boss";
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
    // Every 60s. `work()`'s defaults (localConcurrency: 1, batchSize: 1 -- see
    // node_modules/pg-boss/dist/manager.js) mean this ONE process never runs two sweep jobs
    // at once: Worker.run() (dist/worker.js) awaits the handler in full before its next
    // fetch, so a job that arrives while runSweep is still going simply waits in the queue
    // and runs after, not concurrently.
    //
    // That is NOT the same claim as "singleton by queue name" -- createQueue above uses
    // pg-boss's default 'standard' policy, not 'singleton' (dist/manager.js's
    // QUEUE_POLICIES), so nothing here stops a SECOND process's worker from picking up a
    // different queued job at the same time this one is still working (SKIP LOCKED, per
    // Task 4's parked review finding, only keeps two workers off the SAME job row -- the
    // claim transaction inside claim_notes_for_enrichment commits, and its lock releases,
    // long before embedNote/extractNote's AI calls return). For exactly one API instance --
    // this deployment's shape today -- that never happens: schedule()'s cron firing is
    // itself singleton across instances (dist/timekeeper.js's trySetCronTime does an atomic
    // conditional UPDATE against a single pgboss.version row), so there is only ever one
    // process's worker to race against. A second instance existing at the same time (a
    // rolling redeploy overlap, or horizontal scaling) is the one case this does not cover;
    // see Task 13's report for the full three-question trace through node_modules/pg-boss
    // and why a fix (e.g. `policy: 'singleton'` on createQueue, which trades "queues behind"
    // for "a slow sweep silently drops the next tick") is left as a decision for the human
    // rather than added here.
    await this.boss.work(QUEUE, async () => { await runSweep(deps); });
    await this.boss.schedule(QUEUE, "* * * * *");
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.boss) await stopBoss(this.boss);
  }
}
