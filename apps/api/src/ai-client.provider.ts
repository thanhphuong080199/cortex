import type { AiClient, JsonResult, StreamResult } from "@cortex/core";
import { assertTierAllowsRealData, createGeminiAi } from "@cortex/core";
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
 *
 * Also runs assertTierAllowsRealData (spec §15.6 rule 2) before building that client, the same
 * guard enrich.module.ts's onModuleInit applies before its own createGeminiAi call. A search
 * query is user-typed personal text, no different in kind from a note's content -- a free-tier
 * key must not see it either. Not reachable today (main.ts's own parseApiEnv call already exits
 * the process before RootModule boots if env is invalid, and nothing currently runs this
 * provider against a real GEMINI_TIER=free + hosted SUPABASE_URL pair), but this is the second
 * real-Gemini call site in the app and it should not be the one that skips a guard the first one
 * applies.
 */
export function createLazyGeminiAi(): AiClient {
  let real: AiClient | undefined;
  const get = (): AiClient => {
    if (!real) {
      const env = parseApiEnv(process.env);
      assertTierAllowsRealData(env.GEMINI_TIER, env.SUPABASE_URL);
      real = createGeminiAi(env.GEMINI_API_KEY);
    }
    return real;
  };
  return {
    // `async`, not a plain arrow returning get()'s promise: AiClient's interface promises
    // Promise<...> unconditionally, and get() can throw SYNCHRONOUSLY (parseApiEnv's zod
    // validation, assertTierAllowsRealData) on the first call, before any real client -- let
    // alone a real promise -- exists. A non-async wrapper would let that throw escape as a bare
    // synchronous exception instead of a rejection, breaking that contract for any caller using
    // `.catch()`/`Promise.all` rather than `await` inside their own async function (proven by
    // ai-client.provider.test.ts, which calls embed() directly, outside any surrounding async
    // function body, specifically to catch this).
    embed: async (texts: string[]) => get().embed(texts),
    generateJson: async <T>(args: { prompt: string; schema: Record<string, unknown> }): Promise<JsonResult<T>> =>
      get().generateJson<T>(args),
    generateStream: async (args: { prompt: string; model: string; signal?: AbortSignal }): Promise<StreamResult> =>
      get().generateStream(args),
  };
}
