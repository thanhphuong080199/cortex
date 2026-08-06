import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.E2E_WEB_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",

  /**
   * Serial, deliberately.
   *
   * Every spec drives ONE seeded account (e2e/scripts/seed.mjs creates a single user), so
   * parallel workers would capture, edit and trash each other's notes -- and the failures that
   * produces look like sync bugs rather than like a test-isolation problem, which is the most
   * expensive kind of false positive this suite could generate. Giving each worker its own user
   * is the real fix and is not worth it for a suite this size.
   */
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  // One retry in CI absorbs a genuinely flaky network hop to the local stack. Zero locally, so
  // a developer sees the flake instead of having it hidden from them.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html"], ["github"]] : [["list"]],

  globalSetup: "./e2e/global-setup.ts",

  use: {
    baseURL: BASE_URL,
    // Produced by globalSetup; every spec starts signed in. See that file for why the session
    // is injected rather than typed into the login screen.
    storageState: "e2e/.auth/user.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // `next start`, not `next dev`: the specs assert on server-rendered output and on the
    // redirect in src/app/page.tsx, and dev-mode recompilation makes the first navigation of
    // each spec slow enough to trip its own timeout.
    command: "pnpm start",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
