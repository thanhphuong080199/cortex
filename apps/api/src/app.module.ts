import { Module } from "@nestjs/common";
import { ExportController } from "./export.controller";
import { HealthController } from "./health.controller";
import { MeController } from "./me.controller";
import { NotesController } from "./notes.controller";
import { TagsController } from "./tags.controller";

@Module({
  controllers: [HealthController, MeController, NotesController, TagsController, ExportController],
})
export class AppModule {}
