# Phase 2+3, stages A and B — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side enrichment pipeline (chunk → embed → extract domain/meta/tags) and hybrid semantic search, so that stage C's single input box has something to stand on.

**Architecture:** pg-boss runs inside the existing NestJS process on Railway. A 60-second cron sweep claims notes from one SQL predicate keyed on `md5(content_text)` — no controller enqueues anything, so no write path can be missed. Enrichment bookkeeping lives in a server-only `note_enrichment` table because `notes` is client-writable. Search is one SQL function combining pgvector and Postgres FTS by Reciprocal Rank Fusion.

**Tech Stack:** TypeScript, NestJS 11, pg-boss, `@supabase/supabase-js`, Postgres 15 + pgvector, Gemini API, vitest, turbo, pnpm.

Spec: `docs/superpowers/specs/2026-08-10-phase-2-3-assistant-design.md`.

## Global Constraints

- **Always `pnpm turbo run test --filter=<pkg>`, never `pnpm --filter <pkg> test`.** `@cortex/shared` and `@cortex/core` are consumed as compiled `dist/`, and only turbo's `test` → `^build` edge rebuilds them first.
- **Read the `Cached:` line.** A gate is evidence only when it says `0 cached`. Use `--force` for the final gate of a task.
- **Docker Desktop must be up** for `@cortex/db`, `@cortex/api` and `@cortex/core` suites. When it is down those are turbo cache replays, not runs, and must never be reported as runs.
- **New env vars must be added to `turbo.json`'s `test.env` array** or vitest will not see them — turbo runs tasks in strict env mode.
- **Migrations must schema-qualify extension types**: `extensions.vector(...)`, `extensions.vector_cosine_ops`. Unqualified works locally and fails only against the hosted project (`00012_embedding_dims_gemini.sql` records the exact failure).
- **CI needs no new job.** Every package touched here (`@cortex/shared`, `@cortex/core`, `@cortex/db`, `@cortex/api`, `@cortex/web`, `@cortex/mobile`) is already named in `.github/workflows/ci.yml`. Checked, not assumed — per the phase-1b Task 7 rule. If a task adds a *new package*, it must add the CI step in that same task.
- **Never call the real Gemini API from a test.** Every suite uses the fake from Task 9.
- **`GEMINI_TIER=free` is only legitimate against a local `SUPABASE_URL`.** Enforced in code by Task 12, not by convention.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

---

# Stage A — the pipeline

## Task 1: Environment, and a boot that refuses a split-brain config

**Files:**
- Modify: `apps/api/src/env.ts:19-27` (the zod schema) and its stale header comment at `:8-18`
- Modify: `apps/api/test/env.test.ts`
- Modify: `turbo.json:32-42`

**Interfaces:**
- Produces: `parseApiEnv(env)` returning `ApiEnv` widened with `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GEMINI_TIER`, `ENRICH_MONTHLY_BUDGET_USD`. Throws a zod error when `DATABASE_URL` and `SUPABASE_URL` do not name the same database.

**Context the implementer needs.** `apps/api/src/env.ts` carries a comment (lines 8-18) claiming `@cortex/shared` ships raw TypeScript with `"main": "./src/index.ts"` and that a runtime `require("@cortex/shared")` would crash the container. That is **no longer true** — shared builds to `./dist/index.js` and `notes.controller.ts:3` already imports it at runtime. Correct the comment while you are in the file; leaving it misleads whoever designs the worker next.

The split-brain check exists because `apps/api/.env` was found on 2026-08-10 with `SUPABASE_URL=http://127.0.0.1:54321` and `DATABASE_URL` pointing at the hosted Supavisor pooler. That configuration reads notes from the local stack while pg-boss creates its `pgboss` schema inside the production database and shares one queue between dev and production.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/env.test.ts`:

```ts
const base = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  GEMINI_API_KEY: "key",
  GEMINI_TIER: "free",
  ENRICH_MONTHLY_BUDGET_USD: "5",
};

describe("parseApiEnv — enrichment configuration", () => {
  it("accepts a local pair", () => {
    expect(() => parseApiEnv(base as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("accepts a hosted pair naming the same project ref", () => {
    expect(() =>
      parseApiEnv({
        ...base,
        SUPABASE_URL: "https://wilssluxogpdrbgffmzc.supabase.co",
        DATABASE_URL:
          "postgresql://postgres.wilssluxogpdrbgffmzc:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  // The exact configuration found in apps/api/.env on 2026-08-10.
  it("rejects a local SUPABASE_URL paired with a hosted DATABASE_URL", () => {
    expect(() =>
      parseApiEnv({
        ...base,
        DATABASE_URL:
          "postgresql://postgres.wilssluxogpdrbgffmzc:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
      } as NodeJS.ProcessEnv),
    ).toThrow(/same database/i);
  });

  it("rejects a hosted SUPABASE_URL whose DATABASE_URL names a different project ref", () => {
    expect(() =>
      parseApiEnv({
        ...base,
        SUPABASE_URL: "https://wilssluxogpdrbgffmzc.supabase.co",
        DATABASE_URL:
          "postgresql://postgres.someotherproject:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
      } as NodeJS.ProcessEnv),
    ).toThrow(/same database/i);
  });

  it("rejects a non-numeric budget", () => {
    expect(() => parseApiEnv({ ...base, ENRICH_MONTHLY_BUDGET_USD: "lots" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("rejects a tier outside free|paid", () => {
    expect(() => parseApiEnv({ ...base, GEMINI_TIER: "enterprise" } as NodeJS.ProcessEnv)).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
pnpm turbo run test --filter=@cortex/api -- env.test
```

Expected: FAIL — the new keys are not in the schema, so `parseApiEnv` accepts everything and none of the four rejection cases throw.

- [ ] **Step 3: Widen the schema and add the assertion**

In `apps/api/src/env.ts`, add to `envSchema`:

```ts
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
```

Then replace the bare `envSchema.parse` with a refinement. A Supabase project is identified by its **ref**: it is the subdomain of `<ref>.supabase.co` in `SUPABASE_URL`, and in a Supavisor connection string it is the part of the username after `postgres.`. Local stacks have no ref, so both sides must instead be loopback.

```ts
/** Loopback in either spelling; the Supabase CLI prints 127.0.0.1, humans type localhost. */
function isLocal(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** `<ref>.supabase.co` -> ref; anything else (including a local stack) -> null. */
function refFromSupabaseUrl(raw: string): string | null {
  const host = new URL(raw).hostname;
  const m = /^([a-z0-9]+)\.supabase\.(co|in)$/.exec(host);
  return m ? m[1] : null;
}

/** `postgres.<ref>` -> ref. The direct (non-pooler) host carries the ref in the hostname instead. */
function refFromDatabaseUrl(raw: string): string | null {
  const u = new URL(raw);
  const user = decodeURIComponent(u.username);
  if (user.startsWith("postgres.")) return user.slice("postgres.".length);
  const m = /^db\.([a-z0-9]+)\.supabase\.(co|in)$/.exec(u.hostname);
  return m ? m[1] : null;
}

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
```

- [ ] **Step 4: Declare the new vars to turbo**

In `turbo.json`, extend `tasks.test.env` to:

```json
      "env": [
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_JWT_SECRET",
        "CORS_ORIGINS",
        "PORT",
        "DATABASE_URL",
        "GEMINI_API_KEY",
        "GEMINI_TIER",
        "ENRICH_MONTHLY_BUDGET_USD"
      ]
```

The existing comment above `test` already explains why: turbo runs tasks in strict env mode and strips anything not listed, which previously made every `@cortex/db` suite die at import with `Error: supabaseUrl is required`.

- [ ] **Step 5: Correct the stale comment**

Replace `apps/api/src/env.ts:8-18` with:

```ts
// NOTE: this schema lives in apps/api rather than packages/shared because it is only ever
// read at this app's boot. (An earlier version of this comment said a runtime
// `require("@cortex/shared")` would crash the compiled container because shared shipped raw
// TypeScript. That has not been true since shared gained a build step: its package.json
// "main" is "./dist/index.js", and notes.controller.ts imports it at runtime today.)
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
pnpm turbo run test --filter=@cortex/api -- env.test
```

Expected: PASS, six new cases.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/env.ts apps/api/test/env.test.ts turbo.json
git commit -m "$(cat <<'EOF'
feat(api): boot refuses a SUPABASE_URL and DATABASE_URL naming two databases

Found split in apps/api/.env on 2026-08-10: a local SUPABASE_URL beside the
hosted pooler. That reads notes from the local stack while pg-boss would create
its pgboss schema inside production and share one queue between dev and prod.

Also corrects env.ts's header comment, which claimed @cortex/shared ships raw
TypeScript and would crash the compiled container -- untrue since shared gained
a build step, and notes.controller.ts already imports it at runtime.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Prove pg-boss reaches Postgres

**This task is the phase's leading risk and produces no feature.** Nothing else in stage A is worth building until it passes. If Supavisor session mode refuses pg-boss, the architecture falls back to a claim sweep over a PostgREST RPC, and that must be discovered now rather than in week three.

**Files:**
- Create: `apps/api/src/queue/boss.ts`
- Create: `apps/api/test/boss.integration.test.ts`
- Modify: `apps/api/package.json` (add `pg-boss`)

**Interfaces:**
- Consumes: `parseApiEnv` from Task 1.
- Produces: `createBoss(databaseUrl: string): PgBoss`, `startBoss(boss: PgBoss): Promise<void>`, `stopBoss(boss: PgBoss): Promise<void>`. Task 13 consumes all three.

**Context the implementer needs.** `docs/deploy.md:924` records the failure mode to expect: *"if the connection test fails while resolving the address rather than authenticating, that is the Supabase direct-connection networking issue"*. The hosted `DATABASE_URL` set on Railway uses `aws-0-ap-southeast-1.pooler.supabase.com` **port 5432**, which is Supavisor *session* mode. Port 6543 is transaction mode and will not work: pg-boss relies on session state and advisory locks.

- [ ] **Step 1: Install pg-boss**

```bash
pnpm --filter @cortex/api add pg-boss
```

- [ ] **Step 2: Write the failing integration test**

Create `apps/api/test/boss.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type PgBoss from "pg-boss";
import { createBoss, startBoss, stopBoss } from "../src/queue/boss";

// Runs against whatever DATABASE_URL names -- the local stack in dev, and (run by hand,
// once) the hosted pooler, which is the only way to learn whether Supavisor session mode
// accepts pg-boss before anything depends on it.
describe("pg-boss against the configured database", () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = createBoss(process.env.DATABASE_URL!);
    await startBoss(boss);
  }, 60_000);

  afterAll(async () => {
    if (boss) await stopBoss(boss);
  });

  it("creates its own schema", async () => {
    const rows = await boss.getQueues();
    expect(Array.isArray(rows)).toBe(true);
  });

  it("round-trips a job", async () => {
    const queue = `probe-${Date.now()}`;
    await boss.createQueue(queue);

    const seen: string[] = [];
    await boss.work<{ marker: string }>(queue, async ([job]) => {
      seen.push(job.data.marker);
    });

    await boss.send(queue, { marker: "hello" });

    await expect
      .poll(() => seen, { timeout: 30_000, interval: 250 })
      .toEqual(["hello"]);
  }, 45_000);
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npx supabase start
pnpm turbo run test --filter=@cortex/api -- boss.integration
```

Expected: FAIL — `Cannot find module '../src/queue/boss'`.

- [ ] **Step 4: Write the connection module**

Create `apps/api/src/queue/boss.ts`:

```ts
import PgBoss from "pg-boss";

/**
 * The FIRST direct Postgres connection in this repo -- everything else, including
 * packages/db's tests, reaches Postgres through PostgREST.
 *
 * Against hosted Supabase this must be the Supavisor SESSION pooler (port 5432 on
 * `*.pooler.supabase.com`), not the transaction pooler on 6543: pg-boss holds session state
 * and takes advisory locks, neither of which survives a transaction pooler. The direct host
 * `db.<ref>.supabase.co` also works where it resolves, but docs/deploy.md:924 records that it
 * does not resolve from every network -- if a connection test fails while resolving the
 * address rather than authenticating, that is the cause, not the password.
 */
export function createBoss(databaseUrl: string): PgBoss {
  return new PgBoss({
    connectionString: databaseUrl,
    // Supabase terminates idle connections; a small pool with a short idle timeout keeps the
    // worker from holding one open across a quiet night and waking to a dead socket.
    max: 4,
    // pg-boss owns this schema entirely. Naming it explicitly keeps it out of `public`, where
    // every migration in supabase/migrations/ lives.
    schema: "pgboss",
  });
}

export async function startBoss(boss: PgBoss): Promise<void> {
  boss.on("error", (err) => {
    // No note content ever reaches a log (spec §15.6 rule 1).
    console.error("[pgboss]", err instanceof Error ? err.message : err);
  });
  await boss.start();
}

export async function stopBoss(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: true });
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/api -- boss.integration
```

Expected: PASS, 2 cases.

- [ ] **Step 6: Prove it against the hosted pooler — this is the point of the task**

Run once, by hand, with the hosted string. Do **not** commit this value anywhere.

```bash
DATABASE_URL='<the hosted pooler string from the Railway variable>' \
  npx vitest run --root apps/api test/boss.integration.test.ts
```

Expected: PASS.

**If it fails, read the error before changing anything:**

| Symptom | Meaning | Action |
| --- | --- | --- |
| `ENOTFOUND` / `EAI_AGAIN` | address does not resolve — `deploy.md:924`'s case | Confirm the host is `*.pooler.supabase.com`, not `db.<ref>.supabase.co` |
| `password authentication failed` | wrong password | Reset it in the Supabase dashboard; `powersync_role` is unaffected, it has its own |
| `prepared statement ... already exists`, or advisory-lock errors | transaction pooler | The port is 6543; it must be 5432 |
| Anything else | unknown | **STOP and report.** Do not proceed to Task 3 — the fallback architecture in spec §5 may be required |

Record the outcome in the commit message.

- [ ] **Step 7: Drop the pgboss schema from the hosted database**

The probe created it in production. Stage A's deploy will recreate it deliberately.

```sql
-- Supabase dashboard, SQL editor
drop schema if exists pgboss cascade;
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/queue/boss.ts apps/api/test/boss.integration.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(api): pg-boss connection, proven against the Supavisor session pooler

The first direct Postgres connection in this repo -- everything else reaches
Postgres through PostgREST, which is why 00012 needed a SECURITY DEFINER helper
to observe a column's vector width at all.

Verified by hand against the hosted pooler on port 5432 (session mode) as well
as the local stack: schema creation and a job round-trip both succeed. Port 6543
is transaction mode and cannot work -- pg-boss holds session state and takes
advisory locks. The probe's pgboss schema was dropped from production again.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Hoist the server-only table list

**Files:**
- Modify: `packages/shared/src/dto/sync.ts` (add `SERVER_ONLY_TABLES` beside `SYNC_TABLES`)
- Modify: `packages/db/src/test/sync-rules-isolation.test.ts:196-206`
- Modify: `packages/sync/src/schema.test.ts:12-18`
- Modify: `packages/shared/src/dto/sync.test.ts`

**Interfaces:**
- Produces: `SERVER_ONLY_TABLES: readonly string[]` exported from `@cortex/shared`. Task 4 appends `note_enrichment` to it.

**Why this is its own task.** Two hand-maintained copies of the same seven names exist today. Task 4 adds an eighth, and a hand-written parallel list is exactly what phase 1b's Task 22 found — a status list duplicated directly beneath the comment warning against duplicating it. Hoisting before adding means Task 4 edits one line, not three.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/dto/sync.test.ts`:

```ts
import { SERVER_ONLY_TABLES, SYNC_TABLES } from "./sync.js";

describe("SERVER_ONLY_TABLES", () => {
  it("names every table deliberately excluded from replication", () => {
    expect([...SERVER_ONLY_TABLES].sort()).toEqual(
      [
        "feedback_events",
        "flashcards",
        "ingest_inbox",
        "integrations",
        "memory_revisions",
        "note_chunks",
        "usage_ledger",
      ].sort(),
    );
  });

  it("shares no table with SYNC_TABLES", () => {
    const synced = new Set<string>(SYNC_TABLES);
    for (const t of SERVER_ONLY_TABLES) {
      expect(synced.has(t), `${t} is in both lists`).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/shared -- sync.test
```

Expected: FAIL — `SERVER_ONLY_TABLES` is not exported.

- [ ] **Step 3: Add the list**

In `packages/shared/src/dto/sync.ts`, beside `SYNC_TABLES`:

```ts
/**
 * Tables deliberately absent from the PowerSync sync rules and from the `powersync`
 * publication. The omission is load-bearing -- `integrations` holds credentials that must
 * never reach a device, and the rest are server-side machinery -- so it is asserted rather
 * than trusted: packages/db's sync-rules isolation suite and packages/sync's schema suite
 * both read this list.
 *
 * ONE copy. Two hand-maintained copies existed until 2026-08-10, which is the same
 * parallel-list trap phase 1b's Task 22 fixed for the media status vocabulary.
 */
export const SERVER_ONLY_TABLES = [
  "note_chunks",
  "usage_ledger",
  "integrations",
  "feedback_events",
  "memory_revisions",
  "ingest_inbox",
  "flashcards",
] as const;
```

- [ ] **Step 4: Repoint both consumers**

`packages/db/src/test/sync-rules-isolation.test.ts` — replace the inline array at lines 197-204:

```ts
  it("names no server-only table anywhere", () => {
    for (const t of SERVER_ONLY_TABLES) {
      expect(directives, `server-only table in a sync rule: ${t}`).not.toContain(t);
    }
  });
```

with `import { SERVER_ONLY_TABLES } from "@cortex/shared";` at the top.

`packages/sync/src/schema.test.ts` — replace the `forbidden` array at lines 13-16:

```ts
  it("never declares a server-only table", () => {
    for (const t of SERVER_ONLY_TABLES) expect(tableNames()).not.toContain(t);
  });
```

and add `SERVER_ONLY_TABLES` to the existing `@cortex/shared` import on line 2.

- [ ] **Step 5: Run all three suites**

```bash
pnpm turbo run test --filter=@cortex/shared --filter=@cortex/sync
pnpm turbo run test --filter=@cortex/db -- sync-rules-isolation
```

Expected: PASS everywhere, same assertions as before.

- [ ] **Step 6: Mutation-check the hoist**

Temporarily delete `"integrations"` from `SERVER_ONLY_TABLES` and re-run. The shared suite must fail on the exact-list assertion. Restore it. This proves the list is load-bearing rather than decorative — the same discipline phase 1b applied after finding seven tests that could not fail.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/dto/sync.ts packages/shared/src/dto/sync.test.ts \
        packages/db/src/test/sync-rules-isolation.test.ts packages/sync/src/schema.test.ts
git commit -m "$(cat <<'EOF'
refactor(shared): one copy of the server-only table list, not two

packages/db's isolation suite and packages/sync's schema suite each carried the
same seven names by hand. The next task adds an eighth (note_enrichment), and a
hand-written parallel list is the trap phase 1b's Task 22 fixed for media
statuses. Hoisted to @cortex/shared beside SYNC_TABLES; both suites now read it.

Verified load-bearing by deleting a name and watching the exact-list assertion
fail.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `note_enrichment` and the claim function

**Files:**
- Create: `supabase/migrations/00018_note_enrichment.sql`
- Create: `packages/db/src/test/note-enrichment.test.ts`
- Modify: `packages/shared/src/dto/sync.ts` (append to `SERVER_ONLY_TABLES`)
- Modify: `packages/shared/src/dto/sync.test.ts` (the exact-list assertion)
- Modify: `packages/sync/src/sync-rules.yaml` (header comment only)

**Interfaces:**
- Produces: table `public.note_enrichment`; function `public.claim_notes_for_enrichment(p_limit int)` returning `table(note_id uuid, user_id uuid, content_text text, content_hash text)`. Tasks 10, 11 and 13 consume it.

**The predicate is the whole task.** It keys on `md5(content_text)`, not on `enriched_at < updated_at`. `notes` carries a `moddatetime` trigger firing on every UPDATE, so the timestamp form (a) re-satisfies itself the moment enrichment writes, looping forever, and (b) bills a full re-embed plus a model call every time a note is merely pinned or archived.

- [ ] **Step 1: Write the failing tests**

Create `packages/db/src/test/note-enrichment.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients";

const claim = async (limit = 50) => {
  const { data, error } = await admin.rpc("claim_notes_for_enrichment", { p_limit: limit });
  if (error) throw error;
  return data as { note_id: string; user_id: string; content_text: string; content_hash: string }[];
};

/** The sweep ignores anything edited in the last 90s, so fixtures must be backdated. */
const backdate = (id: string) =>
  admin.from("notes").update({ updated_at: new Date(Date.now() - 300_000).toISOString() }).eq("id", id);

describe("claim_notes_for_enrichment", () => {
  let userId: string;

  beforeAll(async () => {
    ({ id: userId } = await makeUser("enrich-claim@example.com"));
    await admin.from("notes").delete().eq("user_id", userId);
  });

  it("claims a note that has never been enriched", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "a fresh thought" }).select("id").single();
    await backdate(data!.id);

    const claimed = await claim();
    expect(claimed.map((r) => r.note_id)).toContain(data!.id);
  });

  it("does not claim a note edited within the debounce window", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "still typing" }).select("id").single();
    // deliberately NOT backdated
    const claimed = await claim();
    expect(claimed.map((r) => r.note_id)).not.toContain(data!.id);
  });

  // THE COST REGRESSION. A timestamp predicate claims this note and bills an embed plus a
  // model call for a change that touched no text.
  it("does not claim a note that was only pinned", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "unchanged body" }).select("id").single();
    // Mark both steps done for the CURRENT text.
    const md5 = await admin.rpc("_test_md5_content_text", { p_note_id: data!.id });
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId,
      embedded_hash: md5.data, extracted_hash: md5.data,
    });
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).not.toContain(data!.id);

    // Pinning bumps updated_at via the moddatetime trigger, and must change nothing here.
    await admin.from("notes").update({ pinned: true }).eq("id", data!.id);
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).not.toContain(data!.id);
  });

  it("claims again when the text actually changes", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "version one" }).select("id").single();
    const md5 = await admin.rpc("_test_md5_content_text", { p_note_id: data!.id });
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId, embedded_hash: md5.data, extracted_hash: md5.data,
    });
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).not.toContain(data!.id);

    await admin.from("notes").update({ content: "version two" }).eq("id", data!.id);
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).toContain(data!.id);
  });

  it("stops claiming a note that has failed five times", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "poison" }).select("id").single();
    await admin.from("note_enrichment").insert({
      note_id: data!.id, user_id: userId, attempts: 5, last_error: "boom",
    });
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).not.toContain(data!.id);
  });

  it("does not claim a trashed note", async () => {
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "gone", deleted_at: new Date().toISOString() })
      .select("id").single();
    await backdate(data!.id);
    expect((await claim()).map((r) => r.note_id)).not.toContain(data!.id);
  });

  it("is invisible to an authenticated client", async () => {
    const { client } = await makeUser("enrich-rls@example.com");
    const { data, error } = await client.from("note_enrichment").select("note_id");
    expect(data ?? []).toEqual([]);
    expect(error === null || error.code === "42501").toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx supabase start
pnpm turbo run test --filter=@cortex/db -- note-enrichment
```

Expected: FAIL — relation `note_enrichment` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00018_note_enrichment.sql`:

```sql
-- ============ note_enrichment (SERVER-ONLY: the sweep's bookkeeping) ============
--
-- Deliberately NOT columns on `notes`. `notes` is client-writable: PowerSync uploads PATCHes
-- against it and the sync router's generic writer upserts {...op.data, id, user_id}, so a
-- modified client could PATCH a hash and pin its own note out of the pipeline forever, or
-- into it forever. That is the shape of phase 1b's round-2 finding #1, which 00017 closes for
-- child-row ownership.
--
-- `notes.enriched_at` stays where it is and keeps its own job: the client-visible "pending
-- enrichment" flag (design spec §8.2). It is the only thing about enrichment a device sees.
create table public.note_enrichment (
  note_id uuid primary key references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- md5(content_text) at the last success of each step. TWO hashes, because the steps commit
  -- independently: if extraction fails the embedding work is already durable, and the next
  -- sweep re-runs only the step still missing (parent spec §9, "per-step idempotency").
  -- The box (stage C) stamps extracted_hash synchronously; the sweep stamps embedded_hash.
  embedded_hash text,
  extracted_hash text,
  attempts int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
create index note_enrichment_user_idx on public.note_enrichment (user_id);
alter table public.note_enrichment enable row level security;  -- no policies: server-only
create trigger note_enrichment_set_updated_at before update on public.note_enrichment
  for each row execute function extensions.moddatetime(updated_at);

-- No grant to `authenticated`: PostgREST needs a table-level GRANT before RLS is even
-- evaluated, so the missing grant is a second, independent layer (see 00009).
grant select, insert, update, delete on public.note_enrichment to service_role;

-- ============ The sweep ============
--
-- Keyed on md5(content_text), NOT on `enriched_at < updated_at`. `notes_set_updated_at`
-- (00002) fires moddatetime on EVERY update, so a timestamp predicate:
--   1. re-satisfies itself the moment enrichment writes -- a loop that re-enriches every note
--      every sweep, forever; and
--   2. bills a full re-embed plus a model call when a note is merely pinned or archived.
-- The hash form is also what makes an edit arriving DURING enrichment safe: each step records
-- the hash of the text it actually read, so a note edited mid-job ends with a hash that no
-- longer matches and the next sweep takes it. A timestamp form writing now() would mark that
-- edit as already done and drop it silently.
create or replace function public.claim_notes_for_enrichment(p_limit int)
returns table (note_id uuid, user_id uuid, content_text text, content_hash text)
language sql
security definer
set search_path = public
as $$
  select n.id, n.user_id, n.content_text, md5(n.content_text)
  from public.notes n
  left join public.note_enrichment e on e.note_id = n.id
  where n.deleted_at is null
    and n.updated_at < now() - interval '90 seconds'
    and coalesce(e.attempts, 0) < 5
    and (e.embedded_hash  is distinct from md5(n.content_text)
      or e.extracted_hash is distinct from md5(n.content_text))
  order by n.updated_at asc
  limit p_limit
  for update of n skip locked;
$$;
revoke execute on function public.claim_notes_for_enrichment(int) from public;
grant execute on function public.claim_notes_for_enrichment(int) to service_role;

-- ============ Test-support helper (service_role only) ============
-- Fourth of the narrow SECURITY DEFINER readers 00001 describes. packages/db's tests reach
-- Postgres only through PostgREST, so md5() over a GENERATED column is otherwise
-- unobservable -- a test would have to reimplement strip_markdown() in TypeScript to predict
-- it, which would assert the reimplementation rather than the column.
create or replace function public._test_md5_content_text(p_note_id uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select md5(content_text) from public.notes where id = p_note_id;
$$;
revoke execute on function public._test_md5_content_text(uuid) from public;
grant execute on function public._test_md5_content_text(uuid) to service_role;
```

- [ ] **Step 4: Apply and run**

```bash
npx supabase db reset
pnpm turbo run test --filter=@cortex/db -- note-enrichment
```

Expected: PASS, 7 cases.

**If `AuthRetryableFetchError` appears**, that is stale Docker DNS after a reset, not a code fault: `docker restart supabase_kong_cortex`, then re-run.

- [ ] **Step 5: Add the table to the server-only list**

`packages/shared/src/dto/sync.ts` — append `"note_enrichment"` to `SERVER_ONLY_TABLES`, and add it to the expected array in `packages/shared/src/dto/sync.test.ts`.

`packages/sync/src/sync-rules.yaml` — the header comment lists the server-only tables because "absent by omission is load-bearing". Update that sentence:

```
# Server-only tables are absent by omission, which is load-bearing: integrations holds
# credentials that must never reach a device, and note_chunks/note_enrichment/usage_ledger/
# feedback_events/memory_revisions/ingest_inbox are server-side machinery.
```

- [ ] **Step 6: Run the suites that guard the omission**

```bash
pnpm turbo run test --filter=@cortex/shared --filter=@cortex/sync
pnpm turbo run test --filter=@cortex/db -- sync-rules-isolation
```

Expected: PASS. The publication assertion still finds exactly six replicated tables — `00016` scopes it by name, so a new table is not added automatically and no PowerSync redeploy is needed.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/00018_note_enrichment.sql packages/db/src/test/note-enrichment.test.ts \
        packages/shared/src/dto/sync.ts packages/shared/src/dto/sync.test.ts packages/sync/src/sync-rules.yaml
git commit -m "$(cat <<'EOF'
feat(db): note_enrichment, and a sweep that keys on content rather than clocks

The obvious predicate, enriched_at < updated_at, is wrong twice: notes carries a
moddatetime trigger on every UPDATE, so writing enriched_at re-satisfies the
predicate (a loop re-enriching every note forever), and pinning or archiving a
note bills a full re-embed plus a model call for text that did not change. The
md5(content_text) form closes both, and makes an edit arriving mid-job safe.

Bookkeeping is a server-only table, not columns on notes: notes is
client-writable and the router's generic writer upserts {...op.data}, so a
modified client could pin its own note out of the pipeline. Same shape as
round-2 finding #1.

The "only pinned" case is a real regression test, red against a timestamp
predicate.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: The `note_tags` feedback trigger

**Files:**
- Create: `supabase/migrations/00019_note_tags_feedback.sql`
- Create: `packages/db/src/test/note-tags-feedback.test.ts`

**Interfaces:**
- Produces: trigger `note_tags_feedback` on `public.note_tags`. Nothing in TypeScript consumes it; that is the point.

**Why a trigger.** Accepting a suggestion reaches `note_tags` on at least three paths — web writes directly through supabase-js (`apps/web/src/app/notes/[id]/page.tsx:24` reads it that way, `packages/core/src/organize/service.ts:63,76` writes it), mobile writes locally and uploads through `POST /sync/upload`, and phase 9 adds MCP. If a client owns the write, any path that forgets loses the signal permanently, and the parent spec wants it accumulating from day one so phase 8 starts with months of it. This does not contradict parent §9's "why not DB-trigger-driven": that is about where job *enqueueing* lives, while deriving an audit row from a status transition is bookkeeping, the same category as `moddatetime`.

- [ ] **Step 1: Write the failing tests**

Create `packages/db/src/test/note-tags-feedback.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, makeUser } from "./clients";

describe("note_tags -> feedback_events", () => {
  let userId: string;
  let client: SupabaseClient;
  let noteId: string;

  beforeAll(async () => {
    ({ id: userId, client } = await makeUser("tag-feedback@example.com"));
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "body" }).select("id").single();
    noteId = data!.id;
  });

  const suggest = async (tagName: string) => {
    const { data: tag } = await admin.from("tags")
      .insert({ user_id: userId, name: tagName }).select("id").single();
    const { data: link } = await admin.from("note_tags")
      .insert({ user_id: userId, note_id: noteId, tag_id: tag!.id, source: "ai", status: "suggested", confidence: 0.7 })
      .select("id").single();
    return link!.id as string;
  };

  const events = async (subjectId: string) =>
    (await admin.from("feedback_events").select("*").eq("subject_id", subjectId)).data ?? [];

  it("records an accept", async () => {
    const id = await suggest("accept-me");
    await admin.from("note_tags").update({ status: "accepted" }).eq("id", id);
    const rows = await events(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: userId, subject_type: "tag", action: "accept" });
  });

  it("records a reject", async () => {
    const id = await suggest("reject-me");
    await admin.from("note_tags").update({ status: "rejected" }).eq("id", id);
    expect(await events(id)).toMatchObject([{ action: "reject" }]);
  });

  // The property that matters: no client path can skip it. Web writes note_tags through
  // PostgREST with the user's own JWT, never through the API.
  it("fires for a direct PostgREST update by the user", async () => {
    const id = await suggest("web-path");
    const { error } = await client.from("note_tags").update({ status: "accepted" }).eq("id", id);
    expect(error).toBeNull();
    expect(await events(id)).toMatchObject([{ action: "accept" }]);
  });

  it("does not fire when a suggestion is merely re-saved", async () => {
    const id = await suggest("noop");
    await admin.from("note_tags").update({ confidence: 0.9 }).eq("id", id);
    expect(await events(id)).toHaveLength(0);
  });

  it("does not fire twice when an accepted tag is updated again", async () => {
    const id = await suggest("once");
    await admin.from("note_tags").update({ status: "accepted" }).eq("id", id);
    await admin.from("note_tags").update({ status: "accepted" }).eq("id", id);
    expect(await events(id)).toHaveLength(1);
  });

  it("does not fire for a user-created tag that was never suggested", async () => {
    const { data: tag } = await admin.from("tags")
      .insert({ user_id: userId, name: "manual" }).select("id").single();
    const { data: link } = await admin.from("note_tags")
      .insert({ user_id: userId, note_id: noteId, tag_id: tag!.id, source: "user", status: "accepted" })
      .select("id").single();
    expect(await events(link!.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/db -- note-tags-feedback
```

Expected: FAIL — every `events()` call returns `[]`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00019_note_tags_feedback.sql`:

```sql
-- Derives a feedback_events row from a note_tags status transition.
--
-- A TRIGGER rather than application code, because accepting a suggestion reaches this table
-- on at least three paths -- web writes it directly through PostgREST, mobile writes locally
-- and uploads through POST /sync/upload, and phase 9 adds MCP -- and a path that forgets
-- loses the signal permanently. The parent spec wants this accumulating from day one so the
-- phase-8 memory layer starts with months of it.
--
-- This does NOT contradict parent §9's "why not DB-trigger-driven", which is about where job
-- ENQUEUEING lives. Deriving an audit row from a status transition is bookkeeping, the same
-- category as moddatetime.
--
-- Consequence worth stating: mobile suggestion review works OFFLINE. It is a local UPDATE
-- riding sync like everything else, and this fires when the router writes it down.
create or replace function public.note_tags_record_feedback()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.feedback_events (user_id, subject_type, subject_id, action, payload)
  values (
    new.user_id,
    'tag',
    new.id,
    case new.status when 'accepted' then 'accept' else 'reject' end,
    jsonb_build_object('note_id', new.note_id, 'tag_id', new.tag_id, 'confidence', new.confidence)
  );
  return new;
end;
$$;

-- The WHEN clause is the whole guard: only a transition OUT OF 'suggested' INTO a decision
-- counts. Re-saving a suggestion, or updating an already-accepted row, must record nothing --
-- otherwise the signal phase 8 reads is inflated by ordinary writes.
create trigger note_tags_feedback
  after update on public.note_tags
  for each row
  when (old.status = 'suggested' and new.status in ('accepted', 'rejected'))
  execute function public.note_tags_record_feedback();
```

- [ ] **Step 4: Apply and run**

```bash
npx supabase db reset
pnpm turbo run test --filter=@cortex/db -- note-tags-feedback
```

Expected: PASS, 6 cases.

- [ ] **Step 5: Mutation-check the WHEN clause**

Temporarily drop `old.status = 'suggested'` from the trigger's `WHEN`, re-apply, re-run. The "does not fire twice" case must go red. Restore.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00019_note_tags_feedback.sql packages/db/src/test/note-tags-feedback.test.ts
git commit -m "$(cat <<'EOF'
feat(db): feedback_events derives from a note_tags transition, not from a client

Accepting a suggestion reaches note_tags on three paths -- web straight through
PostgREST, mobile through POST /sync/upload, and phase 9's MCP -- and a client
that forgets loses the signal permanently. The parent spec wants it accumulating
from day one so phase 8 starts with months of it, so it goes where no path can
bypass it. It also keeps feedback_events genuinely server-only: clients hold no
DML grant on it.

Tested through a direct PostgREST update as the user, which is the path that
would otherwise be missed, and the WHEN clause mutation-checked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Three new `source_type` values

**Files:**
- Create: `supabase/migrations/00020_note_source_types.sql`
- Modify: `packages/shared/src/enums.ts:28`
- Modify: `packages/shared/src/enums.test.ts`

**Interfaces:**
- Produces: `noteSourceType` widened to include `chat`, `assistant`, `web_search`.

**Why now, in stage A.** `'web_search'` is already required by `2026-08-01-life-domains-web-search-design.md` §6.3 and **was never added** — phase 3 would have hit a check-constraint violation on the first saved answer. `'chat'` and `'assistant'` are stage C's, but the constraint, the enum and `packages/db/src/test/enum-parity.test.ts` must move together, and doing it once is cheaper than twice.

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/enums.test.ts`:

```ts
it("noteSourceType covers capture channels, chat, and saved answers", () => {
  expect(noteSourceType.options).toEqual([
    "quick", "web_clip", "voice", "email", "telegram", "import",
    "chat", "assistant", "web_search",
  ]);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/shared -- enums
```

Expected: FAIL — the array has six entries.

- [ ] **Step 3: Widen the enum**

`packages/shared/src/enums.ts:28`:

```ts
// 'chat'      -- a question you typed into the box. Stored as a note so "what was I
//                researching last month" works through search_notes with no second store.
// 'assistant' -- an answer you chose to save. Down-weighted in retrieval (see search_notes)
//                and cited as something you saved, never as your own thinking.
// 'web_search'-- the same, for an answer carrying web citations. Required by the
//                life-domains spec §6.3 since 2026-08-01 and never added until now.
export const noteSourceType = z.enum([
  "quick", "web_clip", "voice", "email", "telegram", "import",
  "chat", "assistant", "web_search",
]);
```

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/00020_note_source_types.sql`:

```sql
-- packages/db's enum-parity test reads notes_source_type_check out of pg_constraint and
-- asserts it matches @cortex/shared's noteSourceType exactly, so these two move together or
-- the suite fails. See the header of packages/shared/src/enums.ts.
alter table public.notes drop constraint notes_source_type_check;
alter table public.notes add constraint notes_source_type_check
  check (source_type in (
    'quick', 'web_clip', 'voice', 'email', 'telegram', 'import',
    'chat', 'assistant', 'web_search'
  ));
```

- [ ] **Step 5: Apply and run both suites**

```bash
npx supabase db reset
pnpm turbo run test --filter=@cortex/shared -- enums
pnpm turbo run test --filter=@cortex/db -- enum-parity
```

Expected: PASS both. The parity suite is what proves the two sides agree.

- [ ] **Step 6: Mutation-check the parity test**

Add `'bogus'` to the enum only, re-run `enum-parity`. It must fail. Remove it.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/00020_note_source_types.sql packages/shared/src/enums.ts packages/shared/src/enums.test.ts
git commit -m "$(cat <<'EOF'
feat(db,shared): source_type gains chat, assistant and web_search

'web_search' has been required by the life-domains spec §6.3 since 2026-08-01
and no migration ever added it -- phase 3 would have hit a check-constraint
violation on the first saved answer. 'chat' and 'assistant' are stage C's, but
the constraint, the enum and the parity test move together, so once is cheaper
than twice.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: A service-role Supabase client

**Files:**
- Modify: `packages/core/src/supabase.ts`
- Create: `packages/core/src/supabase.test.ts`

**Interfaces:**
- Produces: `createServiceClient(): SupabaseClient`. Tasks 10-13 and 15 consume it.

**Context.** This is the first code in the repo that bypasses RLS. `createUserClient`'s comment states the standing rule — "RLS is the enforcement, no service-role key on this path" — and it still holds for every user-facing path. The exception exists because `note_chunks` and `note_enrichment` have RLS enabled with **no policies**, so they are invisible to `authenticated` by design.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/supabase.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createServiceClient } from "./supabase.js";

describe("createServiceClient", () => {
  it("reads note_enrichment, which authenticated cannot see at all", async () => {
    const client = createServiceClient();
    const { error } = await client.from("note_enrichment").select("note_id").limit(1);
    expect(error).toBeNull();
  });

  it("throws a named error when the key is absent, rather than building a broken client", () => {
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      expect(() => createServiceClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
    }
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core -- supabase
```

Expected: FAIL — `createServiceClient` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/supabase.ts`:

```ts
/**
 * BYPASSES RLS. The only legitimate callers are the enrichment pipeline and the search RPC,
 * both of which read note_chunks / note_enrichment -- tables with RLS enabled and NO policies,
 * invisible to `authenticated` by design.
 *
 * Every user-facing path keeps createUserClient above, where RLS is the enforcement and the
 * server is not trusted with a service key (spec §8.2). When this client is used on behalf of
 * a user, the user id MUST come from the verified JWT and never from a request body -- with
 * RLS out of the picture, that parameter is the only thing separating two users' corpora.
 */
export function createServiceClient(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(process.env.SUPABASE_URL!, key, { auth: { persistSession: false } });
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/core -- supabase
```

Expected: PASS, 2 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supabase.ts packages/core/src/supabase.test.ts
git commit -m "$(cat <<'EOF'
feat(core): a service-role client, confined to the tables RLS deliberately hides

The first code in this repo that bypasses RLS. It exists because note_chunks and
note_enrichment have RLS enabled with no policies, so `authenticated` cannot see
them at all -- which is the design, not an oversight. Every user-facing path
keeps createUserClient and keeps RLS as the enforcement.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: The chunker

**Files:**
- Create: `packages/shared/src/enrich/chunk.ts`
- Create: `packages/shared/src/enrich/chunk.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `chunkText(text: string, opts?: { maxChars?: number }): { index: number; content: string }[]`, and `CHUNK_MAX_CHARS = 1800`. Task 10 consumes it.

**Why it lives in `@cortex/shared` and not `@cortex/core`.** It is pure and dependency-free, so its suite runs in the stack-free CI job with no Docker — and stage C's client may want to show a chunk count without pulling in core's barrel, which reaches `archiver` through `export/service.ts`.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/enrich/chunk.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chunkText, CHUNK_MAX_CHARS } from "./chunk.js";

describe("chunkText", () => {
  it("returns nothing for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps a short note as one chunk — the common case for quick capture", () => {
    expect(chunkText("a single thought")).toEqual([{ index: 0, content: "a single thought" }]);
  });

  it("splits on blank lines rather than mid-sentence", () => {
    const a = "x".repeat(1000);
    const b = "y".repeat(1000);
    const chunks = chunkText(`${a}\n\n${b}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe(a);
    expect(chunks[1].content).toBe(b);
  });

  it("packs several short paragraphs into one chunk", () => {
    const chunks = chunkText("one\n\ntwo\n\nthree");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("one\n\ntwo\n\nthree");
  });

  it("splits a single oversized paragraph, because it cannot be packed whole", () => {
    const chunks = chunkText("z".repeat(CHUNK_MAX_CHARS * 2 + 10));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it("numbers chunks from zero without gaps — note_chunks has unique(note_id, chunk_index)", () => {
    const chunks = chunkText(Array.from({ length: 12 }, () => "p".repeat(500)).join("\n\n"));
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("is deterministic", () => {
    const text = "alpha\n\nbeta\n\n" + "g".repeat(2500);
    expect(chunkText(text)).toEqual(chunkText(text));
  });

  it("normalises CRLF, so a Windows-authored note chunks like any other", () => {
    expect(chunkText("one\r\n\r\ntwo")).toEqual(chunkText("one\n\ntwo"));
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/shared -- chunk
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/shared/src/enrich/chunk.ts`:

```ts
/**
 * Splits a note's content_text for embedding.
 *
 * Deliberately paragraph-based and character-budgeted rather than token-based: a tokenizer
 * would be a dependency in a package that has none, and the budget only needs to keep a chunk
 * comfortably inside the embedding model's input limit. Determinism matters more than
 * precision here, because note_chunks.content_hash is what lets the pipeline skip re-embedding
 * an unchanged chunk.
 */
export const CHUNK_MAX_CHARS = 1800;

export function chunkText(
  text: string,
  opts: { maxChars?: number } = {},
): { index: number; content: string }[] {
  const maxChars = opts.maxChars ?? CHUNK_MAX_CHARS;
  // A CRLF checkout would otherwise produce different chunks -- and different hashes -- for
  // the same note. This repo warns "LF will be replaced by CRLF" on every commit, and
  // phase 1b's sync-rules assertions were red on Windows for exactly this reason.
  const normalised = text.replace(/\r\n/g, "\n").trim();
  if (normalised === "") return [];

  const paragraphs = normalised.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== "");
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current !== "") out.push(current);
    current = "";
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // Cannot be packed whole. Emit what is buffered, then hard-split this one.
      flush();
      for (let i = 0; i < para.length; i += maxChars) out.push(para.slice(i, i + maxChars));
      continue;
    }
    const candidate = current === "" ? para : `${current}\n\n${para}`;
    if (candidate.length > maxChars) {
      flush();
      current = para;
    } else {
      current = candidate;
    }
  }
  flush();

  return out.map((content, index) => ({ index, content }));
}
```

- [ ] **Step 4: Export it**

`packages/shared/src/index.ts`:

```ts
export * from "./enrich/chunk.js";
```

- [ ] **Step 5: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/shared -- chunk
```

Expected: PASS, 8 cases.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/enrich/ packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): a pure, deterministic chunker

Paragraph-based with a character budget rather than token-based: a tokenizer
would be the only dependency in a package that has none, and determinism matters
more than precision here because content_hash is what lets the pipeline skip
re-embedding an unchanged chunk.

Normalises CRLF, without which the same note chunks differently on a Windows
checkout and every hash differs -- the failure phase 1b hit in
sync-rules-isolation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: The AI client interface, a fake, and the Gemini implementation

**Files:**
- Create: `packages/core/src/ai/client.ts`
- Create: `packages/core/src/ai/fake.ts`
- Create: `packages/core/src/ai/gemini.ts`
- Create: `packages/core/src/ai/fake.test.ts`
- Modify: `packages/shared/src/enums.ts` (model constants)
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EmbedResult { vectors: number[][]; inputTokens: number; model: string }
  export interface JsonResult<T> { value: T; inputTokens: number; outputTokens: number; model: string }
  export interface AiClient {
    embed(texts: string[]): Promise<EmbedResult>;
    generateJson<T>(args: { prompt: string; schema: Record<string, unknown> }): Promise<JsonResult<T>>;
  }
  export function createFakeAi(script?: Partial<AiClient>): AiClient;
  export function createGeminiAi(apiKey: string): AiClient;
  ```
  Tasks 10, 11, 12 and 13 consume `AiClient` and `createFakeAi`.

**Model ids.** The life-domains spec §1 names *families* — "Gemini 3 Flash" — which do not resolve as API ids. Verified against Gemini docs on 2026-08-10: `gemini-embedding-001` is current, and the economical high-volume classification model is `gemini-3.5-flash-lite`. Both are pinned in `@cortex/shared` beside `EMBEDDING_MODEL`, and `usage_ledger` records the model per row so a price change edits a constant without rewriting history.

- [ ] **Step 1: Add the model and price constants**

`packages/shared/src/enums.ts`, below `EMBEDDING_MODEL`:

```ts
// The life-domains spec §1 assigns workloads by model FAMILY ("Gemini 3 Flash"), which is not
// an API id. These are the ids, verified against ai.google.dev/gemini-api/docs/models on
// 2026-08-10. Prices are USD per million tokens; usage_ledger records the model with every
// row, so changing a price here never rewrites history.
export const CLASSIFY_MODEL = "gemini-3.5-flash-lite";
export const MODEL_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gemini-embedding-001": { input: 0.15, output: 0 },
  "gemini-3.5-flash-lite": { input: 0.1, output: 0.4 },
};
```

> **Confirm both prices against the live pricing page before committing** and correct them if they have moved. A wrong constant here makes every `usage_ledger` row and the budget gate wrong in the same direction.

- [ ] **Step 2: Write the failing test for the fake**

Create `packages/core/src/ai/fake.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeAi } from "./fake.js";
import { EMBEDDING_DIM } from "@cortex/shared";

describe("createFakeAi", () => {
  it("returns one vector of the real width per input", async () => {
    const ai = createFakeAi();
    const { vectors, model } = await ai.embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIM);
    expect(model).toBe("fake-embed");
  });

  it("is deterministic, so a test can assert on similarity", async () => {
    const ai = createFakeAi();
    const [first] = (await ai.embed(["same text"])).vectors;
    const [second] = (await ai.embed(["same text"])).vectors;
    expect(first).toEqual(second);
  });

  it("gives different texts different vectors", async () => {
    const ai = createFakeAi();
    const { vectors } = await ai.embed(["alpha", "beta"]);
    expect(vectors[0]).not.toEqual(vectors[1]);
  });

  it("lets a test script generateJson", async () => {
    const ai = createFakeAi({
      generateJson: async () => ({ value: { tags: ["x"] }, inputTokens: 1, outputTokens: 1, model: "fake" }),
    });
    const out = await ai.generateJson<{ tags: string[] }>({ prompt: "p", schema: {} });
    expect(out.value.tags).toEqual(["x"]);
  });

  it("throws by default on generateJson, so an unscripted call is a loud test failure", async () => {
    await expect(createFakeAi().generateJson({ prompt: "p", schema: {} })).rejects.toThrow(/not scripted/i);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core -- ai/fake
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the interface and the fake**

Create `packages/core/src/ai/client.ts`:

```ts
export interface EmbedResult {
  vectors: number[][];
  inputTokens: number;
  model: string;
}

export interface JsonResult<T> {
  value: T;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Parent spec §4 item 1: keep the embedding client behind an interface so the provider can be
 * swapped. The provider has already changed once (Voyage -> Gemini, 00012), which is why this
 * is an interface rather than a module of functions.
 */
export interface AiClient {
  embed(texts: string[]): Promise<EmbedResult>;
  generateJson<T>(args: { prompt: string; schema: Record<string, unknown> }): Promise<JsonResult<T>>;
}
```

Create `packages/core/src/ai/fake.ts`:

```ts
import { EMBEDDING_DIM } from "@cortex/shared";
import type { AiClient } from "./client.js";

/** FNV-1a: a tiny, stable string hash. Only needs to be deterministic, not good. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * NO TEST MAY EVER CALL THE REAL GEMINI API. Every suite in this repo uses this fake --
 * a live call in CI would cost money, need a paid key on a runner, and make results depend on
 * a third party's uptime.
 *
 * Vectors are deterministic and text-dependent, so a test can assert that two similar inputs
 * rank above a dissimilar one without any real model.
 */
export function createFakeAi(script: Partial<AiClient> = {}): AiClient {
  return {
    embed:
      script.embed ??
      (async (texts: string[]) => {
        const vectors = texts.map((t) => {
          let s = seedOf(t);
          return Array.from({ length: EMBEDDING_DIM }, () => {
            s = (Math.imul(s, 1103515245) + 12345) >>> 0;
            return s / 0xffffffff - 0.5;
          });
        });
        return { vectors, inputTokens: texts.join(" ").length, model: "fake-embed" };
      }),
    generateJson:
      script.generateJson ??
      (async () => {
        throw new Error("createFakeAi: generateJson was called but not scripted for this test");
      }),
  };
}
```

- [ ] **Step 5: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/core -- ai/fake
```

Expected: PASS, 5 cases.

- [ ] **Step 6: Write the Gemini implementation**

Create `packages/core/src/ai/gemini.ts`. It has **no unit test of its own** — its only untested surface is HTTP shape, and a mocked-fetch test would assert the mock. It is exercised for real once, by hand, in Step 7.

```ts
import { CLASSIFY_MODEL, EMBEDDING_DIM, EMBEDDING_MODEL } from "@cortex/shared";
import type { AiClient, EmbedResult, JsonResult } from "./client.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export function createGeminiAi(apiKey: string): AiClient {
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Status is carried in the message so the caller can distinguish a 429/5xx (retry) from
      // a 400 (a bug in our request, which retrying will never fix). No prompt text is
      // logged -- spec §15.6 rule 1.
      throw new Error(`gemini ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    async embed(texts: string[]): Promise<EmbedResult> {
      const json = await post(`models/${EMBEDDING_MODEL}:batchEmbedContents`, {
        requests: texts.map((text) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          // MRL truncation to the width 00012 sized the column for. Omitting this returns the
          // full 3072-dim vector, which pgvector rejects against a vector(1536) column.
          outputDimensionality: EMBEDDING_DIM,
        })),
      });
      const embeddings = (json.embeddings ?? []) as { values: number[] }[];
      return {
        vectors: embeddings.map((e) => e.values),
        inputTokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
        model: EMBEDDING_MODEL,
      };
    },

    async generateJson<T>(args: { prompt: string; schema: Record<string, unknown> }): Promise<JsonResult<T>> {
      const json = await post(`models/${CLASSIFY_MODEL}:generateContent`, {
        contents: [{ role: "user", parts: [{ text: args.prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: args.schema,
          temperature: 0,
        },
      });
      const candidates = (json.candidates ?? []) as {
        content?: { parts?: { text?: string }[] };
      }[];
      const text = candidates[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string") throw new Error("gemini: no text in response");
      const usage = (json.usageMetadata ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number };
      return {
        // A malformed body must throw, not degrade to a default: the caller records this as a
        // failed step and the sweep retries it. Silently returning {} would mark the note
        // enriched with nothing attached.
        value: JSON.parse(text) as T,
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        model: CLASSIFY_MODEL,
      };
    },
  };
}
```

Export both from `packages/core/src/index.ts`.

- [ ] **Step 7: Exercise the real client once, by hand**

Not a committed test. Confirms the request shape, the model ids and the embedding width against the live API.

```bash
cd apps/api && node --env-file=.env -e "
const { createGeminiAi } = require('@cortex/core');
(async () => {
  const ai = createGeminiAi(process.env.GEMINI_API_KEY);
  const e = await ai.embed(['hello world']);
  console.log('dims', e.vectors[0].length, 'model', e.model);
  const j = await ai.generateJson({
    prompt: 'Return {\"ok\":true}.',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  });
  console.log('json', j.value, 'model', j.model);
})();
"
```

Expected: `dims 1536`, and a parsed `{ ok: true }`. **If `dims` is not 1536, stop** — `outputDimensionality` is not being honoured and every insert into `note_chunks.embedding` will fail against the `vector(1536)` column.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/ai/ packages/core/src/index.ts packages/shared/src/enums.ts
git commit -m "$(cat <<'EOF'
feat(core): AiClient behind an interface, a deterministic fake, and Gemini

The provider has already changed once (Voyage -> Gemini, 00012), which is why
this is an interface rather than a module of functions.

The fake produces deterministic, text-dependent vectors of the real width, so a
test can assert relative similarity with no live call -- and generateJson throws
unless a test scripts it, making an unscripted call a loud failure rather than a
silent default. No suite in this repo may reach the real API.

Model ids pinned in @cortex/shared: the life-domains spec names families
("Gemini 3 Flash"), which do not resolve. Embedding width verified as 1536
against the live API -- without outputDimensionality Gemini returns 3072 and
every note_chunks insert would fail.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: The embed step

**Files:**
- Create: `packages/core/src/enrich/embed.ts`
- Create: `packages/core/src/enrich/embed.test.ts`

**Interfaces:**
- Consumes: `chunkText` (Task 8), `AiClient` (Task 9), `createServiceClient` (Task 7), `claim_notes_for_enrichment` (Task 4).
- Produces: `embedNote(deps: { db: SupabaseClient; ai: AiClient }, note: { noteId: string; userId: string; contentText: string; contentHash: string }): Promise<{ embedded: number; reused: number }>`. Task 13 consumes it.

**The property that matters:** editing paragraph three must not re-embed paragraphs one, two and four. `note_chunks.content_hash` is what makes that possible, and it is why the chunker had to be deterministic.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/enrich/embed.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAi } from "../ai/fake.js";
import { createServiceClient } from "../supabase.js";
import { embedNote } from "./embed.js";

const db = createServiceClient();
let userId: string;
let noteId: string;

async function seedNote(content: string): Promise<{ noteId: string; contentText: string; contentHash: string }> {
  const { data } = await db.from("notes").insert({ user_id: userId, content }).select("id, content_text").single();
  const { data: hash } = await db.rpc("_test_md5_content_text", { p_note_id: data!.id });
  return { noteId: data!.id, contentText: data!.content_text, contentHash: hash as string };
}

describe("embedNote", () => {
  beforeEach(async () => {
    const { data } = await db.auth.admin.createUser({
      email: `embed-${Date.now()}@example.com`, password: "x".repeat(16), email_confirm: true,
    });
    userId = data.user!.id;
  });

  it("writes one chunk row per chunk, with the embedding and the model", async () => {
    const note = await seedNote("first paragraph\n\nsecond paragraph");
    const out = await embedNote({ db, ai: createFakeAi() }, { ...note, userId });

    expect(out).toEqual({ embedded: 1, reused: 0 });
    const { data } = await db.from("note_chunks").select("chunk_index, content_hash, embedding, embedding_model, embedded_at")
      .eq("note_id", note.noteId).order("chunk_index");
    expect(data).toHaveLength(1);
    expect(data![0].embedding).not.toBeNull();
    expect(data![0].embedded_at).not.toBeNull();
  });

  // THE COST PROPERTY.
  it("re-embeds only the changed chunk", async () => {
    const long = (c: string) => c.repeat(1500);
    const note = await seedNote(`${long("a")}\n\n${long("b")}\n\n${long("c")}`);
    const ai = createFakeAi();
    await embedNote({ db, ai }, { ...note, userId });

    const spy = vi.fn(ai.embed);
    await db.from("notes").update({ content: `${long("a")}\n\n${long("B")}\n\n${long("c")}` }).eq("id", note.noteId);
    const { data: updated } = await db.from("notes").select("content_text").eq("id", note.noteId).single();
    const { data: hash } = await db.rpc("_test_md5_content_text", { p_note_id: note.noteId });

    const out = await embedNote(
      { db, ai: { ...ai, embed: spy } },
      { noteId: note.noteId, userId, contentText: updated!.content_text, contentHash: hash as string },
    );

    expect(out).toEqual({ embedded: 1, reused: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toHaveLength(1);
  });

  it("deletes chunks that fall off the end when a note is shortened", async () => {
    const long = (c: string) => c.repeat(1500);
    const note = await seedNote(`${long("a")}\n\n${long("b")}\n\n${long("c")}`);
    await embedNote({ db, ai: createFakeAi() }, { ...note, userId });

    await db.from("notes").update({ content: long("a") }).eq("id", note.noteId);
    const { data: updated } = await db.from("notes").select("content_text").eq("id", note.noteId).single();
    const { data: hash } = await db.rpc("_test_md5_content_text", { p_note_id: note.noteId });
    await embedNote({ db, ai: createFakeAi() }, { noteId: note.noteId, userId, contentText: updated!.content_text, contentHash: hash as string });

    const { data } = await db.from("note_chunks").select("chunk_index").eq("note_id", note.noteId);
    expect(data).toHaveLength(1);
  });

  it("stamps embedded_hash so the sweep stops claiming the note for this step", async () => {
    const note = await seedNote("body");
    await embedNote({ db, ai: createFakeAi() }, { ...note, userId });
    const { data } = await db.from("note_enrichment").select("embedded_hash").eq("note_id", note.noteId).single();
    expect(data!.embedded_hash).toBe(note.contentHash);
  });

  it("is a no-op on a second run", async () => {
    const note = await seedNote("stable text");
    const ai = createFakeAi();
    await embedNote({ db, ai }, { ...note, userId });
    const spy = vi.fn(ai.embed);
    const out = await embedNote({ db, ai: { ...ai, embed: spy } }, { ...note, userId });
    expect(out).toEqual({ embedded: 0, reused: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("writes an empty note's hash without calling the model", async () => {
    const note = await seedNote("");
    const spy = vi.fn(createFakeAi().embed);
    const out = await embedNote({ db, ai: { ...createFakeAi(), embed: spy } }, { ...note, userId });
    expect(out).toEqual({ embedded: 0, reused: 0 });
    expect(spy).not.toHaveBeenCalled();
    const { data } = await db.from("note_enrichment").select("embedded_hash").eq("note_id", note.noteId).single();
    expect(data!.embedded_hash).toBe(note.contentHash);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core -- enrich/embed
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/enrich/embed.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkText, EMBEDDING_MODEL } from "@cortex/shared";
import { createHash } from "node:crypto";
import type { AiClient } from "../ai/client.js";
import { recordUsage } from "./budget.js";

export interface EnrichTarget {
  noteId: string;
  userId: string;
  contentText: string;
  contentHash: string;
}

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

/**
 * Chunks, embeds only what changed, and stamps note_enrichment.embedded_hash.
 *
 * Editing one paragraph of a long note must not re-embed the others; note_chunks.content_hash
 * is what makes that possible, and it is why the chunker is deterministic. Rows are matched by
 * chunk_index (note_chunks has unique(note_id, chunk_index)), so a chunk that merely moved
 * position is re-embedded -- accepted, because tracking moves would need a content-addressed
 * key and the saving is small for the note sizes this system sees.
 */
export async function embedNote(
  deps: { db: SupabaseClient; ai: AiClient },
  note: EnrichTarget,
): Promise<{ embedded: number; reused: number }> {
  const { db, ai } = deps;
  const chunks = chunkText(note.contentText);

  const { data: existingRows, error: readErr } = await db
    .from("note_chunks")
    .select("chunk_index, content_hash")
    .eq("note_id", note.noteId);
  if (readErr) throw readErr;
  const existing = new Map((existingRows ?? []).map((r) => [r.chunk_index as number, r.content_hash as string]));

  const stale = chunks.filter((c) => existing.get(c.index) !== md5(c.content));
  const reused = chunks.length - stale.length;

  if (stale.length > 0) {
    const { vectors, inputTokens, model } = await ai.embed(stale.map((c) => c.content));
    const now = new Date().toISOString();
    const rows = stale.map((c, i) => ({
      user_id: note.userId,
      note_id: note.noteId,
      chunk_index: c.index,
      content: c.content,
      content_hash: md5(c.content),
      token_count: Math.ceil(c.content.length / 4),
      embedding: vectors[i],
      embedding_model: EMBEDDING_MODEL,
      embedded_at: now,
    }));
    const { error } = await db.from("note_chunks").upsert(rows, { onConflict: "note_id,chunk_index" });
    if (error) throw error;
    await recordUsage(db, { userId: note.userId, kind: "embed", model, inputTokens, outputTokens: 0 });
  }

  // A shortened note leaves orphans behind, and an orphan chunk keeps matching searches by
  // text the note no longer contains -- the same failure the phase 1b FTS trigger had to fix.
  const { error: pruneErr } = await db
    .from("note_chunks")
    .delete()
    .eq("note_id", note.noteId)
    .gte("chunk_index", chunks.length);
  if (pruneErr) throw pruneErr;

  const { error: markErr } = await db
    .from("note_enrichment")
    .upsert(
      { note_id: note.noteId, user_id: note.userId, embedded_hash: note.contentHash },
      { onConflict: "note_id" },
    );
  if (markErr) throw markErr;

  return { embedded: stale.length, reused };
}
```

- [ ] **Step 4: Run and watch it pass**

Task 12 supplies `recordUsage`; if executing strictly in order, stub it as a no-op export in `budget.ts` now and let Task 12 fill it in with its own tests.

```bash
pnpm turbo run test --filter=@cortex/core -- enrich/embed
```

Expected: PASS, 6 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/enrich/embed.ts packages/core/src/enrich/embed.test.ts
git commit -m "$(cat <<'EOF'
feat(core): embed only the chunks whose text changed

Editing paragraph three must not re-embed one, two and four -- note_chunks
.content_hash is what makes that possible, and it is why the chunker had to be
deterministic. Tested with a spy asserting the model saw exactly one chunk.

A shortened note's orphan chunks are deleted, not left: an orphan keeps matching
searches by text the note no longer contains, the same failure phase 1b's FTS
insert trigger had to fix.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: The extract step

**Files:**
- Create: `packages/core/src/enrich/extract.ts`
- Create: `packages/core/src/enrich/extract.test.ts`

**Interfaces:**
- Consumes: `AiClient` (Task 9), `domainMetaSchemas` and `noteDomain` from `@cortex/shared`.
- Produces: `extractNote(deps: { db: SupabaseClient; ai: AiClient }, note: EnrichTarget): Promise<{ tags: number; domain: string | null }>`. Task 13 consumes it.

**Three rules the tests pin:**

1. **Reuse an existing tag whose name differs only by case.** Otherwise "Pricing" and "pricing" become two tags — the vocabulary drift the whole design exists to prevent. This is the `findOrCreate` precedent phase 1b established for media items.
2. **At most one not-yet-existing tag per run.**
3. **Never re-suggest a tag already attached to this note in any status**, which is what makes a rejection stick.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/enrich/extract.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeAi } from "../ai/fake.js";
import { createServiceClient } from "../supabase.js";
import { extractNote } from "./extract.js";

const db = createServiceClient();
let userId: string;

const aiReturning = (value: unknown) =>
  createFakeAi({
    generateJson: async () => ({ value, inputTokens: 10, outputTokens: 5, model: "fake-classify" }),
  });

async function seedNote(content: string) {
  const { data } = await db.from("notes").insert({ user_id: userId, content }).select("id, content_text").single();
  const { data: hash } = await db.rpc("_test_md5_content_text", { p_note_id: data!.id });
  return { noteId: data!.id, userId, contentText: data!.content_text, contentHash: hash as string };
}

const tagsOn = async (noteId: string) => {
  const { data } = await db.from("note_tags")
    .select("status, source, confidence, tags(name)").eq("note_id", noteId);
  return (data ?? []) as unknown as { status: string; source: string; confidence: number; tags: { name: string } }[];
};

describe("extractNote", () => {
  beforeEach(async () => {
    const { data } = await db.auth.admin.createUser({
      email: `extract-${Date.now()}@example.com`, password: "x".repeat(16), email_confirm: true,
    });
    userId = data.user!.id;
  });

  it("attaches suggested tags with source 'ai' and the model's confidence", async () => {
    const note = await seedNote("thoughts on pricing psychology");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [{ name: "pricing", confidence: 0.8 }] });
    const out = await extractNote({ db, ai }, note);

    expect(out.tags).toBe(1);
    expect(await tagsOn(note.noteId)).toMatchObject([
      { status: "suggested", source: "ai", confidence: 0.8, tags: { name: "pricing" } },
    ]);
  });

  // RULE 1 — the vocabulary-drift guard.
  it("reuses an existing tag that differs only by case", async () => {
    const { data: existing } = await db.from("tags").insert({ user_id: userId, name: "pricing" }).select("id").single();
    const note = await seedNote("more on pricing");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [{ name: "Pricing", confidence: 0.9 }] });
    await extractNote({ db, ai }, note);

    const { data: allTags } = await db.from("tags").select("id, name").eq("user_id", userId);
    expect(allTags).toHaveLength(1);
    const { data: links } = await db.from("note_tags").select("tag_id").eq("note_id", note.noteId);
    expect(links![0].tag_id).toBe(existing!.id);
  });

  // RULE 2.
  it("creates at most one new tag per run, preferring the highest confidence", async () => {
    await db.from("tags").insert({ user_id: userId, name: "known" });
    const note = await seedNote("body");
    const ai = aiReturning({
      domain: null, domain_meta: {},
      tags: [
        { name: "known", confidence: 0.9 },
        { name: "brand-new-a", confidence: 0.5 },
        { name: "brand-new-b", confidence: 0.8 },
      ],
    });
    await extractNote({ db, ai }, note);

    const names = (await tagsOn(note.noteId)).map((t) => t.tags.name).sort();
    expect(names).toEqual(["brand-new-b", "known"]);
  });

  // RULE 3 — what makes a rejection stick.
  it("does not re-suggest a tag the user already rejected on this note", async () => {
    const { data: tag } = await db.from("tags").insert({ user_id: userId, name: "nope" }).select("id").single();
    const note = await seedNote("body");
    await db.from("note_tags").insert({
      user_id: userId, note_id: note.noteId, tag_id: tag!.id, source: "ai", status: "rejected",
    });

    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [{ name: "nope", confidence: 0.99 }] });
    await extractNote({ db, ai }, note);

    const rows = await tagsOn(note.noteId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected");
  });

  it("suggests a domain and validated domain_meta", async () => {
    const note = await seedNote("ran 5km, felt heavy");
    const ai = aiReturning({
      domain: "health", domain_meta: { activity_type: "run", duration_min: 30 }, tags: [],
    });
    await extractNote({ db, ai }, note);

    const { data } = await db.from("notes").select("domain, domain_meta, enriched_at").eq("id", note.noteId).single();
    expect(data!.domain).toBe("health");
    expect(data!.domain_meta).toMatchObject({ activity_type: "run", duration_min: 30 });
    expect(data!.enriched_at).not.toBeNull();
  });

  it("drops domain_meta that fails the domain's schema rather than writing it", async () => {
    const note = await seedNote("ran 5km");
    const ai = aiReturning({ domain: "health", domain_meta: { duration_min: "half an hour" }, tags: [] });
    await extractNote({ db, ai }, note);

    const { data } = await db.from("notes").select("domain, domain_meta").eq("id", note.noteId).single();
    expect(data!.domain).toBe("health");
    expect(data!.domain_meta).toEqual({});
  });

  it("never overwrites a domain the user set by hand", async () => {
    const note = await seedNote("body");
    await db.from("notes").update({ domain: "finance" }).eq("id", note.noteId);
    const ai = aiReturning({ domain: "health", domain_meta: {}, tags: [] });
    await extractNote({ db, ai }, note);

    const { data } = await db.from("notes").select("domain").eq("id", note.noteId).single();
    expect(data!.domain).toBe("finance");
  });

  it("rejects an unknown domain instead of writing one the CHECK constraint refuses", async () => {
    const note = await seedNote("body");
    const ai = aiReturning({ domain: "astrology", domain_meta: {}, tags: [] });
    await extractNote({ db, ai }, note);

    const { data } = await db.from("notes").select("domain").eq("id", note.noteId).single();
    expect(data!.domain).toBeNull();
  });

  it("stamps extracted_hash", async () => {
    const note = await seedNote("body");
    await extractNote({ db, ai: aiReturning({ domain: null, domain_meta: {}, tags: [] }) }, note);
    const { data } = await db.from("note_enrichment").select("extracted_hash").eq("note_id", note.noteId).single();
    expect(data!.extracted_hash).toBe(note.contentHash);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core -- enrich/extract
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/enrich/extract.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { domainMetaSchemas, noteDomain } from "@cortex/shared";
import type { AiClient } from "../ai/client.js";
import type { EnrichTarget } from "./embed.js";
import { recordUsage } from "./budget.js";

interface Extraction {
  domain: string | null;
  domain_meta: Record<string, unknown>;
  tags: { name: string; confidence: number }[];
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    domain: { type: "string", nullable: true, enum: [...noteDomain.options] },
    domain_meta: { type: "object" },
    tags: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, confidence: { type: "number" } },
        required: ["name", "confidence"],
      },
    },
  },
  required: ["domain", "domain_meta", "tags"],
};

function buildPrompt(contentText: string, vocabulary: string[]): string {
  return [
    "You organise one person's personal notes. Return JSON only.",
    "",
    "Their existing tags, which you must REUSE when one fits:",
    vocabulary.length > 0 ? vocabulary.join(", ") : "(none yet)",
    "",
    "Rules:",
    "- Prefer an existing tag over inventing one. Match on meaning, not spelling.",
    "- Propose at most ONE tag that is not in the list above.",
    "- 3 to 5 tags total. Lowercase, hyphenated, no '#'.",
    "- domain must be one of: " + noteDomain.options.join(", ") + ", or null when none fits.",
    "- domain_meta holds only what the text actually states. Omit anything you are guessing.",
    "",
    "The note:",
    contentText,
  ].join("\n");
}

/**
 * Suggests a domain, fills domain_meta, and attaches tags -- all `suggested`, never applied.
 * The life-domains spec §2 is explicit that freeform text is the source of truth and structure
 * is extracted afterwards, never required at capture.
 */
export async function extractNote(
  deps: { db: SupabaseClient; ai: AiClient },
  note: EnrichTarget,
): Promise<{ tags: number; domain: string | null }> {
  const { db, ai } = deps;

  const { data: tagRows, error: tagErr } = await db.from("tags").select("id, name").eq("user_id", note.userId);
  if (tagErr) throw tagErr;
  const vocabulary = (tagRows ?? []) as { id: string; name: string }[];
  // Case-insensitive, because "Pricing" and "pricing" must be one tag. This is the
  // findOrCreate precedent phase 1b set for media items.
  const byLowerName = new Map(vocabulary.map((t) => [t.name.toLowerCase(), t]));

  const { value, inputTokens, outputTokens, model } = await ai.generateJson<Extraction>({
    prompt: buildPrompt(note.contentText, vocabulary.map((t) => t.name)),
    schema: RESPONSE_SCHEMA,
  });
  await recordUsage(db, { userId: note.userId, kind: "tag", model, inputTokens, outputTokens });

  // ---- tags ----
  const { data: linkedRows } = await db.from("note_tags").select("tag_id").eq("note_id", note.noteId);
  // Any status counts, including 'rejected'. That is what makes a rejection stick: reject sets
  // status rather than deleting the row precisely so this lookup can see it.
  const alreadyLinked = new Set((linkedRows ?? []).map((r) => r.tag_id as string));

  const proposed = (value.tags ?? []).filter((t) => typeof t.name === "string" && t.name.trim() !== "");
  const existingHits = proposed.filter((t) => byLowerName.has(t.name.trim().toLowerCase()));
  const novel = proposed
    .filter((t) => !byLowerName.has(t.name.trim().toLowerCase()))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 1); // at most one new tag per run

  let attached = 0;
  for (const candidate of [...existingHits, ...novel]) {
    const name = candidate.name.trim().toLowerCase();
    let tagId = byLowerName.get(name)?.id;
    if (!tagId) {
      const { data: created, error } = await db.from("tags")
        .insert({ user_id: note.userId, name }).select("id").single();
      if (error) throw error;
      tagId = created!.id as string;
      byLowerName.set(name, { id: tagId, name });
    }
    if (alreadyLinked.has(tagId)) continue;

    const { error } = await db.from("note_tags").insert({
      user_id: note.userId, note_id: note.noteId, tag_id: tagId,
      source: "ai", status: "suggested", confidence: candidate.confidence,
    });
    if (error) throw error;
    attached += 1;
  }

  // ---- domain + meta ----
  const { data: current } = await db.from("notes").select("domain").eq("id", note.noteId).single();
  const parsedDomain = noteDomain.safeParse(value.domain);
  // A domain the user set by hand outranks a suggestion; and a value outside the enum must
  // never be written, or the CHECK constraint fails the whole update.
  const domain = current?.domain ?? (parsedDomain.success ? parsedDomain.data : null);

  let meta: Record<string, unknown> = {};
  if (domain) {
    const schema = domainMetaSchemas[domain as keyof typeof domainMetaSchemas];
    const parsedMeta = schema?.safeParse(value.domain_meta ?? {});
    // Dropped rather than written raw: domain_meta is jsonb and unconstrained at the database
    // level, so an invalid shape stored here surfaces much later as a validation failure the
    // user cannot explain.
    meta = parsedMeta?.success ? (parsedMeta.data as Record<string, unknown>) : {};
  }

  const { error: noteErr } = await db.from("notes")
    .update({ domain, domain_meta: meta, enriched_at: new Date().toISOString() })
    .eq("id", note.noteId)
    .is("deleted_at", null); // a note trashed mid-job must not be written back to life
  if (noteErr) throw noteErr;

  const { error: markErr } = await db.from("note_enrichment").upsert(
    { note_id: note.noteId, user_id: note.userId, extracted_hash: note.contentHash },
    { onConflict: "note_id" },
  );
  if (markErr) throw markErr;

  return { tags: attached, domain };
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/core -- enrich/extract
```

Expected: PASS, 9 cases.

- [ ] **Step 5: Mutation-check the three rules**

Each mutation must fail exactly its own test and nothing else:

| Mutation | Must fail |
| --- | --- |
| Drop `.toLowerCase()` from the `byLowerName` key | "reuses an existing tag that differs only by case" |
| Change `.slice(0, 1)` to `.slice(0, 5)` | "creates at most one new tag per run" |
| Filter `alreadyLinked` to `status === 'accepted'` only | "does not re-suggest a tag the user already rejected" |

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/enrich/extract.ts packages/core/src/enrich/extract.test.ts
git commit -m "$(cat <<'EOF'
feat(core): extract domain, domain_meta and tags -- all suggested, never applied

Three rules, each mutation-checked. Case-insensitive tag reuse, or "Pricing" and
"pricing" become two tags -- the drift the whole design exists to stop, and the
findOrCreate precedent phase 1b set for media items. At most one new tag per
run. And no tag already on the note in ANY status is re-suggested, which is what
makes a rejection stick: reject sets status rather than deleting, precisely so
this lookup can see it.

A hand-set domain outranks a suggestion, a domain outside the enum is never
written (the CHECK would fail the whole update), and domain_meta failing its
zod schema is dropped rather than stored -- unconstrained jsonb would surface
the bad shape much later as an unexplainable validation failure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Usage ledger and the budget gate

**Files:**
- Create/replace: `packages/core/src/enrich/budget.ts`
- Create: `packages/core/src/enrich/budget.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function recordUsage(db: SupabaseClient, u: { userId: string; kind: "embed" | "tag"; model: string; inputTokens: number; outputTokens: number }): Promise<void>;
  export async function monthToDateUsd(db: SupabaseClient, userId: string): Promise<number>;
  export async function isOverBudget(db: SupabaseClient, userId: string, limitUsd: number): Promise<boolean>;
  export function assertTierAllowsRealData(tier: "free" | "paid", supabaseUrl: string): void;
  ```
  Tasks 10, 11 and 13 consume them.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/enrich/budget.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createServiceClient } from "../supabase.js";
import { assertTierAllowsRealData, isOverBudget, monthToDateUsd, recordUsage } from "./budget.js";

const db = createServiceClient();
let userId: string;

describe("usage and budget", () => {
  beforeEach(async () => {
    const { data } = await db.auth.admin.createUser({
      email: `budget-${Date.now()}@example.com`, password: "x".repeat(16), email_confirm: true,
    });
    userId = data.user!.id;
  });

  it("prices a call from the model's constants and stores the model with it", async () => {
    await recordUsage(db, {
      userId, kind: "tag", model: "gemini-3.5-flash-lite", inputTokens: 1_000_000, outputTokens: 1_000_000,
    });
    const { data } = await db.from("usage_ledger").select("*").eq("user_id", userId).single();
    expect(data!.model).toBe("gemini-3.5-flash-lite");
    expect(Number(data!.cost_usd)).toBeCloseTo(0.5, 6); // 0.10 in + 0.40 out
  });

  it("sums only this user's rows", async () => {
    const { data: other } = await db.auth.admin.createUser({
      email: `budget-other-${Date.now()}@example.com`, password: "x".repeat(16), email_confirm: true,
    });
    await recordUsage(db, { userId, kind: "embed", model: "gemini-embedding-001", inputTokens: 1_000_000, outputTokens: 0 });
    await recordUsage(db, { userId: other.user!.id, kind: "embed", model: "gemini-embedding-001", inputTokens: 10_000_000, outputTokens: 0 });
    expect(await monthToDateUsd(db, userId)).toBeCloseTo(0.15, 6);
  });

  it("ignores rows from a previous month", async () => {
    await recordUsage(db, { userId, kind: "embed", model: "gemini-embedding-001", inputTokens: 1_000_000, outputTokens: 0 });
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    await db.from("usage_ledger").update({ created_at: lastMonth.toISOString() }).eq("user_id", userId);
    expect(await monthToDateUsd(db, userId)).toBe(0);
  });

  it("reports over budget only once the limit is passed", async () => {
    expect(await isOverBudget(db, userId, 1)).toBe(false);
    await recordUsage(db, { userId, kind: "tag", model: "gemini-3.5-flash-lite", inputTokens: 20_000_000, outputTokens: 0 });
    expect(await isOverBudget(db, userId, 1)).toBe(true);
  });

  it("prices an unknown model at zero rather than throwing, so a model swap cannot wedge the pipeline", async () => {
    await recordUsage(db, { userId, kind: "tag", model: "gemini-99-future", inputTokens: 1000, outputTokens: 1000 });
    const { data } = await db.from("usage_ledger").select("cost_usd").eq("user_id", userId).single();
    expect(Number(data!.cost_usd)).toBe(0);
  });

  describe("assertTierAllowsRealData", () => {
    it("allows a free key against a local stack", () => {
      expect(() => assertTierAllowsRealData("free", "http://127.0.0.1:54321")).not.toThrow();
    });
    it("allows a paid key anywhere", () => {
      expect(() => assertTierAllowsRealData("paid", "https://wilssluxogpdrbgffmzc.supabase.co")).not.toThrow();
    });
    // §15.6 rule 2, made enforceable instead of documented.
    it("refuses a free key against hosted data", () => {
      expect(() => assertTierAllowsRealData("free", "https://wilssluxogpdrbgffmzc.supabase.co"))
        .toThrow(/paid tier/i);
    });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core -- enrich/budget
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Replace `packages/core/src/enrich/budget.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { MODEL_PRICES_USD_PER_MTOK } from "@cortex/shared";

export function priceUsd(model: string, inputTokens: number, outputTokens: number): number {
  // An unknown model prices at zero rather than throwing: swapping a model id must never wedge
  // the whole pipeline, and a zero row is visible in the ledger as an obvious anomaly.
  const p = MODEL_PRICES_USD_PER_MTOK[model];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export async function recordUsage(
  db: SupabaseClient,
  u: { userId: string; kind: "embed" | "tag"; model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  const { error } = await db.from("usage_ledger").insert({
    user_id: u.userId,
    kind: u.kind,
    model: u.model,
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cost_usd: priceUsd(u.model, u.inputTokens, u.outputTokens),
  });
  if (error) throw error;
}

export async function monthToDateUsd(db: SupabaseClient, userId: string): Promise<number> {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await db.from("usage_ledger")
    .select("cost_usd").eq("user_id", userId).gte("created_at", since);
  if (error) throw error;
  return (data ?? []).reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
}

export async function isOverBudget(db: SupabaseClient, userId: string, limitUsd: number): Promise<boolean> {
  return (await monthToDateUsd(db, userId)) > limitUsd;
}

/**
 * Parent spec §15.6 rule 2 -- "paid AI tier only, verified before phase 2 ships" -- made
 * enforceable rather than documented.
 *
 * Google's API terms: free-tier content is used to "provide, improve, and develop Google
 * products", human reviewers may read inputs and outputs, and the terms themselves say not to
 * submit sensitive or personal information to the unpaid services. Cortex carries mood, health
 * and finance notes. A free key stays legitimate against a local stack full of seed data,
 * which is the only case this allows.
 */
export function assertTierAllowsRealData(tier: "free" | "paid", supabaseUrl: string): void {
  if (tier === "paid") return;
  const host = new URL(supabaseUrl).hostname;
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return;
  throw new Error(
    "GEMINI_TIER=free may not process hosted data: free-tier prompts are used for training " +
      "and may be read by human reviewers, and this database holds mood, health and finance " +
      "notes. Set GEMINI_TIER=paid (spec §15.6 rule 2).",
  );
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/core -- enrich/budget
```

Expected: PASS, 8 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/enrich/budget.ts packages/core/src/enrich/budget.test.ts
git commit -m "$(cat <<'EOF'
feat(core): usage ledger, a month-to-date budget, and an enforceable tier rule

§15.6 rule 2 said "paid AI tier only, verified before phase 2 ships". It is now
code: a free key against a non-local SUPABASE_URL refuses to run, which leaves
free keys usable for local development against seed data and nowhere else.
Google's terms are explicit that free-tier prompts train models and may be read
by humans, and this database holds mood, health and finance notes.

An unknown model prices at zero rather than throwing -- a model swap must never
wedge the pipeline, and a zero row stands out in the ledger.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Wire the sweep, and ship stage A

**Files:**
- Create: `apps/api/src/enrich/enrich.service.ts`
- Create: `apps/api/src/enrich/enrich.module.ts`
- Create: `apps/api/test/enrich.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/main.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-12.
- Produces: a running cron. Nothing else consumes it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/enrich.e2e.test.ts`. It drives `runSweep` directly rather than waiting on the cron — a test that sleeps for a scheduler is slow and flaky, and the schedule itself is one line asserted in Step 5.

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createFakeAi, createServiceClient } from "@cortex/core";
import { runSweep } from "../src/enrich/enrich.service";

const db = createServiceClient();
let userId: string;

const ai = createFakeAi({
  generateJson: async () => ({
    value: { domain: "health", domain_meta: { activity_type: "run" }, tags: [{ name: "running", confidence: 0.9 }] },
    inputTokens: 10, outputTokens: 5, model: "fake-classify",
  }),
});

describe("runSweep", () => {
  beforeAll(async () => {
    const { data } = await db.auth.admin.createUser({
      email: `sweep-${Date.now()}@example.com`, password: "x".repeat(16), email_confirm: true,
    });
    userId = data.user!.id;
  });

  const seedBackdated = async (content: string) => {
    const { data } = await db.from("notes").insert({ user_id: userId, content }).select("id").single();
    await db.from("notes")
      .update({ updated_at: new Date(Date.now() - 300_000).toISOString() })
      .eq("id", data!.id);
    return data!.id as string;
  };

  it("embeds and extracts a claimed note, and does nothing on a second run", async () => {
    const noteId = await seedBackdated("ran 5km this morning");

    const first = await runSweep({ db, ai, budgetUsd: 100, limit: 10 });
    expect(first.processed).toBe(1);

    const { data: chunks } = await db.from("note_chunks").select("id").eq("note_id", noteId);
    expect(chunks!.length).toBeGreaterThan(0);
    const { data: note } = await db.from("notes").select("domain, enriched_at").eq("id", noteId).single();
    expect(note!.domain).toBe("health");
    expect(note!.enriched_at).not.toBeNull();

    const second = await runSweep({ db, ai, budgetUsd: 100, limit: 10 });
    expect(second.processed).toBe(0);
  });

  it("records the failure and stops after five attempts rather than retrying forever", async () => {
    const noteId = await seedBackdated("this one always fails");
    const failing = createFakeAi({
      generateJson: async () => { throw new Error("gemini 500"); },
    });

    for (let i = 0; i < 6; i++) {
      await runSweep({ db, ai: failing, budgetUsd: 100, limit: 10 });
      await db.from("notes").update({ updated_at: new Date(Date.now() - 300_000).toISOString() }).eq("id", noteId);
    }

    const { data } = await db.from("note_enrichment").select("attempts, last_error").eq("note_id", noteId).single();
    expect(data!.attempts).toBe(5);
    expect(data!.last_error).toMatch(/gemini 500/);
  });

  it("claims nothing when the user is over budget", async () => {
    await seedBackdated("would be enriched if there were money");
    const out = await runSweep({ db, ai, budgetUsd: 0.0000001, limit: 10 });
    expect(out.processed).toBe(0);
    expect(out.skippedOverBudget).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/api -- enrich.e2e
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sweep**

Create `apps/api/src/enrich/enrich.service.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type AiClient, embedNote, extractNote, isOverBudget,
} from "@cortex/core";

export interface SweepDeps {
  db: SupabaseClient;
  ai: AiClient;
  budgetUsd: number;
  limit: number;
}

export interface SweepResult {
  processed: number;
  failed: number;
  skippedOverBudget: number;
}

/**
 * Claims eligible notes and runs the two steps.
 *
 * The claim predicate lives in SQL (00018) rather than here, and nothing enqueues from a
 * controller. That is deliberate: notes arrive by two write paths today (POST /notes and
 * POST /sync/upload) with four more in phase 4, and phase 1b missed the second write path
 * three times -- 9f7088d, 445139d, 867d3b1. A sweep's source of truth is the notes table, so
 * there is no path for it to miss.
 */
export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const { db, ai, budgetUsd, limit } = deps;
  const { data, error } = await db.rpc("claim_notes_for_enrichment", { p_limit: limit });
  if (error) throw error;

  const claimed = (data ?? []) as {
    note_id: string; user_id: string; content_text: string; content_hash: string;
  }[];

  const result: SweepResult = { processed: 0, failed: 0, skippedOverBudget: 0 };
  const budgetChecked = new Map<string, boolean>();

  for (const row of claimed) {
    let over = budgetChecked.get(row.user_id);
    if (over === undefined) {
      over = await isOverBudget(db, row.user_id, budgetUsd);
      budgetChecked.set(row.user_id, over);
    }
    if (over) {
      result.skippedOverBudget += 1;
      continue;
    }

    const note = {
      noteId: row.note_id, userId: row.user_id,
      contentText: row.content_text, contentHash: row.content_hash,
    };
    try {
      // Two independent steps, each skipping itself when its own hash already matches. If
      // extraction throws, the embedding work above it is already committed.
      await embedNote({ db, ai }, note);
      await extractNote({ db, ai }, note);
      await db.from("note_enrichment")
        .update({ attempts: 0, last_error: null }).eq("note_id", row.note_id);
      result.processed += 1;
    } catch (err) {
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Never log note text (§15.6 rule 1) -- the id and the message only.
      console.error(`[enrich] note ${row.note_id} failed: ${message}`);
      const { data: existing } = await db.from("note_enrichment")
        .select("attempts").eq("note_id", row.note_id).maybeSingle();
      await db.from("note_enrichment").upsert(
        {
          note_id: row.note_id, user_id: row.user_id,
          attempts: (existing?.attempts ?? 0) + 1,
          last_error: message.slice(0, 500),
        },
        { onConflict: "note_id" },
      );
    }
  }

  if (result.skippedOverBudget > 0) {
    // Logged deliberately: a sweep that silently stops forever is indistinguishable from a bug.
    console.warn(`[enrich] ${result.skippedOverBudget} note(s) skipped -- monthly budget exceeded`);
  }
  return result;
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/api -- enrich.e2e
```

Expected: PASS, 3 cases.

- [ ] **Step 5: Register the cron**

Create `apps/api/src/enrich/enrich.module.ts`:

```ts
import { Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import PgBoss from "pg-boss";
import { createGeminiAi, createServiceClient, assertTierAllowsRealData } from "@cortex/core";
import { createBoss, startBoss, stopBoss } from "../queue/boss";
import { parseApiEnv } from "../env";
import { runSweep } from "./enrich.service";

const QUEUE = "enrich.sweep";

@Module({})
export class EnrichModule implements OnModuleInit, OnApplicationShutdown {
  private boss?: PgBoss;

  async onModuleInit(): Promise<void> {
    const env = parseApiEnv(process.env);
    // Refuses to start rather than processing hosted data on a free key (§15.6 rule 2).
    assertTierAllowsRealData(env.GEMINI_TIER, env.SUPABASE_URL);

    this.boss = createBoss(env.DATABASE_URL);
    await startBoss(this.boss);
    await this.boss.createQueue(QUEUE);

    const deps = {
      db: createServiceClient(),
      ai: createGeminiAi(env.GEMINI_API_KEY),
      budgetUsd: env.ENRICH_MONTHLY_BUDGET_USD,
      limit: 20,
    };
    await this.boss.work(QUEUE, async () => { await runSweep(deps); });
    // Every 60s. Singleton by queue name, so a slow sweep does not stack behind itself.
    await this.boss.schedule(QUEUE, "* * * * *");
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.boss) await stopBoss(this.boss);
  }
}
```

Register `EnrichModule` in `apps/api/src/app.module.ts`'s `imports`. `main.ts` already calls `app.enableShutdownHooks()` (line 45), which is what makes `onApplicationShutdown` fire on Railway's SIGTERM — no change needed there.

- [ ] **Step 6: Run the full gate**

```bash
pnpm turbo run typecheck lint test --force
```

Expected: every package successful, and the `Cached:` line reading `0 cached`. A cached run is not evidence.

- [ ] **Step 7: Commit and open the stage-A PR**

```bash
git add apps/api/src/enrich/ apps/api/src/app.module.ts apps/api/test/enrich.e2e.test.ts
git commit -m "$(cat <<'EOF'
feat(api): the 60-second sweep, and stage A is complete

Nothing enqueues from a controller. Notes arrive by two write paths today and
four more in phase 4, and phase 1b missed the second write path three times
(9f7088d, 445139d, 867d3b1) -- a sweep's source of truth is the notes table, so
there is no path for it to miss.

A failing note stops after five attempts with its error recorded, rather than
being retried forever; and a sweep that skips work because a budget is exhausted
says so, because silent permanent stoppage looks exactly like a bug.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"

git push -u origin feat/phase-2-ai-enrichment
gh pr create --base main --title "Phase 2 stage A: the enrichment pipeline" --body "$(cat <<'EOF'
Chunk, embed, and extract domain/domain_meta/tags — all suggested, never applied.
Design: `docs/superpowers/specs/2026-08-10-phase-2-3-assistant-design.md`.

**This PR is not finished when it merges.** Four Railway variables must be set before
the deployed API can start, and it will now exit at boot without them:

- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
- `GEMINI_TIER=paid`
- `ENRICH_MONTHLY_BUDGET_USD`

`DATABASE_URL` is already set. After deploying, confirm the first sweep ran and that
`pgboss` exists in the hosted database.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 8: After merge — set the variables and watch the first sweep**

```bash
railway variable set GEMINI_TIER=paid --skip-deploys
# the three secrets via --stdin so they are never in shell history
railway logs | grep -i "\[enrich\]\|\[pgboss\]"
```

Expected: no `[pgboss]` errors, and enrichment appearing on notes within two minutes of an edit.

---

# Stage B — retrieval

## Task 14: `search_notes()`

**Files:**
- Create: `supabase/migrations/00021_search_notes.sql`
- Create: `packages/db/src/test/search-notes.test.ts`

**Interfaces:**
- Produces: `public.search_notes(p_user_id uuid, p_query text, p_embedding extensions.vector(1536), p_limit int)` returning `table(note_id uuid, title text, snippet text, score real, matched_by text)`. Task 15 consumes it.

**Reciprocal Rank Fusion**, `score = Σ 1/(k + rank)` with `k = 60`, over two arms: pgvector cosine top-40 on `note_chunks`, and Postgres FTS top-40 on `notes.content_text`. Then two multipliers — recency `exp(-age_days/180)`, and **~0.8 for externally-sourced notes**. The second is built now even though nothing produces such a note until stage C: this function is what stages B, C and phase 9 all call, and retrofitting a multiplier means rewriting it three times.

- [ ] **Step 1: Write the failing tests**

Create `packages/db/src/test/search-notes.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients";

/** A deterministic unit-ish vector; only relative cosine distance matters here. */
const vec = (seed: number) => Array.from({ length: 1536 }, (_, i) => Math.sin(seed * (i + 1)) / 40);

const search = async (userId: string, query: string, embedding: number[], limit = 10) => {
  const { data, error } = await admin.rpc("search_notes", {
    p_user_id: userId, p_query: query, p_embedding: embedding, p_limit: limit,
  });
  if (error) throw error;
  return data as { note_id: string; title: string | null; snippet: string; score: number; matched_by: string }[];
};

async function seed(userId: string, content: string, opts: { embedding?: number[]; sourceType?: string; createdAt?: string } = {}) {
  const { data } = await admin.from("notes").insert({
    user_id: userId, content,
    source_type: opts.sourceType ?? "quick",
    ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
  }).select("id").single();
  if (opts.embedding) {
    await admin.from("note_chunks").insert({
      user_id: userId, note_id: data!.id, chunk_index: 0, content,
      content_hash: "x", embedding: opts.embedding, embedding_model: "test", embedded_at: new Date().toISOString(),
    });
  }
  return data!.id as string;
}

describe("search_notes", () => {
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    ({ id: alice } = await makeUser("search-alice@example.com"));
    ({ id: bob } = await makeUser("search-bob@example.com"));
    await admin.from("notes").delete().in("user_id", [alice, bob]);
  });

  it("finds a note by keyword alone, with no useful embedding", async () => {
    const id = await seed(alice, "the marginal cost of a second cup");
    const rows = await search(alice, "marginal cost", vec(99));
    expect(rows.map((r) => r.note_id)).toContain(id);
    expect(rows.find((r) => r.note_id === id)!.matched_by).toMatch(/fts/);
  });

  // THE DEMO: a note that never contains the query's words.
  it("finds a note by meaning when the words never appear", async () => {
    const target = vec(7);
    const id = await seed(alice, "charging more made people trust it more", { embedding: target });
    await seed(alice, "grocery list: milk, eggs", { embedding: vec(500) });

    const rows = await search(alice, "pricing psychology", target);
    expect(rows[0].note_id).toBe(id);
    expect(rows[0].matched_by).toMatch(/vector/);
  });

  it("marks a note found by both arms", async () => {
    const target = vec(11);
    const id = await seed(alice, "kubernetes ingress notes", { embedding: target });
    const rows = await search(alice, "kubernetes ingress", target);
    expect(rows.find((r) => r.note_id === id)!.matched_by).toBe("both");
  });

  it("ranks a recent note above an old one of equal relevance", async () => {
    const target = vec(21);
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const oldId = await seed(alice, "identical relevance text", { embedding: target, createdAt: old });
    const newId = await seed(alice, "identical relevance text", { embedding: target });
    const rows = await search(alice, "identical relevance text", target);
    const order = rows.map((r) => r.note_id);
    expect(order.indexOf(newId)).toBeLessThan(order.indexOf(oldId));
  });

  // The provenance multiplier. Nothing produces these notes until stage C; the hook is built
  // now because stages B, C and phase 9 all call this function.
  it("ranks a saved assistant answer below the user's own note of equal relevance", async () => {
    const target = vec(31);
    const own = await seed(alice, "duplicate relevance body", { embedding: target });
    const saved = await seed(alice, "duplicate relevance body", { embedding: target, sourceType: "assistant" });
    const rows = await search(alice, "duplicate relevance body", target);
    const order = rows.map((r) => r.note_id);
    expect(order.indexOf(own)).toBeLessThan(order.indexOf(saved));
  });

  it("does not down-weight a chat note, which is the user's own question", async () => {
    const target = vec(41);
    const chat = await seed(alice, "what did I conclude about MCP", { embedding: target, sourceType: "chat" });
    const assistant = await seed(alice, "what did I conclude about MCP", { embedding: target, sourceType: "assistant" });
    const rows = await search(alice, "what did I conclude about MCP", target);
    const order = rows.map((r) => r.note_id);
    expect(order.indexOf(chat)).toBeLessThan(order.indexOf(assistant));
  });

  it("excludes trashed notes", async () => {
    const target = vec(51);
    const id = await seed(alice, "trashed but embedded", { embedding: target });
    await admin.from("notes").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    expect((await search(alice, "trashed but embedded", target)).map((r) => r.note_id)).not.toContain(id);
  });

  // §15.5 and issue-log E3: bob's empty result proves nothing unless ALICE has matching rows.
  it("never returns another user's note, with real rows present for that user", async () => {
    const target = vec(61);
    const aliceNote = await seed(alice, "alice private thinking", { embedding: target });
    const bobNote = await seed(bob, "bob private thinking", { embedding: target });

    const asBob = await search(bob, "private thinking", target);
    expect(asBob.map((r) => r.note_id)).toContain(bobNote);
    expect(asBob.map((r) => r.note_id)).not.toContain(aliceNote);

    const asAlice = await search(alice, "private thinking", target);
    expect(asAlice.map((r) => r.note_id)).toContain(aliceNote);
    expect(asAlice.map((r) => r.note_id)).not.toContain(bobNote);
  });

  it("returns one row per note even when several chunks match", async () => {
    const target = vec(71);
    const { data } = await admin.from("notes")
      .insert({ user_id: alice, content: "multi chunk note" }).select("id").single();
    for (const i of [0, 1, 2]) {
      await admin.from("note_chunks").insert({
        user_id: alice, note_id: data!.id, chunk_index: i, content: `chunk ${i}`,
        content_hash: `h${i}`, embedding: target, embedding_model: "test", embedded_at: new Date().toISOString(),
      });
    }
    const rows = await search(alice, "multi chunk note", target);
    expect(rows.filter((r) => r.note_id === data!.id)).toHaveLength(1);
  });

  it("honours the limit", async () => {
    expect((await search(alice, "the", vec(81), 3)).length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/db -- search-notes
```

Expected: FAIL — function does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00021_search_notes.sql`:

```sql
-- Hybrid retrieval, parent spec §6.8. ONE function, so the API, the assistant (stage C) and
-- phase 9's MCP server all rank identically -- three implementations would drift.
--
-- SECURITY DEFINER and called with service_role, because note_chunks has RLS enabled with NO
-- policies and is invisible to `authenticated` by design. p_user_id is therefore the ONLY
-- thing separating two users' corpora, and callers MUST pass the id from a verified JWT and
-- never from a request body. packages/db's isolation test covers it with real rows for both
-- users -- an assertion that one user reads zero rows is vacuous if the other has none either
-- (§15.5, issue-log E3).
create or replace function public.search_notes(
  p_user_id uuid,
  p_query text,
  p_embedding extensions.vector(1536),
  p_limit int
)
returns table (note_id uuid, title text, snippet text, score real, matched_by text)
language sql
stable
security definer
set search_path = public
as $$
  with vector_arm as (
    select c.note_id,
           row_number() over (order by c.embedding <=> p_embedding) as rank
    from public.note_chunks c
    join public.notes n on n.id = c.note_id
    where c.user_id = p_user_id
      and n.deleted_at is null
      and c.embedding is not null
    order by c.embedding <=> p_embedding
    limit 40
  ),
  -- One row per note: a long note with three matching chunks must not out-rank a short one
  -- three times over.
  vector_best as (
    select note_id, min(rank) as rank from vector_arm group by note_id
  ),
  fts_arm as (
    select n.id as note_id,
           row_number() over (
             order by ts_rank(to_tsvector('english', n.content_text),
                              websearch_to_tsquery('english', p_query)) desc
           ) as rank
    from public.notes n
    where n.user_id = p_user_id
      and n.deleted_at is null
      and to_tsvector('english', n.content_text) @@ websearch_to_tsquery('english', p_query)
    limit 40
  ),
  fused as (
    select coalesce(v.note_id, f.note_id) as note_id,
           -- Reciprocal Rank Fusion, k = 60. RRF needs no score normalisation between the two
           -- arms, which is the point: cosine distance and ts_rank are not comparable
           -- quantities and any attempt to scale them into each other is a fudge factor.
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + f.rank), 0) as base,
           case
             when v.note_id is not null and f.note_id is not null then 'both'
             when v.note_id is not null then 'vector'
             else 'fts'
           end as matched_by
    from vector_best v
    full outer join fts_arm f on f.note_id = v.note_id
  )
  select n.id,
         n.title,
         left(n.content_text, 240) as snippet,
         (
           fused.base
           -- Recency. tau = 180 days for search (parent §6.8).
           * exp(-extract(epoch from (now() - n.created_at)) / 86400.0 / 180.0)
           -- Provenance. A saved answer is not the user's own thinking, so it ranks below an
           -- own note of equal relevance rather than being hidden (life-domains spec §6.3,
           -- "provenance, not prohibition"). 'chat' is EXCLUDED: a question the user typed is
           -- their own words.
           * case when n.source_type in ('assistant', 'web_search') then 0.8 else 1.0 end
         )::real as score,
         fused.matched_by
  from fused
  join public.notes n on n.id = fused.note_id
  where n.deleted_at is null
  order by score desc
  limit p_limit;
$$;
revoke execute on function public.search_notes(uuid, text, extensions.vector(1536), int) from public;
grant execute on function public.search_notes(uuid, text, extensions.vector(1536), int) to service_role;
```

- [ ] **Step 4: Apply and run**

```bash
npx supabase db reset
pnpm turbo run test --filter=@cortex/db -- search-notes
```

Expected: PASS, 10 cases.

- [ ] **Step 5: Mutation-check the two multipliers and the isolation**

| Mutation | Must fail |
| --- | --- |
| Remove the `exp(...)` recency factor | "ranks a recent note above an old one" |
| Change `0.8` to `1.0` | "ranks a saved assistant answer below the user's own note" |
| Add `'chat'` to the down-weighted list | "does not down-weight a chat note" |
| Drop `c.user_id = p_user_id` from the vector arm | "never returns another user's note" |

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00021_search_notes.sql packages/db/src/test/search-notes.test.ts
git commit -m "$(cat <<'EOF'
feat(db): hybrid search over pgvector and FTS, fused by RRF

One function, because the API, stage C's assistant and phase 9's MCP must rank
identically -- three implementations would drift. RRF needs no normalisation
between the arms, which matters: cosine distance and ts_rank are not comparable
quantities and scaling one into the other is a fudge factor.

The provenance multiplier ships now although nothing produces a saved answer
until stage C. Three callers depend on this function, so retrofitting it later
means rewriting it three times. 'chat' is excluded from the down-weight -- a
question the user typed is their own words.

Cross-user isolation is tested with real rows for BOTH users: "bob reads zero
rows" is vacuous when alice has none either (§15.5, issue-log E3).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: `POST /search`

**Files:**
- Create: `apps/api/src/search.controller.ts`
- Create: `apps/api/test/search.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/shared/src/dto/search.ts` (create), `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `POST /search` taking `{ q: string, limit?: number }`, returning `{ results: { noteId, title, snippet, score, matchedBy }[] }`. Tasks 16 and 17 consume it.

**The security property this task exists to protect:** the user id passed to `search_notes` comes from the verified JWT via the existing `@CurrentUser()` decorator, never from the body. Follow `apps/api/src/notes.controller.ts` for the guard and decorator wiring.

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/test/search.e2e.test.ts`, following the existing pattern in `apps/api/test/notes.e2e.test.ts` and its `harness.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./harness";

describe("POST /search", () => {
  let app: TestApp;

  beforeAll(async () => { app = await makeTestApp(); });

  it("rejects an unauthenticated request", async () => {
    await app.request().post("/search").send({ q: "anything" }).expect(401);
  });

  it("rejects an empty query", async () => {
    await app.request().post("/search").set(app.authHeader).send({ q: "" }).expect(400);
  });

  it("returns the caller's matching notes", async () => {
    await app.seedNote({ content: "the marginal cost of a second cup" });
    const res = await app.request().post("/search").set(app.authHeader).send({ q: "marginal cost" }).expect(201);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0]).toHaveProperty("snippet");
  });

  // The property that matters: a body-supplied user id must be ignored.
  it("ignores a userId in the body and searches only the caller's notes", async () => {
    const other = await app.makeOtherUser();
    await app.seedNoteFor(other.id, { content: "someone else's private thinking" });
    const res = await app.request().post("/search").set(app.authHeader)
      .send({ q: "private thinking", userId: other.id }).expect(201);
    expect(res.body.results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/api -- search.e2e
```

Expected: FAIL — 404 on every route.

- [ ] **Step 3: Add the input schema**

Create `packages/shared/src/dto/search.ts` and export it from the barrel:

```ts
import { z } from "zod";

export const searchInput = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.number().int().positive().max(50).optional(),
}).strict();  // .strict() is what makes a body-supplied userId a 400 rather than ignored silently

export type SearchInput = z.infer<typeof searchInput>;
```

- [ ] **Step 4: Implement the controller**

Create `apps/api/src/search.controller.ts`:

```ts
import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { createGeminiAi, createServiceClient } from "@cortex/core";
import { searchInput, type SearchInput } from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";
import { parseApiEnv } from "./env";

@Controller("search")
@UseGuards(SupabaseAuthGuard)
export class SearchController {
  @Post()
  async search(
    @CurrentUser() user: { id: string },
    @Body(new ZodValidationPipe(searchInput)) body: SearchInput,
  ) {
    const env = parseApiEnv(process.env);
    const ai = createGeminiAi(env.GEMINI_API_KEY);
    const db = createServiceClient();

    const { vectors } = await ai.embed([body.q]);

    // user.id comes from the VERIFIED JWT (SupabaseAuthGuard). search_notes runs as
    // service_role with RLS out of the picture, so this parameter is the only thing separating
    // two users' corpora -- it must never be read from the body. searchInput is .strict(), so
    // a body carrying a userId is a 400 rather than a value that gets quietly dropped.
    const { data, error } = await db.rpc("search_notes", {
      p_user_id: user.id,
      p_query: body.q,
      p_embedding: vectors[0],
      p_limit: body.limit ?? 20,
    });
    if (error) throw error;

    return {
      results: (data ?? []).map((r: Record<string, unknown>) => ({
        noteId: r.note_id,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
        matchedBy: r.matched_by,
      })),
    };
  }
}
```

Register `SearchController` in `apps/api/src/app.module.ts`.

- [ ] **Step 5: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/api -- search.e2e
```

Expected: PASS, 4 cases. The e2e suite must inject the fake AI client rather than reaching Gemini — extend `harness.ts` with an override the same way it already overrides Supabase clients.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/search.controller.ts apps/api/test/search.e2e.test.ts \
        apps/api/src/app.module.ts packages/shared/src/dto/search.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): POST /search, with the user id taken only from the verified JWT

search_notes runs as service_role with RLS out of the picture, so p_user_id is
the only thing separating two users' corpora. It comes from the guard's verified
token, and searchInput is .strict() so a body carrying a userId is a 400 rather
than a value quietly dropped. Both covered.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Search on the web

**Files:**
- Create: `apps/web/src/app/search/page.tsx`
- Create: `apps/web/src/app/search/search-form.tsx`
- Create: `apps/web/src/app/search/search-form.test.tsx`
- Modify: the app's nav component (follow whatever `apps/web/src/app/note-list.tsx` links to today)

**Interfaces:**
- Consumes: `POST /search` from Task 15.

Follow the existing conventions in `apps/web`: a server component page, a `"use client"` form, and `NEXT_PUBLIC_API_URL` for the API base (already in `apps/web/.env.local`).

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/app/search/search-form.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchForm } from "./search-form";

const results = [
  { noteId: "n1", title: "Trust", snippet: "charging more made people trust it more", score: 0.9, matchedBy: "vector" },
];

describe("SearchForm", () => {
  it("does not search until submit — every query costs an embedding call", async () => {
    const search = vi.fn();
    render(<SearchForm onSearch={search} />);
    await userEvent.type(screen.getByRole("searchbox"), "pricing");
    expect(search).not.toHaveBeenCalled();
  });

  it("searches on submit and renders the results", async () => {
    const search = vi.fn().mockResolvedValue(results);
    render(<SearchForm onSearch={search} />);
    await userEvent.type(screen.getByRole("searchbox"), "pricing psychology{Enter}");
    await waitFor(() => expect(screen.getByText(/charging more/)).toBeInTheDocument());
    expect(search).toHaveBeenCalledWith("pricing psychology");
  });

  it("says why a result matched, so a semantic hit is not mistaken for a typo", async () => {
    render(<SearchForm onSearch={vi.fn().mockResolvedValue(results)} />);
    await userEvent.type(screen.getByRole("searchbox"), "x{Enter}");
    await waitFor(() => expect(screen.getByText(/by meaning/i)).toBeInTheDocument());
  });

  it("reports an empty result rather than rendering nothing", async () => {
    render(<SearchForm onSearch={vi.fn().mockResolvedValue([])} />);
    await userEvent.type(screen.getByRole("searchbox"), "nothing{Enter}");
    await waitFor(() => expect(screen.getByText(/no notes matched/i)).toBeInTheDocument());
  });

  it("surfaces a failure instead of looking like an empty result", async () => {
    render(<SearchForm onSearch={vi.fn().mockRejectedValue(new Error("boom"))} />);
    await userEvent.type(screen.getByRole("searchbox"), "x{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/web -- search-form
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the form**

Create `apps/web/src/app/search/search-form.tsx`. Keep the fetch out of the component — `onSearch` is injected, which is what makes the tests above possible without mocking `fetch`:

```tsx
"use client";

import { useState } from "react";

export interface SearchResult {
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  matchedBy: string;
}

const WHY: Record<string, string> = {
  vector: "by meaning",
  fts: "by wording",
  both: "by meaning and wording",
};

export function SearchForm({ onSearch }: { onSearch: (q: string) => Promise<SearchResult[]> }) {
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get("q");
    if (typeof q !== "string" || q.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      setResults(await onSearch(q.trim()));
    } catch {
      // Never render a failure as an empty result: "nothing matched" and "the request failed"
      // are different facts, and conflating them makes a broken search look like an empty
      // corpus.
      setError("Search failed. Try again.");
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* Submit-driven, never search-as-you-type: each query costs an embedding call. */}
      <form onSubmit={submit} role="search">
        <input type="search" name="q" placeholder="Search your notes by meaning…" aria-label="Search notes" />
        <button type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
      </form>

      {error && <p role="alert">{error}</p>}

      {results !== null && results.length === 0 && !error && <p>No notes matched.</p>}

      <ul>
        {(results ?? []).map((r) => (
          <li key={r.noteId}>
            <a href={`/notes/${r.noteId}`}>{r.title ?? "Untitled"}</a>
            <p>{r.snippet}</p>
            <small>{WHY[r.matchedBy] ?? r.matchedBy}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Wire the page**

Create `apps/web/src/app/search/page.tsx`, supplying the real `onSearch` that POSTs to `${process.env.NEXT_PUBLIC_API_URL}/search` with the Supabase session's access token in an `Authorization: Bearer` header. Follow whatever `apps/web/src/app/notes/[id]/page.tsx` already does to obtain the session.

- [ ] **Step 5: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/web -- search-form
```

Expected: PASS, 5 cases.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/search/
git commit -m "$(cat <<'EOF'
feat(web): search by meaning, submit-driven

Not search-as-you-type: every query costs an embedding call. Results say why
they matched, so a semantic hit is not mistaken for a typo, and a failed request
renders as an error rather than as an empty result -- "nothing matched" and "the
request failed" are different facts, and conflating them makes broken search
look like an empty corpus.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Search on mobile, and ship stage B

**Files:**
- Create: `apps/mobile/src/lib/semantic-search.ts`
- Create: `apps/mobile/src/lib/semantic-search.test.ts`
- Modify: the notes list screen that already holds the local FTS search box

**Interfaces:**
- Consumes: `POST /search` from Task 15.

**The rule for this screen:** local FTS5 (phase 1b Task 19) stays the instant, offline path. Semantic search is an explicit action that needs the network, and when there is no network the UI must say so rather than silently returning local results as though they were semantic ones.

Logic goes in `src/lib/`, not the `.tsx`. Importing a React Native component under `environment: "node"` dies with a Rollup Flow parse error, so anything left in the screen is untestable — the constraint phase 1b hit in Tasks 18 and 20.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/lib/semantic-search.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { semanticSearch } from "./semantic-search";

const ok = { results: [{ noteId: "n1", title: null, snippet: "s", score: 1, matchedBy: "vector" }] };

describe("semanticSearch", () => {
  it("posts the query with the caller's token", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ok });
    await semanticSearch({ q: "pricing", token: "jwt", apiUrl: "https://api.test", fetchFn });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.test/search");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body as string)).toEqual({ q: "pricing" });
  });

  it("returns the results", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ok });
    const out = await semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", fetchFn });
    expect(out).toEqual(ok.results);
  });

  // Offline must be its own outcome. Returning [] would render as "no notes matched", which
  // is a lie -- the notes may well be there.
  it("throws OfflineError when the request cannot be made", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Network request failed"));
    await expect(semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", fetchFn }))
      .rejects.toMatchObject({ name: "OfflineError" });
  });

  it("throws on a non-2xx rather than returning an empty list", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", fetchFn }))
      .rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/mobile -- semantic-search
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/mobile/src/lib/semantic-search.ts`:

```ts
export interface SemanticResult {
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  matchedBy: string;
}

export class OfflineError extends Error {
  override name = "OfflineError";
}

/**
 * The ONLY online-dependent read on this device. The local FTS5 index (phase 1b Task 19) stays
 * the instant, offline path, and this is an explicit action on top of it.
 *
 * fetchFn is injected so the test needs no network and no RN mock -- the same reason capture.ts
 * exists rather than logic living in the screen.
 */
export async function semanticSearch(args: {
  q: string;
  token: string;
  apiUrl: string;
  limit?: number;
  fetchFn?: typeof fetch;
}): Promise<SemanticResult[]> {
  const doFetch = args.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${args.apiUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${args.token}` },
      body: JSON.stringify(args.limit ? { q: args.q, limit: args.limit } : { q: args.q }),
    });
  } catch {
    // Distinct from "no results". Rendering an offline failure as an empty list tells the user
    // their notes are not there, which is false.
    throw new OfflineError("Semantic search needs a connection");
  }
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const body = (await res.json()) as { results: SemanticResult[] };
  return body.results;
}
```

- [ ] **Step 4: Wire the screen**

In the notes list screen, add a "Search by meaning" action beside the existing local search box. On `OfflineError`, show "Semantic search needs a connection — showing local results" and leave the FTS5 results in place. Never silently substitute one for the other.

- [ ] **Step 5: Run the mobile suite and the bundle**

```bash
pnpm turbo run test --filter=@cortex/mobile
pnpm turbo run bundle --filter=@cortex/mobile
```

Expected: PASS both. **The bundle step is not optional** — `tsc` and vitest both resolve `./x.js` imports that Metro rejects outright, which left the app unbundlable for most of phase 1b while every gate stayed green.

- [ ] **Step 6: Run the full gate**

```bash
pnpm turbo run typecheck lint test --force
```

Expected: every package successful, `Cached: 0 cached`.

- [ ] **Step 7: Commit and open the stage-B PR**

```bash
git add apps/mobile/src/lib/semantic-search.ts apps/mobile/src/lib/semantic-search.test.ts apps/mobile/src/app/
git commit -m "$(cat <<'EOF'
feat(mobile): search by meaning, with offline as its own outcome

Local FTS5 stays the instant, offline path; this is an explicit action on top of
it. OfflineError is distinct from an empty result, because rendering an offline
failure as "no notes matched" tells the user their notes are not there, which is
false.

Logic lives in src/lib/, not the screen: importing an RN component under
environment "node" dies with a Rollup Flow parse error, so anything left in the
.tsx cannot be tested at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"

gh pr create --base main --title "Phase 2 stage B: hybrid semantic search" --body "$(cat <<'EOF'
`search_notes()` fusing pgvector and Postgres FTS by RRF, `POST /search`, and the
search surface on both clients.

The demo: type "pricing psychology" and find the note that only says "charging more
made people trust it more".

Design: `docs/superpowers/specs/2026-08-10-phase-2-3-assistant-design.md` §8.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Definition of Done

- [ ] pg-boss connects through the Supavisor **session** pooler and round-trips a job, proven against the hosted database by hand, and the probe's `pgboss` schema dropped again afterwards
- [ ] `pnpm turbo run typecheck lint test --force` green with `Cached: 0 cached`, Docker up, at the end of each stage
- [ ] `pnpm turbo run bundle --filter=@cortex/mobile` green
- [ ] A note that was only pinned is **not** claimed by the sweep — the cost regression, observed red against a timestamp predicate
- [ ] `feedback_events` fires from a direct PostgREST update by the user, proving no client path bypasses it
- [ ] `search_notes` cross-user isolation asserted with real rows for **both** users
- [ ] Every mutation listed in Tasks 3, 5, 6, 11 and 14 observed failing exactly its own test
- [ ] No test reaches the real Gemini API
- [ ] Stage A's four Railway variables set, and the first hosted sweep observed in `railway logs`
- [ ] `note_enrichment` named in `SERVER_ONLY_TABLES`, in `sync-rules.yaml`'s header comment, and absent from the publication (still exactly six replicated tables — no PowerSync redeploy)
