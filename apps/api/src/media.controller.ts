import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { createUserClient, MediaService } from "@cortex/core";
import { logMediaInput, type LogMediaInput } from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";

// One route: find-or-create is deliberately server-side, so the client just sends the
// typed title -- whether or not it came from the autocomplete -- and never has to decide
// if it is looking at a new item or an existing one.
@Controller("media-log")
@UseGuards(SupabaseAuthGuard)
export class MediaController {
  private svc(user: AuthedUser) { return new MediaService(createUserClient(user.token), user.id); }

  @Post()
  log(@CurrentUser() user: AuthedUser,
      @Body(new ZodValidationPipe(logMediaInput)) body: LogMediaInput) {
    return this.svc(user).logMedia(body);
  }
}
