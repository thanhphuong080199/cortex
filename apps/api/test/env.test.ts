import { describe, expect, it } from "vitest";
import { parseApiEnv } from "../src/env";

describe("parseApiEnv", () => {
  it("accepts a valid SUPABASE_URL", () => {
    const env = parseApiEnv({ SUPABASE_URL: "http://127.0.0.1:54321" });
    expect(env.SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });

  it("throws when SUPABASE_URL is missing", () => {
    expect(() => parseApiEnv({})).toThrow();
  });

  it("throws when SUPABASE_URL is not a valid URL", () => {
    // The exact bug this guards against: an unset/undefined SUPABASE_URL used to only
    // surface later as `new URL("undefined/...")` inside the auth guard's JWKS fetch.
    expect(() => parseApiEnv({ SUPABASE_URL: "undefined" })).toThrow();
  });

  it("PORT and CORS_ORIGINS are optional", () => {
    const env = parseApiEnv({ SUPABASE_URL: "http://127.0.0.1:54321" });
    expect(env.PORT).toBeUndefined();
    expect(env.CORS_ORIGINS).toBeUndefined();
  });
});
