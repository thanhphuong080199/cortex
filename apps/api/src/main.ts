import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
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

  const app = await NestFactory.create(AppModule);

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
