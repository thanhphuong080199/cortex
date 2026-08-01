import { defineConfig } from "vitest/config";

// fileParallelism off for the same reason as @cortex/db: these suites share one local
// Postgres and create users with fixed emails, so parallel files collide.
export default defineConfig({
  test: { environment: "node", setupFiles: ["dotenv/config"], testTimeout: 30000, fileParallelism: false },
});
