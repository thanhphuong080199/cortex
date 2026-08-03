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

> **Deploying an already-provisioned environment?** Steps 1-6 are one-time setup. For
> shipping new code to the environment that already exists, jump to
> [Is there CI/CD?](#is-there-cicd-no--deploys-are-manual) — nothing deploys on merge,
> and the order (schema → env vars → app) matters. Phases 1a and 1c additionally require
> their own checklists ([1a](#phase-1a--deploy-checklist-web-notes),
> [1c](#phase-1c--deploy-checklist-life-domain-capture)).

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
- **Railway CLI** — **installed globally** (`railway 5.30.3`, verified 2026-08-01 at
  `~/AppData/Roaming/npm/railway.ps1`). It is deliberately *not* a repo dependency:
  unlike the Supabase CLI it never runs in CI, only from a developer machine. On a
  machine that lacks it:
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
- `.github/workflows/ci.yml`'s `db-tests` job runs its test steps through
  `pnpm turbo run test --filter=...`, whose `test → ^build` dependency rebuilds
  `@cortex/shared` / `@cortex/core` first (they are consumed as compiled `dist/`).
  Never switch these back to `pnpm --filter <pkg> test` — that form tests against
  whatever stale `dist/` exists (issue log A7/B5).
- Verified locally end to end: `docker build -f apps/api/Dockerfile .` → `docker run` →
  `/health` returns `{"status":"ok"}` with the notes/tags/export routes mapped in the
  startup log.

---

## Phase 1c — deploy checklist (life-domain capture)

### 1. Push the new migrations

```bash
pnpm exec supabase db push        # applies 00012 + 00013 to the hosted project
pnpm exec supabase migration list # confirm local == remote (should now show 00001..00013)
```

- `00012_embedding_dims_gemini.sql` changes `note_chunks.embedding` and
  `memory_facts.embedding` from `vector(1024)` to `vector(1536)` for
  `gemini-embedding-001`, and rebuilds `note_chunks_embedding_idx` around the new
  dimension. **Safe to run on the hosted project: both columns are empty**, because no
  enrichment pipeline exists before phase 2. If this migration is ever re-run against a
  database that *does* hold embeddings, it will fail — by then it needs a re-embed, not
  an `alter type`.
- `00013_life_domains.sql` adds `media_items`, `checkins`, `flashcards` and the
  `notes.domain` / `domain_meta` / `media_item_id` columns, with RLS, grants, and the
  three tables added to the `supabase_realtime` publication.

> ⚠️ **Vector types must be schema-qualified in migrations — hosted-only failure.**
> The first push of `00012` failed with:
>
> ```
> LegacyDbPushApplyError ... At statement: 1
> alter table public.note_chunks alter column embedding type vector(1536)
> ```
>
> `supabase db push` logs `Initialising login role...` and applies migrations as a
> dedicated role whose `search_path` does **not** include `extensions`, which is where
> `00001` installs pgvector. Local `supabase db reset` resolves `vector` fine via
> `config.toml`'s `extra_search_path`, so **this class of bug is invisible until the
> hosted push** — and the CLI truncates the underlying Postgres error, so the message
> above is all you get. Write `extensions.vector(1536)` and
> `extensions.vector_cosine_ops`, exactly as `00001`'s own comment prescribes.
>
> The failed push rolled back cleanly (`note_chunks_embedding_idx` survived), so a
> partial apply is not something to fix by hand — but check before assuming.
>
> Note `00002`/`00005` use *unqualified* `vector(1024)` and pushed successfully at phase
> 0, so this is a behaviour change in the CLI's migration role, not a long-standing rule.
> Qualify vector references in any new migration regardless.

**Applied to the hosted project on 2026-08-01**, verified by querying the catalog:
`note_chunks.embedding` and `memory_facts.embedding` are both `vector(1536)`; all three
new tables report `relrowsecurity = true` with one policy and a `SELECT` grant to
`authenticated`; `notes` has `domain, domain_meta, media_item_id`; and all three tables
are in the `supabase_realtime` publication.

> **The grant block in 00013 is load-bearing.** `00009_revoke_default_grants.sql`
> changed the default privileges template, so tables created after it start with **no**
> grants at all. Without the explicit `grant select, insert, update, delete ... to
> authenticated`, `authenticated` never reaches RLS and every read returns
> `42501 permission denied` — which looks like an RLS misconfiguration and is not one.

### 2. Environment variables — nothing new in 1c

**No new env vars.** 1c is pure CRUD on the 1a foundation; it calls no AI provider.

> **Do not add `GEMINI_API_KEY` (or any provider key) yet.** The provider switch in
> `00012` is a *schema* change only — `EMBEDDING_MODEL` in `@cortex/shared` names the
> model that phase 2 will call. Adding the key now puts an unused live credential in
> Railway. Phase 2 introduces it, together with its entry-checklist item: **verify the
> Gemini project is on the paid tier**, because free-tier prompts are used for training
> and health/mood/finance content flows through this API (life-domains spec §5).

### 3. Redeploy the API

1c adds two routes (`POST /checkins`, `DELETE /checkins/:id`, `POST /media-log`), so the
running container must be replaced or they 404:

```bash
railway up --service cortex-api --detach --yes
```

Verify with a write, not `/health` (see [the section below](#verify-a-deploy-with-a-write-not-with-health)):

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "$API_URL/checkins" -H "Authorization: Bearer <a real user JWT>" \
  -H 'Content-Type: application/json' -d '{"mood":4}'
# 201 = working. 404 = old code still deployed. 500 = env var missing.
```

### 4. Web deployment

No new variables. Redeploy so the check-in widget, media log form, and domain filter
ship; the domain filter reads `?domain=` and queries `notes.domain`, which requires
`00013` to already be applied (step 1 before step 4, as always).

### 5. Post-review hardening — `00014` (applied 2026-08-01)

The phase-1c issue-log review produced `00014_phase1c_hardening.sql`, pushed the same
day (local == remote through `00014`):

- **`checkins` / `flashcards` get `updated_at` + `moddatetime`** per `00002`'s rule —
  PowerSync's incremental cursor (phase 1b) needs `updated_at` to advance on every
  UPDATE, and both tables mutate (soft-deletes; SM-2 scheduling rewrites).
- **`notes.media_item_id` is now a composite FK** `(media_item_id, user_id) →
  media_items (id, user_id)` with PG15's `on delete set null (media_item_id)`. FK checks
  bypass RLS, so the old single-column FK accepted a reference to another user's item.
- **`00012` now carries a fail-fast guard**: if either embedding column holds data, it
  raises instead of silently being a different operation (the alter-type is only valid
  on empty columns; populated columns need a re-embed). The edit is to an
  already-applied migration, which is safe here — applied environments never re-run it,
  and fresh replays hit the guard while the columns are still empty.

### Not in 1c — PowerSync sync rules

`media_items`, `checkins` and `flashcards` must be added to the PowerSync sync rules so
they reach the mobile replica. That is a **phase 1b** item (life-domains spec §7): no
PowerSync service exists yet, so there is nothing to configure here. When 1b lands, the
sync rules and the RLS policies for these three tables get reviewed in the same PR —
they are two independent isolation layers over the same rows (parent spec §11).

---

## Is there CI/CD? (No — deploys are manual)

**Merging to `main` deploys nothing.** Verified 2026-08-01 on both sides:

| Layer | State | Evidence |
| --- | --- | --- |
| GitHub Actions | build / typecheck / lint / test only | `.github/workflows/ci.yml` defines exactly two jobs, `checks` and `db-tests`. There is no deploy job and no other workflow file. |
| Railway → GitHub | **not connected** | `railway status --json` reports `source: {"image": null, "repo": null}` for `cortex-api`. With no repo attached there is no push trigger, so Railway never sees a merge. |
| Database migrations | manual | `supabase db push` is run by a human. Nothing applies migrations automatically. |

So a merge to `main` gives you green checks and **a hosted environment still running the
previous code**. Shipping is three deliberate steps, in this order:

```bash
# 1. schema first -- new code usually assumes the new schema, not the reverse
pnpm exec supabase db push
pnpm exec supabase migration list          # confirm local == remote

# 2. env vars BEFORE the deploy that needs them (see the phase 1a checklist above).
#    --skip-deploys avoids redeploying the OLD code just to attach a new variable.
railway variables --service cortex-api --set-from-stdin SUPABASE_ANON_KEY --skip-deploys

# 3. ship the API
railway up --service cortex-api --detach --yes
```

### Verify a deploy with a WRITE, not with `/health`

`/health` touches no Supabase credential, so it returns `200` even when the API is
completely unable to serve requests. Confirmed locally against the real build: with
`SUPABASE_ANON_KEY` unset, `/health` answers `200` while an authenticated
`POST /notes` returns `500 {"message":"Internal error"}` and the container logs
`Error: supabaseKey is required.` Railway shows that deploy as healthy.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "$API_URL/notes" -H "Authorization: Bearer <a real user JWT>" \
  -H 'Content-Type: application/json' -d '{"content":"deploy smoke test"}'
# 201 = genuinely working. 500 = env var missing. 404 = old code still deployed.
```

That last case is a useful signal on its own: because Phase 0 had no `/notes` route,
`404` vs `401` on an *unauthenticated* `POST /notes` tells you at a glance whether the
running container predates Phase 1a.

### If you want real CD later

Attach the GitHub repo to the Railway service (Railway dashboard → service → Settings →
Source) and it will deploy on push to `main`. Two caveats before enabling it:

- Migrations still would not run. `supabase db push` would need its own workflow step,
  gated to run *before* the app deploy, or a deploy will land on an older schema.
- `apps/api/Dockerfile` expects the **repo root** as build context (it copies
  `packages/`), which `railway.json` already encodes via `dockerfilePath`.

---

# Phase 1b — PowerSync Cloud setup

Sections 1–4 are one-time setup, done in the Supabase SQL editor and the PowerSync
dashboard. None of *that* is a migration: `create role ... password` would commit a secret
to git. Section 5 is the ship log for Stage 1 and does cover a migration — same shape as
`### 5. Post-review hardening — 00014` under the Phase 1c checklist.

## 1. Supabase — replication role and a SCOPED publication

Generate a strong password and store it in a password manager first; Supabase will not
show it again.

```sql
-- BYPASSRLS is required and is the reason sync rules must be tested as an independent
-- isolation layer: replication reads around RLS entirely (parent spec §15.5).
create role powersync_role with replication bypassrls login password '<REDACTED>';

-- SELECT only, and only on the six synced tables. NOT "on all tables": this role has no
-- business seeing integrations.credentials.
grant select on public.notes, public.tags, public.note_tags,
                 public.links, public.media_items, public.checkins
  to powersync_role;

-- The publication MUST be named "powersync". Its SCOPE is ours to choose, and choosing
-- matters: PowerSync's setup guide says `FOR ALL TABLES`, which would put
-- integrations.credentials, note_chunks, usage_ledger and memory_revisions into the
-- replication stream. The sync rules would filter them out -- but only after they had
-- left Postgres. Naming the six tables keeps them out of the stream entirely, giving a
-- third isolation layer beneath the sync rules.
create publication powersync for table
  public.notes, public.tags, public.note_tags,
  public.links, public.media_items, public.checkins;
```

Verify immediately — this is the whole point of the step:

```sql
select tablename from pg_publication_tables where pubname = 'powersync' order by tablename;
```

Exactly six rows. Anything else (especially `integrations`) means
`drop publication powersync;` and create it again. `packages/db`'s
`sync-rules-isolation.test.ts` asserts this same property through
`_test_publication_tables`, so a later widening fails the suite rather than going unnoticed.

## 2. PowerSync instance

Create an Organization → Project → Instance. Pick the region nearest the user.

**Replication connection:**

| Field | Value |
|---|---|
| Type | `postgresql` |
| Hostname | `db.<project-ref>.supabase.co` |
| Port | `5432` |
| Database | `postgres` |
| Username | `powersync_role` |
| Password | from step 1 |
| SSL mode | `verify-full` |

Port **5432 direct**, never the connection pooler on 6543 — logical replication cannot run
through a transaction pooler, and Supabase's UI offers the pooler string by default.

If the connection test fails while resolving the address rather than authenticating, that
is the Supabase direct-connection networking issue, not a wrong password; see PowerSync's
Supabase integration page.

**Client auth:** enable **Supabase**, and **leave the JWT secret field empty**.

That empty field is the correct setting, not an omission. This project issues **asymmetric
(ES256)** tokens — verified directly:

```bash
curl -s https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
# {"keys":[{"alg":"ES256","kty":"EC","use":"sig",...}]}   → asymmetric, leave secret empty
# {"keys":[]} or 404                                      → legacy HS256, secret required
```

PowerSync auto-detects the project and configures the JWKS URI and audience itself. The
`supabase_jwt_secret` option exists only for projects still on legacy HS256 symmetric keys.

Pasting the legacy secret anyway does not fail loudly: PowerSync would try to verify an
ES256 token with an HS256 key, and every sync would fail authentication with a message that
reads like a bad token rather than a wrong algorithm. `apps/api/src/auth/supabase-auth.guard.ts`
records the same trap from the other side — `supabase status` still prints a legacy
`JWT_SECRET` for backward compatibility, and that secret does not verify real tokens, which
is why `SUPABASE_JWT_SECRET` is left unset in this repo's `.env` files.

**Sync streams:** paste the contents of `packages/sync/src/sync-rules.yaml`. It uses Sync
Streams edition 3 — PowerSync classes the older `bucket_definitions` form as legacy.

## 3. Client environment

Take the instance URL from the PowerSync Dashboard — instance → settings/overview →
**Instance URL**. **Copy it whole; do not assemble it from an instance id.** The host
differs between instances and regions (PowerSync's own docs show more than one form), so a
constructed URL is a guess.

```
EXPO_PUBLIC_POWERSYNC_URL=<pasted verbatim from the dashboard>
EXPO_PUBLIC_API_URL=https://<api>.up.railway.app
```

Check it resolves before wiring anything to it:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$EXPO_PUBLIC_POWERSYNC_URL"
```

**Any** HTTP status — `401` and `404` included — means DNS and TLS are fine and the URL is
live; the endpoint is not meant to answer an unauthenticated bare GET. A connection or
name-resolution error means the URL is wrong or the instance is still provisioning.

`apps/mobile/.env` is gitignored and CI fails if any `.env` reaches a runner.

## 4. Android dev client

PowerSync and SQLCipher are native modules, so **Expo Go cannot run this app**:

```bash
pnpm --filter @cortex/mobile exec eas build --profile development --platform android
```

A dev client built before phase 1b will not work — it is a compiled binary and cannot load
newly added native modules. Rebuild after the PowerSync dependencies land (plan Task 17).

### Backup and transfer are OFF, and it takes two mechanisms, not one

`android:allowBackup=false` in `app.json` is load-bearing, not a preference: Auto Backup
would copy the SQLCipher database to Google Drive while its key lives in Android Keystore,
which is not backed up — producing an undecryptable file on Drive. Pure risk, no benefit.

Verified in the generated manifest (Task 11):

```bash
pnpm --filter @cortex/mobile exec expo prebuild --platform android --clean
rg 'allowBackup' apps/mobile/android/app/src/main/AndroidManifest.xml
# android:allowBackup="false"
```

**`allowBackup=false` is not sufficient on its own.** On Android 12+ it disables cloud backup
but **does not** disable device-to-device transfer. What covers D2D is a second, separate
mechanism that arrived with the `expo-secure-store` config plugin:

```xml
<!-- expo-secure-store/android/src/main/res/xml/secure_store_data_extraction_rules.xml -->
<device-transfer>
  <include domain="sharedpref" path="."/>
  <exclude domain="sharedpref" path="SecureStore"/>
</device-transfer>
```

Only the `sharedpref` domain is included, so the `database` and `file` domains — where the
SQLCipher database lives — are outside both cloud backup and device transfer, and SecureStore's
own preferences are excluded on top of that. These resources ship inside the library and reach
the app through Android resource merging; the app's own `res/xml/` is empty, which is why
grepping the app module for them finds nothing.

**Consequence for anyone changing mobile dependencies:** dropping the `expo-secure-store`
plugin, or overriding `dataExtractionRules` in `app.json`, silently removes the D2D protection
while `allowBackup="false"` still sits in the manifest looking like it covers everything. The
two are not interchangeable. Re-run the prebuild and re-read the merged manifest after any
change to `plugins`.

`apps/mobile/android/` and `ios/` are gitignored. This is a Continuous Native Generation
project: `app.json` is the source of truth and prebuild regenerates the native projects
wholesale, so a committed manifest could outlive the config that produced it.

## 5. Stage 1 ship — `00015` and the `/sync/upload` write verification

Shipped 2026-08-03, in the order the CI/CD section prescribes (schema, then API).

`00015_conflict_copy_link_kind.sql` widens `links_kind_check` to accept `conflict_copy`.
It is a constraint swap, not a type change — `00003` created `links.kind` as a bare check
rather than an enum. `supabase migration list` shows local == remote through `00015`.

Deploy verified with a **write**, not `/health` (see
[the rule above](#verify-a-deploy-with-a-write-not-with-health)). The three requests are chosen
so each one fails distinctly if the wrong thing shipped; a 401 probe proves only that the
route is registered.

```bash
API='https://<api>.up.railway.app'
NOTE_ID='<a client-generated v4 UUID>'   # must be real hex: the DTO rejects a bad one at 400

# 1. PUT  -> 201 {"applied":["1"], ...}   the router writes under RLS with the user's JWT
# 2. PATCH -> "conflict_copies":[]        updateWithConflictCopy: no base_updated_at, no copy
# 3. replay op 1 verbatim -> "applied":["1"], NOT "failed"
```

Step 3 is the one worth keeping. `createWithId` is idempotent — a 23505 on an id the
caller already owns is a replayed op, not a conflict. Before that fix, a resend threw at
its own primary key and the op wedged the queue permanently, so a deploy missing it
answers step 3 with `failed` + `kind: "conflict"` while steps 1 and 2 still look fine.

Run each request from a shell that re-declares the token: the harness gives every
`!` command a fresh shell, so a `TOKEN=` set in a previous block is gone. Clean up
afterwards (`DELETE /notes/:id` then `DELETE /notes/:id/purge`) — a smoke-test note is
real user data and will otherwise sync to every device.
