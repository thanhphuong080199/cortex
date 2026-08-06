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

/* ---------------------------------------------------------------- bundleInDebug */
/**
 * A plain `assembleDebug` APK contains NO JavaScript: React Native's Gradle plugin skips the
 * bundle step in debug and the app expects a Metro dev server at runtime. In CI that means a
 * background Metro process plus `adb reverse tcp:8081`, and a red screen whenever either is a
 * second late. Bundling in debug trades ~30s of build time for removing that whole class of
 * flake.
 */
let gradle = readFileSync(GRADLE, "utf8");
if (/bundleInDebug/.test(gradle)) {
  console.log("bundleInDebug: already present, left alone");
} else if (/react\s*\{/.test(gradle)) {
  gradle = gradle.replace(/react\s*\{/, "react {\n    bundleInDebug = true");
  writeFileSync(GRADLE, gradle);
  console.log("bundleInDebug: patched into the react { } block");
} else {
  // Loud rather than silent: without the bundle the APK installs, launches, and shows a red
  // screen, and the Maestro failure would name a missing element instead of a missing bundle.
  console.error(
    "::error::no `react { }` block in app/build.gradle — cannot enable bundleInDebug. " +
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
