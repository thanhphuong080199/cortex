#!/usr/bin/env node
/**
 * Post-`expo prebuild` edits for the E2E debug APK, plus one assertion.
 *
 * apps/mobile/android/ is gitignored and regenerated on every run (app.json is the source of
 * truth), so none of this can be a tracked edit. Two of the three changes must ALSO never be
 * true of a release build, which is the second reason they live in a script the release
 * workflow does not call.
 *
 * Run from the repo root, after `expo prebuild --platform android`.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const GRADLE = "apps/mobile/android/app/build.gradle";
const MANIFEST = "apps/mobile/android/app/src/main/AndroidManifest.xml";

for (const f of [GRADLE, MANIFEST]) {
  if (!existsSync(f)) {
    console.error(`::error::${f} not found — run \`expo prebuild --platform android\` first`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------ debuggableVariants */
/**
 * A plain `assembleDebug` APK contains NO JavaScript: React Native's Gradle plugin treats
 * `debug` as a "debuggable variant" by default (`debuggableVariants = ['debug', 'debugOptimized']`
 * in ReactExtension) and skips the bundle step for those, so the app expects a Metro dev server
 * at runtime. In CI that means a background Metro process plus `adb reverse tcp:8081`, and a red
 * screen whenever either is a second late. Emptying `debuggableVariants` makes `debug` bundle
 * like any release variant, trading ~30s of build time for removing that whole class of flake.
 *
 * `bundleInDebug` was the property for this on older RN Gradle plugin versions; 0.86's
 * `ReactExtension` has no such property (`Could not set unknown property 'bundleInDebug'`) and
 * only exposes `debuggableVariants`.
 *
 * The idempotency check below must match an actual assignment, not just the word: expo
 * prebuild's generated build.gradle already contains the line
 * `// debuggableVariants = ["liteDebug", "prodDebug"]` as a commented-out example, which a bare
 * `/debuggableVariants/` test matches too. That false positive skipped patching entirely, so the
 * debug variant stayed on the default (['debug', 'debugOptimized']) and no JS was ever bundled --
 * this is what actually shipped, silently, until Maestro finally got far enough to notice the
 * app had no bundle.
 */
let gradle = readFileSync(GRADLE, "utf8");
if (/^\s*debuggableVariants\s*=/m.test(gradle)) {
  console.log("debuggableVariants: already present, left alone");
} else if (/react\s*\{/.test(gradle)) {
  gradle = gradle.replace(/react\s*\{/, "react {\n    debuggableVariants = []");
  writeFileSync(GRADLE, gradle);
  console.log("debuggableVariants: patched to [] in the react { } block");
} else {
  // Loud rather than silent: without the bundle the APK installs, launches, and shows a red
  // screen, and the Maestro failure would name a missing element instead of a missing bundle.
  console.error(
    "::error::no `react { }` block in app/build.gradle — cannot empty debuggableVariants. " +
      "If this RN version dropped the property, build assembleRelease instead " +
      "(android-apk.yml already does that and embeds JS via `expo export:embed`).",
  );
  process.exit(1);
}

/* ------------------------------------------------------------ cleartext traffic */
/**
 * The emulator reaches Supabase, the Nest API and PowerSync over plain http at 10.0.2.2.
 * Android 9+ blocks cleartext by default, and the symptom is a generic network failure deep
 * inside the sync stream that names nothing about TLS.
 */
let manifest = readFileSync(MANIFEST, "utf8");
if (/usesCleartextTraffic/.test(manifest)) {
  console.log("usesCleartextTraffic: already present, left alone");
} else {
  manifest = manifest.replace(/<application /, '<application android:usesCleartextTraffic="true" ');
  writeFileSync(MANIFEST, manifest);
  console.log("usesCleartextTraffic: patched to true");
}

/* --------------------------------------------- expo-dev-menu overlay assertions */
/**
 * The four meta-data keys that keep expo-dev-menu's own UI from covering the app.
 *
 * WHAT THIS IS FOR. `01-first-login-and-sync` went red on `main` on 2026-08-25 and stayed red
 * (runs 32808664046, 33169978187). It reads as a product bug and is not one: `tapOn: sign-out`
 * COMPLETES, then the 30s `extendedWaitUntil "Sign in with Google"` times out. The screen
 * hierarchy captured at that step holds exactly six strings -- Cortex / Reload / Go home /
 * TOOLS / Toggle performance monitor / Toggle element inspector. That is expo-dev-menu's bottom
 * sheet. The app was never signed out, and Maestro could not see the app at all.
 *
 * `toolsButton` is the one that was missing, and it is the one that caused it.
 * `MovableFloatingActionButton` (expo-dev-menu 57.0.10, android/src/debug) is hosted in a
 * LinearLayout with `z = Float.MAX_VALUE` -- above everything React Native draws -- and
 * `rememberFabState` starts it at `Offset(fabAreaBounds.x, 0f)`: the TOP-RIGHT corner, below
 * the status bar. Its pointer-input Box is the FAB plus a 16dp margin, so on this 320x640 mdpi
 * emulator it owns roughly x 236..320, y 24..108, and a tap inside that opens the dev menu.
 *
 * Maestro tapped the sign-out button at (268, 43). The button's own bounds are [231,30][306,56].
 * Those overlap, the FAB is on top, and the FAB won.
 *
 * WHY IT STARTED WHEN IT DID, since nothing about the dev menu changed: the 2026-08-24 redesign
 * (2c37798) moved sign-out out of the note list's footer and into the chat header's top-right --
 * i.e. underneath a button that had been sitting harmlessly in empty corner ever since
 * expo-dev-client was added. The suite was last green on 2026-08-09, before that move.
 *
 * WHY THIS FILE ONLY ASSERTS. All four values come from `apps/mobile/app.json`'s expo-dev-client
 * plugin block, which is the upstream-supported way to set them (expo-dev-launcher's config
 * plugin maps toolsButton/skipOnboarding/showMenuAtLaunch/embeddedBundle onto exactly these
 * meta-data names). Writing them here as well would give the same setting two owners and let
 * app.json rot silently. What this file adds is the thing app.json cannot: a build that FAILS
 * when the plugin stops emitting them, instead of a suite that goes red four steps later
 * against a screen that is not the app.
 *
 * NOT a release concern: every one of these lives in expo-dev-menu's `debug` source set, so
 * `assembleRelease` never compiles any of it and `android-apk.yml` correctly never runs this
 * script.
 */
const DEV_MENU_META = {
  // The overlay that actually broke the suite -- see above.
  EXDevMenuShowFloatingActionButton: "false",
  // `shouldShowAtLaunch = showsAtLaunch || !isOnboardingFinished` (DevMenuFragment.onCreate), so
  // both of these are needed and neither is sufficient. `launchApp: clearState: true` wipes the
  // SharedPreferences a human dismissal would have written, so on every run the defaults -- open
  // the menu -- are what apply unless these say otherwise.
  EXDevMenuShowsAtLaunch: "false",
  EXDevMenuIsOnboardingFinished: "true",
  // What puts "Load embedded bundle" on the dev launcher screen, which subflows/
  // dismiss-dev-launcher.yaml taps. Without it that flow has nothing to tap and the app never
  // gets past the launcher.
  EXDevClientEmbeddedBundle: "true",
};

// Attribute order inside the tag is not asserted: expo's `addMetaDataItemToMainApplication`
// emits name-then-value today, and a check that breaks when a serialiser reorders attributes
// would be a false alarm about the one thing this is not testing.
const missingMeta = Object.entries(DEV_MENU_META).filter(
  ([name, value]) =>
    !new RegExp(
      `<meta-data(?=[^>]*android:name="${name}")(?=[^>]*android:value="${value}")[^>]*>`,
    ).test(manifest),
);
if (missingMeta.length > 0) {
  console.error(
    `::error::AndroidManifest.xml is missing ${missingMeta.map(([n, v]) => `${n}="${v}"`).join(", ")}. ` +
      "These come from app.json (expo.plugins -> expo-dev-client -> android) and are what keep " +
      "expo-dev-menu's floating button and bottom sheet off the top of the app. Without them a " +
      "tap on the chat header's sign-out button opens the dev menu instead, and every assertion " +
      "after it fails against a screen that is not the app.",
  );
  process.exit(1);
}
console.log(`expo-dev-menu: verified ${Object.keys(DEV_MENU_META).length} overlay meta-data keys`);

/* ------------------------------------------------------- allowBackup assertion */
/**
 * Mục 2's "adb backup → refused/empty", checked at the property rather than through the
 * dialog.
 *
 * `adb backup` on API 33 needs an on-device confirmation nobody can tap unattended, so running
 * it in CI proves nothing either way. `android:allowBackup="false"` is what actually makes the
 * backup empty, it comes from app.json, and it is a §7.6 security property rather than a
 * preference -- so the useful test is that it survived prebuild. If app.json ever loses it,
 * this fails the E2E build.
 */
if (!/android:allowBackup="false"/.test(manifest)) {
  console.error(
    '::error::AndroidManifest.xml is missing android:allowBackup="false". ' +
      "It comes from app.json (expo.android.allowBackup) and is what makes `adb backup` empty.",
  );
  process.exit(1);
}
console.log('allowBackup: verified android:allowBackup="false"');
