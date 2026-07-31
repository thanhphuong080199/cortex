import { Controller, Get, UseGuards } from "@nestjs/common";
import { CurrentUser } from "./auth/current-user.decorator";
import { SupabaseAuthGuard, type AuthedUser } from "./auth/supabase-auth.guard";

@Controller("me")
@UseGuards(SupabaseAuthGuard)
export class MeController {
  @Get()
  me(@CurrentUser() user: AuthedUser) {
    return { id: user.id, email: user.email };
  }
}
