import { Body, Controller, Delete, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { createUserClient, TagService } from "@cortex/core";
import { attachTagInput, createTagInput, type AttachTagInput, type CreateTagInput } from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";

// Rootless @Controller(): these routes span two prefixes (/tags and /notes/:id/tags)
// but share one service.
@Controller()
@UseGuards(SupabaseAuthGuard)
export class TagsController {
  private svc(user: AuthedUser) { return new TagService(createUserClient(user.token), user.id); }

  @Post("tags")
  findOrCreate(@CurrentUser() user: AuthedUser,
               @Body(new ZodValidationPipe(createTagInput)) body: CreateTagInput) {
    return this.svc(user).findOrCreate(body);
  }

  @Post("notes/:id/tags")
  attach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) noteId: string,
         @Body(new ZodValidationPipe(attachTagInput)) body: AttachTagInput) {
    return this.svc(user).attach(noteId, body.tagId);
  }

  @Delete("notes/:id/tags/:tagId")
  async detach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) noteId: string,
               @Param("tagId", ParseUUIDPipe) tagId: string) {
    await this.svc(user).detach(noteId, tagId);
    return { ok: true };
  }
}
