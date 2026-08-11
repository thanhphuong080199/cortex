import { Module } from "@nestjs/common";
import { CheckinsController } from "./checkins.controller";
import { ExportController } from "./export.controller";
import { HealthController } from "./health.controller";
import { MeController } from "./me.controller";
import { MediaController } from "./media.controller";
import { NotesController } from "./notes.controller";
import { SyncController } from "./sync.controller";
import { TagsController } from "./tags.controller";

// EnrichModule is deliberately NOT imported here. Every e2e suite (checkins/notes/tags/etc.)
// boots this exact module via test/harness.ts's bootstrapTestApp(), and EnrichModule's
// onModuleInit starts a real pg-boss worker wired to a REAL Gemini client (createGeminiAi,
// not the fake). pg-boss's cron runs an immediate check on start() (node_modules/pg-boss's
// Timekeeper.start() calls `setImmediate(() => this.onCron())`) and the "* * * * *" schedule
// used here is due within the same minute by construction, so within roughly the default
// 5-10s of any suite calling app.init(), a live sweep -- and a live Gemini API call -- could
// fire in the middle of an unrelated test run. "NO TEST MAY EVER CALL THE REAL GEMINI API"
// (ai/fake.ts) has no exception for "the app happened to boot with the module attached", so
// EnrichModule is composed onto AppModule only in main.ts, where the real process runs.
@Module({
  controllers: [
    HealthController, MeController, NotesController, TagsController, ExportController,
    CheckinsController, MediaController, SyncController,
  ],
})
export class AppModule {}
