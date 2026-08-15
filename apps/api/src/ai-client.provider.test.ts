import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLazyGeminiAi } from "./ai-client.provider";
import { parseApiEnv } from "./env";

// createLazyGeminiAi must refuse to build a real client for a free-tier key against hosted data
// (spec §15.6 rule 2) -- the same guard enrich.module.ts's onModuleInit applies before building
// ITS Gemini client. assertTierAllowsRealData throws synchronously, before createGeminiAi (and
// therefore before any fetch) ever runs, so this is provable without the real Gemini API ever
// being reached -- NO TEST MAY EVER CALL THE REAL GEMINI API (packages/core/src/ai/fake.ts).
//
// This suite builds its ENTIRE environment below rather than leaning on whatever the process
// happens to carry, for two independent reasons:
//
//  1. Correctness. get() calls parseApiEnv BEFORE assertTierAllowsRealData, and this branch made
//     DATABASE_URL / GEMINI_API_KEY / GEMINI_TIER / ENRICH_MONTHLY_BUDGET_USD /
//     ASSISTANT_MONTHLY_BUDGET_USD required. With any of them missing, parseApiEnv throws a
//     ZodError naming that variable, `rejects.toThrow`
//     sees a rejection, and /free-tier/i does not match -- so the test fails for a reason that
//     has nothing to do with the rule it exists to pin. Locally that never happened because
//     vitest's `setupFiles: ["dotenv/config"]` backfilled apps/api/.env; CI has no .env by
//     design (see the "Assert no .env files" step in ci.yml), which is exactly the divergence
//     that hid this.
//
//  2. Safety, which matters more. The developer's real GEMINI_API_KEY is in that same .env. The
//     ONLY thing standing between this test and a live, billable call against it is the ORDER of
//     two statements inside get(): assertTierAllowsRealData before createGeminiAi. Reorder them
//     -- a refactor, a merge -- and this test starts embedding "hosted, free-tier, personal
//     text" against a real key, on a free tier, whose prompts Google uses for training. A test
//     whose safety rests on the implementation not changing is not a safe test, so the fetch
//     stub below makes the network unreachable regardless of order: the guard is what SHOULD
//     stop it, the stub is what DOES if the guard ever moves.
describe("createLazyGeminiAi", () => {
  // A hosted SUPABASE_URL/DATABASE_URL pair naming the SAME project ref, so parseApiEnv's own
  // same-database check passes and the failure below is provably assertTierAllowsRealData, not
  // an unrelated env-shape error. The ref is a literal, not a real credential: the password is
  // "pw" and nothing here is ever connected to.
  const HOSTED_ENV: Record<string, string> = {
    SUPABASE_URL: "https://wilssluxogpdrbgffmzc.supabase.co",
    DATABASE_URL:
      "postgresql://postgres.wilssluxogpdrbgffmzc:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
    SUPABASE_ANON_KEY: "anon-key-never-sent-anywhere",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-never-sent-anywhere",
    GEMINI_API_KEY: "dummy-key-this-test-must-never-reach-the-network",
    GEMINI_TIER: "free",
    ENRICH_MONTHLY_BUDGET_USD: "5",
    ASSISTANT_MONTHLY_BUDGET_USD: "5",
  };

  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const [key, value] of Object.entries(HOSTED_ENV)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    // Not a spy on a real fetch -- a replacement that CANNOT reach the network. Throwing beats
    // returning a fake 200: a silently-satisfied embed() would let a reordered implementation
    // pass this suite while having really called out, which is the failure mode being guarded.
    vi.stubGlobal("fetch", () => {
      throw new Error("test attempted a network call; no test may reach the real Gemini API");
    });
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    vi.unstubAllGlobals();
  });

  // Proves the claim the two tests below rest on, and does it WITHOUT needing a runner that has
  // no ambient environment: parseApiEnv takes the env to read as an argument, so handing it the
  // literal map -- never process.env -- checks that HOSTED_ENV alone satisfies every required
  // variable in src/env.ts. Locally this suite would pass either way, because vitest's
  // `setupFiles: ["dotenv/config"]` loads apps/api/.env and backfills anything missing; CI has
  // no .env on purpose, which is the divergence that made this suite red there and green here.
  // Without this assertion, adding a sixth required variable to envSchema puts it straight back
  // into that state, and the next person sees it only as a CI failure in an unrelated PR.
  it("carries every variable env.ts requires, with no help from the ambient environment", () => {
    expect(() => parseApiEnv(HOSTED_ENV)).not.toThrow();
  });

  it("refuses a free-tier key against hosted data before constructing a real client", async () => {
    const ai = createLazyGeminiAi();
    await expect(ai.embed(["hosted, free-tier, personal text"])).rejects.toThrow(/free-tier/i);
  });

  // The rejection above must come from the tier guard and nothing else. Without this, a future
  // env change that made parseApiEnv throw first would leave the suite green only because the
  // message happened to still match -- or red for a reason no one would read as "the guard
  // moved". Naming the stub explicitly proves the network was never the thing that stopped it.
  it("is stopped by the guard, not by the unreachable network", async () => {
    const ai = createLazyGeminiAi();
    const err = await ai.embed(["hosted, free-tier, personal text"]).then(
      () => new Error("embed() resolved; the tier guard did not fire at all"),
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/free-tier/i);
    expect((err as Error).message).not.toMatch(/attempted a network call/);
  });
});
