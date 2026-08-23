import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AppModule } from "./app.module";
import { EnrichModule } from "./enrich/enrich.module";
import { MoodModule } from "./mood/mood.module";
import { RootModule } from "./root.module";

// Pins the one line that puts the cron in the actually-deployed process. Nothing else can
// exercise it: main.ts is `void bootstrap()` at import time and process.exit(1)s on missing
// env, so importing it from a test starts a server rather than checking anything, and every
// e2e suite deliberately boots AppModule alone (see app.module.ts's comment), never
// RootModule. This reads the @Module decorator's own metadata instead -- a refactor that drops
// EnrichModule from root.module.ts's imports array turns enrichment off in production,
// permanently and silently, with every other test in this repo still green; this is the one
// test that would catch it.
describe("RootModule", () => {
  // A cron that is never registered is a feature that silently does not exist: nothing else in
  // the system references MoodModule, and it reads no table any other test touches, so without
  // this line the whole stage could ship dark and every suite would still be green.
  it("imports AppModule, EnrichModule and MoodModule", () => {
    const imports = Reflect.getMetadata("imports", RootModule) as unknown[];
    expect(imports).toContain(AppModule);
    expect(imports).toContain(EnrichModule);
    expect(imports).toContain(MoodModule);
  });
});
