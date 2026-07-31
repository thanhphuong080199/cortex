import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

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
const secret = process.env.SUPABASE_JWT_SECRET
  ? new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET)
  : null;
const jwks = secret
  ? null
  : createRemoteJWKSet(new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

async function verify(token: string): Promise<JWTPayload> {
  const { payload } = secret
    ? await jwtVerify(token, secret)
    : await jwtVerify(token, jwks!);
  return payload;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) throw new UnauthorizedException("Missing bearer token");
    try {
      const payload = await verify(token);
      if (!payload.sub) throw new Error("no sub");
      req.user = { id: payload.sub, email: String(payload.email ?? ""), token };
      return true;
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
  }
}
