# Cortex Phase 0 deploy runbook

This is the step-by-step guide for turning the local-only Phase 0 build into the
hosted demo environment: a real Supabase project, real Google OAuth, and the API
running on Railway. It assumes no memory of prior sessions — every command and every
dashboard click that matters is written out below.

Everything in this doc uses placeholders (`<project-ref>`, `<org-id>`, ...). Never
commit the real values that fill them in — they belong in `.env.local` / `.env`
files (already gitignored) or in the Supabase/Railway/Google dashboards.

Steps 2-4 and 6 below require a human with browser access to Supabase, Google Cloud
Console, and Railway — they cannot be scripted end-to-end by an agent. Step 5 (the
API Dockerfile) is already implemented and verified locally; see
[Local Docker verification](#local-docker-verification-already-done) at the bottom.

## Provisioned environment (current state)

| Item | Value |
| --- | --- |
| Supabase project name | `cortex` |
| Project ref | `wilssluxogpdrbgffmzc` |
| Region | `ap-southeast-1` (Singapore) |
| Dashboard | https://supabase.com/dashboard/project/wilssluxogpdrbgffmzc |
| API URL | `https://wilssluxogpdrbgffmzc.supabase.co` |

The project ref and API URL are **not** secrets — they ship in every client bundle via
`NEXT_PUBLIC_SUPABASE_URL`. The DB password, service_role key, and Google client secret
**are** secrets and live only in a password manager and the dashboards.

Progress against the steps below:

- [x] **Step 1** — project created, linked, all 9 migrations pushed
      (`00001`..`00009`, confirmed via `supabase migration list`: local == remote),
      `allowed_emails` seeded with `phuong011999vn@gmail.com` (`owner`).
- [x] **Step 2** — Google Cloud OAuth client created and Supabase Google provider
      enabled; verified via `/auth/v1/settings` reporting `external.google = true`.
- [x] **Step 3** — web login verified end-to-end with a real Google account.
- [x] **Step 4** — mobile login verified on an EAS `preview` APK (**not** Expo Go —
      see the step for why). Same Google account as web: `auth.users` still holds
      exactly one row and its `last_sign_in_at` advanced from `03:08:34Z` (web) to
      `05:04:17Z` (phone), which is the spec's "phone + web, same account" item.
- [x] **Step 5** — API Dockerfile, built and verified locally
- [x] **Step 6** — API deployed to Railway at
      `https://cortex-api-production-8e4e.up.railway.app`; `/health` and `/me` both
      verified against the live URL.

> ⚠️ **The Railway deployment is on the free trial: $5 of credit, 30 days from
> 2026-08-01, so it lapses around 2026-08-31.** When it does, `/health` stops
> answering and the Phase 0 demo URL dies. Moving to the Hobby plan ($5/month,
> includes $5 of usage credit) keeps it alive. Railway's Free plan grants only $1 of
> monthly usage credit, which is not enough to keep an always-on container running.

Local client env files are already written and gitignored, pointing at the hosted
project: `apps/web/.env.local` and `apps/mobile/.env`.

### Verified live against the hosted project after Step 1

Run with the service_role and anon keys, against
`https://wilssluxogpdrbgffmzc.supabase.co`:

| Check | Result |
| --- | --- |
| Non-allow-listed signup (`stranger@example.com`, admin API) | `HTTP 500 {"code":"P0001","message":"Signup not allowed for stranger@example.com"}` — gate fires |
| `anon` reads `allowed_emails` | `200 []` — server-only table invisible |
| `anon` reads `notes` | `200 []` — RLS default-deny holds |

This covers the "invite gate rejects non-allow-listed accounts" DoD item at the
database layer. The trigger fires on `before insert on auth.users`, which is the
same code path a Google signup takes, so a non-allow-listed Google account is
rejected by the identical mechanism.

### Verified live after Steps 2-3 (web login)

| Check | Result |
| --- | --- |
| `/auth/v1/settings` → `external.google` | `true` |
| `GET /` on the web app | `307 → /login` — route protection active |
| `/auth/v1/authorize?provider=google&redirect_to=http://localhost:3000/auth/callback` | `302 → accounts.google.com` with the real `client_id`; `redirect_to` **preserved**, proving the URL is allow-listed (an unlisted value is silently replaced with the Site URL) |
| `auth.users` after signing in with Google | 1 user, `identities: [{provider: "google"}]`, `app_metadata.provider = "google"` |

Note the user count: the `stranger@example.com` gate probe above created no row,
so the allowlist held under a real admin-API signup attempt.

## Prerequisites

Accounts needed:
- A [Supabase](https://supabase.com) account with an organization you can create
  projects under.
- A [Google Cloud](https://console.cloud.google.com) account/project for the OAuth
  client.
- A [Railway](https://railway.app) account for hosting the API.

CLIs:
- **pnpm** and **Node 22+** — already required for this repo, nothing new to
  install.
- **Supabase CLI** — already a `devDependency` at the repo root
  (`supabase: ^2.110.0` in `package.json`). Do **not** install it globally; every
  command in this doc is invoked as `pnpm exec supabase ...` from the repo root,
  matching what `.github/workflows/ci.yml` does.
- **Railway CLI** — **not installed on this machine**. Install it first:
  ```bash
  npm install -g @railway/cli
  # or, on Windows PowerShell:
  #   irm https://railway.app/install.ps1 | iex
  railway --version   # sanity check
  ```

## Step 1 — Create and link the hosted Supabase project, push the schema

All commands from the repo root, using the workspace's pinned CLI:

```bash
pnpm exec supabase login
pnpm exec supabase orgs list                 # find your <org-id>
pnpm exec supabase projects create cortex --org-id <org-id> --db-password <strong-password> --region ap-southeast-1
pnpm exec supabase link --project-ref <project-ref>
pnpm exec supabase db push                   # applies migrations 00001..00008 in supabase/migrations/
```

- `<project-ref>` is the short id Supabase assigns (visible in the `projects create`
  output and in the dashboard URL `https://supabase.com/dashboard/project/<project-ref>`).
- Pick a region close to you; it cannot be changed later without recreating the
  project.
- `supabase db push` applies every migration under `supabase/migrations/` in order
  (`00001_extensions_helpers.sql` through `00008_invite_gate.sql`) to the hosted
  database. Confirm it reports all 8 as applied before moving on.

### Seed `allowed_emails` — REQUIRED before any login attempt

Migration `00008_invite_gate.sql` installs a `before insert on auth.users` trigger
(`check_email_allowed_trigger`) that raises an exception — rejecting the signup —
for any email not present in `public.allowed_emails`. The `allowed_emails` table has
RLS enabled with **no policies**, and grants are `service_role`-only, so it cannot be
edited through the client libraries or Table Editor's normal RLS-aware view; use the
Supabase Dashboard's **SQL Editor** (`https://supabase.com/dashboard/project/<project-ref>/sql/new`),
which runs as a privileged role:

```sql
insert into public.allowed_emails (email, note) values
  ('<your-google-email>', 'owner');
```

**Do this before attempting any Google login.** If you skip it, the very first
sign-in attempt (Step 3) will fail confusingly: Supabase's callback page shows a
generic "Database error saving new user" with no indication it's the invite gate —
by design (see Step 2 of the task brief; friendlier copy is a later polish item).
Add every teammate's Google account email here as you invite them.

## Step 2 — Google Cloud OAuth client + Supabase provider config

**Google Cloud Console** (`APIs & Services → Credentials`, for the Google Cloud
project you want to use — create one if needed):

1. `+ Create Credentials → OAuth client ID`.
2. Application type: **Web application**.
3. Authorized redirect URI — must match exactly:
   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```
4. Save. Copy the generated **Client ID** and **Client secret**.
5. `APIs & Services → OAuth consent screen`: set User type to **External**, fill in
   the app name/support email, and under **Test users** add every Google account
   that needs to sign in (including your own) while the app is in "Testing"
   publishing status. (Publishing to production removes the test-user cap but
   triggers Google's verification process — not needed for the Phase 0 demo.)

**Supabase Dashboard** (`https://supabase.com/dashboard/project/<project-ref>/auth/providers`):

1. `Authentication → Providers → Google` → toggle **Enabled**.
2. Paste the **Client ID** and **Client Secret** from Google Cloud Console above.
3. Save.

**Supabase Dashboard — URL Configuration**
(`https://supabase.com/dashboard/project/<project-ref>/auth/url-configuration`):

1. **Site URL**: `http://localhost:3000` for now (Phase 0 web isn't deployed yet —
   see spec note that web is online-only but not yet hosted anywhere besides
   `localhost` for this phase).
2. **Redirect URLs** — add both:
   - `http://localhost:3000/auth/callback`
   - `cortex://*` — the mobile deep-link scheme. This matches `"scheme": "cortex"`
     in `apps/mobile/app.json`; Expo's auth-session flow redirects back into the app
     via `cortex://...` after the Google consent screen, and Supabase must have that
     scheme allow-listed or the redirect is rejected.

### How this relates to `supabase/config.toml`'s `[auth.external.google]` block

`supabase/config.toml` (checked into the repo) has:

```toml
[auth.external.google]
enabled = true
client_id = "env(GOOGLE_OAUTH_CLIENT_ID)"
secret = "env(GOOGLE_OAUTH_CLIENT_SECRET)"
```

This section only affects the **local** Supabase stack started by `supabase start`
(the one at `127.0.0.1:54321` used for local dev and CI) — it reads
`GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` from your shell environment at
`supabase start` time. It is entirely independent of the hosted project's provider
config, which lives in the Supabase Dashboard as configured above and is **not**
driven by `config.toml` at all. You can:
- leave the local env vars unset (as this repo currently does — see the comment in
  `config.toml`: no real Google OAuth client existed on the dev machine as of Task
  8-11, so local sign-in was exercised via email/password test helpers in
  `packages/db/src/test/clients.ts` instead), or
- optionally point the **same** Google OAuth client at both: add a second Authorized
  redirect URI in Google Cloud Console for the local stack
  (`http://127.0.0.1:54321/auth/v1/callback`) and export
  `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` before `supabase start`, if
  you want local Google sign-in too. Not required for the Phase 0 demo, which only
  needs the hosted project working.

## Step 3 — Verify web login end-to-end

Point the web app at the hosted project. Edit `apps/web/.env.local` (already
gitignored) — variable names must match what `apps/web/src/lib/supabase/client.ts`
and `server.ts` actually read:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<hosted anon key>
```

The anon key is under `Project Settings → API` in the dashboard
(`https://supabase.com/dashboard/project/<project-ref>/settings/api`) — the
"anon public" key, not the service role key.

```bash
pnpm --filter @cortex/web dev
```

Open `http://localhost:3000`, sign in with a Google account that **is** in
`allowed_emails` — the home page should show that account's email.

Also verify the gate works the other way: attempt sign-in with a Google account
**not** in `allowed_emails`. Supabase's callback page should show a database-error
message (expected — see the note in Step 1; this is acceptable UX for Phase 0).

## Step 4 — Verify mobile login end-to-end

Point the mobile app at the same hosted project. Edit `apps/mobile/.env` — variable
names must match what `apps/mobile/src/lib/supabase.ts` reads:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<hosted anon key — same value as web's>
```

### Expo Go does NOT work for this project — use an EAS build

The original draft of this step said "Expo Go or a dev build". **Expo Go is not an
option here**, for two independent reasons, both established by testing rather than
assumed:

1. **SDK mismatch.** The app targets Expo SDK 57 (`expo ^57.0.9`,
   `react-native 0.86.2`, `react 19.2.3`). Expo Go reports
   `Project is incompatible with this version of Expo Go` and refuses to run the
   current bundle — a stale cached bundle can still launch, which makes this look
   like an intermittent bug rather than a hard incompatibility.
2. **Supabase will not allow-list Expo Go's redirect URL.** In Expo Go,
   `makeRedirectUri({ scheme: "cortex" })` resolves to `exp://<lan-ip>:8081/--/`
   rather than `cortex://`, because Expo Go cannot register a third-party custom
   scheme. Adding `exp://192.168.1.39:8081/**` to the Redirect URLs list **does not
   work** — the entry saves fine but Supabase's matcher still rejects every
   `exp://` form, falling back to the Site URL. Symptom: after Google consent the
   browser lands on `http://localhost:3000` (the phone's own localhost, where
   nothing is listening) and sign-in silently fails.

How this was verified — `/auth/v1/authorize` is **not** a valid probe, because it
echoes any `redirect_to` you hand it, including `https://evil.example.com/steal`.
The admin `generate_link` endpoint *does* enforce the allow-list (note `redirect_to`
is a **top-level** field, not nested under `options`):

```bash
curl -X POST "https://<project-ref>.supabase.co/auth/v1/admin/generate_link" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"magiclink","email":"<you>","redirect_to":"cortex://"}'
```

If the returned `action_link` echoes your `redirect_to` verbatim it is allow-listed;
if it comes back as the Site URL it was rejected. Always run a known-good and a
known-bad control alongside the candidate, or the probe proves nothing.

Result on this project: `cortex://` and `http://localhost:3000/auth/callback` are
**allowed**; every `exp://192.168.1.39:8081/...` form is **rejected**.

### Build and install the APK

`apps/mobile/eas.json` defines a `preview` profile — a standalone internal-distribution
APK. It is deliberately not the `development` profile, which would additionally require
the `expo-dev-client` package just to verify sign-in.

`.env` is gitignored and **EAS Build does not upload gitignored files**, so the two
`EXPO_PUBLIC_*` values must live as EAS environment variables or the build ships with
them `undefined`. They are set on the `preview` environment, and the profile declares
`"environment": "preview"` so they actually get injected:

```bash
cd apps/mobile
eas login
eas init                     # links the project, writes extra.eas.projectId into app.json
eas env:create --name EXPO_PUBLIC_SUPABASE_URL      --value "https://<project-ref>.supabase.co" \
  --environment preview --visibility plaintext --scope project --type string
eas env:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "<hosted anon key>" \
  --environment preview --visibility plaintext --scope project --type string
eas build -p android --profile preview
```

Confirm the build log line `Environment variables ... loaded from the "preview"
environment` appears — if it doesn't, the profile is missing `"environment"` and the
app will crash on launch with an undefined Supabase URL.

Install the resulting APK on the device, sign in with **the same** Google account used
in Step 3, and confirm the email is shown. Together with Step 3 this satisfies the
Phase 0 spec requirement: the same Google account signed in on both web and phone.

### `expo start` rewrites `apps/mobile/tsconfig.json` — check before committing

Running `expo start` reformats that file and **strips `.expo/types/**/*.ts` and
`expo-env.d.ts` from `include`** (it logs only
`TypeScript: The tsconfig.json#include property has been updated`). Those entries are
committed on purpose; losing them can break `pnpm typecheck` in CI. Run
`git diff apps/mobile/tsconfig.json` after any `expo start` and revert if it changed.

### Do not run `supabase config push` to fix redirect URLs

It pushes the local `supabase/config.toml`, which carries
`site_url = "http://127.0.0.1:3000"`, `additional_redirect_urls = ["https://127.0.0.1:3000"]`,
and an `[auth.external.google]` block reading env vars that are unset on a typical dev
machine. Running it would overwrite the hosted Site URL and redirect allow-list and can
disable the Google provider, wiping the client ID/secret configured in Step 2.

## Step 5 — API Dockerfile (already done — see verification below)

`apps/api/Dockerfile` and `apps/api/Dockerfile.dockerignore` are implemented and
verified locally (build + run + curl). See
[Local Docker verification](#local-docker-verification-already-done) below for what
was actually run and its output. Nothing further to do here unless the image needs
changes.

## Step 6 — Deploy the API to Railway

Verified against **railway CLI 5.30.3**. The earlier draft of this step guessed at
flags; the sequence below is what actually ran.

`railway up --dockerfile <path>` **does not exist** on CLI 5.x. Build config comes
from `railway.json` at the **repo root** (committed):

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "apps/api/Dockerfile" },
  "deploy": { "healthcheckPath": "/health", "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 3 }
}
```

Every command runs from the **repo root** — the build context must be the repo root,
not `apps/api/`, because `apps/api/Dockerfile` copies `packages/`, `pnpm-lock.yaml`,
and `pnpm-workspace.yaml` from above `apps/api/`. If Railway's settings expose a
"Root Directory" field, leave it at `/`.

```bash
npm install -g @railway/cli
railway login                      # opens a browser; cannot be scripted

# `init` needs an explicit workspace when run non-interactively.
railway whoami --json              # -> .workspaces[0].id
railway init --name cortex-api --workspace <workspace-id> --json

# `init` creates the project but NOT a service; variables need a service to attach to.
railway add --service cortex-api --json

railway variables --service cortex-api \
  --set "SUPABASE_URL=https://<project-ref>.supabase.co" --set "PORT=3001"
railway variables --service cortex-api --kv     # confirm both, and that SUPABASE_JWT_SECRET is ABSENT

railway up --service cortex-api --detach --yes

# Railway does NOT assign a public URL by default - generate one:
railway domain --service cortex-api --port 3001 --json
```

Notes from the real run:

- `railway variables --set ...` may print *"This session is missing Railway's agent
  tooling ... `railway setup agent`"*. That is a **nudge, not a failure** — the
  variables are still set. Confirm with `railway variables --kv` rather than
  re-running or installing the agent tooling.
- Without `railway domain`, the service builds and runs but is unreachable from the
  internet, which looks like a broken deploy.
- The deploy answered `/health` about 45 s after `railway up` returned.

### Why `SUPABASE_JWT_SECRET` must stay unset in production

`apps/api/src/auth/supabase-auth.guard.ts` picks its verification strategy based on
whether `SUPABASE_JWT_SECRET` is set at request time (`verify()` in that file):

- **If set**: verifies the bearer token as HS256 using that shared secret. This is
  the legacy Supabase signing scheme.
- **If unset**: fetches `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` and verifies
  the token as ES256 or RS256 against the project's real, asymmetric signing keys
  (`createRemoteJWKSet` from `jose`, cached across requests).

Hosted Supabase projects issue asymmetric (ES256) access tokens by default (the same
is true of the local stack — see the comment block at the top of
`supabase-auth.guard.ts`). There is no legacy HS256 secret that will actually verify
those tokens; `supabase status`/dashboard-shown "JWT secret" values are kept only for
backward compatibility with older projects and will make the guard reject every real
token as invalid if you set it here. Leaving `SUPABASE_JWT_SECRET` unset in Railway's
variables makes the guard use the JWKS path — the correct one for this project — and
is also literally the only variable this API needs beyond `SUPABASE_URL` and `PORT`.

### Verify the Railway deployment

You do **not** need to dig a token out of DevTools. A real ES256 access token can be
minted server-side with the service_role key, without setting a password on a
Google-only account: `generate_link` returns an `action_link`, and fetching that link
*without following redirects* yields a `Location` header containing `#access_token=`.

```bash
# 1. mint (redirect_to must be an allow-listed URL)
ACTION=$(curl -s -X POST "https://<project-ref>.supabase.co/auth/v1/admin/generate_link" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"magiclink","email":"<you>","redirect_to":"http://localhost:3000/auth/callback"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).action_link")

# 2. exchange for a token (do not follow the redirect)
TOKEN=$(curl -s -i "$ACTION" | grep -i '^location:' | sed -E 's/.*access_token=([^&]+).*/\1/')
```

Delete the token afterwards — it is a live credential.

Actual results against `https://cortex-api-production-8e4e.up.railway.app`:

| Request | Response |
| --- | --- |
| `GET /health` | `200 {"status":"ok"}` |
| `GET /me` (no token) | `401 {"message":"Missing bearer token",...}` |
| `GET /me` (garbage token) | `401 {"message":"Invalid token",...}` |
| `GET /me` (real ES256 JWT) | `200 {"id":"5f9ef175-…","email":"phuong011999vn@gmail.com"}` |

The minted token's header decoded to `alg: ES256`, confirming empirically that the
project issues asymmetric tokens and that the JWKS path — not `SUPABASE_JWT_SECRET` —
is the correct verification strategy. The returned `id` matches the `auth.users` row
from Steps 3-4.

## Verification checklist (Phase 0 demo criteria)

- [x] `pnpm turbo run typecheck lint test` — full suite green in CI (run
      `30680043647` on `main`). `typecheck` + `lint` re-run locally after the
      deploy-phase config changes: 10/10 tasks pass. The `test` task was **not**
      re-run locally, because `@cortex/db` and `@cortex/api` need Docker for
      `supabase start` and Docker was not running; those changes were config/docs
      only and touch no test path.
- [x] RLS isolation suite green (cross-user reads provably empty on every
      client-visible table) — covered by the existing suite, run in CI
- [x] Invite gate: a non-allow-listed account cannot sign up — the trigger fired on a
      real admin-API signup attempt (`P0001 Signup not allowed for stranger@example.com`)
      and created no row; `auth.users` still holds exactly one user
- [x] Same Google account signed in on web (hosted, Step 3) and phone (Step 4) —
      one `auth.users` row, `last_sign_in_at` advanced `03:08:34Z` → `05:04:17Z`
- [x] `curl https://cortex-api-production-8e4e.up.railway.app/health` → `{"status":"ok"}`
- [x] `curl .../me -H "Authorization: Bearer <token>"` →
      your real id + email

---

## Local Docker verification (already done)

This section records what was actually built and run locally as proof the
Dockerfile works, before any Railway account existed to deploy it to.

Build (from repo root — the build context must be the repo root because the
Dockerfile copies `packages/`):

```bash
docker build -f apps/api/Dockerfile -t cortex-api .
```

Result: builds successfully in two stages (`build` → final). Final image:

```
cortex-api:latest   259MB
```

Run, pointing `SUPABASE_URL` at a placeholder host (fine for `/health`, which is a
public route needing no Supabase credentials):

```bash
docker run -d --name cortex-api-test -p 3001:3001 -e SUPABASE_URL=https://example.supabase.co cortex-api
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3001/health
```

Actual output:

```
{"status":"ok"}
HTTP_STATUS:200
```

`/me` was also spot-checked to confirm the guard is wired up (expected to reject
without a token — full success requires a real hosted project's JWT, which isn't
available until Step 1/2 above are done by a human):

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3001/me
```

```
{"message":"Missing bearer token","error":"Unauthorized","statusCode":401}
HTTP_STATUS:401
```

The runtime image was also inspected to confirm it's clean — no leaked `.env`, no
dev-only packages:

```
/app
├── dist/           (compiled: dist/main.js, matching CMD ["node", "dist/main.js"])
├── node_modules/   (production dependencies only)
└── package.json
```

### Why the Dockerfile differs from the task brief's draft

The brief's draft had two real defects, both confirmed by hands-on testing rather
than assumed:

1. **`pnpm --filter @cortex/api deploy --prod /app` fails outright** on pnpm 11 in
   this workspace: `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE` — "starting from pnpm v10,
   we only deploy from workspaces that have `inject-workspace-packages=true` set...
   run with the `--legacy` flag". Fixed by adding `--legacy`.
2. **A per-directory `apps/api/.dockerignore` is never read** when the build context
   is the repo root (`docker build -f apps/api/Dockerfile -t cortex-api .` from
   root). Confirmed with a throwaway `COPY apps/api ./apps/api` + `ls` test: with no
   ignore file, `apps/api/.env` and `apps/api/node_modules` both leak into the build
   context; naming the file `apps/api/.dockerignore` made no difference; naming it
   `apps/api/Dockerfile.dockerignore` (BuildKit's convention for a
   Dockerfile-adjacent ignore file, keyed off the `-f` path) fixed it — build context
   transfer dropped from being dominated by `node_modules` to `14.00kB`, and `.env`/
   `node_modules` no longer appear inside the container. That's the file actually
   shipped at `apps/api/Dockerfile.dockerignore`, not `apps/api/.dockerignore`.

Also simplified vs. the draft: since `pnpm deploy` already copies the freshly-built
`dist/` alongside the pruned `node_modules` (it copies the whole package directory),
the draft's second, separate `COPY --from=build /repo/apps/api/dist ./dist` was
redundant. The final stage instead cherry-picks exactly three paths out of the
deploy output (`package.json`, `node_modules`, `dist`) rather than copying the whole
`/app` deploy directory, which also drops `test/`, `vitest.config.ts`,
`eslint.config.mjs`, and `.env.example` that `pnpm deploy` otherwise carries along —
none of which belong in a runtime image.

> ⚠️ **Superseded by Phase 1a.** At Phase 0 this section read: "`@cortex/api`'s only
> workspace dependency is `@cortex/config`… the final image needs zero workspace
> packages." That is **no longer true.** Phase 1a added two *runtime* workspace
> dependencies — `@cortex/core` (services) and `@cortex/shared` (zod DTOs) — and both
> are imported by `apps/api/src/**`. See
> [Workspace packages in the runtime image](#workspace-packages-in-the-runtime-image).

`@cortex/config` remains build-time only (a `devDependency` supplying
`tsconfig.base.json`/`eslint.base.mjs` — `apps/api/tsconfig.json` has
`"extends": "@cortex/config/tsconfig.base.json"`), never imported by `apps/api/src/**`.

`apps/api/tsconfig.build.json` (from Task 8) was also confirmed still doing its job
inside the container: `rootDir: "src"` + `outDir: "dist"` compiles to `dist/main.js`
directly, not `dist/src/main.js`, matching `CMD ["node", "dist/main.js"]`.

---

## Phase 1a — deploy checklist (web notes)

Everything below is required for the Phase 1a build to work in production. Each item
is here because it fails **silently or only in production** — the local stack passes
without it.

### 1. Push the new migrations

```bash
supabase db push        # applies 00010 + 00011 to the hosted project
supabase migration list # confirm local == remote (should now show 00001..00011)
```

- `00010_realtime_publication.sql` adds `notes`, `tags`, `note_tags` to the
  `supabase_realtime` publication. Supabase ships that publication **empty**, so
  without this migration no `postgres_changes` event is ever broadcast — the live
  note list silently degrades to "refresh to see changes" with no error anywhere.
- `00011_note_tags_partial_unique.sql` replaces `note_tags`' total unique constraint
  with a partial one (`where deleted_at is null`). Without it, removing a tag and
  re-adding the same tag fails with `23505`.

### 2. Railway environment variables (API)

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | ✅ | Already set in Phase 0. |
| `SUPABASE_ANON_KEY` | ✅ **new in 1a** | Phase 0 never needed it; every write now does. |
| `SUPABASE_JWT_SECRET` | ❌ must stay **unset** | Setting it forces the HS256 branch, which rejects the project's real ES256 tokens — every request 401s. |
| `SUPABASE_SERVICE_ROLE_KEY` | ❌ do **not** set | Tests only. No service-role key belongs on a request path; RLS is the enforcement (spec §4.1). |
| `CORS_ORIGINS` | ✅ | Must list the deployed web origin, or the browser blocks every write. |

> **`SUPABASE_ANON_KEY` is the one that bites.** `createUserClient()` builds each
> per-request Supabase client from it, so if it is missing the API still boots, `/health`
> still returns 200, and only *writes* fail. Local dev passes because the key is in
> `apps/api/.env`. Verify after deploy with an authenticated `POST /notes`, not `/health`.

### 3. Web deployment environment variables

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Base URL of the Railway API, **no trailing slash** (the client concatenates `/notes` directly). Missing → requests go to `undefined/notes`. |
| `NEXT_PUBLIC_SUPABASE_URL` | Already set in Phase 0; also used by the Realtime socket. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Already set in Phase 0. |

### Workspace packages in the runtime image

Phase 1a added `@cortex/core` and `@cortex/shared` as **runtime** dependencies of
`@cortex/api`. Both are TypeScript-source packages, so each now has a `build` script
emitting `dist/` and points `main`/`types` there — Node cannot `require` a `.ts` file.

Consequences, all already applied:

- `apps/api/Dockerfile` builds with `pnpm --filter @cortex/api... build` (note the
  trailing `...`, which pulls in dependencies). With a bare `--filter @cortex/api`, the
  image builds successfully and then dies at startup on
  `Cannot find module .../packages/core/src/supabase.js`.
- `.github/workflows/ci.yml`'s `db-tests` job builds `@cortex/shared` and `@cortex/core`
  before running the filtered test commands; that job runs on a different runner from
  the `checks` job, so it cannot reuse its build output.
- Verified locally end to end: `docker build -f apps/api/Dockerfile .` → `docker run` →
  `/health` returns `{"status":"ok"}` with the notes/tags/export routes mapped in the
  startup log.
