import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { CoreErrorFilter } from "./core-error.filter";
import { parseApiEnv } from "./env";

// Falls back to these when CORS_ORIGINS is unset — covers apps/web's dev server
// (`next dev --port 3000`) on both hostnames browsers may use for localhost.
const DEFAULT_CORS_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

async function bootstrap() {
  let env: ReturnType<typeof parseApiEnv>;
  try {
    env = parseApiEnv(process.env);
  } catch (err) {
    // Fail fast at boot with a readable message instead of limping along and failing
    // confusingly on the first request (see env.ts).
    console.error("Invalid environment configuration:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Express defaults the JSON body to 100 kB, and a full sync batch is bigger than that:
  // SYNC_UPLOAD_MAX_OPS is 500, whose envelope alone is ~75 kB before a single note's text.
  // A phone coming back from a day offline therefore hit 413 on its first upload -- and a 413
  // is indistinguishable to the client from any other rejection, so the batch was at risk of
  // being dropped rather than retried. The connector now retries it; this is what makes the
  // retry succeed instead of looping.
  app.useBodyParser("json", { limit: "10mb" });

  // Maps packages/core's CoreError to 404/409/500 so PostgREST codes never reach
  // clients (spec §6). The e2e suites register the same filter on their test app.
  app.useGlobalFilters(new CoreErrorFilter());

  const origins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : DEFAULT_CORS_ORIGINS;
  app.enableCors({ origin: origins });

  // Railway sends SIGTERM on redeploys/restarts; without this Nest never runs
  // onModuleDestroy/beforeApplicationShutdown hooks or closes connections gracefully —
  // the process is just killed.
  app.enableShutdownHooks();

  await app.listen(env.PORT ?? 3001);
}
void bootstrap();
