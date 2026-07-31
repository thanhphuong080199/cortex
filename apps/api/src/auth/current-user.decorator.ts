import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AuthedUser } from "./supabase-auth.guard";

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedUser =>
    ctx.switchToHttp().getRequest().user,
);
