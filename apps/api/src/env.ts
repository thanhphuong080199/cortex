import { z } from "zod";

// Validated once at boot (see main.ts) so a missing/malformed SUPABASE_URL fails fast
// with a clear message here, rather than surfacing later — confusingly — as
// `new URL("undefined/...")` inside supabase-auth.guard.ts's JWKS fetch on the first
// authenticated request.
//
// NOTE: this schema deliberately lives in apps/api, not packages/shared, even though
// packages/shared already depends on zod and would otherwise be the natural home for a
// small shared env schema. packages/shared ships raw TypeScript source (package.json
// "main": "./src/index.ts", no build step) and today is only ever consumed by
// TypeScript-aware tooling (vitest in packages/db's tests, tsc for typechecking).
// apps/api's Dockerfile compiles via plain `tsc` (module: commonjs) and runs the
// compiled dist/main.js with plain `node` in production — that compiled output does not
// bundle or transpile workspace node_modules dependencies, so a runtime
// `require("@cortex/shared")` would try to load a raw .ts file and crash the container
// at boot. Keeping this schema local to apps/api avoids that failure mode while still
// satisfying the "validate env with zod at boot" requirement.
const envSchema = z.object({
  SUPABASE_URL: z.string().url({ message: "SUPABASE_URL must be a valid absolute URL" }),
  PORT: z.string().optional(),
  // Comma-separated list of allowed CORS origins, e.g.
  // "https://app.example.com,https://admin.example.com". Falls back to localhost dev
  // origins (see DEFAULT_CORS_ORIGINS in main.ts) when unset.
  CORS_ORIGINS: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
});

export type ApiEnv = z.infer<typeof envSchema>;

/** Throws a zod error (with a readable message) if required env vars are missing/invalid. */
export function parseApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  return envSchema.parse(env);
}
