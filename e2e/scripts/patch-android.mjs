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
