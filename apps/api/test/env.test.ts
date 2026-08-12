import { describe, expect, it } from "vitest";
import { parseApiEnv } from "../src/env";

// Minimal env satisfying every required key, so tests that only care about one field
// (e.g. SUPABASE_URL, PORT) don't have to restate the rest.
const base = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  GEMINI_API_KEY: "key",
  GEMINI_TIER: "free",
  ENRICH_MONTHLY_BUDGET_USD: "5",
};

describe("parseApiEnv", () => {
  it("accepts a valid SUPABASE_URL", () => {
    const env = parseApiEnv(base as NodeJS.ProcessEnv);
    expect(env.SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });

  it("throws when SUPABASE_URL is missing", () => {
    expect(() => parseApiEnv({})).toThrow();
  });

  it("throws when SUPABASE_URL is not a valid URL", () => {
    // The exact bug this guards against: an unset/undefined SUPABASE_URL used to only
    // surface later as `new URL("undefined/...")` inside the auth guard's JWKS fetch.
    expect(() => parseApiEnv({ ...base, SUPABASE_URL: "undefined" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("PORT and CORS_ORIGINS are optional", () => {
    const env = parseApiEnv(base as NodeJS.ProcessEnv);
    expect(env.PORT).toBeUndefined();
    expect(env.CORS_ORIGINS).toBeUndefined();
  });
});

describe("parseApiEnv — enrichment configuration", () => {
  it("accepts a local pair", () => {
    expect(() => parseApiEnv(base as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("accepts a hosted pair naming the same project ref", () => {
    expect(() =>
      parseApiEnv({
        ...base,
        SUPABASE_URL: "https://wilssluxogpdrbgffmzc.supabase.co",
        DATABASE_URL:
          "postgresql://postgres.wilssluxogpdrbgffmzc:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  // The exact configuration found in apps/api/.env on 2026-08-10.
  it("rejects a local SUPABASE_URL paired with a hosted DATABASE_URL", () => {
    expect(() =>
      parseApiEnv({
        ...base,
        DATABASE_URL:
          "postgresql://postgres.wilssluxogpdrbgffmzc:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
      } as NodeJS.ProcessEnv),
    ).toThrow(/same database/i);
  });

  it("rejects a hosted SUPABASE_URL whose DATABASE_URL names a different project ref", () => {
    expect(() =>
      parseApiEnv({
        ...base,
        SUPABASE_URL: "https://wilssluxogpdrbgffmzc.supabase.co",
        DATABASE_URL:
          "postgresql://postgres.someotherproject:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
      } as NodeJS.ProcessEnv),
    ).toThrow(/same database/i);
  });

  it("rejects a non-numeric budget", () => {
    expect(() => parseApiEnv({ ...base, ENRICH_MONTHLY_BUDGET_USD: "lots" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("rejects a tier outside free|paid", () => {
    expect(() => parseApiEnv({ ...base, GEMINI_TIER: "enterprise" } as NodeJS.ProcessEnv)).toThrow();
  });

  // Regression: the original guard only compared refs (`apiRef !== dbRef`), so two hosts
  // that were both ref-less -- neither a "*.supabase.co" URL nor a Supavisor "postgres.<ref>"
  // connection string -- always satisfied `apiRef !== dbRef === false` and passed silently,
  // no matter what they actually pointed at.
  it("rejects a local SUPABASE_URL paired with an unrelated non-Supabase DATABASE_URL", () => {
    expect(() =>
      parseApiEnv({
        ...base,
        DATABASE_URL: "postgresql://admin:pw@my-rds-instance.amazonaws.com:5432/mydb",
      } as NodeJS.ProcessEnv),
    ).toThrow(/same database/i);
  });

  // Host-equal, port-different: SUPABASE_URL's local stack is 54321/54322 by Supabase CLI
  // convention, but a project ref cannot be recovered from a bare loopback address, so this
  // layer has no fact to distinguish "the Supabase stack's Postgres" from "some other local
  // Postgres" beyond "both are loopback." Deliberately accepted rather than bent into a
  // rejection this check cannot justify -- see the `bothLocal` comment in env.ts.
  it("accepts a local SUPABASE_URL paired with a different local Postgres (port cannot be checked here)", () => {
    expect(() =>
      parseApiEnv({
        ...base,
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/otherdb",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
