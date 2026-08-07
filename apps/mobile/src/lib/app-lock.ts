import * as LocalAuthentication from "expo-local-authentication";

import { IS_E2E_BUILD } from "./e2e";

/**
 * Mandatory app lock (phase 1b spec §7.6, §7.7). The device holds the full note corpus,
 * so "borrowed phone" is a real threat, not a hypothetical.
 *
 * Short enough that a borrowed phone is protected; long enough that switching apps to
 * copy a link is not punished by a biometric prompt.
 */
export const LOCK_GRACE_MS = 60_000;

export function shouldRelock(backgroundedAt: number | null, now: number): boolean {
  if (backgroundedAt === null) return true; // cold start
  return now - backgroundedAt >= LOCK_GRACE_MS;
}

export async function authenticate(): Promise<boolean> {
  // A CI emulator has no enrolled Class 3 biometric, so the call below can only ever resolve
  // `success: false` there and the gate would render "Cortex is locked" for the whole run. See
  // lib/e2e.ts for why this branch cannot exist in a build anyone installs.
  //
  // The COST of this seam, stated plainly: the three lock behaviours in the phase-1b test plan
  // (prompt on cold start, no prompt inside the 60s grace, prompt after it) are not covered by
  // any E2E flow, because the build the flows run against has no lock. `shouldRelock` above is
  // unit-tested; the AppState wiring in AppLockGate that calls it is not, and stays a manual
  // check on a real device.
  if (IS_E2E_BUILD) return true;

  const r = await LocalAuthentication.authenticateAsync({
    promptMessage: "Unlock Cortex",
    // Default is 'weak', which admits Android Class 2 biometrics -- camera face unlock,
    // spoofable with a photo on some devices. Health, mood and finance data warrants
    // Class 3 (spec §7.6).
    biometricsSecurityLevel: "strong",
    // Deliberately left at the default. Disabling the fallback would lock out every
    // device with no enrolled biometric, which is a large share of Android.
    disableDeviceFallback: false,
  });
  return r.success;
}

/**
 * Can the SQLCipher key be stored behind `requireAuthentication: true` on this device?
 *
 * This exists because the app lock and the database key have DIFFERENT floors, and the spec
 * only settled the first one. §7.6 keeps `disableDeviceFallback: false` so a PIN-only device
 * still gets in — but expo-secure-store's `requireAuthentication` has no such fallback:
 * `AuthenticationHelper.assertBiometricsSupport()` throws "No biometrics are currently
 * enrolled" on both the read and the write path. Left unchecked, those users clear the lock
 * with their PIN and then hit a hard rejection fetching the key, which is the very lockout
 * §7.6 chose the fallback to avoid.
 *
 * `getEnrolledLevelAsync() === BIOMETRIC_STRONG` is the matching question, because it is the
 * same predicate SecureStore uses: `canAuthenticate(BIOMETRIC_STRONG) == BIOMETRIC_SUCCESS`.
 *
 * `isEnrolledAsync()` would be the WRONG question. It is
 * `canAuthenticateUsingWeakBiometrics() == BIOMETRIC_SUCCESS`, so a phone whose only enrolled
 * biometric is 2D face unlock answers `true` and SecureStore throws anyway — crashing on
 * exactly the Class 2 hardware §7.6 calls out as spoofable.
 */
export async function hasStrongBiometrics(): Promise<boolean> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  return level === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG;
}
