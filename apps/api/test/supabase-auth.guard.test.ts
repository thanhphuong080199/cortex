import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { SupabaseAuthGuard, type AuthedUser } from "../src/auth/supabase-auth.guard";

// Unit-level coverage of SupabaseAuthGuard, independent of the live local Supabase
// stack's algorithm. The e2e suite (app.e2e.test.ts) always runs with
// SUPABASE_JWT_SECRET unset (the local stack issues ES256, verified via JWKS), so the
// HS256 branch never executes there. These tests instantiate the guard directly with a
// fake ExecutionContext and set process.env.SUPABASE_JWT_SECRET per test to exercise
// the HS256 branch, which the guard now resolves lazily per call (see supabase-auth.guard.ts)
// rather than once at module-import time, specifically so this is possible.

function makeCtx(req: { headers: Record<string, string | undefined>; user?: AuthedUser }): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe("SupabaseAuthGuard — HS256 branch (SUPABASE_JWT_SECRET set)", () => {
  const originalSecret = process.env.SUPABASE_JWT_SECRET;
  const testSecret = "unit-test-hs256-secret-at-least-32-bytes-long";
  const subject = "11111111-1111-4111-8111-111111111111";

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = originalSecret;
  });

  it("accepts a token signed with the configured HS256 secret and returns sub/email", async () => {
    process.env.SUPABASE_JWT_SECRET = testSecret;
    const token = await new SignJWT({ email: "hs256-user@test.local" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subject)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(testSecret));

    const req: { headers: Record<string, string>; user?: AuthedUser } = { headers: { authorization: `Bearer ${token}` } };
    const guard = new SupabaseAuthGuard();

    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.user).toEqual({ id: subject, email: "hs256-user@test.local", token });
  });

  it("rejects a token signed with the wrong HS256 secret", async () => {
    process.env.SUPABASE_JWT_SECRET = testSecret;
    const token = await new SignJWT({ email: "hs256-user@test.local" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subject)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-completely-different-secret-value"));

    const req = { headers: { authorization: `Bearer ${token}` } };
    const guard = new SupabaseAuthGuard();

    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a token with the wrong audience even with a correct HS256 signature", async () => {
    process.env.SUPABASE_JWT_SECRET = testSecret;
    const token = await new SignJWT({ email: "hs256-user@test.local" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subject)
      .setAudience("some-other-audience")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(testSecret));

    const req = { headers: { authorization: `Bearer ${token}` } };
    const guard = new SupabaseAuthGuard();

    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("SupabaseAuthGuard — JWKS branch infra failures", () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalSecret = process.env.SUPABASE_JWT_SECRET;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = originalSecret;
  });

  it("propagates (does not mask as 401) when the JWKS endpoint is unreachable", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.SUPABASE_URL = "http://127.0.0.1:1"; // nothing listens here; connection refused immediately

    // Well-formed compact JWT (valid base64url header/payload); verification never gets
    // far enough to check the signature because the key fetch itself fails first.
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "whatever", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "x", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url");
    const token = `${header}.${payload}.${Buffer.from("sig").toString("base64url")}`;

    const req = { headers: { authorization: `Bearer ${token}` } };
    const guard = new SupabaseAuthGuard();

    await expect(guard.canActivate(makeCtx(req))).rejects.not.toBeInstanceOf(UnauthorizedException);
  });
});
