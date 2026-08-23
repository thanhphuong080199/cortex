import { Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { assertTierAllowsRealData, createGeminiAi, createServiceClient } from "@cortex/core";
import { createBoss, startBoss, stopBoss } from "../queue/boss";
import { createPgLockSession, MOOD_LOCK_ID, withSweepLock } from "../queue/sweep-lock";
import { parseApiEnv } from "../env";
import { runMoodSweep } from "./mood.service";

const QUEUE = "mood.sweep";

/**
 * Stage S3's hourly job, deliberately its own module rather than a second schedule inside
 * EnrichModule: different cadence, different lock, different failure mode, and one onModuleInit
 * owning two schedules is how the second one comes to be forgotten.
 */
@Module({})
export class MoodModule implements OnModuleInit, OnApplicationShutdown {
  private boss?: PgBoss;

  async onModuleInit(): Promise<void> {
    const env = parseApiEnv(process.env);
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

    await this.boss.work(QUEUE, async () => {
      const outcome = await withSweepLock(
        await createPgLockSession(env.DATABASE_URL),
        // NOT SWEEP_LOCK_ID. The enrichment sweep ticks every 60 seconds and holds its lock
        // across AI calls, so sharing an id would make this job lose most hours and read nothing,
        // logging "skipped" as though that were healthy.
        MOOD_LOCK_ID,
        () => runMoodSweep(deps),
      );
      if (!outcome.ran) {
        console.log("[mood] sweep skipped: another instance holds the mood lock");
        return;
      }
      const r = outcome.result;
      // The only evidence the job ran at all: a healthy hour and a dead cron are otherwise
      // identical in the logs, and at one tick an hour a dead cron takes a long time to notice.
      console.log(
        `[mood] sweep complete: processed=${r.processed} noReading=${r.noReading} ` +
          `failed=${r.failed} skippedOverBudget=${r.skippedOverBudget}`,
      );
    });

    // Hourly, not every minute. A session becomes eligible only four hours after its last
    // message, and nothing reads mood_readings (S3 spec §6), so the up-to-one-hour delay has no
    // consequence -- while a per-minute schedule would be 59 wasted full scans of chat_messages
    // every hour.
    await this.boss.schedule(QUEUE, "0 * * * *");
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.boss) await stopBoss(this.boss);
  }
}
