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
> [Is there CI/CD?](#is-there-cicd-code-ships-automatically-migrations-and-env-vars-do-not) —
> code ships automatically on merge once E2E passes, but the schema and env vars still don't,
> and the order (schema → env vars → merge) matters. Phases 1a and 1c additionally require
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

**This table is the whole set the API requires, not just 1a's additions** — deliberately one
table rather than a per-phase delta in each checklist, because two copies drift and the
operator reading the wrong one gets a container that will not boot. It mirrors
`apps/api/src/env.ts`'s `envSchema`; that file is the authority, and if the two ever
disagree, the file wins and this table is the bug.

Everything marked ✅ is validated at boot by `parseApiEnv`. A missing or malformed one is
**not** a degraded mode: `main.ts` catches the `ZodError`, logs it, and calls
`process.exit(1)`. The container never listens, so `/health` never answers and Railway shows
a crash loop rather than a healthy deploy with a broken feature.

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | ✅ | Already set in Phase 0. |
| `SUPABASE_ANON_KEY` | ✅ **1a** | Phase 0 never needed it; every write now does. |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ **2** — *was "do not set"* | **Reversed in phase 2; see below.** |
| `DATABASE_URL` | ✅ **2** | The **session** pooler, port **5432**. Not 6543 — [see below](#database_url-must-be-the-session-pooler-5432-not-the-transaction-pooler-6543). |
| `GEMINI_API_KEY` | ✅ **2** | A **paid-tier** key. The 1c note saying "do not add this yet" expired when phase 2 shipped. |
| `GEMINI_TIER` | ✅ **2** | Literally `free` or `paid`; anything else fails the schema. Must be `paid` in production — enforced, [see below](#gemini_tier-must-be-paid-in-production-and-that-is-enforced-not-advised). |
| `ENRICH_MONTHLY_BUDGET_USD` | ✅ **2** | A positive number, e.g. `10`. Caps the **enrichment sweep** only — search is metered against the same ledger but never blocked by it, [see below](#the-budget-caps-the-sweep-search-is-metered-but-not-gated). |
| `ASSISTANT_MONTHLY_BUDGET_USD` | ✅ **Stage C1** | A positive number, e.g. `10`. A circuit breaker, not a budget — it gates `POST /assistant` specifically (the one-box chat turn), set generously since refusing to answer is a UX failure. Independent of `ENRICH_MONTHLY_BUDGET_USD`; both read the same `usage_ledger`. |
| `CORS_ORIGINS` | ✅ in practice | Optional in the schema (it falls back to localhost dev origins), but a deployed API without the real web origin blocks every browser write. |
| `SUPABASE_JWT_SECRET` | ❌ must stay **unset** | Setting it forces the HS256 branch, which rejects the project's real ES256 tokens — every request 401s. |
| `PORT` | ❌ leave to Railway | Railway injects it; setting it by hand only creates a way to disagree with the platform. |

> **`SUPABASE_ANON_KEY` is the one that bites.** `createUserClient()` builds each
> per-request Supabase client from it, so if it is missing the API still boots, `/health`
> still returns 200, and only *writes* fail. Local dev passes because the key is in
> `apps/api/.env`. Verify after deploy with an authenticated `POST /notes`, not `/health`.
>
> That is the *old* trap and it still applies to `CORS_ORIGINS`. The seven ✅ variables above
> now fail the opposite way — loudly, at boot — which is the better failure, but it means a
> phase-2 deploy against a phase-1 variable set does not limp: it never starts.

#### `SUPABASE_SERVICE_ROLE_KEY` — this row used to say "do **not** set"

Until phase 2 this table read *"Tests only. No service-role key belongs on a request path;
RLS is the enforcement (spec §4.1)."* That was a **security rule**, not a convenience, and
phase 2 overrides it deliberately. Ignoring the change is not a safe default — the API will
not boot without the key — so here is what changed and what still holds.

**What forced it.** Enrichment writes `note_chunks`, and `search_notes` reads it.
`note_chunks` has **RLS enabled with no policies**, which makes it invisible to
`authenticated` *by design*: chunk text and embeddings are derived data no client should
query directly. A per-request user client therefore reads back exactly zero rows — not an
error, an empty result — so semantic search returns "no matches" over a fully populated
corpus. Nothing in the logs says why.

**Why it is safe here.** The key is not a substitute for RLS on the request path; the
isolation moved rather than disappeared:

- `search_notes` is `SECURITY DEFINER` (`00022_search_notes.sql`) — a single, auditable
  function over the tables RLS deliberately hides, not a general-purpose bypass.
- Its `p_user_id` comes **only** from the JWT that `SupabaseAuthGuard` has already verified
  (`search.controller.ts` passes `user.id`). It is never read from the request body, and
  `searchInput` is `.strict()`, so a body carrying a `userId` is a **400** rather than a
  value that gets quietly ignored.
- Every other route still goes through `createUserClient()` under the caller's own JWT.
  Service-role is scoped to enrichment and search, not adopted API-wide.

**What would make it unsafe** — treat any of these as a security regression, not a refactor:

1. `p_user_id` sourced from anywhere but the verified JWT — a body field, a query string, a
   header, a "the caller is an admin" branch. That parameter is the *entire* boundary between
   two users' corpora once RLS is out of the picture.
2. Dropping `.strict()` from `searchInput`, which is what converts an injected `userId` from a
   400 into a silently-ignored field — and one refactor later, into a respected one.
3. Handing the service-role client to a route that could take a user-controlled table or
   filter, rather than a fixed `SECURITY DEFINER` function.
4. Ever exposing the key to a client. It is a **server-side** variable: no `NEXT_PUBLIC_`
   twin, never in `apps/web` or `apps/mobile`, never in a response body or an error message.

`packages/db`'s cross-user isolation suite covers the RLS half; `search_notes`' own tests
cover the `p_user_id` half. Both must stay green — they are what makes the sentence this row
used to contain still true in spirit.

#### `DATABASE_URL` must be the **session** pooler (5432), not the transaction pooler (6543)

New in phase 2 and the first direct Postgres connection in the repo — everything else,
including `packages/db`'s tests, reaches Postgres through PostgREST. pg-boss (the enrichment
queue) needs it, and it is fussy about *which* connection string:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
                                                                                   ^^^^ not 6543
```

pg-boss holds session state and takes **advisory locks**, and neither survives a transaction
pooler. Supabase's dashboard offers the **6543** string by default, so this is the one you get
by copying the obvious thing. The failure does not name the port: you get
`prepared statement "..." already exists`, or an advisory-lock error, or jobs that appear to
queue and never run.

> **Two different "5432" rules live in this document, and they are not the same rule.**
> PowerSync's replication connection ([§2 of the phase 1b setup](#2-powersync-instance)) needs
> the **direct** host `db.<project-ref>.supabase.co:5432`, because logical replication cannot
> run through *any* pooler. pg-boss needs the **session pooler** host
> `*.pooler.supabase.com:5432`. Both say 5432; the hostnames differ, and swapping them gets you
> a connection that fails while *resolving the address* rather than authenticating — which
> reads like a wrong password and is not one.

`apps/api/src/env.ts` cross-checks that `DATABASE_URL` and `SUPABASE_URL` name the **same**
project: a local `SUPABASE_URL` beside a hosted `DATABASE_URL` boots happily and then reads
notes from the local stack while creating pg-boss's `pgboss` schema **inside production**,
sharing one queue between dev and prod. That split was found on 2026-08-10 and is now a boot
failure. It cannot catch a *hosted* mismatch between two different projects' pooler and API
URLs beyond the ref comparison, so still paste both from the same dashboard.

To verify the string before anything depends on it, run the hosted probe documented at the top
of `apps/api/test/boss.integration.test.ts` — it is the only way to learn whether Supavisor
session mode accepts pg-boss. Drop the `pgboss` schema afterwards.

#### Two API instances will not double-enrich — but the guarantee is an advisory lock, not a replica count

Worth knowing before you scale the service or read a redeploy log.

`DATABASE_URL` carries a second job besides pg-boss: the enrichment worker takes a **session-level
advisory lock** on it (`apps/api/src/queue/sweep-lock.ts`) around every sweep. An instance that
does not win the lock logs

```
[enrich] sweep skipped: another instance holds the sweep lock
```

and does nothing until the next 60-second tick. **A few of those lines during a deploy are normal**
— Railway's default rolling redeploy runs the old and new containers together for roughly 30
seconds, which is exactly the window this exists for.

**Why it was needed.** pg-boss's `work()` defaults keep *one process* from sweeping twice at once,
and that is all they do — the queue uses the default `standard` policy, and the `SKIP LOCKED` in
`claim_notes_for_enrichment` stops releasing its row locks the moment that claim transaction
commits, long before the Gemini calls return. Two containers would therefore claim *disjoint*
notes and bill for both. Until 2026-08-12 the only thing preventing that was "there is exactly one
API instance" — an invariant nothing enforced and the default deploy strategy breaks by design.

**What this does not do.** It bounds *concurrency*, not spend; the budget still does that. And it
is not a reason to scale the service — one instance is right for this workload. It means a
redeploy no longer double-bills, and that turning on a second replica is a capacity decision
rather than a correctness one.

**Two ways to break it**, both worth recognising in a log:

- **Persistent skipping** (every tick, not just during a deploy) means something else holds the
  lock: a second service pointed at the same database, or a stale connection Postgres has not yet
  reaped. Check `select * from pg_locks where locktype = 'advisory'`.
- **Pointing `DATABASE_URL` at the transaction pooler (6543)** silently removes the protection —
  session-level advisory locks do not survive it. Same port rule as pg-boss, now with a second
  consequence.

#### `GEMINI_TIER` must be `paid` in production, and that is enforced, not advised

`assertTierAllowsRealData` (`packages/core/src/enrich/budget.ts`) **throws** for
`GEMINI_TIER=free` against a hosted `SUPABASE_URL`. Free-tier prompts are used to train
Google's models and may be read by human reviewers, and this database holds mood, health and
finance notes (parent spec §15.6 rule 2). `free` is permitted only against a loopback
`SUPABASE_URL` — local dev and CI, where the data is fake.

So `GEMINI_TIER=free` on Railway is not a cheaper deploy; it is an API that boots and then
fails every enrichment and every search with a tier error. Set `paid`, and confirm the Google
Cloud project is actually on a paid plan — the variable asserts your intent, it cannot verify
Google's billing state.

#### The budget caps the sweep; search is **metered but not gated**

Two things spend money on Gemini, and `ENRICH_MONTHLY_BUDGET_USD` stops only one of them.

| Path | Writes `usage_ledger` | Blocked by the budget |
| --- | --- | --- |
| Enrichment sweep (embed + extract, per note) | yes | **yes** — `isOverBudget` skips the user for the rest of the UTC month |
| `POST /search` (one embedding of the query) | yes | **no** — it runs regardless |

**Why search is metered.** Every search embeds its query, so it is a billable path.
`isOverBudget` is deliberately fail-**closed** (`packages/core/src/enrich/budget.ts`) so that an
outage in the spend query can never turn into unlimited spend — a guarantee that is worth
nothing for a path the ledger never records. Until 2026-08-12 search wrote no row at all, so the
only place that spend appeared was Google's own console. It now writes one `kind = 'embed'` row
per successful search.

**Why search is not gated.** Refusing to let someone search their own notes because a
*background* job overspent is the wrong trade: the budget exists to bound what Cortex spends on
its own initiative, and a search is the user asking. Gating would also put a second round trip
(`isOverBudget`'s RPC) in front of an interactive request.

**Scale, so the numbers are on the record.** One query embeds to roughly $0.0000045 — about
200,000 searches per dollar. The reason to meter was never the amount; it was that the amount
was invisible.

**A failed ledger write does not fail the search.** The `recordUsage` call in
`search.controller.ts` is wrapped in its own `try/catch` that logs
`[search] usage_ledger write failed: <code>: <message>` and continues. The accepted cost is a
silent under-count; the alternative — a ledger problem returning 500 on every search — is worse.
So **do not treat `usage_ledger` as an audit-grade meter for search**: it is a monitoring
signal, and its `input_tokens` are a chars/4 estimate (the same caveat `budget.ts` records for
the sweep's `embed` rows).

**Still open, deliberately:** `POST /search` has **no rate limit**. Metering makes an abusive
or looping client *visible* in `usage_ledger`; it does not stop one. If you want a ceiling on
search spend rather than a record of it, that is a rate limit at the edge, not a budget check
in the controller — a separate piece of work, parked here on purpose.

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

> ~~**Do not add `GEMINI_API_KEY` (or any provider key) yet.**~~ **Superseded — phase 2 has
> shipped.** This note was correct while 1c was the head of the branch: `00012` was a *schema*
> change only, `EMBEDDING_MODEL` merely named the model phase 2 would call, and adding the key
> then would have parked an unused live credential in Railway.
>
> Phase 2 now requires `GEMINI_API_KEY`, `GEMINI_TIER`, `ENRICH_MONTHLY_BUDGET_USD` and
> `DATABASE_URL`, and the API **will not boot** without them. It also delivered the
> paid-tier check this note asked for as an assertion rather than a checklist item —
> `assertTierAllowsRealData` refuses a free-tier key against hosted data outright. See
> [the API variable table](#2-railway-environment-variables-api), which is the single
> authoritative list; this 1c section is kept as the ship log for 1c, not as current
> configuration advice.

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

## Phase 2 — deploy checklist (AI enrichment + semantic search)

**Shipped to production on 2026-08-12.** This section is both the procedure and the ship log.

Phase 2 is the first release where the API does work on its own initiative: a pg-boss cron
inside the API process sweeps notes every 60 seconds, chunks and embeds them through Gemini,
and extracts a domain and tags. `POST /search` fuses pgvector and Postgres FTS. Two
consequences for deploying it:

- The API now needs a **direct Postgres connection** and a **service-role key**, so the
  variable table gained five entries — see [§2 above](#2-railway-environment-variables-api),
  which is the authoritative list.
- **The order matters.** Push migrations *first*, then deploy. The reverse boots an API that
  looks completely healthy and fails every sweep and every search, because the failure is at
  runtime, not at boot. See the warning at the end of step 3.

### 1. Push the new migrations

```bash
pnpm exec supabase db push --dry-run   # confirm exactly 00018..00025, no seeds, no roles
pnpm exec supabase db push
pnpm exec supabase migration list      # local == remote, through 00025
```

| Migration | What it adds |
| --- | --- |
| `00018_note_enrichment.sql` | `note_enrichment` bookkeeping + `claim_notes_for_enrichment` |
| `00019_note_tags_feedback.sql` | tag feedback events |
| `00020_note_source_types.sql` | note source vocabulary |
| `00021_usage_month_to_date.sql` | `usage_month_to_date_usd` — the SUM moved into Postgres |
| `00022_search_notes.sql` | `search_notes`, the RRF fusion function + HNSW index use |
| `00023_enrichment_attempts_and_fairness.sql` | `attempts_hash`; over-budget users no longer starve the global sweep |
| `00024_search_recency_clamp.sql` | clamps the recency decay so a future `created_at` cannot amplify a score |
| `00025_revoke_client_grants_drift.sql` | **hosted-only effect** — see [step 5](#5-the-grant-drift-00025-fixes-was-hosted-only) |

> **Qualify pgvector types.** `00022` and `00024` reference `extensions.vector(...)`, never bare
> `vector(...)`. Bare works locally and fails only on the hosted push — the trap
> [`00012` hit](#2-environment-variables--nothing-new-in-1c). Grep any new migration for
> `vector(` before pushing.

Verify in the catalog rather than trusting the exit code — `db push` reports success per file,
not per object:

```sql
select to_regclass('public.note_enrichment') is not null;         -- t
select proname, prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and proname in ('search_notes','claim_notes_for_enrichment','usage_month_to_date_usd');
-- all three present, all prosecdef = true
```

### 2. Set the Railway variables

Five additions, all boot-validated. `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`,
`GEMINI_API_KEY`, `GEMINI_TIER`, `ENRICH_MONTHLY_BUDGET_USD` — the
[variable table](#2-railway-environment-variables-api) covers each one and the traps.

Two things worth doing rather than assuming:

- **Set secrets through stdin**, so no credential lands in a shell history or a log:
  `printf '%s' "$VALUE" | railway variable set NAME --stdin --skip-deploys`. `--skip-deploys`
  lets you stage the whole set and redeploy once instead of once per variable.
- **Run the app's own validator against the live set** before deploying. This is the only check
  that tests what actually boots, including the `SUPABASE_URL`/`DATABASE_URL` same-project
  cross-check:

  ```bash
  cd apps/api && railway variables --json | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      require('./dist/env.js').parseApiEnv(JSON.parse(s)); console.log('would boot'); })"
  ```

Take the **legacy** `service_role` key (the ~219-char `eyJ…` JWT under *Legacy API keys*), not
the newer `sb_secret_…`. The project offers both, but `SUPABASE_ANON_KEY` is the legacy anon
JWT and every local and CI run exercises legacy keys; mixing generations is an extra variable on
the one deploy that first puts a service-role key on a request path.

### 3. Redeploy the API

```bash
railway up --service cortex-api --ci     # --ci streams build logs, then exits
```

> **`railway up` uploads the working tree**, and `apps/api/Dockerfile` does
> `COPY apps/api ./apps/api`. The repo root `.dockerignore` is what keeps `apps/api/.env` —
> hosted `DATABASE_URL` with its password, the service-role key, the Gemini key — out of the
> build context. Do not delete it. The published image is otherwise clean only by accident of
> layering: the runtime stage happens to copy just `package.json`, `node_modules` and `dist`.

> ⚠️ **A deploy against a pre-00018 schema is the quiet failure.** Every variable can be
> correct, `parseApiEnv` passes, Nest maps every route, `/health` returns 200 — and then each
> sweep and each search fails, because `note_enrichment` and `search_notes` do not exist. The
> env vars fail *loudly at boot*; this fails *silently at runtime*. Migrations first.

### 4. Verify — with a write, and then with the pipeline

[The write check](#verify-a-deploy-with-a-write-not-with-health) still applies and still comes
first. `401` on an unauthenticated `POST /notes` also confirms you are not looking at a stale
container. Phase 2 adds three more checks, in order:

```bash
railway logs --service cortex-api | grep enrich
# [enrich] sweep complete: processed=16 failed=0 skippedOverBudget=0
```

1. **The sweep runs.** That line is the *only* evidence it is alive — per-note output fires only
   on failure, so a dead cron and a healthy one otherwise look identical. `[enrich] sweep
   skipped: another instance holds the sweep lock` is normal during a rolling redeploy;
   *persistent* skipping is not (see
   [the advisory-lock section](#two-api-instances-will-not-double-enrich--but-the-guarantee-is-an-advisory-lock-not-a-replica-count)).
2. **A new note gets enriched.** `note_enrichment.embedded_hash` fills in and `note_chunks` gains
   rows. Allow ~2 minutes: `claim_notes_for_enrichment` has a deliberate **90-second debounce**
   (`n.updated_at < now() - interval '90 seconds'`) so a note is not enriched mid-edit. A
   just-created note being skipped is the debounce, not a fault.
3. **`POST /search` returns it**, with `matchedBy` of `vector` or `both` — that is the whole
   chain: chunk → embedding → HNSW → RRF → HTTP.

Two queries worth running once, because both answer questions logs cannot:

```sql
-- Must be 0. A non-zero count is the silent-failure signature: usage was billed and
-- embedded_hash stamped, but search_notes filters on `embedding is not null`, so those
-- chunks are invisible forever and the hash predicate guarantees they are never retried.
select count(*) from note_chunks where embedding is null;

-- Every AI call, including one row per search. Search is METERED but not gated; see
-- "The budget caps the sweep" above.
select kind, count(*), round(sum(cost_usd)::numeric, 6) from usage_ledger group by kind;
```

A note with a `note_enrichment` row and **zero** chunks is not a fault either: an empty
`content_text` (a media-log row) chunks to nothing. That is why the two counts can differ by a
few.

### 5. The grant drift `00025` fixes was hosted-only

Found while verifying this deploy, and the reason it is worth reading: **the hosted project and
a local `supabase db reset` did not agree**, so the local test suite had been proving a stricter
configuration than production ran.

On the hosted project, `anon` *and* `authenticated` held `INSERT/SELECT/UPDATE/DELETE` on all 23
tables in `public` — including `note_chunks`, `note_enrichment` and `usage_ledger`, whose own
grant-block comments say they get no client DML at all. Locally those tables grant nothing.

The cause is not a one-off: `pg_default_acl` for schema `public`, owner `postgres`, granted
`arwd` to both roles on the hosted project and nothing locally — so *every* table a future
migration created was born client-writable there. `00009` had already reached this template
(hosted's `arwd` is exactly `arwdDxtm` minus the `Dxtm` it revoked); it simply never covered the
DML half. `00025` revokes the grants **and** the template, or the next `create table` would undo
it.

Nothing was exploitable: RLS is on for all 23 tables and all 15 policies target `authenticated`,
so every `anon` grant was inert, the eight zero-policy tables blocked `authenticated` too, and
`digests`/`memory_facts` have `for select` policies only. Every privilege `00025` removes was
already unusable — which is why it cannot break a working path, and why it was worth fixing
before something made it reachable. The design (`00007`) describes *two* independent layers,
"a table-level GRANT before RLS is even evaluated", and production had one.

Visible improvement after the push: a client hitting a server-only table now gets `42501
permission denied` at the grant layer instead of a silent empty result from RLS.

> One residual, present **identically in local and hosted**, so it is not drift: the
> `supabase_admin`-owned default ACL still grants `arwdDxtm` to `anon`/`authenticated`. Tables
> created by these migrations are owned by `postgres`, not `supabase_admin`, so it does not
> apply to them.

### `00035` drops and recreates `search_notes` — the revoke/grant pair in the diff is expected

Stage S1.5 (2026-08-23) widened `search_notes`'s return by one column (`source_type`), so it can
tell the assistant whether a matched note is the user's own words or a saved answer of its own.
Postgres cannot `CREATE OR REPLACE FUNCTION` a changed return type — it has to `DROP FUNCTION` and
recreate it, same as `00032` before it. Because `search_notes` is `SECURITY DEFINER` and its
`DROP` discards its ACL, the migration ends with the same `revoke ... from public` /
`grant execute ... to service_role` footer `00022` established. **That footer showing up in the
diff is the migration working correctly, not a sign something was accidentally widened** — a
missing footer would leave the function briefly `PUBLIC`-executable, not present at all.

Pushed to hosted 2026-08-23; `supabase migration list` confirmed local == remote through `00035`
before and after.

### Stage S3 (`00036`–`00038`)

Three migrations, all additive and all safe to apply to a live project:

- `00036_mood_readings.sql` — creates `mood_readings` and `mood_readings_user_end_idx` (server-only:
  RLS on with zero policies, and `select, insert, update, delete` granted to `service_role` only —
  no grant to anon/authenticated, so no client can reach the table regardless of policy — see the
  file's header for why the omission is deliberate), plus the `_test_policy_count` helper used to
  assert the zero-policy claim in tests. No new index on `chat_messages`: the existing
  `chat_messages_session_idx` (00006) already covers the claim RPC's scan.
- `00037_usage_kind_mood.sql` — re-states `usage_ledger_kind_check` with `'mood'` added.
- `00038_claim_sessions_for_mood.sql` — creates the claim RPC, granted to `service_role` only.

Apply to the hosted project after the PR merges:

```bash
pnpm supabase db push          # no --local: this targets HOSTED
```

**Before the first hosted run**, count what the backfill will process and record the number here,
so the first hour's spend is a known quantity rather than a surprise:

```sql
select count(*) from (
  select session_id from public.chat_messages
  group by session_id
  having max(created_at) < now() - interval '4 hours'
) s;
```

No new environment variable. The job shares `ENRICH_MONTHLY_BUDGET_USD` with the enrichment sweep
and is distinguishable in `usage_ledger` by `kind = 'mood'`.

### Ship log — 2026-08-12

Everything that went wrong getting here — including the two defects this deploy itself
surfaced (`00025`'s grant drift and the missing `.dockerignore`) — is in
[`docs/phase-2-issue-log.md`](./phase-2-issue-log.md), same format as the 1c log. Read it
before the next deploy: most of its entries produce no error anywhere.

- `00018`–`00025` pushed; remote head `00025`, verified in `pg_proc` / `pg_class`, not from the
  CLI's exit code.
- All eight required variables set and confirmed by piping `railway variables --json` through
  the compiled `parseApiEnv`.
- `railway up` → Nest started, `POST /search` mapped, `EnrichModule` initialised.
- Unauthenticated `POST /notes` → `401`; authenticated → `201`.
- First sweep: `processed=16 failed=0 skippedOverBudget=0`. A new note was embedded, given
  `domain=life`, and returned by `POST /search` with `matchedBy=vector`.
- `select count(*) from note_chunks where embedding is null` → **0**.
- `usage_ledger` recorded the search embedding: `gemini-embedding-001`, 6 input tokens,
  `$0.0000009`.
- Post-`00025` re-check: `POST /notes`, `/tags`, `/me`, `/search` all still succeed;
  `note_chunks` / `usage_ledger` / `note_enrichment` return `42501` to `authenticated`.

---

## Web — Vercel deploy checklist

This section did not exist before Stage C1 Task 10 — the web app is deployed on Vercel (a
linked project, visible locally as `.vercel/project.json`: `projectName: "web"`,
`framework: "nextjs"`, `rootDirectory: "apps/web"`, production URL
`https://web-tan-nu-96.vercel.app`), but nothing about it had been written down here. What
follows is what could be established from the linked project config and the CLI, not a fresh
setup guide — unlike Supabase/Google/Railway above, provisioning this project is not part of
this checklist.

| Item | Value | Already true? |
| --- | --- | --- |
| Framework preset | Next.js (auto-detected) | yes |
| Root Directory | `apps/web` | yes |
| Build Command | `cd ../.. && pnpm turbo run build --filter=@cortex/web` | **not yet applied** — pinning was denied by the sandbox's live-infra guard; see below |
| `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | set on the Vercel project | assumed — the production URL serves a working, signed-in app, which is not reachable with any of the three unset; not independently re-verified by this task |

### Why the Build Command needed pinning

Before Task 10 the Build Command was unset (`null` in `project.json`), so Vercel ran its own
default. That default currently works — Vercel's own Turborepo detection walks up from
`rootDirectory` and runs the monorepo build, which resolves `@cortex/shared`'s workspace
dependency correctly. But a **bare** `next build` (no turbo, no dependency graph) fails:
`packages/shared`'s `package.json` points `main` at `./dist/index.js`, and nothing produces
that directory except `packages/shared`'s own `build` script — `next build` on its own never
runs it. Pinning the command explicitly removes the dependence on Vercel's inference ever
staying correct.

```
cd ../.. && pnpm turbo run build --filter=@cortex/web
```

(`cd ../..` is relative to the Root Directory, `apps/web`, landing back at the repo root where
`turbo` and the workspace live.)

**Not applied by this task.** Changing a live Vercel project's build settings is a
dashboard-equivalent mutation this agent's sandbox explicitly blocks (`vercel project update`
was denied by the harness's own auto-mode classifier, the same way Steps 2–4/6 above require a
human with browser access). Set it by hand:

- Dashboard: Project **web** → Settings → Build & Development Settings → Build Command → paste
  the command above, override the framework default, Save.
- Or CLI, from a session that allows project mutations:
  ```bash
  vercel project update web --build-command "cd ../.. && pnpm turbo run build --filter=@cortex/web"
  ```

Until one of those runs, the "Already true?" cell above stays aspirational, not verified —
re-check `apps/web/.vercel/project.json`'s `buildCommand` field (`vercel pull`) after applying it.

---

## Is there CI/CD? (Code ships automatically; migrations and env vars do not)

**Merging to `main` deploys the API and web app, once E2E passes — but not the schema.**
`post-merge.yml`'s `deploy-api` and `deploy-web` jobs (added alongside the Stage C1 branch)
run after `e2e-web`, gated on `needs.e2e-web.result == 'success'` and on a path filter (touch
nothing under `apps/api`/`packages/core`/`packages/db`/`packages/shared`/`supabase/migrations`
and `deploy-api` is skipped entirely; same idea for `deploy-web` and `apps/web`). Both are
independent of `e2e-mobile` — neither app needs the mobile suite green to ship.

| Layer | State | Evidence |
| --- | --- | --- |
| GitHub Actions | deploys API + web after E2E, on push to `main` | `post-merge.yml`'s `deploy-api`/`deploy-web` jobs — `railway up --service cortex-api --detach --yes` and `vercel deploy --prod` respectively, each needing its own repo secret (`RAILWAY_TOKEN`, `VERCEL_TOKEN` — see below). |
| Railway → GitHub | still **not connected** as a native integration | `railway status --json` reports `source: {"image": null, "repo": null}` for `cortex-api` — deploys are the GitHub Actions job calling the Railway CLI directly, not Railway's own git integration. |
| Database migrations | **still manual, deliberately** | `supabase db push` is run by a human. The deploy jobs do NOT run it — a bad migration must never apply itself just because the code that needs it happened to pass E2E. If a PR adds a migration, push it BEFORE merging, or the just-deployed code may assume a schema that isn't there yet. |

So a merge to `main` now ships code automatically, but **shipping a migration is still your
job, and it goes first**:

```bash
# 1. schema first -- new code usually assumes the new schema, not the reverse. Do this
#    BEFORE merging a PR that includes a migration; the deploy jobs will not do it for you.
pnpm exec supabase db push
pnpm exec supabase migration list          # confirm local == remote

# 2. env vars BEFORE the deploy that needs them (see the phase 1a checklist above).
#    --skip-deploys avoids redeploying the OLD code just to attach a new variable -- useful
#    when you're setting a var ahead of a merge that hasn't shipped yet.
railway variables --service cortex-api --set-from-stdin SUPABASE_ANON_KEY --skip-deploys

# 3. merge to main -- deploy-api and deploy-web take it from here, once e2e-web is green
```

Manual deploys (`railway up` / `vercel deploy --prod` by hand) still work exactly as before,
for anything the automatic path doesn't cover — a hotfix you want to ship without waiting on
E2E, or a rollback.

### Deploy job secrets

`deploy-api` needs `RAILWAY_TOKEN` and `deploy-web` needs `VERCEL_TOKEN`, both as repo
secrets (`gh secret set RAILWAY_TOKEN` / `gh secret set VERCEL_TOKEN`, or the GitHub UI —
Settings → Secrets and variables → Actions). Neither could be minted from an already
logged-in CLI session — both platforms return an authorization error for that
(`projectTokenCreate`/`apiTokenCreate` on Railway: `Not Authorized`; `vercel tokens add`:
`Cannot create tokens for this app (403)`) — so both have to come from the dashboard:

- **Railway**: prefer a **project token**, not a personal one — Project → Settings →
  Tokens → scope it to `cortex-api`'s `production` environment. A personal account token
  works too but grants access to every project on the account, not just this one.
- **Vercel**: [vercel.com/account/tokens](https://vercel.com/account/tokens) — **the
  dashboard's scope selector (top-left) must be on your personal account, not a team**,
  or this page isn't reachable the same way. Create → name it → Scope dropdown → the
  team that owns the project (`phillip7`) → the **`web`** project specifically (not "All
  Projects", which creates a team-wide token instead) → set an expiration → Create.
  This makes a genuinely **project-scoped token** (`vcp_...`), contrary to what an
  earlier version of this doc claimed — Vercel does support scoping to one project, it's
  just not reachable from `vercel tokens add` on the CLI (that command, and the REST API's
  equivalent, both require a full-account token to call; a project-scoped token cannot
  mint new tokens, which is why creating one has to start from the dashboard). `deploy-web`
  still pins `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` in the workflow regardless (not secret —
  just IDs, matching `apps/web/.vercel/project.json`), so the deploy target is explicit
  either way.

Until both secrets exist, `deploy-api`/`deploy-web` will run and fail (not silently skip) —
that's deliberate, so a missing secret is loud in the Actions tab rather than a deploy that
quietly never happened.

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

### If you want migrations in the pipeline too

Deliberately not done. Adding a `supabase db push` step to `post-merge.yml`, gated to run
*before* `deploy-api`/`deploy-web`, would close the last manual gap — but it also means a
bad migration applies itself the moment its PR merges and E2E passes, with no human in that
path. Revisit this if the manual step becomes the actual bottleneck, not by default.

An alternative to the GitHub Actions job this repo uses: attach the GitHub repo to the
Railway service directly (Railway dashboard → service → Settings → Source), which deploys
on push to `main` without a workflow step at all. Not used here because it can't be gated
on `e2e-web` passing first, and it doesn't cover `apps/web` (a Vercel project) either way.

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

-- SELECT only, and only on the seven synced tables (six from Phase 1b's original setup, plus
-- chat_messages — added 2026-08-22 by migration 00034 for the mobile chat transcript; see
-- "chat_messages joins the publication" below). NOT "on all tables": this role has no
-- business seeing integrations.credentials.
grant select on public.notes, public.tags, public.note_tags,
                 public.links, public.media_items, public.checkins, public.chat_messages
  to powersync_role;

-- The publication MUST be named "powersync". Its SCOPE is ours to choose, and choosing
-- matters: PowerSync's setup guide says `FOR ALL TABLES`, which would put
-- integrations.credentials, note_chunks, usage_ledger and memory_revisions into the
-- replication stream. The sync rules would filter them out -- but only after they had
-- left Postgres. Naming the seven tables keeps them out of the stream entirely, giving a
-- third isolation layer beneath the sync rules.
create publication powersync for table
  public.notes, public.tags, public.note_tags,
  public.links, public.media_items, public.checkins, public.chat_messages;
```

Verify immediately — this is the whole point of the step. Being IN the publication is
necessary but not sufficient: logical replication also requires the table-level GRANT above,
which is a separate check (`bypassrls` bypasses row policies, not table grants) —

```sql
select tablename from pg_publication_tables where pubname = 'powersync' order by tablename;
```

Exactly seven rows. Anything else (especially `integrations`) means
`drop publication powersync;` and create it again. `packages/db`'s
`sync-rules-isolation.test.ts` asserts this same property through
`_test_publication_tables`, so a later widening fails the suite rather than going unnoticed.

```sql
select has_table_privilege('powersync_role', 'public.chat_messages', 'SELECT');
-- must be true -- run this for every table in the list above, not just chat_messages, since
-- the publication query alone cannot tell you whether the GRANT was ever issued.
```

### The publication is now also in a migration — `00016_powersync_publication.sql`

Task 12 moved the `create publication` above into version control, along with the
`_test_publication_tables` helper the test needs. Two consequences:

- **On the hosted project it is a no-op.** The `do $$ ... if not exists` guard sees the
  publication this section already created by hand and skips it. The migration deliberately
  does **not** follow up with `alter publication ... add table`, which would error on a
  relation already in the publication.
- **The helper function is not a no-op**, so `00016` had to be pushed before the suite could
  assert the publication against the hosted project.

**Shipped 2026-08-03.** `npx supabase db push` applied `00016`; `npx supabase migration list`
shows `00001`–`00016` local == remote. (The CLI is a devDependency here — `supabase` alone is
not on PATH.)

Because of the `if not exists` guard, that push proves the **helper** landed, not that the
hosted publication has the right scope: had it existed with a wrong scope, the guard would have
skipped it. Confirm from the dashboard SQL editor, which needs no `service_role` key in a shell
session:

```sql
select * from _test_publication_tables('powersync');
-- checkins, links, media_items, note_tags, notes, tags -- exactly six rows (before 00034; see
-- below for the seventh)
```

**Run 2026-08-03: six rows, no `integrations`.** `sync-rules-isolation.test.ts` asserts this
automatically against the **local** stack and CI, so the hosted publication stays a manual check
— re-run the query above after any change to replication configuration.

A publication that lives only in a dashboard session is a layer nobody can review, diff or
restore. The migration is what makes the local stack and CI carry the same six-table scope the
hosted project was given by hand — which is what lets the test run anywhere instead of
skipping, as its first draft did everywhere.

### chat_messages joins the publication — `00034_powersync_publication_chat_messages.sql`

Stage S1 (2026-08-22) added the mobile chat transcript, and with it a seventh synced table:
`chat_messages` must replicate to the device for the chat screen to work offline. Same
guarded shape as `00016`, for the same reason (a bare `alter publication ... add table`
errors on a relation already present, which is exactly the re-run-against-hosted case), plus
one thing `00016` didn't need: a table-level `GRANT SELECT` to `powersync_role`, guarded
behind `if exists (select 1 from pg_roles where rolname = 'powersync_role')` because that role
does not exist on the local/CI stack (`e2e/powersync/up.sh` replicates as `postgres` there).

**Final whole-branch review finding (Critical), fixed 2026-08-22 before this ever reached
hosted:** the first version of this migration added the publication membership but never
granted `powersync_role` SELECT on the table. Local and CI could never have caught this —
neither runs PowerSync as that role — so it would have shipped as a silent, permanent empty
transcript on every real device the moment `supabase db push` (without `--local`) applied it,
discovered only by a human looking at a phone.

**As of this fix wave, `00034` has NOT yet been applied to the hosted project** — Task 16's
unflagged `supabase db push` is still deliberately deferred to a human (see the top-level
Deploy checklist). When it is, verify BOTH properties, not just one — membership in the
publication does not imply the grant exists, and vice versa:

```sql
select * from _test_publication_tables('powersync');
-- checkins, links, media_items, note_tags, notes, tags, chat_messages -- exactly seven rows

select has_table_privilege('powersync_role', 'public.chat_messages', 'SELECT');
-- must be true
```

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
# 2. PATCH -> "conflict_copies":[]        updateWithConflictCopy: no base_content, no copy
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

## 6. Stage 4 ship — native build flags and the dev-client rebuild

Stage 4 added two **native** build flags and two native modules. None of them can be picked up
by an existing dev client: it is a compiled binary.

### The `op-sqlite` block, and how to actually verify it

```jsonc
// apps/mobile/package.json
"op-sqlite": { "sqlcipher": true, "fts5": true }
```

- `sqlcipher` encrypts the local replica. Without it the whole corpus sits unencrypted.
- `fts5` compiles `SQLITE_ENABLE_FTS5`. Without it the `notes_fts` virtual table fails at
  runtime with "no such module: fts5" and offline search is dead.

Both take effect at **Gradle configure time** and print their own confirmation:

```
[OP-SQLITE] Detected op-sqlite config from package.json at: <path>
[OP-SQLITE] using sqlcipher.
[OP-SQLITE] FTS5 enabled
```

All three lines must appear. If the first names a `package.json` other than
`apps/mobile/package.json`, move the `op-sqlite` block to the file it names and rebuild —
PowerSync's docs warn that monorepo hoisting can do this.

**Do not use the grep the plan suggests.** `rg sqlcipher apps/mobile/android/*.gradle` matches
nothing whether or not the flag is set, because the flag is consumed in op-sqlite's own
`build.gradle` under `node_modules`. A green grep there is an unencrypted database that looks
configured.

**Verifying without an Android SDK.** The flags can be read out of the built APK instead, which
is the merged artifact rather than the config that should produce it:

```bash
unzip -o -q <build>.apk "lib/arm64-v8a/libop-sqlite.so" -d ext
grep -ac sqlite3_key ext/lib/arm64-v8a/libop-sqlite.so   # SQLCipher-only API
grep -ac bm25        ext/lib/arm64-v8a/libop-sqlite.so   # FTS5-only
grep -ac rtreecheck  ext/lib/arm64-v8a/libop-sqlite.so   # must be 0 — rtree is NOT enabled
```

The third line is what makes the first two mean something: a bare `fts5` substring survives in
the SQLite amalgamation whether or not the feature is compiled, so a flag we deliberately left
off has to come back zero from the same binary. Check all four ABIs — a per-arch divergence
would ship an unencrypted database to some devices only.

### PowerSync majors move together

`@powersync/react-native`, `@powersync/common` (in both `apps/mobile` and `packages/sync`) and
`@powersync/react` are pinned at `^2.0.0`. v2 is the major that switched from
`@journeyapps/react-native-quick-sqlite` to `@op-engineering/op-sqlite`, which is what the
`op-sqlite` block above configures.

Dropping any one of them below 2 re-splits the `Schema` class identity: `AppSchema` is built in
`packages/sync` and handed to a `PowerSyncDatabase` constructed in `apps/mobile`, and two
physical copies of `@powersync/common` fail far from the cause. Check after any dependency
change:

```bash
readlink -f apps/mobile/node_modules/@powersync/common
readlink -f packages/sync/node_modules/@powersync/common
# must be the SAME path
```

### Rebuild required after Stage 4

`expo-dev-client`, `expo-file-system` and `expo-sharing` were all added during Stage 4, on top
of the two native flags. Rebuild:

```bash
pnpm --filter @cortex/mobile exec eas build --profile development --platform android
```

`expo-dev-client` in particular is not optional — EAS refuses a `developmentClient` build
without it.

### Environment variables and the dev client

A **development** build carries no JS: Metro serves it from your machine at runtime, so
`EXPO_PUBLIC_*` come from your local `apps/mobile/.env` and EAS needs none set. A `preview` or
`production` build inlines them at build time, so all four
(`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_POWERSYNC_URL`,
`EXPO_PUBLIC_API_URL`) **must** be configured on EAS before that build, or the app ships
pointing at `undefined`.

---

# Web — Vercel deploy checklist

Issue-log **E3** says the search UI "is not live until web redeploys". That is exactly right,
and narrower than it sounds. **Web is already deployed** — this section was first written
claiming otherwise, and every claim below is now what the CLI and the live site actually
report, not what the repo implied.

## 0. What is actually true right now (verified 2026-08-12)

| | |
|---|---|
| Project | `phillip7/web`, `prj_s4LpM7…`, created 2026-08-04 |
| Live production deploy | `web-2u0kmce12-phillip7.vercel.app`, **● Ready**, built **2026-08-04** |
| Stable aliases | `web-tan-nu-96.vercel.app`, `web-phillip7.vercel.app` |
| Root Directory | `apps/web` ✅ already set |
| Env vars (Production) | all three `NEXT_PUBLIC_*` ✅ already set |
| Railway `CORS_ORIGINS` | ✅ already includes `https://web-tan-nu-96.vercel.app` |

**The live build predates stage B.** It was built eight days before phase 2 merged, so it has
no `/search` route, no search UI, and none of phase 1c. A redeploy from current `main` is the
whole content of "make search live".

## 1. The actual blocker: Deployment Protection is ON

Every path on the live site answers `302` to `https://vercel.com/sso-api?url=…`:

```
$ curl -s -o /dev/null -D - https://web-phillip7.vercel.app/login | grep -i '^location'
Location: https://vercel.com/sso-api?url=https%3A%2F%2Fweb-phillip7.vercel.app%2Flogin&nonce=…
```

`/`, `/login` and `/search` all do it, which is the tell: `/login` has no auth requirement of
its own, so a redirect there is not the app's middleware — it is Vercel Authentication in front
of the whole deployment.

**Consequence: the site is usable only by someone signed in to the Vercel account.** Cortex has
two users; unless the second is on the team, the app is invisible to them no matter how many
times it is redeployed. This is the first thing to change, and it is a dashboard setting, not
code:

> Vercel → Project `web` → Settings → **Deployment Protection** → Vercel Authentication → set
> Production to **Disabled** (leave preview protection on if you like — previews cannot write
> anyway, see §4).

Nothing else in this checklist matters until this is off, because every verification in §5 would
otherwise be measuring the SSO page.

## 2. Build Command — pin it, even though it currently works

Project settings show the **default** build command (`next build`), and the 2026-08-04 deploy
succeeded with it from a clean checkout. But a bare `next build` does not work on its own:

```
$ rm -rf packages/shared/dist && npx next build
Module not found: Can't resolve '@cortex/shared'
```

`@cortex/shared`'s `package.json` `main` is `./dist/index.js`, and there is no `prepare` or
`postinstall` script to produce it — so something on Vercel's side is building the workspace
first, almost certainly its Turborepo detection picking up `turbo.json`.

**Set it explicitly anyway:**

```
cd ../.. && pnpm turbo run build --filter=@cortex/web
```

The current arrangement works by inference from a file we do not control the meaning of. Naming
the command costs nothing and removes the dependency on that detection continuing to behave the
same way after any Vercel or turbo upgrade. This is a judgement call, not a fix for a live
failure — recorded as such so nobody later "simplifies" it back.

While here: `next.config.ts`'s comment claims `@cortex/shared` ships raw TypeScript with `main`
at `src/index.ts`. That has been false since `5162b2b`; `transpilePackages` is now doing nothing
for it. Stale, harmless, worth correcting the next time that file is opened.

## 3. Supabase Auth — the redirect allowlist (OUTSIDE VERCEL)

Phase 0 set **Site URL = `http://localhost:3000`**, and it is still that.

The app needs no code change: `login/page.tsx:9` uses `${location.origin}/auth/callback` and
`auth/callback/route.ts:5` reads the origin off the request, so it works on any domain Supabase
is willing to redirect to.

Supabase → Authentication → URL Configuration:

- **Site URL** → `https://web-tan-nu-96.vercel.app` (match whatever `CORS_ORIGINS` names — §4)
- **Redirect URLs** → add `https://web-tan-nu-96.vercel.app/auth/callback`

**Failure mode:** Google sign-in completes and then bounces to localhost or
`redirect_uri_mismatch`. The deployment is green and the home page renders; it just cannot be
signed into.

## 4. `CORS_ORIGINS` — already set, verify the alias matches

```
CORS_ORIGINS = https://web-tan-nu-96.vercel.app,http://localhost:3000,http://127.0.0.1:3000
```

Already correct, and worth understanding rather than trusting: `env.ts:19` makes this
**optional** and `main.ts:10` defaults to localhost only. So had it been unset, the API would
boot clean, `/health` would answer, every server-side read through Supabase would work, and the
site would look entirely functional — while every browser *write* was blocked before leaving the
browser, visible only in the console. Since stage C1's box opens with a `POST /notes`, that
failure presents as the assistant doing nothing at all.

**The one thing to check:** the value names `web-tan-nu-96`, and the site is also aliased as
`web-phillip7`. Whichever alias is used in the browser must be the one listed here — an origin
is an exact string match. Use one alias consistently, or list both.

### Preview deployments cannot write

Vercel mints a fresh URL per preview and `app.enableCors({ origin: origins })` takes exact
strings, so previews render and then fail every write.

**Ruled: production alias only.** Making previews fully functional means matching origins by
pattern in `main.ts`, which widens the CORS surface for a benefit two users do not need. If that
changes it is a small separate PR, not a config tweak.

## 5. Deploy, and verify in this order

Git integration deploys `main` to production, and needs no new CI. Note that Vercel deploys
**independently of** `ci.yml` — a red CI does not block a deploy. Acceptable at this size.

Manually instead:

```bash
vercel pull --yes --environment=production
vercel build --prod        # on Windows this fails at EPERM: symlink — a local
                           # limitation, not a project one; Linux builders are fine
vercel deploy --prebuilt --prod
```

Order matters here, because each failure mimics the next:

| Check | Expect | If it fails |
|---|---|---|
| `GET /login` | `200`, not a `vercel.com/sso-api` redirect | §1 — protection still on |
| `GET /` unauthenticated | `307 → /login` | build or env, not wiring |
| Google sign-in | returns signed in | §3 |
| Notes list renders | rows | Supabase read path — RLS or anon key |
| **Create a note** | `201`, row appears | §4 — check the console for CORS first |
| `/search` exists at all | not a 404 | the deploy is still the 2026-08-04 build |
| Search a phrase from a known note | results with `matchedBy` | `NEXT_PUBLIC_API_URL`, then §4 |
| Search Vietnamese without diacritics | matches | needs `00026` pushed to hosted |
