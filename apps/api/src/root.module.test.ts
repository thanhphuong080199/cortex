import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AppModule } from "./app.module";
import { EnrichModule } from "./enrich/enrich.module";
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
  it("imports both AppModule and EnrichModule", () => {
    const imports = Reflect.getMetadata("imports", RootModule) as unknown[];
    expect(imports).toContain(AppModule);
    expect(imports).toContain(EnrichModule);
  });
});
