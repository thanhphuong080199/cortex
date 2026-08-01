import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { createUserClient, ExportService } from "@cortex/core";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";

@Controller("export")
@UseGuards(SupabaseAuthGuard)
export class ExportController {
  @Get()
  async export(@CurrentUser() user: AuthedUser, @Res() res: Response) {
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="cortex-export-${date}.zip"`);
    // Piped directly into the Express response -- memory stays flat (spec §4.3).
    await new ExportService(createUserClient(user.token), user.id).buildArchive(res);
  }
}
