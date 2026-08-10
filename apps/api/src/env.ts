import { z } from "zod";

// Validated once at boot (see main.ts) so a missing/malformed SUPABASE_URL fails fast
// with a clear message here, rather than surfacing later — confusingly — as
// `new URL("undefined/...")` inside supabase-auth.guard.ts's JWKS fetch on the first
// authenticated request.
//
// NOTE: this schema lives in apps/api rather than packages/shared because it is only ever
// read at this app's boot. (An earlier version of this comment said a runtime
// `require("@cortex/shared")` would crash the compiled container because shared shipped raw
// TypeScript. That has not been true since shared gained a build step: its package.json
// "main" is "./dist/index.js", and notes.controller.ts imports it at runtime today.)
const envSchema = z.object({
  SUPABASE_URL: z.string().url({ message: "SUPABASE_URL must be a valid absolute URL" }),
  PORT: z.string().optional(),
  // Comma-separated list of allowed CORS origins, e.g.
  // "https://app.example.com,https://admin.example.com". Falls back to localhost dev
  // origins (see DEFAULT_CORS_ORIGINS in main.ts) when unset.
  CORS_ORIGINS: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, {
    message: "SUPABASE_SERVICE_ROLE_KEY is required: the enrichment pipeline and search RPC " +
      "read note_chunks, which has RLS enabled with no policies and is therefore invisible " +
      "to `authenticated` by design.",
  }),
  DATABASE_URL: z.string().url(),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_TIER: z.enum(["free", "paid"]),
  ENRICH_MONTHLY_BUDGET_USD: z.coerce.number().positive(),
});

export type ApiEnv = z.infer<typeof envSchema>;

/** Loopback in either spelling; the Supabase CLI prints 127.0.0.1, humans type localhost. */
function isLocal(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** `<ref>.supabase.co` -> ref; anything else (including a local stack) -> null. */
function refFromSupabaseUrl(raw: string): string | null {
  const host = new URL(raw).hostname;
  const m = /^([a-z0-9]+)\.supabase\.(co|in)$/.exec(host);
  return m ? (m[1] ?? null) : null;
}

/** `postgres.<ref>` -> ref. The direct (non-pooler) host carries the ref in the hostname instead. */
function refFromDatabaseUrl(raw: string): string | null {
  const u = new URL(raw);
  const user = decodeURIComponent(u.username);
  if (user.startsWith("postgres.")) return user.slice("postgres.".length);
  const m = /^db\.([a-z0-9]+)\.supabase\.(co|in)$/.exec(u.hostname);
  return m ? (m[1] ?? null) : null;
}

/** Throws a zod error (with a readable message) if required env vars are missing/invalid. */
export function parseApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = envSchema.parse(env);

  // Both must name ONE database. Found split on 2026-08-10: a local SUPABASE_URL beside a
  // hosted DATABASE_URL reads notes from the local stack while pg-boss creates its `pgboss`
  // schema inside production and shares a single queue between dev and production.
  const apiRef = refFromSupabaseUrl(parsed.SUPABASE_URL);
  const dbRef = refFromDatabaseUrl(parsed.DATABASE_URL);
  const bothLocal =
    apiRef === null &&
    dbRef === null &&
    isLocal(new URL(parsed.SUPABASE_URL).hostname) &&
    isLocal(new URL(parsed.DATABASE_URL).hostname);

  if (!bothLocal && apiRef !== dbRef) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["DATABASE_URL"],
        message:
          `SUPABASE_URL and DATABASE_URL must point at the same database ` +
          `(SUPABASE_URL ref=${apiRef ?? "local"}, DATABASE_URL ref=${dbRef ?? "local"}).`,
      },
    ]);
  }
  return parsed;
}
