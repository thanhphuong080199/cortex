import { Module } from "@nestjs/common";
import { CheckinsController } from "./checkins.controller";
import { ExportController } from "./export.controller";
import { HealthController } from "./health.controller";
import { MeController } from "./me.controller";
import { MediaController } from "./media.controller";
import { NotesController } from "./notes.controller";
import { TagsController } from "./tags.controller";

@Module({
  controllers: [
    HealthController, MeController, NotesController, TagsController, ExportController,
    CheckinsController, MediaController,
  ],
})
export class AppModule {}
