import { defineConfig } from "vitest/config";
// No database here: this package is schema declarations, so the suite is pure.
export default defineConfig({ test: { environment: "node" } });
