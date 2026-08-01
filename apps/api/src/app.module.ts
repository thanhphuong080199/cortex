import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { MeController } from "./me.controller";

@Module({ controllers: [HealthController, MeController] })
export class AppModule {}
