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

Neither suite is a required status check, and neither should become one — see
[`ci.md`](./ci.md), "branch protection may only ever require `CI gate`". `e2e-mobile.yml` is
path-filtered, so on a docs-only PR it never reports at all.

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

## Writing a Maestro flow

Five CI cycles on PR #6 were spent on assertions that failed while the thing they wanted was
plainly on screen. **No `apps/mobile` code was changed to fix any of them** — every one was a
defect in the flow. Two of them had been passing *vacuously*.

Read the `maestro-debug-output` artifact — `screen-hierarchy/*.json` and the screenshot — before
forming any hypothesis about sync or the app. The screenshot alone is misleading; the hierarchy
is what Maestro actually matched against.

### 1. Nothing in the note list starts on screen

`NoteList`'s `ListHeaderComponent` — capture box, check-in widget, media form, search box, view
chips — is **taller than any emulator viewport**, and a `FlatList` never renders off-screen rows
into the accessibility hierarchy at all. So a note that has synced perfectly is still absent from
the hierarchy.

- Use `scrollUntilVisible`, never `extendedWaitUntil`, to reach a row. It retries until its
  timeout, so it is still a real wait — the 90s in `wait-for-download.yaml` is unchanged in
  meaning, only in method.
- `scrollUntilVisible` needs the element **fully** inside the viewport, not merely intersecting.
- Run `subflows/scroll-to-top.yaml` before every DOWN scroll. Scroll position carries across
  commands and `back` restores it, so a DOWN scroll for a row a previous step already scrolled
  past runs to the end of the list instead of finding it.
- `scroll-to-top.yaml` targets the `capture-input` **testID**, not the "Capture a thought"
  placeholder, which disappears the moment anything is typed.
- **An edit moves its row.** The list is `ORDER BY updated_at DESC`, so after editing a note it
  is at the top, not where you left it. Re-locate it; do not tap where it was.
- Seed order is the reverse of row order. `seed.mjs` writes Zarquon → Edit → Purge → Trash →
  Restore → Conflict → Apostrophe, so on screen that is Apostrophe first and Zarquon last.

### 2. The keyboard covers the rows, and never leaves on its own

The search box keeps focus after `inputText`, leaving roughly a 10px strip of list visible — so
`scrollUntilVisible` can never satisfy "fully visible" for any row.

`hideKeyboard` after `inputText`/`eraseText` — **but only where the keyboard is provably up.** On
Android it fires a back event. The IME swallows that while showing; with no keyboard up it
**navigates**, and the next step runs on the wrong screen.

The same asymmetry is why a bare `back` after typing never leaves a screen: the back press is
spent dismissing the keyboard. In the editor, `hideKeyboard` must come *before* `back`.

### 3. Selectors are regexes matched against the element's WHOLE text

`tapOn: Login` matches exactly `Login`, not `Login here`. For a substring, write `.*Continue.*`.

This is how two assertions were passing vacuously:

- `visible: "TYPEDFAST"` could never match `editor-input`, a multiline box holding the entire
  note body (`"…while offline.TYPEDFAST"`). It needs `".*TYPEDFAST.*"`.
- **Note bodies are never on screen in the list at all.** A row draws `title ?? content`, so
  asserting on a body there is unsatisfiable. Ask the FTS index through the search box instead.
  And note that `fts.ts` indexes **`content` only, not `title`** — a search for a note's title
  matches nothing, which makes a title-based FTS check pass for the wrong reason.
- Conflict copies inherit the original's title (`service.ts`: `title: current.title`), so both
  notes render identically. `04b` distinguishes them by searching for each *body* — one note
  cannot hold both, so a hit for each is two notes, which is the actual assertion.

### 4. Which flows own their state

| Flow | `clearState` | Depends on |
| --- | --- | --- |
| `01-first-login-and-sync` | `true` | seeded corpus only |
| `02-online-basics` | `true` | seeded corpus only |
| `03-server-to-device` | `true` | seeded corpus only |
| `04a-offline-actions` | **`false`** | the local DB `03` left behind |
| `04b-reconnect-verify` | **`false`** | `04a`'s DB, including its undrained upload queue |

01–03 are independent and can be run alone. **04a/04b cannot be decoupled and should not be** —
going offline, queueing writes, and reconnecting *is* the test; a self-seeding 04b would assert
nothing.

Because 04a inherits state it did not create and then goes offline immediately, it opens with a
`scrollUntilVisible` on `Conflict target`. That is a precondition check, not a step: it makes a
bad hand-off from 03 fail at the top of the flow, instead of surfacing thirty steps later as
`Conflict target not found`, which is indistinguishable from a sync bug without a 30-minute
re-run.

### 5. There is no retry, on purpose

Nothing in `run-maestro.sh` or `e2e-mobile.yml` retries. Every failure on PR #6 was a real defect
in the suite, so a retry would have hidden all five and converted them into intermittent green.
The suite is also cumulative: a retry replays from flow 01, so the worst case approaches the
75-minute job timeout.

The one genuine flake observed was **GitHub infrastructure** — run 31114390388 died after 35 log
lines with `Failed to resolve action download info. Error: Service Unavailable`, before any step
ran. No script-level retry can help with that; `gh run rerun --failed` is the answer.

### 6. Artifacts on a timeout

Both artifact steps are `if: failure() || cancelled()`, not `if: failure()`.

A job that exceeds `timeout-minutes` is **cancelled, not failed**, and `failure()` is false under
cancellation — so a hung 75-minute run, the outcome that most needs a logcat, uploaded nothing.
Cancelled jobs get a finite grace period in which these steps still run, so keep them cheap and
expect a genuinely wedged runner to lose them anyway.

`/tmp/seed.json` is **deliberately excluded** from the upload: it holds a live access token and
this repo is public, so artifacts are downloadable by anyone. The token only reaches a local
stack and expires in an hour, which makes publishing it harmless rather than sensible. The note
ids that make it useful for debugging are already in the Maestro output.

### 7. Sign-out kills the tokens every later flow was going to use

`lib/auth.ts` calls `supabase.auth.signOut()` with no options, and GoTrue defaults to **global**
scope — it revokes the user's sessions server-side, not just this device's copy. Flow 01 ends
signed out, so the seeded access token then fails the `session_id` check GoTrue performs on
`/auth/v1/user`, which is the call `setSession` makes. Every flow after 01 would report
"E2E session failed".

`run-maestro.sh` re-mints a session between 01 and 02 with `seed.mjs --no-corpus` (re-seeding the
corpus would double every note and break the counts 02 and 04b assert). Narrowing the app to
`scope: 'local'` would be the wrong fix — signing out everywhere is the product's behaviour, and
01 asserting it is the point.

Flow 01 only ever worked by accident: it happened to open the deep link 11.7s after launch, where
02 did so at 1.2s and the `/e2e-session` route had not mounted yet, so the link was **dropped
without an error**. `install-session.yaml` now waits for the signed-out home screen first.

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

- **A Realtime subscription with no user token is silently dead**, and the error blames the
  wrong thing. `realtime.subscription_check_filters()` builds its list of filterable columns
  from `has_column_privilege(claims->>'role', …)`, so an `anon` socket sees **zero** columns of
  `public.notes` (00009 revoked the defaults) and every filter is rejected with
  `invalid column for filter user_id` — a column that plainly exists. The channel still replies
  `status: ok`; the rejection arrives afterwards as a separate `system` frame. This is what the
  suite caught, and it was broken for real users, not just for the harness. Fixed by
  `supabase.realtime.setAuth(token)` in `note-list.tsx` before subscribing.
- **`next start` binds 3000 regardless**, so `playwright.config.ts` derives the port from
  `E2E_WEB_URL` and passes `--port`. With `reuseExistingServer`, a `next dev` left running by a
  developer would otherwise be adopted silently, and the suite fails with redirects to `/login`
  because that server has none of this env. (`next dev` also replaces `.next`, so
  `next start` then needs a rebuild.)
- **`CORS_ORIGINS` on the API must list whatever port the web server is on.** Moving the suite
  to 3100 without updating it makes every write fail while the page looks fine.

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

### The limit of a green mobile run

The emulator has clean host networking — no Doze, no cell handover, no captive portal. The
`connected=true` assertion in `02-online-basics.yaml` (the export button's label is rendered
from `useStatus().connected`) catches the bug if it is in the code. It cannot catch it if it is
in the environment. Closing the open real-device sync issue still needs one manual run on
hardware.
