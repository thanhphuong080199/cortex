# Cortex Phase 0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Cortex monorepo, Supabase schema v1 with RLS + invite gate, Google OAuth on web and mobile, a deployed NestJS API skeleton, and CI — ending with the Phase 0 demo: log in on phone + web with the same Google account, and a cross-user read test that provably returns empty.

**Architecture:** Turborepo + pnpm monorepo. Supabase (Postgres + pgvector + Auth) is the authoritative store with RLS on every table (default-deny; server-only tables get RLS enabled with zero policies). One NestJS service verifies Supabase JWTs via JWKS. Next.js web uses `@supabase/ssr` Google OAuth; Expo mobile uses `expo-auth-session` + `WebBrowser` OAuth. PowerSync is **not** in this phase (Phase 1).

**Tech Stack:** pnpm ≥10, Turborepo 2, TypeScript 5 (strict), Node 22, Supabase CLI + supabase-js v2, NestJS 11, Next.js 15 (app router), Expo (latest stable SDK, expo-router), Vitest 3, zod 4, jose.

**Spec:** `docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md` (§6 schema, §11 auth, §12.3 repo layout, §13 phase 0). Phases 1–10 get their own plan documents later.

## Global Constraints

- All tables: `user_id uuid not null references auth.users(id)`, RLS enabled, policy `user_id = auth.uid()` for all four operations unless noted; `id uuid default gen_random_uuid()`; timestamps `timestamptz`; soft-delete via `deleted_at` on synced tables. (Spec §6 preamble.)
- Server-only tables (`note_chunks, ingest_inbox, memory_revisions, feedback_events, usage_ledger, integrations`): RLS **enabled with no policies** — clients denied, service role bypasses. (Spec §6.7.)
- Embeddings columns are `vector(1024)` for `voyage-3.5`. (Spec §4.1.)
- Web is **online-only**; offline-first (PowerSync) is mobile-only. (Spec §4.8 — no PowerSync work in this phase.)
- Invite gate: signup allowed only for emails in `allowed_emails`. (Spec §11.)
- All secrets via env vars; never commit `.env` files (commit `.env.example` instead).
- Deviation from spec §12.3, locked here: SQL migrations live in `/supabase/migrations` (Supabase CLI requirement); `packages/db` holds RLS tests + typed helpers and documents this.

## Prerequisites (verify before Task 1)

- Node 22 (`node -v`), pnpm ≥10 (`corepack enable; corepack prepare pnpm@latest --activate`)
- Docker Desktop running (needed by `supabase start`)
- Supabase CLI (`scoop install supabase` on Windows, or `npm i -g supabase`)
- A Supabase cloud project + Google Cloud OAuth client exist only by Task 12 (deploy) — not needed before.

## File Structure

```
cortex/
├─ .github/workflows/ci.yml            # Task 11
├─ package.json  pnpm-workspace.yaml  turbo.json  eslint.config.mjs   # Task 1
├─ supabase/
│  ├─ config.toml                      # Task 3 (supabase init)
│  └─ migrations/
│     ├─ 00001_extensions_helpers.sql  # Task 3: pgvector, strip_markdown()
│     ├─ 00002_content.sql             # Task 4: notes, note_chunks, attachments, ingest_inbox
│     ├─ 00003_organization.sql        # Task 5: tags, note_tags, links
│     ├─ 00004_tasks_review.sql        # Task 5: tasks, review_queue
│     ├─ 00005_memory_feedback.sql     # Task 5: memory_facts, memory_revisions, feedback_events
│     ├─ 00006_synthesis_chat.sql      # Task 5: digests, chat_sessions, chat_messages
│     ├─ 00007_integrations_ops.sql    # Task 5: integrations, calendar_links, usage_ledger
│     └─ 00008_invite_gate.sql         # Task 6: allowed_emails + auth trigger
├─ packages/
│  ├─ config/                          # Task 1: tsconfig base, eslint base
│  ├─ shared/                          # Task 2: zod enums/constants
│  └─ db/                              # Tasks 3–7: test helpers + RLS tests
├─ apps/
│  ├─ api/                             # Task 8: NestJS health + auth guard + /me (+ Dockerfile, Task 12)
│  ├─ web/                             # Task 9: Next.js login + protected page
│  └─ mobile/                          # Task 10: Expo login
└─ docs/
```

---

### Task 1: Monorepo scaffold (pnpm + Turborepo + shared config)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.gitignore`, `.nvmrc`
- Create: `packages/config/package.json`, `packages/config/tsconfig.base.json`, `packages/config/eslint.base.mjs`
- Create: `eslint.config.mjs` (root)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `@cortex/config` package — every later package extends `packages/config/tsconfig.base.json` and imports `packages/config/eslint.base.mjs`; root scripts `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (turbo).

- [ ] **Step 1: Write root `package.json`**

```json
{
  "name": "cortex",
  "private": true,
  "packageManager": "pnpm@10.13.1",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "test": "turbo run test"
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.6.0",
    "eslint": "^9.20.0",
    "typescript-eslint": "^8.20.0",
    "prettier": "^3.4.0"
  }
}
```

- [ ] **Step 2: Write `pnpm-workspace.yaml`, `.nvmrc`, `.gitignore`**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`.nvmrc`: `22`

`.gitignore`:
```
node_modules/
.turbo/
dist/
.next/
.expo/
.env
.env.local
*.tsbuildinfo
supabase/.temp/
```

- [ ] **Step 3: Write `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {},
    "test": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 4: Write `packages/config`**

`packages/config/package.json`:
```json
{
  "name": "@cortex/config",
  "version": "0.0.0",
  "private": true,
  "files": ["tsconfig.base.json", "eslint.base.mjs"]
}
```

`packages/config/tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`packages/config/eslint.base.mjs`:
```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    ignores: ["**/dist/**", "**/.next/**", "**/.expo/**", "**/node_modules/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
);
```

Root `eslint.config.mjs`:
```js
export { default } from "./packages/config/eslint.base.mjs";
```

- [ ] **Step 5: Install and verify**

Run: `pnpm install` then `pnpm turbo run typecheck lint test`
Expected: install succeeds; turbo reports no tasks found (no packages define them yet) and exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm + turborepo monorepo with shared config"
```

---

### Task 2: `packages/shared` — zod enums/constants + Vitest wiring

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/eslint.config.mjs`, `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/index.ts`, `packages/shared/src/enums.ts`
- Test: `packages/shared/src/enums.test.ts`

**Interfaces:**
- Consumes: `@cortex/config` (tsconfig/eslint bases).
- Produces: `@cortex/shared` exporting zod enums `noteLifecycle, noteSourceType, paraCategory, suggestionStatus, taskStatus, memoryCategory, memoryStatus` (each a `z.ZodEnum`) and constants `EMBEDDING_DIM = 1024`, `EMBEDDING_MODEL = "voyage-3.5"`. Later phases add DTOs here; Task 4's SQL check constraints must match these enum values exactly.

- [ ] **Step 1: Scaffold the package**

`packages/shared/package.json`:
```json
{
  "name": "@cortex/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^4.0.0" },
  "devDependencies": { "@cortex/config": "workspace:*", "vitest": "^3.0.0" }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "@cortex/config/tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"]
}
```

`packages/shared/eslint.config.mjs`:
```js
export { default } from "@cortex/config/eslint.base.mjs";
```

`packages/shared/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

- [ ] **Step 2: Write the failing test**

`packages/shared/src/enums.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIM, EMBEDDING_MODEL,
  memoryCategory, noteLifecycle, noteSourceType, taskStatus,
} from "./enums.js";

describe("shared enums", () => {
  it("accepts valid values", () => {
    expect(noteLifecycle.parse("inbox")).toBe("inbox");
    expect(noteSourceType.parse("telegram")).toBe("telegram");
    expect(taskStatus.parse("suggested")).toBe("suggested");
    expect(memoryCategory.parse("opinion")).toBe("opinion");
  });
  it("rejects invalid values", () => {
    expect(() => noteLifecycle.parse("trash")).toThrow();
    expect(() => noteSourceType.parse("sms")).toThrow();
  });
  it("pins embedding contract", () => {
    expect(EMBEDDING_DIM).toBe(1024);
    expect(EMBEDDING_MODEL).toBe("voyage-3.5");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @cortex/shared test`
Expected: FAIL — cannot resolve `./enums.js`.

- [ ] **Step 4: Implement**

`packages/shared/src/enums.ts`:
```ts
import { z } from "zod";

export const noteLifecycle = z.enum(["inbox", "active", "evergreen", "archived"]);
export const noteSourceType = z.enum(["quick", "web_clip", "voice", "email", "telegram", "import"]);
export const paraCategory = z.enum(["project", "area", "resource", "archive"]);
export const suggestionStatus = z.enum(["suggested", "accepted", "rejected"]);
export const taskStatus = z.enum(["suggested", "todo", "doing", "done", "dropped"]);
export const memoryCategory = z.enum([
  "identity", "preference", "interest", "project",
  "habit", "opinion", "skill", "relationship",
]);
export const memoryStatus = z.enum(["proposed", "active", "archived", "rejected"]);

export const EMBEDDING_DIM = 1024;
export const EMBEDDING_MODEL = "voyage-3.5";
```

`packages/shared/src/index.ts`:
```ts
export * from "./enums.js";
```

- [ ] **Step 5: Run tests, typecheck, lint — all pass**

Run: `pnpm --filter @cortex/shared test && pnpm --filter @cortex/shared typecheck && pnpm --filter @cortex/shared lint`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): zod enums and embedding constants"
```

---

### Task 3: Supabase local project + extensions/helpers migration

**Files:**
- Create: `supabase/config.toml` (via `supabase init`)
- Create: `supabase/migrations/00001_extensions_helpers.sql`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/eslint.config.mjs`, `packages/db/vitest.config.ts`, `packages/db/.env.example`, `packages/db/README.md`
- Create: `packages/db/src/test/clients.ts`
- Test: `packages/db/src/test/helpers.test.ts`

**Interfaces:**
- Consumes: Docker + Supabase CLI.
- Produces: running local stack (`supabase start`); SQL function `public.strip_markdown(md text) returns text` (IMMUTABLE — required by Task 4's generated column); `packages/db` test harness exporting `admin` (service-role supabase-js client) and `makeUser(email): Promise<{ client, id }>` used by Tasks 4–8 tests. Env contract: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 1: Initialize Supabase and start the local stack**

Run from repo root: `supabase init` then `supabase start`
Expected: config.toml created; stack starts and prints API URL `http://127.0.0.1:54321`, anon key, service_role key. Copy those into `packages/db/.env` (created below).

- [ ] **Step 2: Scaffold `packages/db`**

`packages/db/package.json`:
```json
{
  "name": "@cortex/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "dependencies": { "@supabase/supabase-js": "^2.48.0" },
  "devDependencies": { "@cortex/config": "workspace:*", "vitest": "^3.0.0", "dotenv": "^16.4.0" }
}
```

`packages/db/tsconfig.json`:
```json
{
  "extends": "@cortex/config/tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"]
}
```

`packages/db/eslint.config.mjs`:
```js
export { default } from "@cortex/config/eslint.base.mjs";
```

`packages/db/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", setupFiles: ["dotenv/config"], testTimeout: 30000, fileParallelism: false },
});
```

`packages/db/.env.example`:
```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<from `supabase status`>
SUPABASE_SERVICE_ROLE_KEY=<from `supabase status`>
```

`packages/db/README.md`: one paragraph — "Migrations live in `/supabase/migrations` (Supabase CLI convention). This package holds the RLS/schema test suite and, later, typed query helpers. Run `supabase start`, copy `.env.example` → `.env` with keys from `supabase status`, then `pnpm test`."

`packages/db/src/test/clients.ts`:
```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

export const TEST_PASSWORD = "cortex-test-password-123";

/** Allow-lists the email, creates (or reuses) the user, returns a signed-in client. */
export async function makeUser(email: string): Promise<{ client: SupabaseClient; id: string }> {
  await admin.from("allowed_emails").upsert({ email });          // no-op until Task 6 migration exists
  const created = await admin.auth.admin.createUser({ email, password: TEST_PASSWORD, email_confirm: true });
  if (created.error && !created.error.message.includes("already been registered")) throw created.error;
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (signIn.error) throw signIn.error;
  return { client, id: signIn.data.user!.id };
}
```

Note: until Task 6 creates `allowed_emails`, the `upsert` returns an error object (table missing) but does not throw — tests in this task don't depend on it. Task 6 makes it live.

- [ ] **Step 3: Write the failing test**

`packages/db/src/test/helpers.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { admin } from "./clients.js";

describe("strip_markdown", () => {
  it("strips markdown syntax to plain text", async () => {
    const { data, error } = await admin.rpc("strip_markdown", {
      md: "# Title\n\nSome **bold** and a [link](https://x.com).\n\n```js\ncode();\n```",
    });
    expect(error).toBeNull();
    expect(data).toBe("Title Some bold and a link.");
  });
  it("handles null/empty", async () => {
    const { data } = await admin.rpc("strip_markdown", { md: "" });
    expect(data).toBe("");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @cortex/db test`
Expected: FAIL — RPC `strip_markdown` not found.

- [ ] **Step 5: Write the migration**

`supabase/migrations/00001_extensions_helpers.sql`:
```sql
create extension if not exists vector;

-- Plain-text projection of markdown for FTS. IMMUTABLE so it can back a generated column.
create or replace function public.strip_markdown(md text)
returns text
language sql
immutable
as $$
  select trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(coalesce(md, ''), '```[^`]*```', ' ', 'g'),  -- fenced code blocks
            '!?\[([^\]]*)\]\([^)]*\)', '\1', 'g'),                      -- links/images -> keep label
          '^#{1,6}\s+', '', 'gm'),                                       -- heading markers
        '[*_~`>#|]', '', 'g'),                                           -- inline md punctuation
      '\s+', ' ', 'g')                                                   -- collapse whitespace
  );
$$;
```

- [ ] **Step 6: Apply and re-run test**

Run: `supabase db reset` then `pnpm --filter @cortex/db test`
Expected: PASS. (If the exact-string assertion fails on spacing, fix the *function* until output is stable plain text — the assertion documents the contract.)

- [ ] **Step 7: Verify typecheck/lint, commit**

```bash
pnpm --filter @cortex/db typecheck && pnpm --filter @cortex/db lint
git add supabase packages/db
git commit -m "feat(db): local supabase stack, pgvector, strip_markdown helper, test harness"
```

---

### Task 4: Content tables migration (notes, note_chunks, attachments, ingest_inbox)

**Files:**
- Create: `supabase/migrations/00002_content.sql`
- Test: `packages/db/src/test/schema-content.test.ts`

**Interfaces:**
- Consumes: `strip_markdown` (Task 3), `makeUser`/`admin` harness (Task 3).
- Produces: tables `notes` (client-writable, RLS `user_id = auth.uid()`), `note_chunks`, `attachments`, `ingest_inbox` (server-only: RLS enabled, no policies). Column names/types exactly as below — Phase 1+ sync schema and API depend on them.

- [ ] **Step 1: Write the failing test**

`packages/db/src/test/schema-content.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

describe("content schema", () => {
  it("inserts a note and generates content_text", async () => {
    const { client, id } = await makeUser("schema-a@test.local");
    const { data, error } = await client
      .from("notes")
      .insert({ user_id: id, content: "# Hello\n\n**world**" })
      .select("id, content_text, lifecycle, source_type")
      .single();
    expect(error).toBeNull();
    expect(data!.content_text).toBe("Hello world");
    expect(data!.lifecycle).toBe("inbox");
    expect(data!.source_type).toBe("quick");
  });

  it("rejects invalid lifecycle values", async () => {
    const { client, id } = await makeUser("schema-a@test.local");
    const { error } = await client.from("notes").insert({ user_id: id, content: "x", lifecycle: "trash" });
    expect(error).not.toBeNull();
  });

  it("denies client access to server-only tables", async () => {
    const { client } = await makeUser("schema-a@test.local");
    for (const table of ["note_chunks", "ingest_inbox"]) {
      const { data } = await client.from(table).select("id");
      expect(data ?? []).toHaveLength(0);      // RLS: no policies -> empty, never rows
    }
    const { error } = await client.from("note_chunks").insert({ note_id: crypto.randomUUID(), chunk_index: 0, content: "x" });
    expect(error).not.toBeNull();              // insert denied
  });

  it("service role can write note_chunks", async () => {
    const { client, id } = await makeUser("schema-a@test.local");
    const { data: note } = await client.from("notes").insert({ user_id: id, content: "chunk me" }).select("id").single();
    const { error } = await admin.from("note_chunks").insert({
      user_id: id, note_id: note!.id, chunk_index: 0, content: "chunk me", token_count: 3,
    });
    expect(error).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cortex/db test -- schema-content`
Expected: FAIL — relation "notes" does not exist. (`makeUser` works: local stack allows email/password sign-up via admin API; the invite trigger doesn't exist yet.)

- [ ] **Step 3: Write the migration**

`supabase/migrations/00002_content.sql`:
```sql
-- ============ notes (synced, client-writable) ============
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  title text,
  content text not null default '',
  content_text text generated always as (public.strip_markdown(content)) stored,
  source_type text not null default 'quick'
    check (source_type in ('quick','web_clip','voice','email','telegram','import')),
  source_meta jsonb not null default '{}',
  lifecycle text not null default 'inbox'
    check (lifecycle in ('inbox','active','evergreen','archived')),
  para_category text check (para_category in ('project','area','resource','archive')),
  para_status text not null default 'none' check (para_status in ('none','suggested','accepted')),
  pinned boolean not null default false,
  word_count int,
  enriched_at timestamptz,
  last_reviewed_at timestamptz,
  review_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index notes_user_updated_idx on public.notes (user_id, updated_at desc);
create index notes_user_lifecycle_idx on public.notes (user_id, lifecycle);
create index notes_fts_idx on public.notes using gin (to_tsvector('english', content_text));

alter table public.notes enable row level security;
create policy notes_own on public.notes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ============ note_chunks (SERVER-ONLY: embeddings) ============
create table public.note_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  note_id uuid not null references public.notes(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  token_count int,
  content_hash text,
  embedding vector(1024),
  embedding_model text,
  embedded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (note_id, chunk_index)
);
create index note_chunks_user_note_idx on public.note_chunks (user_id, note_id);
create index note_chunks_embedding_idx on public.note_chunks
  using hnsw (embedding vector_cosine_ops);
alter table public.note_chunks enable row level security;  -- no policies: server-only

-- ============ attachments (synced metadata) ============
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  note_id uuid not null references public.notes(id) on delete cascade,
  storage_path text not null,
  mime text,
  size_bytes bigint,
  kind text check (kind in ('audio','image','file')),
  transcript_status text not null default 'none'
    check (transcript_status in ('none','pending','done','failed')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index attachments_user_note_idx on public.attachments (user_id, note_id);
alter table public.attachments enable row level security;
create policy attachments_own on public.attachments
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ============ ingest_inbox (SERVER-ONLY: idempotent inbound) ============
create table public.ingest_inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  channel text not null check (channel in ('telegram','email','clipper')),
  external_id text not null,
  payload jsonb not null default '{}',
  status text not null default 'received' check (status in ('received','processed','failed')),
  note_id uuid references public.notes(id),
  created_at timestamptz not null default now(),
  unique (channel, external_id)
);
alter table public.ingest_inbox enable row level security;  -- no policies: server-only
```

- [ ] **Step 4: Apply and run tests**

Run: `supabase db reset && pnpm --filter @cortex/db test`
Expected: PASS (Task 3 tests still green too).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00002_content.sql packages/db
git commit -m "feat(db): content tables (notes, note_chunks, attachments, ingest_inbox) with RLS"
```

---

### Task 5: Remaining domain tables (organization, tasks/review, memory, synthesis/chat, integrations/ops)

**Files:**
- Create: `supabase/migrations/00003_organization.sql`, `00004_tasks_review.sql`, `00005_memory_feedback.sql`, `00006_synthesis_chat.sql`, `00007_integrations_ops.sql`
- Test: `packages/db/src/test/schema-domain.test.ts`

**Interfaces:**
- Consumes: `notes` (Task 4), test harness (Task 3).
- Produces: every remaining spec-§6 table with the exact columns below. `memory_facts` is client-**readable only** (select policy only); `memory_revisions`, `feedback_events`, `usage_ledger`, `integrations` are server-only (no policies).

- [ ] **Step 1: Write the failing test**

`packages/db/src/test/schema-domain.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

describe("domain schema", () => {
  it("tags are unique per user case-insensitively", async () => {
    const { client, id } = await makeUser("schema-b@test.local");
    await client.from("tags").insert({ user_id: id, name: "Ideas" });
    const { error } = await client.from("tags").insert({ user_id: id, name: "ideas" });
    expect(error).not.toBeNull();
  });

  it("tasks default to suggested status", async () => {
    const { client, id } = await makeUser("schema-b@test.local");
    const { data, error } = await client.from("tasks")
      .insert({ user_id: id, title: "Ship phase 0", source: "user", status: "todo" })
      .select("status").single();
    expect(error).toBeNull();
    expect(data!.status).toBe("todo");
  });

  it("memory_facts are read-only for clients", async () => {
    const { client, id } = await makeUser("schema-b@test.local");
    const { error: insertErr } = await client.from("memory_facts")
      .insert({ user_id: id, category: "preference", statement: "x", confidence: 0.5 });
    expect(insertErr).not.toBeNull();                       // no insert policy
    const { error: adminErr } = await admin.from("memory_facts")
      .insert({ user_id: id, category: "preference", statement: "Prefers TypeScript", confidence: 0.8 });
    expect(adminErr).toBeNull();                            // service role writes
    const { data } = await client.from("memory_facts").select("statement");
    expect(data).toHaveLength(1);                           // select policy works
  });

  it("server-only ops tables deny clients", async () => {
    const { client } = await makeUser("schema-b@test.local");
    for (const table of ["memory_revisions", "feedback_events", "usage_ledger", "integrations"]) {
      const { data } = await client.from(table).select("id");
      expect(data ?? []).toHaveLength(0);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @cortex/db test -- schema-domain`
Expected: FAIL — relation "tags" does not exist.

- [ ] **Step 3: Write the migrations**

`supabase/migrations/00003_organization.sql`:
```sql
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  name text not null,
  color text,
  created_by text not null default 'user' check (created_by in ('user','ai')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index tags_user_name_uidx on public.tags (user_id, lower(name)) where deleted_at is null;
alter table public.tags enable row level security;
create policy tags_own on public.tags for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.note_tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  note_id uuid not null references public.notes(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  source text not null check (source in ('user','ai')),
  status text not null default 'accepted' check (status in ('suggested','accepted','rejected')),
  confidence real,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (note_id, tag_id)
);
create index note_tags_user_note_idx on public.note_tags (user_id, note_id);
alter table public.note_tags enable row level security;
create policy note_tags_own on public.note_tags for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  from_note_id uuid not null references public.notes(id) on delete cascade,
  to_note_id uuid not null references public.notes(id) on delete cascade,
  kind text not null default 'semantic' check (kind in ('semantic','manual','reference')),
  status text not null default 'suggested' check (status in ('suggested','accepted','dismissed')),
  similarity real,
  rationale text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, from_note_id, to_note_id)
);
alter table public.links enable row level security;
create policy links_own on public.links for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
```

`supabase/migrations/00004_tasks_review.sql`:
```sql
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  note_id uuid references public.notes(id) on delete set null,
  title text not null,
  details text,
  status text not null default 'suggested' check (status in ('suggested','todo','doing','done','dropped')),
  source text not null default 'user' check (source in ('user','ai')),
  source_span jsonb,
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index tasks_user_status_idx on public.tasks (user_id, status);
alter table public.tasks enable row level security;
create policy tasks_own on public.tasks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.review_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  note_id uuid not null references public.notes(id) on delete cascade unique,
  due_at timestamptz not null,
  interval_days real not null default 3,
  ease real not null default 2.0,
  last_result text check (last_result in ('kept','snoozed','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index review_queue_user_due_idx on public.review_queue (user_id, due_at);
alter table public.review_queue enable row level security;
create policy review_queue_own on public.review_queue for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
```

`supabase/migrations/00005_memory_feedback.sql`:
```sql
create table public.memory_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  category text not null check (category in
    ('identity','preference','interest','project','habit','opinion','skill','relationship')),
  statement text not null,
  rationale text,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  salience real not null default 0.5,
  status text not null default 'proposed' check (status in ('proposed','active','archived','rejected')),
  evidence jsonb not null default '[]',
  embedding vector(1024),
  first_observed_at timestamptz,
  last_confirmed_at timestamptz,
  superseded_by uuid references public.memory_facts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index memory_facts_user_status_idx on public.memory_facts (user_id, status);
alter table public.memory_facts enable row level security;
-- Clients read their own facts; ALL mutations go through the API (service role).
create policy memory_facts_read_own on public.memory_facts
  for select to authenticated using (user_id = (select auth.uid()));

create table public.memory_revisions (   -- SERVER-ONLY audit log
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  fact_id uuid not null references public.memory_facts(id) on delete cascade,
  action text not null check (action in ('propose','accept','reject','confirm','update','decay','archive')),
  actor text not null check (actor in ('agent','user')),
  diff jsonb,
  created_at timestamptz not null default now()
);
alter table public.memory_revisions enable row level security;

create table public.feedback_events (    -- SERVER-ONLY (write-through API)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  subject_type text not null check (subject_type in
    ('tag','link','task','digest_item','memory_fact','chat_answer','para')),
  subject_id uuid,
  action text not null check (action in ('accept','reject','edit','thumbs_up','thumbs_down')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index feedback_events_user_idx on public.feedback_events (user_id, created_at desc);
alter table public.feedback_events enable row level security;
```

`supabase/migrations/00006_synthesis_chat.sql`:
```sql
create table public.digests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  period text not null check (period in ('weekly','monthly')),
  period_start date not null,
  period_end date not null,
  status text not null default 'pending' check (status in ('pending','ready','failed')),
  content_md text,
  clusters jsonb,
  model_meta jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, period, period_start)
);
alter table public.digests enable row level security;
create policy digests_read_own on public.digests
  for select to authenticated using (user_id = (select auth.uid()));

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.chat_sessions enable row level security;
create policy chat_sessions_own on public.chat_sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  citations jsonb,
  retrieval_meta jsonb,
  created_at timestamptz not null default now()
);
create index chat_messages_session_idx on public.chat_messages (session_id, created_at);
alter table public.chat_messages enable row level security;
create policy chat_messages_own on public.chat_messages for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
```

`supabase/migrations/00007_integrations_ops.sql`:
```sql
create table public.integrations (      -- SERVER-ONLY (credentials never reach clients)
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  provider text not null check (provider in ('telegram','google_calendar','slack','email_alias')),
  external_id text not null,
  credentials jsonb,                    -- encrypt via Supabase Vault when first real secret lands (phase 4)
  status text not null default 'active' check (status in ('active','revoked','error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, external_id)
);
alter table public.integrations enable row level security;

create table public.calendar_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  note_id uuid not null references public.notes(id) on delete cascade,
  event_id text not null,
  event_meta jsonb,
  event_start timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.calendar_links enable row level security;
create policy calendar_links_own on public.calendar_links for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.usage_ledger (      -- SERVER-ONLY cost control
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  kind text not null check (kind in ('embed','chat','tag','digest','memory','transcribe')),
  model text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric,
  created_at timestamptz not null default now()
);
create index usage_ledger_user_idx on public.usage_ledger (user_id, created_at desc);
alter table public.usage_ledger enable row level security;
```

- [ ] **Step 4: Apply and run the full db suite**

Run: `supabase db reset && pnpm --filter @cortex/db test`
Expected: PASS across all test files.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations packages/db
git commit -m "feat(db): full schema v1 - organization, tasks, memory, synthesis, integrations with RLS"
```

---

### Task 6: Invite gate (`allowed_emails` + auth trigger)

**Files:**
- Create: `supabase/migrations/00008_invite_gate.sql`
- Test: `packages/db/src/test/invite-gate.test.ts`

**Interfaces:**
- Consumes: test harness (Task 3) — `makeUser` already upserts into `allowed_emails`, so existing tests keep passing.
- Produces: table `public.allowed_emails(email text primary key)` (server-only) and trigger `check_email_allowed` on `auth.users` that rejects non-allow-listed signups. Task 12 seeds real emails into it.

- [ ] **Step 1: Write the failing test**

`packages/db/src/test/invite-gate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { admin, makeUser, TEST_PASSWORD } from "./clients.js";

describe("invite gate", () => {
  it("rejects signup for a non-allow-listed email", async () => {
    const { error } = await admin.auth.admin.createUser({
      email: "stranger@test.local", password: TEST_PASSWORD, email_confirm: true,
    });
    expect(error).not.toBeNull();
    expect(String(error!.message)).toMatch(/not allowed|Database error/i);
  });

  it("allows signup for an allow-listed email", async () => {
    const { id } = await makeUser("invited@test.local");   // makeUser allow-lists first
    expect(id).toBeTruthy();
  });

  it("hides allowed_emails from clients", async () => {
    const { client } = await makeUser("invited@test.local");
    const { data } = await client.from("allowed_emails").select("email");
    expect(data ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @cortex/db test -- invite-gate`
Expected: FAIL — the stranger signup *succeeds* (no gate yet), so the first assertion fails.

- [ ] **Step 3: Write the migration**

`supabase/migrations/00008_invite_gate.sql`:
```sql
create table public.allowed_emails (
  email text primary key,
  note text,
  created_at timestamptz not null default now()
);
alter table public.allowed_emails enable row level security;  -- no policies: server-only

-- Trigger-based gate. (Supabase "before user created" auth hooks exist, but a trigger
-- is testable locally and sufficient at this scale; revisit if Supabase deprecates it.)
create or replace function public.check_email_allowed()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.allowed_emails where lower(email) = lower(new.email)) then
    raise exception 'Signup not allowed for %', new.email;
  end if;
  return new;
end;
$$;

create trigger check_email_allowed_trigger
  before insert on auth.users
  for each row execute function public.check_email_allowed();
```

- [ ] **Step 4: Apply and run the full db suite**

Run: `supabase db reset && pnpm --filter @cortex/db test`
Expected: PASS — including all earlier files (their `makeUser` calls allow-list first, so they still pass).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00008_invite_gate.sql packages/db
git commit -m "feat(db): invite gate - allowed_emails allowlist enforced by auth trigger"
```

---

### Task 7: RLS cross-user isolation test suite (the Phase 0 demo proof)

**Files:**
- Test: `packages/db/src/test/rls-isolation.test.ts`

**Interfaces:**
- Consumes: full schema (Tasks 4–6), harness (Task 3).
- Produces: the spec's "cross-user read test provably empty" evidence; CI (Task 11) runs it on every push. No new runtime code.

- [ ] **Step 1: Write the tests (they should pass immediately if RLS is right — the point is proof, and they'd have caught a missing policy)**

`packages/db/src/test/rls-isolation.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makeUser } from "./clients.js";

const CLIENT_TABLES = [
  "notes", "tags", "note_tags", "links", "tasks", "review_queue",
  "digests", "memory_facts", "chat_sessions", "chat_messages",
  "calendar_links", "attachments",
];

let alice: { client: SupabaseClient; id: string };
let bob: { client: SupabaseClient; id: string };
let aliceNoteId: string;

beforeAll(async () => {
  alice = await makeUser("alice@test.local");
  bob = await makeUser("bob@test.local");
  const { data } = await alice.client.from("notes")
    .insert({ user_id: alice.id, title: "secret", content: "alice only" })
    .select("id").single();
  aliceNoteId = data!.id;
});

describe("cross-user isolation", () => {
  it("bob reads zero rows from every client-visible table", async () => {
    for (const table of CLIENT_TABLES) {
      const { data, error } = await bob.client.from(table).select("id");
      expect(error, table).toBeNull();
      expect(data, table).toHaveLength(0);
    }
  });

  it("bob cannot read alice's note by id", async () => {
    const { data } = await bob.client.from("notes").select("*").eq("id", aliceNoteId);
    expect(data).toHaveLength(0);
  });

  it("bob cannot update or delete alice's note", async () => {
    const { data: upd } = await bob.client.from("notes")
      .update({ title: "hacked" }).eq("id", aliceNoteId).select();
    expect(upd).toHaveLength(0);                       // 0 rows affected
    const { data: del } = await bob.client.from("notes")
      .delete().eq("id", aliceNoteId).select();
    expect(del).toHaveLength(0);
    const { data: still } = await alice.client.from("notes").select("title").eq("id", aliceNoteId).single();
    expect(still!.title).toBe("secret");
  });

  it("bob cannot insert rows owned by alice", async () => {
    const { error } = await bob.client.from("notes")
      .insert({ user_id: alice.id, content: "forged" });
    expect(error).not.toBeNull();                      // with check blocks foreign user_id
  });

  it("anonymous clients read nothing", async () => {
    const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } });
    const { data } = await anon.from("notes").select("id");
    expect(data ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the suite**

Run: `supabase db reset && pnpm --filter @cortex/db test`
Expected: PASS. If any isolation test fails, STOP and fix the policy in the corresponding migration before proceeding — this suite is the security contract.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/test/rls-isolation.test.ts
git commit -m "test(db): cross-user RLS isolation suite - reads provably empty"
```

---

### Task 8: `apps/api` — NestJS skeleton (health, Supabase JWT guard, /me)

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/eslint.config.mjs`, `apps/api/vitest.config.ts`, `apps/api/.env.example`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/health.controller.ts`
- Create: `apps/api/src/auth/supabase-auth.guard.ts`, `apps/api/src/auth/current-user.decorator.ts`, `apps/api/src/me.controller.ts`
- Test: `apps/api/test/app.e2e.test.ts`

**Interfaces:**
- Consumes: local Supabase (Tasks 3–6) for issuing real JWTs in tests; `makeUser` pattern (re-implemented locally to keep apps/api self-contained).
- Produces: `GET /health` → `{ "status": "ok" }` (public); `GET /me` → `{ "id": <uuid>, "email": <string> }` (bearer-JWT-guarded); `SupabaseAuthGuard` + `@CurrentUser()` — every future authed route in phases 1+ uses these. Env contract: `PORT`, `SUPABASE_URL`, `SUPABASE_JWT_SECRET` (optional — HS256 local fallback), `SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY` (tests only).

- [ ] **Step 1: Scaffold the package**

`apps/api/package.json`:
```json
{
  "name": "@cortex/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "jose": "^5.9.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@cortex/config": "workspace:*",
    "@nestjs/cli": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@supabase/supabase-js": "^2.48.0",
    "@swc/core": "^1.10.0",
    "dotenv": "^16.4.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.0",
    "unplugin-swc": "^1.5.0",
    "vitest": "^3.0.0"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "extends": "@cortex/config/tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "dist",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "declaration": false
  },
  "include": ["src", "test"]
}
```

`apps/api/vitest.config.ts` (swc handles Nest decorators):
```ts
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", setupFiles: ["dotenv/config"], testTimeout: 30000 },
  plugins: [swc.vite({ module: { type: "commonjs" } })],
});
```

`apps/api/.env.example`:
```
PORT=3001
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_JWT_SECRET=<from `supabase status` (local dev); unset in prod to use JWKS>
SUPABASE_ANON_KEY=<tests only>
SUPABASE_SERVICE_ROLE_KEY=<tests only>
```

`apps/api/eslint.config.mjs`: `export { default } from "@cortex/config/eslint.base.mjs";`

- [ ] **Step 2: Write the failing e2e test**

`apps/api/test/app.e2e.test.ts`:
```ts
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createClient } from "@supabase/supabase-js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";

const url = process.env.SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function getToken(email: string): Promise<{ token: string; userId: string }> {
  const password = "cortex-test-password-123";
  await admin.from("allowed_emails").upsert({ email });
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error && !created.error.message.includes("already been registered")) throw created.error;
  const client = createClient(url, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { token: data.session!.access_token, userId: data.user!.id };
}

describe("api skeleton", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it("GET /health is public", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /me without token → 401", async () => {
    const res = await request(app.getHttpServer()).get("/me");
    expect(res.status).toBe(401);
  });

  it("GET /me with garbage token → 401", async () => {
    const res = await request(app.getHttpServer()).get("/me").set("Authorization", "Bearer nonsense");
    expect(res.status).toBe(401);
  });

  it("GET /me with a real Supabase JWT → id + email", async () => {
    const { token, userId } = await getToken("api-e2e@test.local");
    const res = await request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: userId, email: "api-e2e@test.local" });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @cortex/api test`
Expected: FAIL — cannot resolve `../src/app.module`.

- [ ] **Step 4: Implement**

`apps/api/src/main.ts`:
```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
```

`apps/api/src/app.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { MeController } from "./me.controller";

@Module({ controllers: [HealthController, MeController] })
export class AppModule {}
```

`apps/api/src/health.controller.ts`:
```ts
import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  health() {
    return { status: "ok" };
  }
}
```

`apps/api/src/auth/supabase-auth.guard.ts`:
```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface AuthedUser { id: string; email: string; token: string }

// HS256 with the project JWT secret when provided (local dev / legacy projects),
// otherwise the project's JWKS endpoint (asymmetric keys, production).
const secret = process.env.SUPABASE_JWT_SECRET
  ? new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET)
  : null;
const jwks = secret
  ? null
  : createRemoteJWKSet(new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

async function verify(token: string): Promise<JWTPayload> {
  const { payload } = secret
    ? await jwtVerify(token, secret)
    : await jwtVerify(token, jwks!);
  return payload;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) throw new UnauthorizedException("Missing bearer token");
    try {
      const payload = await verify(token);
      if (!payload.sub) throw new Error("no sub");
      req.user = { id: payload.sub, email: String(payload.email ?? ""), token };
      return true;
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
  }
}
```

`apps/api/src/auth/current-user.decorator.ts`:
```ts
import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AuthedUser } from "./supabase-auth.guard";

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedUser =>
    ctx.switchToHttp().getRequest().user,
);
```

`apps/api/src/me.controller.ts`:
```ts
import { Controller, Get, UseGuards } from "@nestjs/common";
import { CurrentUser } from "./auth/current-user.decorator";
import { SupabaseAuthGuard, type AuthedUser } from "./auth/supabase-auth.guard";

@Controller("me")
@UseGuards(SupabaseAuthGuard)
export class MeController {
  @Get()
  me(@CurrentUser() user: AuthedUser) {
    return { id: user.id, email: user.email };
  }
}
```

- [ ] **Step 5: Run tests (local Supabase running, `apps/api/.env` populated incl. `SUPABASE_JWT_SECRET` from `supabase status`)**

Run: `pnpm --filter @cortex/api test`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck, lint, build; run dev server once and curl /health**

Run: `pnpm --filter @cortex/api typecheck && pnpm --filter @cortex/api lint && pnpm --filter @cortex/api build`
Then `pnpm --filter @cortex/api start` in background, `curl http://localhost:3001/health` → `{"status":"ok"}`, stop it.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(api): nestjs skeleton with supabase jwt guard, /health and /me"
```

---

### Task 9: `apps/web` — Next.js Google login + protected page

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/eslint.config.mjs`, `apps/web/.env.example`
- Create: `apps/web/src/lib/supabase/client.ts`, `apps/web/src/lib/supabase/server.ts`, `apps/web/src/middleware.ts`
- Create: `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/app/login/page.tsx`, `apps/web/src/app/auth/callback/route.ts`, `apps/web/src/app/auth/signout/route.ts`

**Interfaces:**
- Consumes: Supabase Auth (Google provider configured locally in this task via `supabase/config.toml`; hosted config in Task 12).
- Produces: `/login` (Google button), `/auth/callback` (code exchange), `/` (protected — redirects to `/login` when signed out, shows email + sign-out when signed in). The `createClient` helpers in `src/lib/supabase/` are the pattern all future web data access uses.

- [ ] **Step 1: Scaffold**

`apps/web/package.json`:
```json
{
  "name": "@cortex/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev --port 3000",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  },
  "dependencies": {
    "@supabase/ssr": "^0.6.0",
    "@supabase/supabase-js": "^2.48.0",
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@cortex/config": "workspace:*",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "typescript": "^5.6.0"
  }
}
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "@cortex/config/tsconfig.base.json",
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "lib": ["dom", "dom.iterable", "es2022"],
    "noEmit": true,
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`apps/web/next.config.ts`:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default nextConfig;
```

`apps/web/.env.example`:
```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from `supabase status`>
```

`apps/web/eslint.config.mjs`:
```js
export { default } from "@cortex/config/eslint.base.mjs";
```

- [ ] **Step 2: Enable Google provider on the local stack**

In `supabase/config.toml` add (client id/secret come from the Google Cloud OAuth client — for local dev you can defer real Google and validate the redirect flow at Task 12; email/password sign-in covers local testing):
```toml
[auth.external.google]
enabled = true
client_id = "env(GOOGLE_OAUTH_CLIENT_ID)"
secret = "env(GOOGLE_OAUTH_CLIENT_SECRET)"
```
Run `supabase stop && supabase start` (with those env vars set, or leave placeholders and test Google end-to-end in Task 12).

- [ ] **Step 3: Implement supabase helpers + middleware**

`apps/web/src/lib/supabase/client.ts`:
```ts
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

`apps/web/src/lib/supabase/server.ts`:
```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // called from a Server Component; middleware refreshes sessions instead
          }
        },
      },
    },
  );
}
```

`apps/web/src/middleware.ts`:
```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  await supabase.auth.getUser(); // refresh session cookie if expired
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
```

- [ ] **Step 4: Implement pages + routes**

`apps/web/src/app/layout.tsx`:
```tsx
export const metadata = { title: "Cortex" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`apps/web/src/app/login/page.tsx`:
```tsx
"use client";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  async function signIn() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${location.origin}/auth/callback` },
    });
  }
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <button onClick={signIn}>Sign in with Google</button>
    </main>
  );
}
```

`apps/web/src/app/auth/callback/route.ts`:
```ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/`);
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
```

`apps/web/src/app/auth/signout/route.ts`:
```ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url));
}
```

`apps/web/src/app/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return (
    <main style={{ padding: 24 }}>
      <h1>Cortex</h1>
      <p>Signed in as {user.email}</p>
      <form action="/auth/signout" method="post"><button>Sign out</button></form>
    </main>
  );
}
```

- [ ] **Step 5: Verify manually**

Run: `pnpm --filter @cortex/web typecheck && pnpm --filter @cortex/web lint && pnpm --filter @cortex/web build`, then `pnpm --filter @cortex/web dev`.
Expected: visiting `http://localhost:3000` redirects to `/login`. (Full Google round-trip is verified against hosted Supabase in Task 12; locally, protected-route redirect + build passing is the acceptance bar.)

- [ ] **Step 6: Commit**

```bash
git add apps/web supabase/config.toml
git commit -m "feat(web): nextjs app with supabase google oauth login and protected home"
```

---

### Task 10: `apps/mobile` — Expo Google login

**Files:**
- Create: `apps/mobile/package.json`, `apps/mobile/tsconfig.json`, `apps/mobile/app.json`, `apps/mobile/eslint.config.mjs`, `apps/mobile/.env.example`
- Create: `apps/mobile/src/lib/supabase.ts`, `apps/mobile/src/lib/auth.ts`
- Create: `apps/mobile/app/_layout.tsx`, `apps/mobile/app/index.tsx`

**Interfaces:**
- Consumes: Supabase Auth Google provider (hosted config in Task 12; the OAuth flow requires the hosted project — local Supabase is unreachable from a phone without tunneling).
- Produces: Expo app with `signInWithGoogle()` (browser-based OAuth → `supabase.auth.setSession`) and a home screen showing the signed-in email. `src/lib/supabase.ts` is the client every future mobile feature imports. Deep-link scheme: `cortex://`.

- [ ] **Step 1: Scaffold with create-expo-app, then trim**

Run: `pnpm create expo-app@latest apps/mobile --template blank-typescript` (then move config to match below), or write files directly:

`apps/mobile/package.json`:
```json
{
  "name": "@cortex/mobile",
  "version": "0.0.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "dev": "expo start",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  },
  "dependencies": {
    "@react-native-async-storage/async-storage": "*",
    "@supabase/supabase-js": "^2.48.0",
    "expo": "*",
    "expo-auth-session": "*",
    "expo-constants": "*",
    "expo-crypto": "*",
    "expo-linking": "*",
    "expo-router": "*",
    "expo-status-bar": "*",
    "expo-web-browser": "*",
    "react": "*",
    "react-native": "*",
    "react-native-url-polyfill": "^2.0.0",
    "react-native-safe-area-context": "*",
    "react-native-screens": "*"
  },
  "devDependencies": {
    "@cortex/config": "workspace:*",
    "@types/react": "*",
    "typescript": "^5.6.0"
  }
}
```
(`*` versions: run `npx expo install` after `pnpm install` so Expo pins SDK-compatible versions — commit the resolved `package.json`.)

`apps/mobile/app.json`:
```json
{
  "expo": {
    "name": "Cortex",
    "slug": "cortex",
    "scheme": "cortex",
    "version": "0.1.0",
    "orientation": "portrait",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "ios": { "bundleIdentifier": "app.cortex.mobile", "supportsTablet": false },
    "android": { "package": "app.cortex.mobile" },
    "plugins": ["expo-router", "expo-web-browser"]
  }
}
```

`apps/mobile/tsconfig.json`:
```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": { "strict": true, "paths": { "@/*": ["./src/*"] } },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

`apps/mobile/.env.example`:
```
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<hosted anon key — set in Task 12>
```

`apps/mobile/eslint.config.mjs`:
```js
export { default } from "@cortex/config/eslint.base.mjs";
```

- [ ] **Step 2: Implement the Supabase client**

`apps/mobile/src/lib/supabase.ts`:
```ts
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);
```

- [ ] **Step 3: Implement the OAuth flow (Supabase-documented Expo pattern)**

`apps/mobile/src/lib/auth.ts`:
```ts
import { makeRedirectUri } from "expo-auth-session";
import * as QueryParams from "expo-auth-session/build/QueryParams";
import * as WebBrowser from "expo-web-browser";
import { supabase } from "./supabase";

WebBrowser.maybeCompleteAuthSession();

const redirectTo = makeRedirectUri({ scheme: "cortex" });

export async function signInWithGoogle(): Promise<void> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== "success") return;

  const { params, errorCode } = QueryParams.getQueryParams(result.url);
  if (errorCode) throw new Error(errorCode);
  const { access_token, refresh_token } = params;
  if (!access_token || !refresh_token) return;

  const { error: sessionError } = await supabase.auth.setSession({ access_token, refresh_token });
  if (sessionError) throw sessionError;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
```

- [ ] **Step 4: Implement screens**

`apps/mobile/app/_layout.tsx`:
```tsx
import { Stack } from "expo-router";

export default function RootLayout() {
  return <Stack screenOptions={{ headerTitle: "Cortex" }} />;
}
```

`apps/mobile/app/index.tsx`:
```tsx
import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Button, Text, View } from "react-native";
import { signInWithGoogle, signOut } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16 }}>
      {session ? (
        <>
          <Text>Signed in as {session.user.email}</Text>
          <Button title="Sign out" onPress={() => void signOut()} />
        </>
      ) : (
        <Button title="Sign in with Google" onPress={() => void signInWithGoogle()} />
      )}
    </View>
  );
}
```

- [ ] **Step 5: Verify locally**

Run: `pnpm install && pnpm --filter @cortex/mobile exec expo install` (pins SDK versions), then `pnpm --filter @cortex/mobile typecheck` and `pnpm --filter @cortex/mobile exec expo start`.
Expected: typecheck clean; app boots in Expo Go showing the sign-in button. (End-to-end Google login is verified in Task 12 against hosted Supabase.)

- [ ] **Step 6: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): expo app with supabase google oauth flow"
```

---

### Task 11: CI — GitHub Actions (typecheck, lint, unit + RLS tests)

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: all package scripts (Tasks 1–10); Supabase CLI GitHub action.
- Produces: CI that fails the build when typecheck/lint/tests — **including the RLS isolation suite** — fail. Required for every later phase's PRs.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run typecheck lint
      - run: pnpm --filter @cortex/shared test

  db-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      - run: pnpm install --frozen-lockfile
      - run: supabase start
      - name: Export local keys
        run: supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET)=' >> keys.env
      - name: Run db + api tests
        run: |
          set -a; source keys.env; set +a
          export SUPABASE_URL="$API_URL"
          export SUPABASE_ANON_KEY="$ANON_KEY"
          export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
          export SUPABASE_JWT_SECRET="$JWT_SECRET"
          pnpm --filter @cortex/db test
          pnpm --filter @cortex/api test
```

Note: `supabase status -o env` key names can differ by CLI version (`API_URL` vs `SUPABASE_URL`). First CI run tells you; adjust the grep/exports once and pin `version:` in `supabase/setup-cli` to the version you validated locally.

- [ ] **Step 2: Push a branch and verify both jobs green**

Run:
```bash
git checkout -b ci-setup
git add .github
git commit -m "ci: typecheck, lint, unit and RLS test workflow"
git push -u origin ci-setup
```
Open a PR, watch both jobs pass. Fix env-name mismatches if the db job fails on missing vars.

- [ ] **Step 3: Merge to main**

```bash
git checkout main
git merge ci-setup
git push
```

---

### Task 12: Deploy — hosted Supabase + Google OAuth + Railway API

**Files:**
- Create: `apps/api/Dockerfile`, `apps/api/.dockerignore`
- Create: `docs/deploy.md` (records every console setting below so it's reproducible)

**Interfaces:**
- Consumes: everything above.
- Produces: hosted Supabase project with schema + invite gate; Google OAuth working on hosted web + mobile; API live at a Railway URL answering `/health` and `/me`. This is the Phase 0 demo environment; Phase 1 builds on it.

- [ ] **Step 1: Create and link the hosted Supabase project, push schema**

```bash
supabase login
supabase projects create cortex --org-id <your-org> --db-password <strong-password> --region ap-southeast-1
supabase link --project-ref <project-ref>
supabase db push          # applies migrations 00001..00008
```
Then seed your invite list (SQL editor or psql):
```sql
insert into public.allowed_emails (email, note) values
  ('phuong011999vn@gmail.com', 'owner');
```

- [ ] **Step 2: Google Cloud OAuth client + Supabase provider config**

In Google Cloud Console (`APIs & Services → Credentials`): create OAuth client (Web application). Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`. Configure the consent screen (External, add your test emails).
In Supabase Dashboard (`Authentication → Providers → Google`): enable, paste client ID + secret.
In `Authentication → URL Configuration`: Site URL `http://localhost:3000` for now; add redirect URLs `http://localhost:3000/auth/callback` and `cortex://*` (mobile deep link).
Record all of it in `docs/deploy.md`.

- [ ] **Step 3: Verify web login end-to-end**

Point `apps/web/.env.local` at the hosted project (`NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co`, hosted anon key). `pnpm --filter @cortex/web dev` → sign in with your Google account → home shows your email. Also verify the gate: a Google account **not** in `allowed_emails` must be rejected (Supabase shows a database-error message on callback — acceptable for now; friendlier copy is a later polish item).

- [ ] **Step 4: Verify mobile login end-to-end**

Set `apps/mobile/.env` to the hosted URL + anon key. `pnpm --filter @cortex/mobile exec expo start`, open on device → Sign in with Google → email shown. This plus Step 3 is the spec's "log in on phone + web with the same Google account".

- [ ] **Step 5: Dockerfile for the API**

`apps/api/Dockerfile`:
```dockerfile
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @cortex/api...
RUN pnpm --filter @cortex/api build
RUN pnpm --filter @cortex/api deploy --prod /app

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app .
COPY --from=build /repo/apps/api/dist ./dist
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "dist/main.js"]
```

`apps/api/.dockerignore`:
```
node_modules
dist
.env
```

Verify locally: `docker build -f apps/api/Dockerfile -t cortex-api .` then `docker run -p 3001:3001 -e SUPABASE_URL=https://<ref>.supabase.co cortex-api` and `curl localhost:3001/health`.

- [ ] **Step 6: Deploy to Railway**

```bash
railway login
railway init --name cortex-api
railway variables --set "SUPABASE_URL=https://<project-ref>.supabase.co" --set "PORT=3001"
railway up --dockerfile apps/api/Dockerfile
```
(Do **not** set `SUPABASE_JWT_SECRET` in prod — guard then verifies via hosted JWKS.)
Verify: `curl https://<railway-domain>/health` → `{"status":"ok"}`; `GET /me` with a token copied from the hosted web session → your id + email.

- [ ] **Step 7: Write `docs/deploy.md` and commit**

Document: project refs, console URLs, every dashboard setting from Steps 1–2, Railway env vars, and the two verification curls.

```bash
git add apps/api/Dockerfile apps/api/.dockerignore docs/deploy.md
git commit -m "feat(deploy): api dockerfile, railway deploy, hosted supabase + google oauth docs"
git push
```

---

## Phase 0 Definition of Done (spec §13 row 0)

- [ ] `pnpm turbo run typecheck lint test` green locally and in CI
- [ ] RLS isolation suite green: cross-user reads provably empty on every client-visible table
- [ ] Invite gate: non-allow-listed Google account cannot sign up
- [ ] Same Google account signed in on web (hosted) and phone
- [ ] `https://<railway-domain>/health` returns `{"status":"ok"}`; `/me` returns your identity from a real JWT
