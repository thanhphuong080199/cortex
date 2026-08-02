import { Body, Controller, ForbiddenException, Post, UseGuards } from "@nestjs/common";
import { createUserClient } from "@cortex/core";
import { syncUploadInput, type SyncUploadInput } from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { applySyncOps } from "./sync/router";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("sync")
@UseGuards(SupabaseAuthGuard)
export class SyncController {
  @Post("upload")
  upload(@CurrentUser() user: AuthedUser,
         @Body(new ZodValidationPipe(syncUploadInput)) body: SyncUploadInput) {
    // RLS would reject a foreign user_id anyway, but a batch that tries it is a client
    // bug or an attack -- neither should be answered with a partial success. Rejecting
    // the whole batch keeps the failure loud.
    const foreign = body.ops.find(
      (o) => o.data?.user_id !== undefined && o.data.user_id !== user.id,
    );
    if (foreign) throw new ForbiddenException(`op ${foreign.op_id}: user_id does not match the caller`);

    // A fresh client per request, carrying the caller's JWT -- RLS is the enforcement,
    // so there is no service-role key anywhere on this path (spec §4.1).
    return applySyncOps(createUserClient(user.token), user.id, body.ops);
  }
}
