import { Module } from "@nestjs/common";
import { CheckinsController } from "./checkins.controller";
import { ExportController } from "./export.controller";
import { HealthController } from "./health.controller";
import { MeController } from "./me.controller";
import { MediaController } from "./media.controller";
import { NotesController } from "./notes.controller";
import { SyncController } from "./sync.controller";
import { TagsController } from "./tags.controller";

@Module({
  controllers: [
    HealthController, MeController, NotesController, TagsController, ExportController,
    CheckinsController, MediaController, SyncController,
  ],
})
export class AppModule {}
