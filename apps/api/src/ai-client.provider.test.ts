import { afterEach, describe, expect, it } from "vitest";
import { createLazyGeminiAi } from "./ai-client.provider";

// createLazyGeminiAi must refuse to build a real client for a free-tier key against hosted data
// (spec §15.6 rule 2) -- the same guard enrich.module.ts's onModuleInit applies before building
// ITS Gemini client. assertTierAllowsRealData throws synchronously, before createGeminiAi (and
// therefore before any fetch) ever runs, so this is provable without the real Gemini API ever
// being reached -- NO TEST MAY EVER CALL THE REAL GEMINI API (packages/core/src/ai/fake.ts).
describe("createLazyGeminiAi", () => {
  const original = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    GEMINI_TIER: process.env.GEMINI_TIER,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("refuses a free-tier key against hosted data before constructing a real client", async () => {
    // A hosted SUPABASE_URL/DATABASE_URL pair naming the same project ref, so parseApiEnv's
    // own same-database check passes and the failure below is provably assertTierAllowsRealData,
    // not an unrelated env-shape error.
    process.env.SUPABASE_URL = "https://wilssluxogpdrbgffmzc.supabase.co";
    process.env.DATABASE_URL =
      "postgresql://postgres.wilssluxogpdrbgffmzc:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres";
    process.env.GEMINI_TIER = "free";

    const ai = createLazyGeminiAi();
    await expect(ai.embed(["hosted, free-tier, personal text"])).rejects.toThrow(/free-tier/i);
  });
});
