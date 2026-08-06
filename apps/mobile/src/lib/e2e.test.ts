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

describe("authenticate", () => {
  /**
   * Mocked with the package's real SecurityLevel numbering, matching app-lock.test.ts -- a mock
   * that invented its own would let an implementation comparing the wrong level pass.
   */
  function mockLocalAuth(success: boolean) {
    const authenticateAsync = vi.fn(async () => ({ success }));
    vi.doMock("expo-local-authentication", () => ({
      authenticateAsync,
      hasHardwareAsync: vi.fn(async () => true),
      isEnrolledAsync: vi.fn(async () => true),
      getEnrolledLevelAsync: vi.fn(async () => 3),
      SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    }));
    return authenticateAsync;
  }

  it("does not prompt at all in an E2E build", async () => {
    vi.resetModules();
    process.env.EXPO_PUBLIC_E2E = "1";
    const authenticateAsync = mockLocalAuth(false);
    const { authenticate } = await import("./app-lock.js");

    // `true` even though the mocked prompt would have failed: the point is that the prompt is
    // never reached, which is what makes the gate passable on an emulator with no enrolled
    // biometric.
    await expect(authenticate()).resolves.toBe(true);
    expect(authenticateAsync).not.toHaveBeenCalled();
  });

  it("prompts for a Class 3 biometric when the flag is off", async () => {
    vi.resetModules();
    delete process.env.EXPO_PUBLIC_E2E;
    const authenticateAsync = mockLocalAuth(true);
    const { authenticate } = await import("./app-lock.js");

    await expect(authenticate()).resolves.toBe(true);
    expect(authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        biometricsSecurityLevel: "strong",
        disableDeviceFallback: false,
      }),
    );
  });

  it("still reports a refused prompt as a failure when the flag is off", async () => {
    vi.resetModules();
    delete process.env.EXPO_PUBLIC_E2E;
    mockLocalAuth(false);
    const { authenticate } = await import("./app-lock.js");
    await expect(authenticate()).resolves.toBe(false);
  });
});
