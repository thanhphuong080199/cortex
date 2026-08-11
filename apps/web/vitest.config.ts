import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Default environment is node: most suites test pure logic (api client, view predicate,
// debounced saver) and gain nothing from a DOM. Component tests (*.test.tsx) opt into jsdom
// per-file with a `// @vitest-environment jsdom` docblock at the top of the file -- not
// `environmentMatchGlobs`, which does the same job but is deprecated as of vitest 3 (a
// console warning on every run, "use test.projects instead") in favour of a heavier
// multi-project setup this repo doesn't otherwise need for four thin logic suites plus one
// component suite.
export default defineConfig({
  // Automatic JSX runtime so .tsx test files don't need `import React` in scope just to use
  // JSX -- Next.js already compiles the app this way; esbuild needs telling explicitly since
  // vitest runs outside Next's own build pipeline.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
