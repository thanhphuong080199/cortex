import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The real numeric values of `LocalAuthentication.SecurityLevel`, from
 * expo-local-authentication@57.0.2 `src/LocalAuthentication.types.ts`.
 *
 * They are spelled out here rather than imported so the assertions below are anchored to the
 * package's actual contract. A mock that invented its own numbering would let an implementation
 * comparing against the wrong level pass.
 */
const LEVEL = { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 } as const;

let enrolledLevel: number = LEVEL.BIOMETRIC_STRONG;

vi.mock("expo-local-authentication", () => ({
  authenticateAsync: vi.fn(async () => ({ success: true })),
  hasHardwareAsync: vi.fn(async () => true),
  isEnrolledAsync: vi.fn(async () => true),
  getEnrolledLevelAsync: vi.fn(async () => enrolledLevel),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));

const { LOCK_GRACE_MS, shouldRelock, authenticate, hasStrongBiometrics } =
  await import("./app-lock.js");

beforeEach(() => {
  enrolledLevel = LEVEL.BIOMETRIC_STRONG;
  vi.clearAllMocks();
});

describe("shouldRelock", () => {
  it("locks on cold start (never backgrounded)", () => {
    expect(shouldRelock(null, 1_000)).toBe(true);
  });
  it("does not lock inside the grace period", () => {
    expect(shouldRelock(1_000, 1_000 + LOCK_GRACE_MS - 1)).toBe(false);
  });
  it("locks once the grace period has elapsed", () => {
    expect(shouldRelock(1_000, 1_000 + LOCK_GRACE_MS)).toBe(true);
  });
  it("uses a 60 second grace period", () => {
    expect(LOCK_GRACE_MS).toBe(60_000);
  });
});

describe("authenticate", () => {
  it("requests Class 3 biometrics and keeps the device-credential fallback", async () => {
    const la = await import("expo-local-authentication");
    await authenticate();
    expect(la.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ biometricsSecurityLevel: "strong", disableDeviceFallback: false }),
    );
  });

  it("returns false when the prompt is dismissed", async () => {
    const la = await import("expo-local-authentication");
    vi.mocked(la.authenticateAsync).mockResolvedValueOnce({ success: false } as never);
    expect(await authenticate()).toBe(false);
  });
});

/**
 * This predicate decides whether the SQLCipher key can be stored behind
 * `requireAuthentication: true`, so it has to answer the SAME question expo-secure-store asks
 * internally -- not a similar one.
 *
 * `AuthenticationHelper.assertBiometricsSupport()` (expo-secure-store@57.0.1) calls
 * `canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)` and throws unless it
 * returns BIOMETRIC_SUCCESS. `getEnrolledLevelAsync()` reports BIOMETRIC_STRONG under exactly
 * that condition, so it is the matching question.
 *
 * `isEnrolledAsync()` is NOT, and that is the trap: it is
 * `canAuthenticateUsingWeakBiometrics() == BIOMETRIC_SUCCESS`, so a phone whose only enrolled
 * biometric is 2D image-based face unlock answers `true` while SecureStore still throws
 * "No biometrics are currently enrolled". Those are precisely the Class 2 devices spec 7.6
 * singles out as spoofable, so getting this wrong crashes the app on the exact hardware the
 * spec was worried about.
 */
describe("hasStrongBiometrics", () => {
  it("is true when a Class 3 biometric is enrolled", async () => {
    enrolledLevel = LEVEL.BIOMETRIC_STRONG;
    expect(await hasStrongBiometrics()).toBe(true);
  });

  it("is false for a Class 2 biometric, which SecureStore refuses to gate on", async () => {
    enrolledLevel = LEVEL.BIOMETRIC_WEAK;
    expect(await hasStrongBiometrics()).toBe(false);
  });

  it("is false on a PIN/pattern-only device", async () => {
    enrolledLevel = LEVEL.SECRET;
    expect(await hasStrongBiometrics()).toBe(false);
  });

  it("is false with no device security at all", async () => {
    enrolledLevel = LEVEL.NONE;
    expect(await hasStrongBiometrics()).toBe(false);
  });

  it("asks for the enrolled LEVEL, not isEnrolledAsync", async () => {
    const la = await import("expo-local-authentication");
    await hasStrongBiometrics();
    expect(la.getEnrolledLevelAsync).toHaveBeenCalled();
    expect(la.isEnrolledAsync).not.toHaveBeenCalled();
  });
});
