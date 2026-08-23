import { Module } from "@nestjs/common";
import { AppModule } from "./app.module";
import { EnrichModule } from "./enrich/enrich.module";
import { MoodModule } from "./mood/mood.module";

/**
 * Composed here, not inside AppModule's own `imports`: AppModule is the exact module every
 * e2e suite boots (test/harness.ts), and EnrichModule and MoodModule each start a real pg-boss
 * worker against a real Gemini client the moment they initialise (see app.module.ts's comment
 * for why). This module is what puts the cron in the actually-deployed process while keeping it
 * entirely out of every test's module graph -- main.ts is the only importer.
 *
 * Exported (rather than living inline in main.ts, which is `void bootstrap()`-at-import-time
 * and process.exit(1)s on missing env) specifically so root.module.test.ts can read this
 * class's own @Module metadata without booting a server. main.ts self-bootstrapping was what
 * made an earlier version of this file uncoverable: nothing could import it to check that
 * EnrichModule was still wired in without also starting a real process.
 */
@Module({ imports: [AppModule, EnrichModule, MoodModule] })
export class RootModule {}
