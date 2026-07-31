import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { AuthedUser } from "./supabase-auth.guard";

// Exported separately (rather than only inline in createParamDecorator) so it can be
// unit tested directly with a fake ExecutionContext, without going through Nest's
// param-decorator resolution pipeline.
export function currentUserFactory(_data: unknown, ctx: ExecutionContext): AuthedUser {
  const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
  // `user` is only ever set by SupabaseAuthGuard. A route using @CurrentUser() without
  // @UseGuards(SupabaseAuthGuard) would otherwise get `undefined` here despite the
  // AuthedUser return type — an uncaught TypeError deep in the handler instead of a
  // clean 401. Fail closed instead.
  if (!req.user) {
    throw new UnauthorizedException("No authenticated user on request; is this route guarded by SupabaseAuthGuard?");
  }
  return req.user;
}

export const CurrentUser = createParamDecorator(currentUserFactory);
