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
   * The saved-answer write, reached from the chat box's offer (C5 §11) and from the
   * saved-external chip (§6.3). Both send the same body to the same route, which is half of
   * why the two produce the same row; buildSavedAnswerRow is the other half.
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
    });
  }
}
