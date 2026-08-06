#!/usr/bin/env bash
# The ordered Maestro run, including the radio toggles Maestro cannot do itself.
#
# This lives in a script rather than inline in the workflow for two reasons:
# reactivecircus/android-emulator-runner takes a single `script`, and the ordering IS the test
# design -- a developer who cannot reproduce the sequence locally cannot debug a CI failure.
#
# Expects: an emulator already booted and visible to adb, a built debug APK, and /tmp/seed.json
# from e2e/scripts/seed.mjs. SUPABASE_ANON_KEY must be exported.
set -euo pipefail

APK=apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
APP_ID=app.cortex.mobile
SEED=${SEED_FILE:-/tmp/seed.json}

curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"
maestro --version

adb install -r "$APK"

# Captured for the artifact upload. The `[powersync]` status line (lib/powersync.ts) is the one
# place `connected=` is ever printed, and it is the first thing to read when a download-side
# flow times out.
adb logcat -c
adb logcat > /tmp/logcat.txt 2>&1 &

ACCESS_TOKEN=$(jq -r .accessToken "$SEED")
REFRESH_TOKEN=$(jq -r .refreshToken "$SEED")

# Everything that does NOT change when the session is re-minted after 01. The note ids in
# particular must survive: the flows below assert against the corpus that is already there.
FIXED=(
  -e "APP_ID=$APP_ID"
  -e "SUPABASE_URL=http://127.0.0.1:54321"
  -e "SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY:?}"
  -e "API_URL=http://127.0.0.1:3001"
  -e "NOTE_EDIT_TARGET=$(jq -r .noteIds.editTarget "$SEED")"
  -e "NOTE_PURGE_TARGET=$(jq -r .noteIds.purgeTarget "$SEED")"
  -e "NOTE_TRASH_TARGET=$(jq -r .noteIds.trashTarget "$SEED")"
  -e "NOTE_RESTORE_TARGET=$(jq -r .noteIds.restoreTarget "$SEED")"
  -e "NOTE_CONFLICT_TARGET=$(jq -r .noteIds.conflictTarget "$SEED")"
  -e "CAPTURE_MARKER=offline capture marker"
  -e "DOUBLE_TAP_MARKER=double tap marker"
)

# Rebuilt whenever the tokens change, because Maestro takes them by value on the command line.
build_common() {
  COMMON=(
    "${FIXED[@]}"
    -e "ACCESS_TOKEN=$ACCESS_TOKEN"
    -e "REFRESH_TOKEN=$REFRESH_TOKEN"
  )
}
build_common

# `run-as` works because a debug APK is debuggable; it is the only way to see an app's private
# storage without root. Recorded BEFORE sign-out so the assertion afterwards compares against
# something real rather than against a guessed filename -- PowerSync's database name is not
# something this script should hard-code.
db_files() {
  adb shell run-as "$APP_ID" sh -c 'ls -1 databases files 2>/dev/null' 2>/dev/null || true
}

echo "::group::01 first login and sync"
maestro test .maestro/01-first-login-and-sync.yaml "${COMMON[@]}"
echo "::endgroup::"

# 01 ends signed out. Sign-out wipes local data BEFORE clearing the Supabase session
# (lib/auth.ts), and a wipe that failed must not read as a clean sign-out. Maestro can only see
# the screen, and an empty-looking list is exactly what a zero-height list produced once while
# every row was present -- so this is checked on the filesystem instead.
AFTER_SIGNOUT="$(db_files)"
if echo "$AFTER_SIGNOUT" | grep -qiE '\.(sqlite|db)($|[0-9-])'; then
  echo "::error::a local database survived sign-out:"
  echo "$AFTER_SIGNOUT"
  exit 1
fi
echo "sign-out wipe: no database files remain"

# 01 SIGNED OUT, WHICH KILLED THE TOKENS EVERY FLOW BELOW WAS GOING TO USE.
# `supabase.auth.signOut()` takes the global scope by default (lib/auth.ts passes no options), so
# it deletes the user's sessions server-side, not just this device's copy. The access token then
# fails the session_id check GoTrue does on /auth/v1/user, which is the call setSession makes --
# so app/e2e-session.tsx would report "E2E session failed" for the rest of the run.
#
# Minting a fresh pair is the fix rather than narrowing the app's sign-out to `scope: 'local'`:
# signing out everywhere is the product's behaviour, and 01 asserting it is the point.
#
# --no-corpus so this only signs in. Re-seeding would add a second copy of every note and break
# the counts 02 and 04b assert. The note ids stay as FIXED captured them.
echo "::group::re-mint the session 01 signed out of"
node e2e/scripts/seed.mjs --no-corpus > /tmp/seed-reauth.json
ACCESS_TOKEN=$(jq -r .accessToken /tmp/seed-reauth.json)
REFRESH_TOKEN=$(jq -r .refreshToken /tmp/seed-reauth.json)
build_common
echo "re-minted the E2E session"
echo "::endgroup::"

echo "::group::02 online basics"
maestro test .maestro/02-online-basics.yaml "${COMMON[@]}"
echo "::endgroup::"

echo "::group::03 server to device"
maestro test .maestro/03-server-to-device.yaml "${COMMON[@]}"
echo "::endgroup::"

# ---- offline half ----
# Which command actually works varies by emulator image, so try the modern one and fall back.
# `svc` alone leaves the emulator's cellular data up on some images, which is why both are set.
go_offline() {
  adb shell cmd connectivity airplane-mode enable 2>/dev/null \
    || { adb shell svc wifi disable; adb shell svc data disable; }
}
go_online() {
  adb shell cmd connectivity airplane-mode disable 2>/dev/null \
    || { adb shell svc wifi enable; adb shell svc data enable; }
}

echo "::group::04a offline actions"
go_offline
# The app needs a moment to notice; 04a's first assertion waits for the export button to flip,
# so a slow radio shows up there rather than as a mid-flow surprise.
maestro test .maestro/04a-offline-actions.yaml "${COMMON[@]}"
echo "::endgroup::"

echo "::group::04b reconnect and verify"
go_online
maestro test .maestro/04b-reconnect-verify.yaml "${COMMON[@]}"
echo "::endgroup::"

echo "all flows passed"
