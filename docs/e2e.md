# End-to-end tests

Two suites, one backend. **Playwright** drives `apps/web` in headless Chromium; **Maestro**
drives `apps/mobile` on an Android emulator. Both run against the local Supabase stack plus
`apps/api`, and the mobile one additionally needs a PowerSync Service container.

| Workflow | Trigger | Cold | Warm |
| --- | --- | --- | --- |
| `.github/workflows/e2e-web.yml` | every PR to `main` | ~9–12 min | ~6–8 min |
| `.github/workflows/e2e-mobile.yml` | PRs to `main` touching mobile/api/shared/sync/core/migrations/e2e/.maestro | ~40–55 min | ~20–28 min |

**This repo is public, so GitHub Actions is free and unmetered on standard runners.** The
numbers above matter for PR latency, not for quota. (If it ever goes private: Free plan is
2,000 min/month at a ×1 Linux multiplier, so one cold mobile run is ~2.5% of the month.)

Mobile is dominated by the op-sqlite SQLCipher + FTS5 NDK compile (~20–30 min cold, largely
cached after) and the first AVD boot (~8–10 min cold, ~2–3 warm).

---

## Running the web suite locally

```bash
pnpm exec supabase start                      # keep realtime; see "Realtime" below
pnpm turbo run build --filter=@cortex/web --filter=@cortex/api

eval "$(pnpm exec supabase status -o env | tr -d '"' | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY)=')"
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY"
export NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 E2E_API_URL=http://127.0.0.1:3001

PORT=3001 node apps/api/dist/main.js &        # do NOT set SUPABASE_JWT_SECRET
node e2e/scripts/seed.mjs --reset

pnpm --filter @cortex/web exec playwright install chromium   # once
pnpm --filter @cortex/web exec playwright test               # or: --ui
```

Playwright starts `next start` itself (`webServer` in `playwright.config.ts`) and reuses an
already-running server outside CI.

## Running the mobile suite locally

Needs everything above, plus: Android SDK with an API 33 x86_64 `google_apis` AVD, **JDK 17**
(RN 0.86's Gradle plugin rejects newer ones), and Docker.

```bash
export SUPABASE_URL=http://127.0.0.1:54321
bash e2e/powersync/up.sh                       # PowerSync on :8080

export EXPO_PUBLIC_E2E=1
export EXPO_PUBLIC_SUPABASE_URL=http://10.0.2.2:54321
export EXPO_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY"
export EXPO_PUBLIC_API_URL=http://10.0.2.2:3001
export EXPO_PUBLIC_POWERSYNC_URL=http://10.0.2.2:8080

pnpm turbo run build --filter='@cortex/mobile^...'
(cd apps/mobile && pnpm exec expo prebuild --platform android --no-install)
node e2e/scripts/patch-android.mjs
(cd apps/mobile/android && ./gradlew assembleDebug --no-daemon -PreactNativeArchitectures=x86_64)

node e2e/scripts/seed.mjs --reset > /tmp/seed.json
emulator -avd <your-api-33-avd> -no-boot-anim &
bash e2e/scripts/run-maestro.sh
```

`10.0.2.2` is the emulator's alias for the host loopback. The host-side scripts use
`127.0.0.1`; both sets of variables exist for that reason.

---

## Facts that were measured, not read

Each of these cost a round trip. They are recorded so the next person does not repeat them.

- **PowerSync listens on 8080 inside the container**, not 80. Its README documents
  `-p 8080:80`. Mapped that way the container is `Up`, the port looks published, and every
  probe answers `Empty reply from server`.
- **There is no `/probes/ready`** on v1.23.3 — it 404s. `/probes/liveness` and
  `/probes/startup` both work; startup is the one that also means replication initialised.
- **Bucket storage is Postgres**, in its own `powersync_storage` database. The Mongo container
  PowerSync's compose demo uses is unnecessary here.
- **`--network host` does not work on Docker Desktop.** `up.sh` publishes a port and reaches the
  host through `host.docker.internal` (with `--add-host=…:host-gateway` for Linux).
- **`supabase start` issues ES256 access tokens.** The CLI still reports a legacy HS256
  `JWT_SECRET`, and it verifies nothing. Leave `SUPABASE_JWT_SECRET` unset so the API guard and
  PowerSync both use JWKS.
- **New users are gated.** `00008_invite_gate.sql` puts a trigger on `auth.users`; the admin API
  is not a way around it. `seed.mjs` inserts into `allowed_emails` first, as service_role.
- **Postgres's `english` config treats both halves of `don't` as stop words**, so the web search
  for it correctly returns nothing. The mobile mirror asserts a *hit* because there the risk is
  FTS5 quote syntax, not stemming.
- **`getByRole("alert")` is never unique in Next.js** — it injects
  `<div id="__next-route-announcer__" role="alert">` into every page.
- **A grep-for-a-marker guard on the built bundle cannot work.** As an unconditional export the
  string is in every bundle; as a conditional one Metro tree-shakes it out of every bundle.
  `android-apk.yml` asserts `EXPO_PUBLIC_E2E` is absent from its environment instead.

### Realtime

`e2e-web.yml` keeps the realtime container; `e2e-mobile.yml` and `ci.yml` drop it. That is not
an inconsistency: `apps/web`'s note list is driven by `postgres_changes` and `quick-capture.tsx`
does no optimistic insert, while `apps/mobile` uses PowerSync for its download path and never
touches Realtime.

---

## What is NOT covered, and why

**The sign-in screens of both apps.** Both use `signInWithOAuth({provider:"google"})` and
nothing else; Google's consent screen is not automatable. The E2E user is created through the
Supabase admin API, and the session is injected — as cookies on web (`e2e/global-setup.ts`),
over a `cortex://e2e-session` deep link on mobile. Everything behind sign-in is covered.

**The three app-lock behaviours** (prompt on cold start, no prompt inside the 60s grace, prompt
after it). The APK under test is built with `EXPO_PUBLIC_E2E=1`, which makes `authenticate()`
return `true` without prompting — an emulator has no enrolled Class 3 biometric, so the gate
would otherwise never open. Covering these needs a second APK without the flag plus
`adb shell locksettings set-pin` and `adb emu finger touch 1`. `shouldRelock` is unit-tested;
the `AppState` wiring in `AppLockGate` is a manual check on a real device.

**Re-enrolling a biometric → the "offline copy was reset" banner.** Driving the Settings UI to
add a second fingerprint and waiting for KeyStore invalidation is too flaky to be worth it.
`db-key.test.ts` covers the `lost` transition.

**Restoring a trashed note on mobile.** `restoreNote` exists in `apps/mobile/src/lib/note-edits.ts`
and is unit-tested, but **no screen imports it** — `note-editor.tsx` renders a bare `In trash`
where a restore control would go. The web app has `Restore` and `Delete forever` buttons in its
trash view; mobile has neither. There is nothing to drive. Wiring that button is a product
change, not a test change.

**Live updates on web.** `apps/web/e2e/capture.spec.ts` marks the live-echo case `test.fixme`.
Measured: the write lands, the row is in Postgres, `notes` is in the `supabase_realtime`
publication and the container is healthy — and no `postgres_changes` event reaches the open
page. Two candidates, not yet distinguished: `note-list.tsx` builds a fresh browser client
inside its effect and subscribes immediately, which may race session hydration and leave
Realtime evaluating RLS as anon (in which case live updates are broken for real users too); or
the cookie-injected session hydrates differently from an OAuth one. **This is worth resolving
before trusting the web suite's coverage of realtime behaviour.**

### The limit of a green mobile run

The emulator has clean host networking — no Doze, no cell handover, no captive portal. The
`connected=true` assertion in `02-online-basics.yaml` (the export button's label is rendered
from `useStatus().connected`) catches the bug if it is in the code. It cannot catch it if it is
in the environment. Closing the open real-device sync issue still needs one manual run on
hardware.
