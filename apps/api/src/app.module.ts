import { Module } from "@nestjs/common";
import { AI_CLIENT, createLazyGeminiAi } from "./ai-client.provider";
import { AssistantController } from "./assistant.controller";
import { CheckinsController } from "./checkins.controller";
import { ExportController } from "./export.controller";
import { HealthController } from "./health.controller";
import { MeController } from "./me.controller";
import { MediaController } from "./media.controller";
import { NotesController } from "./notes.controller";
import { SearchController } from "./search.controller";
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
// EnrichModule is composed onto AppModule only in root.module.ts, which only main.ts imports.
//
// SearchController DOES live here, unlike EnrichModule, because it must actually be reachable
// over HTTP -- RootModule's controllers all come from AppModule (root.module.ts). Its AI_CLIENT
// provider is safe under the same NO-REAL-GEMINI-AT-BOOT rule for a different reason than "not
// imported": createLazyGeminiAi() (ai-client.provider.ts) never calls parseApiEnv/createGeminiAi
// until something actually calls embed()/generateJson(), which only happens inside a real
// POST /search request -- never during any other suite's boot or tests.
//
// AssistantController is the same story, plus a second lazy read: it parses
// ASSISTANT_MONTHLY_BUDGET_USD from process.env inside its handler, not as an eager class
// field, so a missing/invalid value only throws for an actual POST /assistant request -- not
// at app.init() for every other e2e suite that boots this module (see the controller's own
// comment).
@Module({
  controllers: [
    HealthController, MeController, NotesController, TagsController, ExportController,
    CheckinsController, MediaController, SyncController, SearchController, AssistantController,
  ],
  providers: [{ provide: AI_CLIENT, useFactory: createLazyGeminiAi }],
})
export class AppModule {}
