import { Body, Controller, Delete, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { CheckinService, createUserClient } from "@cortex/core";
import { createCheckinInput, type CreateCheckinInput } from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";

// Writes only. Reads stay on supabase-js against RLS (the 1a architecture), so there is
// no GET here -- the check-in history is a client query, not an endpoint.
@Controller("checkins")
@UseGuards(SupabaseAuthGuard)
export class CheckinsController {
  // A fresh client per request, carrying the caller's JWT -- RLS is the enforcement,
  // so there is no service-role key anywhere on this path (spec §4.1).
  private svc(user: AuthedUser) { return new CheckinService(createUserClient(user.token), user.id); }

  @Post()
  create(@CurrentUser() user: AuthedUser,
         @Body(new ZodValidationPipe(createCheckinInput)) body: CreateCheckinInput) {
    return this.svc(user).create(body);
  }

  @Delete(":id")
  remove(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc(user).softDelete(id);
  }
}
