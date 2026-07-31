import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface AuthedUser { id: string; email: string; token: string }

// HS256 with the project JWT secret when provided (local dev / legacy projects),
// otherwise the project's JWKS endpoint (asymmetric keys, production).
//
// NOTE: as of Supabase CLI 2.x, `supabase start` issues asymmetric (ES256) access
// tokens by default even though `supabase status` still reports a legacy JWT_SECRET
// for backward compatibility — that legacy secret does NOT verify real tokens. This
// repo's local .env therefore leaves SUPABASE_JWT_SECRET unset so the guard falls
// through to the JWKS path (served locally at {SUPABASE_URL}/auth/v1/.well-known/jwks.json)
// for local dev too, exercising the same code path used in production.

const SUPABASE_AUDIENCE = "authenticated";

// Supabase's asymmetric JWT signing keys can be ES256 or RS256 depending on project
// configuration (the local stack observed here issues ES256; hosted projects may be
// configured for either). Both are accepted on the JWKS path so this guard keeps
// working across projects without a code change. HS256 is only ever accepted on the
// legacy shared-secret path below — the two branches never share an algorithm.
const ASYMMETRIC_ALGORITHMS = ["ES256", "RS256"];

// Verification-key selection is intentionally lazy — re-read from process.env on every
// call (memoized by value, not by call count) — rather than resolved once at module
// import time. Production behavior is unchanged (env vars are static at runtime there),
// but this lets tests exercise the HS256 branch by setting SUPABASE_JWT_SECRET before
// invoking the guard directly, without needing to reimport the module.
let cachedSecretValue: string | undefined;
let cachedSecretKey: Uint8Array | undefined;
let cachedJwksUrl: string | undefined;
let cachedJwks: JWTVerifyGetKey | undefined;

async function verify(token: string): Promise<JWTPayload> {
  const secretEnv = process.env.SUPABASE_JWT_SECRET;
  if (secretEnv) {
    if (cachedSecretValue !== secretEnv) {
      cachedSecretKey = new TextEncoder().encode(secretEnv);
      cachedSecretValue = secretEnv;
    }
    const { payload } = await jwtVerify(token, cachedSecretKey!, {
      algorithms: ["HS256"],
      audience: SUPABASE_AUDIENCE,
    });
    return payload;
  }

  const url = `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  if (cachedJwksUrl !== url || !cachedJwks) {
    cachedJwks = createRemoteJWKSet(new URL(url));
    cachedJwksUrl = url;
  }
  const { payload } = await jwtVerify(token, cachedJwks, {
    algorithms: ASYMMETRIC_ALGORITHMS,
    audience: SUPABASE_AUDIENCE,
  });
  return payload;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) throw new UnauthorizedException("Missing bearer token");

    let payload: JWTPayload;
    try {
      payload = await verify(token);
    } catch (err) {
      // A malformed/expired/wrong-signature/wrong-audience token is a client auth
      // failure (401). Anything else — e.g. the JWKS endpoint being unreachable — is
      // an infra failure, not proof the token is bad, so let it propagate and surface
      // as a 5xx instead of masquerading as "unauthenticated".
      if (err instanceof joseErrors.JOSEError) {
        throw new UnauthorizedException("Invalid token");
      }
      throw err;
    }

    if (!payload.sub) throw new UnauthorizedException("Invalid token");
    req.user = { id: payload.sub, email: String(payload.email ?? ""), token };
    return true;
  }
}
