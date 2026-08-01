import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", setupFiles: ["dotenv/config"], testTimeout: 30000 },
  plugins: [swc.vite()],
});
