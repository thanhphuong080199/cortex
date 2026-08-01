import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Node environment, no jsdom: 1a tests only the pure logic (api client, view predicate,
// debounced saver). Components are thin rendering and are verified manually (spec §7).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
