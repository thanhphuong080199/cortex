import { defineConfig } from "vitest/config";
// Pure-logic suites only: RN native modules are mocked per test file.
export default defineConfig({ test: { environment: "node" } });
