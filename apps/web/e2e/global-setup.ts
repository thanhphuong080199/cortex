import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Signs the E2E user in and writes the result as a Playwright storageState, so every spec starts
 * on the app instead of on /login.
 *
 * WHY NOT DRIVE THE LOGIN SCREEN
 *
 * The product has exactly one sign-in path, `signInWithOAuth({provider:"google"})`
 * (src/app/login/page.tsx). Google's consent screen cannot be automated from CI. The user is
 * therefore created through the Supabase ADMIN api by e2e/scripts/seed.mjs -- a path no product
 * code has -- and this signs in as them with a password. The consequence, stated plainly: the
 * app's own sign-in code is NOT covered by these tests. Everything behind it is.
 *
 * WHY A COOKIE JAR AND NOT HAND-WRITTEN COOKIES
 *
 * The session lives in cookies whose names, chunking and encoding are @supabase/ssr's business
 * (`sb-<ref>-auth-token`, split across numbered chunks once it exceeds the 4KB cookie limit).
 * Writing them by hand would be a second implementation to keep in step with the one
 * src/middleware.ts and src/lib/supabase/server.ts read them with. Instead this drives the same
 * `createServerClient` against a throwaway in-memory jar and persists whatever it produces, so
 * the format is correct by construction and cannot drift.
 */

const AUTH_FILE = "e2e/.auth/user.json";
const TOKEN_FILE = "e2e/.auth/token.txt";

export default async function globalSetup() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set; " +
        "the web E2E job exports them from `supabase status`",
    );
  }

  const jar: { name: string; value: string; options: CookieOptions }[] = [];

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => jar.map(({ name, value }) => ({ name, value })),
      // Annotated rather than inferred, matching src/lib/supabase/server.ts and
      // src/middleware.ts: @supabase/ssr types this callback loosely enough that
      // `noImplicitAny` rejects the bare parameter, and `next build` typechecks this directory.
      setAll: (toSet: { name: string; value: string; options: CookieOptions }[]) => {
        // Replace wholesale rather than append: a refresh rewrites the same names, and keeping
        // both generations would persist a stale chunk alongside a fresh one, which decodes to
        // a corrupt token rather than to no token at all.
        jar.length = 0;
        jar.push(...toSet);
      },
    },
  });

  const { data, error } = await supabase.auth.signInWithPassword({
    email: process.env.E2E_EMAIL ?? "e2e@cortex.test",
    password: process.env.E2E_PASSWORD ?? "e2e-password-not-a-secret",
  });
  if (error) {
    throw new Error(
      `E2E sign-in failed: ${error.message}. Has e2e/scripts/seed.mjs been run against this stack?`,
    );
  }
  if (jar.length === 0) {
    // A "successful" sign-in that wrote nothing would produce an empty storageState, and every
    // spec would then fail with a redirect to /login -- which reads as a routing bug rather
    // than as an auth-setup bug. Fail here, where the cause is obvious.
    throw new Error("sign-in reported success but wrote no cookies; nothing to persist");
  }

  const base = new URL(process.env.E2E_WEB_URL ?? "http://127.0.0.1:3000");

  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  writeFileSync(
    AUTH_FILE,
    JSON.stringify(
      {
        cookies: jar.map((c) => ({
          name: c.name,
          value: c.value,
          domain: base.hostname,
          path: "/",
          // A far-future expiry rather than a session cookie: middleware.ts refreshes on every
          // request, but a slow suite must not log itself out midway.
          expires: Math.floor(Date.now() / 1000) + 3600,
          // The app reads these server-side through the cookie header; httpOnly would be more
          // faithful to production, but Playwright's storageState replays them either way and
          // `false` keeps them inspectable when a spec fails.
          httpOnly: false,
          // The stack is plain http on localhost, so a Secure cookie would never be sent.
          secure: base.protocol === "https:",
          sameSite: "Lax" as const,
        })),
        origins: [],
      },
      null,
      2,
    ),
    "utf8",
  );

  // A couple of assertions can only be made against the API or PostgREST -- media find-or-create
  // is a server-side decision the page never renders. Writing the token beside the cookies keeps
  // those specs self-contained instead of depending on the workflow to export an extra variable,
  // which is the kind of coupling that passes locally and fails in CI.
  writeFileSync(TOKEN_FILE, data.session?.access_token ?? "", "utf8");

  // Same self-contained principle, for the ONE value a file can't carry as cleanly as an env
  // var: the seeded user's id, which a spec needs to scope an admin-client insert to the right
  // owner (RLS requires it; there is no "insert as whoever the cookies say" shortcut through
  // service-role). Set here, not read from the workflow: Playwright forks its worker processes
  // AFTER globalSetup returns, so a `process.env` write here is visible in every spec, and nothing
  // upstream of this file has to remember to export it.
  if (data.user?.id) process.env.E2E_USER_ID = data.user.id;

  console.log(`[e2e] wrote ${jar.length} auth cookie(s) to ${AUTH_FILE}`);
}
