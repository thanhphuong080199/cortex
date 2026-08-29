import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The E2E build flag turns off a security control, so the thing worth testing is not that the
 * flag WORKS -- it is that it stays off. `IS_E2E_BUILD` is a build-time constant in a real
 * build (Metro inlines EXPO_PUBLIC_*), but under vitest `process.env` is read at module
 * evaluation, so re-importing after changing it exercises the same comparison.
 *
 * Each case resets the module registry because the constant is captured once at import.
 */
const ORIGINAL = process.env.EXPO_PUBLIC_E2E;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EXPO_PUBLIC_E2E;
  else process.env.EXPO_PUBLIC_E2E = ORIGINAL;
  vi.resetModules();
});

async function loadE2E(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env.EXPO_PUBLIC_E2E;
  else process.env.EXPO_PUBLIC_E2E = value;
  return import("./e2e.js");
}

describe("IS_E2E_BUILD", () => {
  it("is false when EXPO_PUBLIC_E2E is unset", async () => {
    const { IS_E2E_BUILD } = await loadE2E(undefined);
    expect(IS_E2E_BUILD).toBe(false);
  });

  /**
   * The exact-match check matters more than it looks. A truthiness test would make
   * `EXPO_PUBLIC_E2E=0` and `EXPO_PUBLIC_E2E=false` both enable the bypass, and those are
   * precisely the spellings someone reaches for when trying to turn it OFF.
   */
  it("is false for every value other than the exact string '1'", async () => {
    for (const value of ["0", "false", "true", "yes", "", "1 ", "01"]) {
      const { IS_E2E_BUILD } = await loadE2E(value);
      expect(IS_E2E_BUILD, `EXPO_PUBLIC_E2E=${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("is true only for '1'", async () => {
    const { IS_E2E_BUILD } = await loadE2E("1");
    expect(IS_E2E_BUILD).toBe(true);
  });
});

// There was a second block here covering `authenticate()`'s E2E bypass -- the biometric app
// lock's. The lock was dropped on 2026-08-25 (68b618c) and app-lock.ts with it on 2026-08-29,
// so the only bypass this flag still opens is the deep-link session route, and that one is
// exercised for real by .maestro/subflows/install-session.yaml on every E2E run.
