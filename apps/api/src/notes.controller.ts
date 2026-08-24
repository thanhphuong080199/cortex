import { Body, Controller, Delete, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { createUserClient, NoteService, saveAnswer } from "@cortex/core";
import {
  createNoteInput, saveAnswerInput, updateNoteInput,
  type CreateNoteInput, type SaveAnswerInput, type UpdateNoteInput,
} from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("notes")
@UseGuards(SupabaseAuthGuard)
export class NotesController {
  // A fresh client per request, carrying the caller's JWT -- RLS is the enforcement,
  // so there is no service-role key anywhere on this path (spec §4.1).
  private svc(user: AuthedUser) { return new NoteService(createUserClient(user.token), user.id); }

  @Post()
  create(@CurrentUser() user: AuthedUser,
         @Body(new ZodValidationPipe(createNoteInput)) body: CreateNoteInput) {
    return this.svc(user).create(body);
  }

  @Patch(":id")
  update(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
         @Body(new ZodValidationPipe(updateNoteInput)) body: UpdateNoteInput) {
    return this.svc(user).update(id, body);
  }

  @Delete(":id")
  softDelete(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc(user).softDelete(id);
  }

  @Post(":id/restore")
  restore(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc(user).restore(id);
  }

  @Delete(":id/purge")
  purge(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc(user).purge(id);
  }

  /**
   * The saved-answer write. Today the offer's accept action (C5 §11) is its only caller; the
   * saved-external chip (§6.3) is not built yet by this plan. Whichever caller reaches this
   * route -- one today, a second later -- sends the same body to it, which is half of why the
   * two will produce the same row once both exist; buildSavedAnswerRow is the other half.
   */
  @Post("save-answer")
  async saveAnswer(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(saveAnswerInput)) body: SaveAnswerInput,
  ): Promise<{ id: string }> {
    return saveAnswer(createUserClient(user.token), {
      userId: user.id,
      statement: body.statement,
      ...(body.sourceUrl !== undefined ? { sourceUrl: body.sourceUrl } : {}),
      ...(body.forMessageId !== undefined ? { forMessageId: body.forMessageId } : {}),
    });
  }
}
