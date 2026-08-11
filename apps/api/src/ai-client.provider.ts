import type { AiClient, JsonResult } from "@cortex/core";
import { createGeminiAi } from "@cortex/core";
import { parseApiEnv } from "./env";

/**
 * DI token for the AiClient SearchController depends on. A Symbol (not a class) because
 * AiClient is an interface -- it has no runtime value Nest could key a provider on.
 */
export const AI_CLIENT = Symbol("AI_CLIENT");

/**
 * Returns an AiClient that defers constructing the real Gemini client -- and calling
 * parseApiEnv -- until its first actual use, rather than at DI-container boot time.
 *
 * This provider lives in AppModule, which is the exact module every e2e suite in this repo
 * boots (test/harness.ts's bootstrapTestApp()). A factory that called
 * parseApiEnv()/createGeminiAi() eagerly here would make the boot of the seven OTHER e2e
 * suites (notes, tags, checkins, media, export, sync-upload, app) depend on GEMINI_* env being
 * present and valid too -- exactly the trap Task 13 hit with EnrichModule's onModuleInit, which
 * is why EnrichModule is composed onto AppModule only in root.module.ts (see that file's and
 * app.module.ts's comments) instead of living inside AppModule itself. None of those seven
 * suites' routes ever call embed()/generateJson(), so the real client returned by
 * createGeminiAi() is simply never constructed during their runs. Only an actual request into
 * SearchController's handler forces it -- at which point it is built once and cached for the
 * life of the process, not reconstructed per request (see search.controller.ts).
 */
export function createLazyGeminiAi(): AiClient {
  let real: AiClient | undefined;
  const get = (): AiClient => {
    if (!real) real = createGeminiAi(parseApiEnv(process.env).GEMINI_API_KEY);
    return real;
  };
  return {
    embed: (texts: string[]) => get().embed(texts),
    generateJson: <T>(args: { prompt: string; schema: Record<string, unknown> }): Promise<JsonResult<T>> =>
      get().generateJson<T>(args),
  };
}
