/**
 * The single place the E2E build flag is read.
 *
 * WHAT THIS WEAKENS, AND WHY IT IS SAFE
 *
 * Google OAuth cannot be driven by a test on a CI emulator -- its consent screen is not
 * automatable. When this flag is on, `app/e2e-session.tsx` will install a session handed to it
 * over a deep link instead. That is a real reduction in security and it may NEVER be on in a
 * build a user installs.
 *
 * It used to gate a second bypass as well: the mandatory biometric lock, which an emulator with
 * no enrolled Class 3 biometric could never clear. The lock was dropped on 2026-08-25 (68b618c)
 * and `app-lock.ts` with it on 2026-08-29, so the deep-link session is now the only thing here.
 *
 * What keeps that true:
 *
 *  1. `EXPO_PUBLIC_*` is inlined by Metro at BUILD time, not read at runtime. In a build made
 *     without the variable set, the comparison below is `undefined === "1"`, so this constant is
 *     the literal `false`. There is no runtime toggle, no env file, and no debug menu that can
 *     flip it on an APK that has already been built.
 *  2. Nothing in eas.json, app.json or .github/workflows/android-apk.yml sets it. The ONLY
 *     place it is set is .github/workflows/e2e-mobile.yml, whose APK is a CI artifact.
 *  3. android-apk.yml refuses to build at all if the variable is present in its environment.
 *
 * WHY THERE IS NO BUNDLE MARKER TO GREP FOR
 *
 * An earlier version exported a marker string for the release workflow to find in the built
 * bundle. Two measured results killed it. Written as an unconditional `export const`, the string
 * sat in EVERY bundle, so the guard would have failed every legitimate release. Written as a
 * conditional, Metro tree-shook it out of the E2E bundle too -- nothing imports it, so it is
 * dropped whether or not the flag is on, and the guard was blind in both directions. Keeping it
 * would have meant deliberately retaining dead weight in production bundles to make a test
 * artifact detectable. The environment assertion in android-apk.yml checks the same thing
 * deterministically and costs nothing.
 */
export const IS_E2E_BUILD = process.env.EXPO_PUBLIC_E2E === "1";
