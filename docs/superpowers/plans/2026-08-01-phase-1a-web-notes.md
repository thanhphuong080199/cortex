# Phase 1a — Web Notes (online-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web notes CRUD with quick capture, Realtime live list, manual tags, FTS search, trash/restore/purge, and markdown+zip export — per the approved spec `docs/superpowers/specs/2026-08-01-phase-1a-web-notes-design.md`.

**Architecture:** Reads go browser → Supabase (RLS + Realtime); writes go browser → NestJS API (bearer JWT) → `packages/core` services → supabase-js client built per-request from the caller's JWT. RLS is the enforcement everywhere; no service-role key on the write path.

**Tech Stack:** Next.js 15 (app router, `@supabase/ssr`), NestJS 11, zod 4, supabase-js 2, vitest 3, supertest, `archiver` + `yaml` + (dev) `adm-zip`.

## Global Constraints

- Foreign or missing resources return **404, never 403** (spec §6) — "not found" and "not yours" must be indistinguishable.
- No service-role key anywhere in `packages/core` or `apps/api` request paths (spec §4.1).
- Purge (`DELETE /notes/:id/purge`) is valid **only when `deleted_at is not null`**; otherwise 404 (spec §4).
- zod schemas live in `packages/shared/src/dto/` and are consumed by both API pipes and the web fetch client — one definition (spec §4.2).
- All tests run against the local Supabase stack already used by `packages/db` (env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
- Commit after every task (conventional commits, as in git history).
- Web UI: no Playwright in 1a; vitest on pure logic only (spec §7).
- Monorepo: new package `packages/core` must be added to workspace deps of `apps/api`; turbo picks it up from the existing workspace glob.

---

### Task 1: Migrations 00010 (realtime publication) + 00011 (note_tags partial unique)

**Files:**
- Create: `supabase/migrations/00010_realtime_publication.sql`
- Create: `supabase/migrations/00011_note_tags_partial_unique.sql`
- Test: `packages/db/src/test/note-tags-reattach.test.ts`

**Interfaces:**
- Produces: `notes`, `tags`, `note_tags` in the `supabase_realtime` publication; `note_tags` unique on `(note_id, tag_id) where deleted_at is null` (constraint `note_tags_note_id_tag_id_key` dropped, index `note_tags_note_tag_uidx` added).

- [ ] **Step 1: Write the failing test** — detach (soft-delete) then re-attach the same tag must not violate a unique constraint:

```ts
// packages/db/src/test/note-tags-reattach.test.ts
import { describe, expect, it } from "vitest";
import { makeUser } from "./clients";

describe("note_tags detach → re-attach", () => {
  it("allows re-attaching a tag after soft-deleting the link", async () => {
    const { client, id } = await makeUser("reattach@test.local");
    const { data: note } = await client.from("notes")
      .insert({ user_id: id, content: "re-attach cycle" }).select().single();
    const { data: tag } = await client.from("tags")
      .insert({ user_id: id, name: "cycle" }).select().single();

    const first = await client.from("note_tags")
      .insert({ user_id: id, note_id: note!.id, tag_id: tag!.id, source: "user" })
      .select().single();
    expect(first.error).toBeNull();

    const del = await client.from("note_tags")
      .update({ deleted_at: new Date().toISOString() }).eq("id", first.data!.id);
    expect(del.error).toBeNull();

    const second = await client.from("note_tags")
      .insert({ user_id: id, note_id: note!.id, tag_id: tag!.id, source: "user" });
    expect(second.error).toBeNull(); // fails with 23505 before migration 00011
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cortex/db test -- note-tags-reattach`
Expected: FAIL — second insert errors with `23505` (duplicate key `note_tags_note_id_tag_id_key`).

- [ ] **Step 3: Write the migrations**

```sql
-- supabase/migrations/00010_realtime_publication.sql
-- Supabase ships supabase_realtime as an EMPTY publication; without this no
-- postgres_changes events broadcast at all (spec §3).
alter publication supabase_realtime add table public.notes, public.tags, public.note_tags;
```

```sql
-- supabase/migrations/00011_note_tags_partial_unique.sql
-- Soft-deleting a tag link then re-adding the same tag violated the total
-- unique constraint. Mirror what `tags` already does: partial unique index.
alter table public.note_tags drop constraint note_tags_note_id_tag_id_key;
create unique index note_tags_note_tag_uidx
  on public.note_tags (note_id, tag_id) where deleted_at is null;
```

- [ ] **Step 4: Apply migrations and verify the test passes**

Run: `supabase db reset` (or `supabase migration up` on the running local stack), then `pnpm --filter @cortex/db test -- note-tags-reattach`
Expected: PASS. Also run the full db suite (`pnpm --filter @cortex/db test`) — the RLS isolation, enum-parity, and default-grants suites must stay green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00010_realtime_publication.sql supabase/migrations/00011_note_tags_partial_unique.sql packages/db/src/test/note-tags-reattach.test.ts
git commit -m "feat(db): realtime publication + note_tags partial unique (1a migrations)"
```

---

### Task 2: DTOs in `packages/shared`

**Files:**
- Create: `packages/shared/src/dto/notes.ts`, `packages/shared/src/dto/tags.ts`, `packages/shared/src/dto/index.ts`
- Modify: `packages/shared/src/index.ts` (re-export `./dto`)
- Test: `packages/shared/src/dto/notes.test.ts`, `packages/shared/src/dto/tags.test.ts`

**Interfaces:**
- Produces (exact exports, consumed by Tasks 8–11 pipes and Task 12 web client):
  - `createNoteInput` / `CreateNoteInput`, `updateNoteInput` / `UpdateNoteInput`
  - `createTagInput` / `CreateTagInput`, `attachTagInput` / `AttachTagInput`
- Consumes: `noteLifecycle` from `packages/shared/src/enums.ts`.

- [ ] **Step 1: Write failing tests**

```ts
// packages/shared/src/dto/notes.test.ts
import { describe, expect, it } from "vitest";
import { createNoteInput, updateNoteInput } from "./notes";

describe("createNoteInput", () => {
  it("accepts content only", () => {
    expect(createNoteInput.safeParse({ content: "hi" }).success).toBe(true);
  });
  it("rejects content over 100k chars", () => {
    expect(createNoteInput.safeParse({ content: "x".repeat(100_001) }).success).toBe(false);
  });
});

describe("updateNoteInput", () => {
  it("rejects an empty object", () => {
    expect(updateNoteInput.safeParse({}).success).toBe(false);
  });
  it("accepts lifecycle-only patch", () => {
    expect(updateNoteInput.safeParse({ lifecycle: "archived" }).success).toBe(true);
  });
  it("accepts explicit null title (clear title)", () => {
    expect(updateNoteInput.safeParse({ title: null }).success).toBe(true);
  });
  it("rejects unknown lifecycle", () => {
    expect(updateNoteInput.safeParse({ lifecycle: "zombie" }).success).toBe(false);
  });
});
```

```ts
// packages/shared/src/dto/tags.test.ts
import { describe, expect, it } from "vitest";
import { attachTagInput, createTagInput } from "./tags";

describe("createTagInput", () => {
  it("trims and requires non-empty name", () => {
    expect(createTagInput.safeParse({ name: "  " }).success).toBe(false);
    expect(createTagInput.parse({ name: " ideas " }).name).toBe("ideas");
  });
  it("validates color as #rrggbb", () => {
    expect(createTagInput.safeParse({ name: "x", color: "#12abEF" }).success).toBe(true);
    expect(createTagInput.safeParse({ name: "x", color: "red" }).success).toBe(false);
  });
});

describe("attachTagInput", () => {
  it("requires a uuid tagId", () => {
    expect(attachTagInput.safeParse({ tagId: "not-a-uuid" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cortex/shared test`
Expected: FAIL — module `./notes` / `./tags` not found.

- [ ] **Step 3: Implement the DTOs (verbatim from spec §4.2)**

```ts
// packages/shared/src/dto/notes.ts
import { z } from "zod";
import { noteLifecycle } from "../enums";

export const createNoteInput = z.object({
  content: z.string().max(100_000),
  title: z.string().max(500).optional(),
});
export type CreateNoteInput = z.infer<typeof createNoteInput>;

export const updateNoteInput = z
  .object({
    content: z.string().max(100_000).optional(),
    title: z.string().max(500).nullable().optional(),
    lifecycle: noteLifecycle.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "at least one field required");
export type UpdateNoteInput = z.infer<typeof updateNoteInput>;
```

```ts
// packages/shared/src/dto/tags.ts
import { z } from "zod";

export const createTagInput = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type CreateTagInput = z.infer<typeof createTagInput>;

export const attachTagInput = z.object({ tagId: z.uuid() });
export type AttachTagInput = z.infer<typeof attachTagInput>;
```

```ts
// packages/shared/src/dto/index.ts
export * from "./notes";
export * from "./tags";
```

Add `export * from "./dto";` to `packages/shared/src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @cortex/shared test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): zod DTOs for notes and tags (1a)"
```

---

### Task 3: `packages/core` scaffold — `createUserClient` + `mapPostgrestError`

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`
- Create: `packages/core/src/supabase.ts`, `packages/core/src/errors.ts`, `packages/core/src/index.ts`
- Create: `packages/core/src/test/harness.ts` (self-contained copy of the `makeUser` pattern — deliberately not imported from `@cortex/db` to avoid publishing another package's test internals as an API)
- Test: `packages/core/src/errors.test.ts`

**Interfaces:**
- Produces (consumed by every later core/api task):
  - `createUserClient(jwt: string): SupabaseClient` — anon-key client with `Authorization: Bearer <jwt>` header, `persistSession: false` (spec §4.1, verbatim).
  - `mapPostgrestError(error: PostgrestError): CoreError` where `CoreError = { kind: "not_found" | "conflict" | "internal"; cause: PostgrestError }`.
  - `NOT_FOUND`, `CONFLICT`, `INTERNAL` are the `kind` discriminants controllers switch on (Task 9).
  - Test harness: `makeUser(email): Promise<{ client, id, token }>` — **also returns the access token** (core services take a JWT, not a client).

- [ ] **Step 1: Create the package**

```json
// packages/core/package.json
{
  "name": "@cortex/core",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit", "lint": "eslint .", "test": "vitest run" },
  "dependencies": {
    "@cortex/shared": "workspace:*",
    "@supabase/supabase-js": "^2.48.0",
    "archiver": "^7.0.0",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "@cortex/config": "workspace:*",
    "@types/archiver": "^6.0.0",
    "adm-zip": "^0.5.16",
    "@types/adm-zip": "^0.5.5",
    "dotenv": "^16.4.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json` and `vitest.config.ts`: copy the shape used by `packages/db` (extends `@cortex/config` base; vitest loads `dotenv/config`). Run `pnpm install`.

- [ ] **Step 2: Write the failing test**

```ts
// packages/core/src/errors.test.ts
import { describe, expect, it } from "vitest";
import { mapPostgrestError } from "./errors";

const pgErr = (code: string) => ({ code, message: "m", details: "", hint: "" }) as any;

describe("mapPostgrestError", () => {
  it("maps PGRST116 (zero rows on .single()) to not_found", () => {
    expect(mapPostgrestError(pgErr("PGRST116")).kind).toBe("not_found");
  });
  it("maps 23505 to conflict", () => {
    expect(mapPostgrestError(pgErr("23505")).kind).toBe("conflict");
  });
  it("maps anything else to internal", () => {
    expect(mapPostgrestError(pgErr("XX000")).kind).toBe("internal");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @cortex/core test` — Expected: FAIL (`./errors` not found).

- [ ] **Step 4: Implement**

```ts
// packages/core/src/supabase.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Per-request client carrying the caller's JWT. RLS is the enforcement —
// no service-role key on this path (spec §4.1).
export function createUserClient(jwt: string): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
}
```

```ts
// packages/core/src/errors.ts
import type { PostgrestError } from "@supabase/supabase-js";

export type CoreErrorKind = "not_found" | "conflict" | "internal";
export interface CoreError { kind: CoreErrorKind; cause: PostgrestError }

// Keeps PostgREST codes from leaking into HTTP responses (spec §6).
export function mapPostgrestError(error: PostgrestError): CoreError {
  if (error.code === "PGRST116") return { kind: "not_found", cause: error };
  if (error.code === "23505") return { kind: "conflict", cause: error };
  return { kind: "internal", cause: error };
}
```

```ts
// packages/core/src/test/harness.ts
// Self-contained sign-in harness (same pattern as packages/db/src/test/clients.ts,
// plus the access token, because core services take a JWT).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const TEST_PASSWORD = "cortex-test-password-123";

export async function makeUser(email: string): Promise<{ client: SupabaseClient; id: string; token: string }> {
  const normalized = email.toLowerCase();
  const { error: upsertErr } = await admin.from("allowed_emails").upsert({ email: normalized });
  if (upsertErr) throw upsertErr;
  const created = await admin.auth.admin.createUser({ email: normalized, password: TEST_PASSWORD, email_confirm: true });
  if (created.error && !created.error.message.includes("already been registered")) throw created.error;
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email: normalized, password: TEST_PASSWORD });
  if (signIn.error) throw signIn.error;
  return { client, id: signIn.data.user!.id, token: signIn.data.session!.access_token };
}
```

`packages/core/src/index.ts`: `export * from "./supabase"; export * from "./errors";`

- [ ] **Step 5: Run test to verify it passes, then commit**

Run: `pnpm --filter @cortex/core test` — Expected: PASS.

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): package scaffold with createUserClient and error mapping"
```

---

### Task 4: `NoteService` — create / update

**Files:**
- Create: `packages/core/src/notes/service.ts`, `packages/core/src/notes/index.ts`
- Modify: `packages/core/src/index.ts` (re-export `./notes`)
- Test: `packages/core/src/notes/service.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 5, 9 and by 1b's sync-upload handler later):
  - `class NoteService { constructor(client: SupabaseClient, userId: string) }`
  - `create(input: CreateNoteInput): Promise<Note>`
  - `update(id: string, input: UpdateNoteInput): Promise<Note>` — throws `CoreError{kind:"not_found"}` for foreign/missing/deleted notes
  - `Note` = the full `notes` row (`id, user_id, title, content, lifecycle, created_at, updated_at, deleted_at, ...`), typed as `packages/core/src/notes/types.ts` interface.
- Consumes: `createUserClient`, `mapPostgrestError`, DTO types from Task 2, `makeUser` harness.

- [ ] **Step 1: Write failing tests**

```ts
// packages/core/src/notes/service.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase";
import { makeUser } from "../test/harness";
import { NoteService } from "./service";

let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
let svc: NoteService;

beforeAll(async () => {
  alice = await makeUser("core-notes-alice@test.local");
  bob = await makeUser("core-notes-bob@test.local");
  svc = new NoteService(createUserClient(alice.token), alice.id);
});

describe("NoteService.create", () => {
  it("creates an inbox note with defaults", async () => {
    const note = await svc.create({ content: "hello world" });
    expect(note.lifecycle).toBe("inbox");
    expect(note.user_id).toBe(alice.id);
    expect(note.title).toBeNull();
  });
});

describe("NoteService.update", () => {
  it("patches only provided fields", async () => {
    const note = await svc.create({ content: "before", title: "t" });
    const updated = await svc.update(note.id, { lifecycle: "archived" });
    expect(updated.lifecycle).toBe("archived");
    expect(updated.content).toBe("before"); // untouched
  });
  it("throws not_found for another user's note", async () => {
    const bobsNote = await new NoteService(createUserClient(bob.token), bob.id)
      .create({ content: "bob's" });
    await expect(svc.update(bobsNote.id, { content: "steal" }))
      .rejects.toMatchObject({ kind: "not_found" });
  });
  it("throws not_found for a random uuid", async () => {
    await expect(svc.update(crypto.randomUUID(), { content: "x" }))
      .rejects.toMatchObject({ kind: "not_found" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cortex/core test -- notes` — Expected: FAIL (`./service` not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/notes/service.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateNoteInput, UpdateNoteInput } from "@cortex/shared";
import { mapPostgrestError } from "../errors";

export interface Note {
  id: string; user_id: string; title: string | null; content: string;
  lifecycle: string; source_type: string; pinned: boolean;
  created_at: string; updated_at: string; deleted_at: string | null;
}

// Services take a client + userId and know nothing about HTTP (spec §2.2).
// RLS enforces isolation; the explicit .eq("user_id") is belt-and-suspenders
// and makes zero-row results (→ not_found) deterministic in tests.
export class NoteService {
  constructor(private client: SupabaseClient, private userId: string) {}

  async create(input: CreateNoteInput): Promise<Note> {
    const { data, error } = await this.client.from("notes")
      .insert({ user_id: this.userId, content: input.content, title: input.title ?? null })
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as Note;
  }

  async update(id: string, input: UpdateNoteInput): Promise<Note> {
    const patch: Record<string, unknown> = {};
    if (input.content !== undefined) patch.content = input.content;
    if (input.title !== undefined) patch.title = input.title;
    if (input.lifecycle !== undefined) patch.lifecycle = input.lifecycle;
    const { data, error } = await this.client.from("notes")
      .update(patch)
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .select().single();
    if (error) throw mapPostgrestError(error); // zero rows → PGRST116 → not_found
    return data as Note;
  }
}
```

`packages/core/src/notes/index.ts`: `export * from "./service";` and re-export from the package index.

- [ ] **Step 4: Run tests to verify they pass** — `pnpm --filter @cortex/core test -- notes` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): NoteService create/update with not-found semantics"
```

---

### Task 5: `NoteService` — softDelete / restore / purge

**Files:**
- Modify: `packages/core/src/notes/service.ts`
- Test: `packages/core/src/notes/service.test.ts` (append)

**Interfaces:**
- Produces (consumed by Task 9):
  - `softDelete(id): Promise<{ id: string; deleted_at: string }>`
  - `restore(id): Promise<Note>` — only restores rows where `deleted_at is not null`
  - `purge(id): Promise<{ id: string }>` — hard delete, **only** on already-soft-deleted rows; otherwise `not_found` (two-step deletion invariant, spec §4)

- [ ] **Step 1: Write failing tests (append to the existing describe file)**

```ts
describe("NoteService trash lifecycle", () => {
  it("softDelete sets deleted_at; restore clears it", async () => {
    const note = await svc.create({ content: "trash me" });
    const trashed = await svc.softDelete(note.id);
    expect(trashed.deleted_at).not.toBeNull();
    const restored = await svc.restore(note.id);
    expect(restored.deleted_at).toBeNull();
  });

  it("purge on a live note is not_found (two-step deletion)", async () => {
    const note = await svc.create({ content: "still alive" });
    await expect(svc.purge(note.id)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("purge on a trashed note hard-deletes it", async () => {
    const note = await svc.create({ content: "goodbye" });
    await svc.softDelete(note.id);
    await svc.purge(note.id);
    const { data } = await alice.client.from("notes").select("id").eq("id", note.id);
    expect(data).toEqual([]);
  });

  it("update refuses a trashed note (not_found)", async () => {
    const note = await svc.create({ content: "trashed, not editable" });
    await svc.softDelete(note.id);
    await expect(svc.update(note.id, { content: "zombie edit" }))
      .rejects.toMatchObject({ kind: "not_found" });
  });
});
```

- [ ] **Step 2: Run to verify failure** — methods don't exist → FAIL.

- [ ] **Step 3: Implement (append to `NoteService`)**

```ts
  async softDelete(id: string): Promise<{ id: string; deleted_at: string }> {
    const { data, error } = await this.client.from("notes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .select("id, deleted_at").single();
    if (error) throw mapPostgrestError(error);
    return data as { id: string; deleted_at: string };
  }

  async restore(id: string): Promise<Note> {
    const { data, error } = await this.client.from("notes")
      .update({ deleted_at: null })
      .eq("id", id).eq("user_id", this.userId).not("deleted_at", "is", null)
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as Note;
  }

  async purge(id: string): Promise<{ id: string }> {
    // Hard delete allowed ONLY from trash. delete() returns the deleted rows via
    // .select(); zero rows (live note / foreign / missing) → PGRST116 → not_found.
    const { data, error } = await this.client.from("notes")
      .delete()
      .eq("id", id).eq("user_id", this.userId).not("deleted_at", "is", null)
      .select("id").single();
    if (error) throw mapPostgrestError(error);
    return data as { id: string };
  }
```

- [ ] **Step 4: Run tests** — `pnpm --filter @cortex/core test -- notes` → PASS (all, including Task 4's).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/notes
git commit -m "feat(core): note trash lifecycle - softDelete/restore/purge with two-step guard"
```

---

### Task 6: `TagService` — find-or-create, attach, detach

**Files:**
- Create: `packages/core/src/organize/service.ts`, `packages/core/src/organize/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/organize/service.test.ts`

**Interfaces:**
- Produces (consumed by Task 10):
  - `class TagService { constructor(client: SupabaseClient, userId: string) }`
  - `findOrCreate(input: CreateTagInput): Promise<Tag>` — case-insensitive match on `lower(name)`; on `23505` race, retries the select once and returns the existing row (spec §6 table)
  - `attach(noteId: string, tagId: string): Promise<NoteTag>` — `source:'user'`, `status:'accepted'`; foreign note/tag → `not_found`
  - `detach(noteId: string, tagId: string): Promise<void>` — sets `deleted_at` on the live link; missing link → `not_found`
  - `Tag = { id, user_id, name, color, created_by, created_at, deleted_at }`, `NoteTag = { id, note_id, tag_id, source, status }`

- [ ] **Step 1: Write failing tests**

```ts
// packages/core/src/organize/service.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase";
import { makeUser } from "../test/harness";
import { NoteService } from "../notes/service";
import { TagService } from "./service";

let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
let tags: TagService;
let notes: NoteService;

beforeAll(async () => {
  alice = await makeUser("core-tags-alice@test.local");
  bob = await makeUser("core-tags-bob@test.local");
  tags = new TagService(createUserClient(alice.token), alice.id);
  notes = new NoteService(createUserClient(alice.token), alice.id);
});

describe("TagService.findOrCreate", () => {
  it("is idempotent and case-insensitive", async () => {
    const a = await tags.findOrCreate({ name: "Ideas" });
    const b = await tags.findOrCreate({ name: "ideas" });
    expect(b.id).toBe(a.id);
    expect(a.created_by).toBe("user");
  });
});

describe("attach / detach / re-attach", () => {
  it("survives the full cycle (migration 00011 contract)", async () => {
    const note = await notes.create({ content: "taggable" });
    const tag = await tags.findOrCreate({ name: "cycle-core" });
    const link = await tags.attach(note.id, tag.id);
    expect(link.status).toBe("accepted");
    await tags.detach(note.id, tag.id);
    const relink = await tags.attach(note.id, tag.id); // must not 23505
    expect(relink.id).not.toBe(link.id);
  });

  it("attaching to a foreign note is not_found", async () => {
    const bobsNote = await new NoteService(createUserClient(bob.token), bob.id)
      .create({ content: "bob note" });
    const tag = await tags.findOrCreate({ name: "trespass" });
    await expect(tags.attach(bobsNote.id, tag.id))
      .rejects.toMatchObject({ kind: "not_found" });
  });

  it("detaching a non-attached tag is not_found", async () => {
    const note = await notes.create({ content: "bare" });
    const tag = await tags.findOrCreate({ name: "never-attached" });
    await expect(tags.detach(note.id, tag.id))
      .rejects.toMatchObject({ kind: "not_found" });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @cortex/core test -- organize` → FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/organize/service.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateTagInput } from "@cortex/shared";
import { mapPostgrestError } from "../errors";

export interface Tag { id: string; user_id: string; name: string; color: string | null; created_by: string; created_at: string; deleted_at: string | null }
export interface NoteTag { id: string; note_id: string; tag_id: string; source: string; status: string }

export class TagService {
  constructor(private client: SupabaseClient, private userId: string) {}

  async findOrCreate(input: CreateTagInput): Promise<Tag> {
    const existing = await this.client.from("tags")
      .select().eq("user_id", this.userId).ilike("name", input.name)
      .is("deleted_at", null).maybeSingle();
    if (existing.error) throw mapPostgrestError(existing.error);
    if (existing.data) return existing.data as Tag;

    const inserted = await this.client.from("tags")
      .insert({ user_id: this.userId, name: input.name, color: input.color ?? null, created_by: "user" })
      .select().single();
    if (!inserted.error) return inserted.data as Tag;

    // 23505 race: another request created it between our select and insert —
    // retry the select once and return the existing row (spec §6).
    if (inserted.error.code === "23505") {
      const retry = await this.client.from("tags")
        .select().eq("user_id", this.userId).ilike("name", input.name)
        .is("deleted_at", null).single();
      if (retry.error) throw mapPostgrestError(retry.error);
      return retry.data as Tag;
    }
    throw mapPostgrestError(inserted.error);
  }

  async attach(noteId: string, tagId: string): Promise<NoteTag> {
    // RLS makes an insert referencing a foreign note/tag fail; surface as not_found.
    const { data, error } = await this.client.from("note_tags")
      .insert({ user_id: this.userId, note_id: noteId, tag_id: tagId, source: "user", status: "accepted" })
      .select("id, note_id, tag_id, source, status").single();
    if (error) {
      // FK violation (23503) or RLS check failure (42501) on a foreign row must be
      // indistinguishable from "does not exist" (spec §6).
      if (error.code === "23503" || error.code === "42501") {
        throw { kind: "not_found", cause: error };
      }
      throw mapPostgrestError(error);
    }
    return data as NoteTag;
  }

  async detach(noteId: string, tagId: string): Promise<void> {
    const { data, error } = await this.client.from("note_tags")
      .update({ deleted_at: new Date().toISOString() })
      .eq("user_id", this.userId).eq("note_id", noteId).eq("tag_id", tagId)
      .is("deleted_at", null)
      .select("id").single();
    if (error) throw mapPostgrestError(error);
    if (!data) throw { kind: "not_found" };
  }
}
```

- [ ] **Step 4: Run tests** — PASS. Also re-run the whole core suite.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/organize packages/core/src/index.ts
git commit -m "feat(core): TagService find-or-create, attach/detach with 23505 retry"
```

---

### Task 7: `ExportService` — slug, frontmatter, zip stream

**Files:**
- Create: `packages/core/src/export/slug.ts`, `packages/core/src/export/service.ts`, `packages/core/src/export/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/export/slug.test.ts`, `packages/core/src/export/service.test.ts`

**Interfaces:**
- Produces (consumed by Task 11):
  - `noteFilename(note: { id: string; title: string | null; content: string }): string` — kebab-case slug of title (or first content line) + `-` + first 8 chars of id + `.md`
  - `class ExportService { constructor(client: SupabaseClient, userId: string) }`
  - `buildArchive(out: NodeJS.WritableStream): Promise<void>` — pipes a zip (`manifest.json`, `README.md`, `notes/*.md` with YAML frontmatter) into `out`; excludes soft-deleted notes; frontmatter fields: `id, title, tags, lifecycle, created_at, updated_at` (spec §4.3).

- [ ] **Step 1: Write failing slug tests**

```ts
// packages/core/src/export/slug.test.ts
import { describe, expect, it } from "vitest";
import { noteFilename } from "./slug";

describe("noteFilename", () => {
  const id = "a1b2c3d4-0000-0000-0000-000000000000";
  it("slugs the title", () => {
    expect(noteFilename({ id, title: "Pricing Psychology!", content: "" }))
      .toBe("pricing-psychology-a1b2c3d4.md");
  });
  it("falls back to first content line when untitled", () => {
    expect(noteFilename({ id, title: null, content: "sync conflict notes\nmore" }))
      .toBe("sync-conflict-notes-a1b2c3d4.md");
  });
  it("never returns an empty slug", () => {
    expect(noteFilename({ id, title: null, content: "???" }))
      .toBe("note-a1b2c3d4.md");
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// packages/core/src/export/slug.ts
export function noteFilename(note: { id: string; title: string | null; content: string }): string {
  const base = (note.title ?? note.content.split("\n")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "note"}-${note.id.slice(0, 8)}.md`;
}
```

Run slug tests → PASS.

- [ ] **Step 3: Write failing service test**

```ts
// packages/core/src/export/service.test.ts
import AdmZip from "adm-zip";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createUserClient } from "../supabase";
import { makeUser } from "../test/harness";
import { NoteService } from "../notes/service";
import { TagService } from "../organize/service";
import { ExportService } from "./service";

async function collectZip(svc: ExportService): Promise<AdmZip> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c) => chunks.push(c));
  await svc.buildArchive(out);
  return new AdmZip(Buffer.concat(chunks));
}

describe("ExportService", () => {
  let zip: AdmZip;
  beforeAll(async () => {
    const alice = await makeUser("core-export-alice@test.local");
    const client = createUserClient(alice.token);
    const notes = new NoteService(client, alice.id);
    const tags = new TagService(client, alice.id);
    const note = await notes.create({ content: "# Body\ncontent here", title: "Export: me?" });
    const tag = await tags.findOrCreate({ name: "exported" });
    await tags.attach(note.id, tag.id);
    const trashed = await notes.create({ content: "should not appear" });
    await notes.softDelete(trashed.id);
    zip = await collectZip(new ExportService(client, alice.id));
  });

  it("contains manifest, README, and one note file", () => {
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("manifest.json");
    expect(names).toContain("README.md");
    expect(names.filter((n) => n.startsWith("notes/"))).toHaveLength(1); // trashed excluded
  });

  it("note file has parseable YAML frontmatter with tags", () => {
    const entry = zip.getEntries().find((e) => e.entryName.startsWith("notes/"))!;
    const text = entry.getData().toString("utf8");
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fm).not.toBeNull();
    const meta = parseYaml(fm![1]);
    expect(meta.title).toBe("Export: me?"); // the ': ' case hand-rolled YAML corrupts
    expect(meta.tags).toEqual(["exported"]);
    expect(text.endsWith("# Body\ncontent here")).toBe(true);
  });

  it("manifest lists notes, tags, note_tags", () => {
    const manifest = JSON.parse(zip.readAsText("manifest.json"));
    expect(manifest.notes).toHaveLength(1);
    expect(manifest.tags.length).toBeGreaterThanOrEqual(1);
    expect(manifest.note_tags).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run to verify failure**, then implement:

```ts
// packages/core/src/export/service.ts
import archiver from "archiver";
import type { SupabaseClient } from "@supabase/supabase-js";
import { stringify as yamlStringify } from "yaml";
import { mapPostgrestError } from "../errors";
import { noteFilename } from "./slug";

export class ExportService {
  constructor(private client: SupabaseClient, private userId: string) {}

  async buildArchive(out: NodeJS.WritableStream): Promise<void> {
    // RLS bounds every query to the caller; soft-deleted notes excluded (spec §4.3).
    const [notes, tags, noteTags] = await Promise.all([
      this.client.from("notes").select("id, title, content, lifecycle, created_at, updated_at")
        .is("deleted_at", null).order("created_at"),
      this.client.from("tags").select("id, name, color").is("deleted_at", null),
      this.client.from("note_tags").select("note_id, tag_id").is("deleted_at", null),
    ]);
    for (const r of [notes, tags, noteTags]) if (r.error) throw mapPostgrestError(r.error);

    const tagName = new Map(tags.data!.map((t) => [t.id, t.name]));
    const tagsByNote = new Map<string, string[]>();
    for (const nt of noteTags.data!) {
      const list = tagsByNote.get(nt.note_id) ?? [];
      const name = tagName.get(nt.tag_id);
      if (name) list.push(name);
      tagsByNote.set(nt.note_id, list);
    }

    const archive = archiver("zip");
    const done = new Promise<void>((resolve, reject) => {
      out.on("finish", resolve).on("close", resolve).on("error", reject);
      archive.on("error", reject);
    });
    archive.pipe(out);

    archive.append(JSON.stringify({ exported_at: new Date().toISOString(),
      notes: notes.data, tags: tags.data, note_tags: noteTags.data }, null, 2),
      { name: "manifest.json" });
    archive.append(
      "# Cortex export\n\nMarkdown notes with YAML frontmatter (drop into Obsidian/Logseq)." +
      " `manifest.json` is the full structured dump.\n",
      { name: "README.md" });

    for (const note of notes.data!) {
      // yaml package, not string concatenation: titles containing ': ' or quotes
      // silently corrupt hand-rolled YAML (spec §4.3).
      const frontmatter = yamlStringify({
        id: note.id, title: note.title, tags: tagsByNote.get(note.id) ?? [],
        lifecycle: note.lifecycle, created_at: note.created_at, updated_at: note.updated_at,
      }).trimEnd();
      archive.append(`---\n${frontmatter}\n---\n${note.content}`,
        { name: `notes/${noteFilename(note)}` });
    }
    await archive.finalize();
    await done;
  }
}
```

- [ ] **Step 5: Run tests** — `pnpm --filter @cortex/core test -- export` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/export packages/core/src/index.ts
git commit -m "feat(core): ExportService - streamed zip with yaml frontmatter and manifest"
```

---

### Task 8: API wiring — `ZodValidationPipe` + core error filter

**Files:**
- Modify: `apps/api/package.json` (add `"@cortex/core": "workspace:*"`, `"@cortex/shared": "workspace:*"`; move `@supabase/supabase-js` to dependencies)
- Create: `apps/api/src/zod-validation.pipe.ts`, `apps/api/src/core-error.filter.ts`
- Test: `apps/api/test/zod-validation.pipe.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 9–11):
  - `new ZodValidationPipe(schema)` — parses body; on failure throws `BadRequestException` whose response body is `{ message: "validation failed", issues: [{ path, message }] }` (400 with field paths, spec §6).
  - `CoreErrorFilter` — an `@Catch()` exception filter registered globally in `main.ts`: `kind:"not_found"` → 404, `kind:"conflict"` → 409, `kind:"internal"` → 500 with details logged, not echoed (spec §6). Non-core errors are rethrown to Nest's default handling.

- [ ] **Step 1: Write failing pipe test**

```ts
// apps/api/test/zod-validation.pipe.test.ts
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { createNoteInput } from "@cortex/shared";
import { ZodValidationPipe } from "../src/zod-validation.pipe";

describe("ZodValidationPipe", () => {
  const pipe = new ZodValidationPipe(createNoteInput);
  it("passes valid input through parsed", () => {
    expect(pipe.transform({ content: "ok", extra: "stripped" }))
      .toEqual({ content: "ok" });
  });
  it("throws 400 with field paths on invalid input", () => {
    try {
      pipe.transform({});
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const body = (e as BadRequestException).getResponse() as any;
      expect(body.issues[0].path).toBe("content");
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @cortex/api test -- zod-validation` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/zod-validation.pipe.ts
import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private schema: ZodType<T>) {}
  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return result.data;
  }
}
```

```ts
// apps/api/src/core-error.filter.ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";

const KINDS = new Set(["not_found", "conflict", "internal"]);
const isCoreError = (e: unknown): e is { kind: string; cause?: unknown } =>
  typeof e === "object" && e !== null && KINDS.has((e as any).kind);

@Catch()
export class CoreErrorFilter implements ExceptionFilter {
  private logger = new Logger("CoreErrorFilter");
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (isCoreError(exception)) {
      if (exception.kind === "not_found") return res.status(404).json({ message: "Not found" });
      if (exception.kind === "conflict") return res.status(409).json({ message: "Conflict" });
      this.logger.error(JSON.stringify(exception.cause)); // logged, never echoed (spec §6)
      return res.status(500).json({ message: "Internal error" });
    }
    if (exception instanceof HttpException) {
      return res.status(exception.getStatus()).json(exception.getResponse());
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ message: "Internal error" });
  }
}
```

In `apps/api/src/main.ts` add `app.useGlobalFilters(new CoreErrorFilter());`.

- [ ] **Step 4: Run tests** — PASS (pipe test; filter is covered by e2e in Task 9). Run `pnpm --filter @cortex/api typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): zod validation pipe + core error filter (404/409/500 mapping)"
```

---

### Task 9: `notes.controller` — 5 routes + e2e

**Files:**
- Create: `apps/api/src/notes.controller.ts`
- Modify: `apps/api/src/app.module.ts` (register controller)
- Test: `apps/api/test/notes.e2e.test.ts`

**Interfaces:**
- Consumes: `SupabaseAuthGuard`, `CurrentUser` decorator (`AuthedUser { id, email, token }`), `NoteService`, `createUserClient`, DTOs, `ZodValidationPipe`.
- Produces routes (spec §4): `POST /notes`, `PATCH /notes/:id`, `DELETE /notes/:id`, `POST /notes/:id/restore`, `DELETE /notes/:id/purge`.

- [ ] **Step 1: Write failing e2e tests** (bootstraps the Nest app like the existing `apps/api/test/app.e2e.test.ts` does; reuse its app-factory pattern and sign in two real users via the same harness approach as `packages/core/src/test/harness.ts` — copy `makeUser` into `apps/api/test/harness.ts` with the token return):

```ts
// apps/api/test/notes.e2e.test.ts
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { CoreErrorFilter } from "../src/core-error.filter";
import { makeUser } from "./harness";

let app: INestApplication;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new CoreErrorFilter());
  await app.init();
  alice = await makeUser("api-notes-alice@test.local");
  bob = await makeUser("api-notes-bob@test.local");
});
afterAll(async () => { await app.close(); });

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("POST /notes", () => {
  it("401 without token", async () => {
    await request(app.getHttpServer()).post("/notes").send({ content: "x" }).expect(401);
  });
  it("400 with field paths on empty body", async () => {
    const res = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({}).expect(400);
    expect(res.body.issues[0].path).toBe("content");
  });
  it("201 creates an inbox note", async () => {
    const res = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "from api" }).expect(201);
    expect(res.body.lifecycle).toBe("inbox");
  });
});

describe("note lifecycle over HTTP", () => {
  let noteId: string;
  beforeAll(async () => {
    const res = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "lifecycle" });
    noteId = res.body.id;
  });

  it("PATCH archives via lifecycle field", async () => {
    const res = await request(app.getHttpServer()).patch(`/notes/${noteId}`)
      .set(auth(alice.token)).send({ lifecycle: "archived" }).expect(200);
    expect(res.body.lifecycle).toBe("archived");
  });
  it("Bob PATCHing Alice's note is 404, not 403", async () => {
    await request(app.getHttpServer()).patch(`/notes/${noteId}`)
      .set(auth(bob.token)).send({ content: "steal" }).expect(404);
  });
  it("purge before delete is 404 (two-step)", async () => {
    await request(app.getHttpServer()).delete(`/notes/${noteId}/purge`)
      .set(auth(alice.token)).expect(404);
  });
  it("delete → restore → delete → purge", async () => {
    await request(app.getHttpServer()).delete(`/notes/${noteId}`).set(auth(alice.token)).expect(200);
    await request(app.getHttpServer()).post(`/notes/${noteId}/restore`).set(auth(alice.token)).expect(201);
    await request(app.getHttpServer()).delete(`/notes/${noteId}`).set(auth(alice.token)).expect(200);
    await request(app.getHttpServer()).delete(`/notes/${noteId}/purge`).set(auth(alice.token)).expect(200);
  });
});
```

- [ ] **Step 2: Run to verify failure** — routes don't exist → 404s where 201/200 expected.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/notes.controller.ts
import { Body, Controller, Delete, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { createUserClient, NoteService } from "@cortex/core";
import { createNoteInput, updateNoteInput, type CreateNoteInput, type UpdateNoteInput } from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("notes")
@UseGuards(SupabaseAuthGuard)
export class NotesController {
  private svc(user: AuthedUser) { return new NoteService(createUserClient(user.token), user.id); }

  @Post()
  create(@CurrentUser() user: AuthedUser,
         @Body(new ZodValidationPipe(createNoteInput)) body: CreateNoteInput) {
    return this.svc(user).create(body);
  }

  @Patch(":id")
  update(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
         @Body(new ZodValidationPipe(updateNoteInput)) body: UpdateNoteInput) {
    return this.svc(user).update(id, body);
  }

  @Delete(":id")
  softDelete(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc(user).softDelete(id);
  }

  @Post(":id/restore")
  restore(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc(user).restore(id);
  }

  @Delete(":id/purge")
  purge(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc(user).purge(id);
  }
}
```

Register in `app.module.ts`: `controllers: [HealthController, MeController, NotesController]`.

- [ ] **Step 4: Run tests** — `pnpm --filter @cortex/api test -- notes.e2e` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): notes controller - create/patch/trash/restore/purge"
```

---

### Task 10: `tags.controller` + e2e

**Files:**
- Create: `apps/api/src/tags.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/tags.e2e.test.ts`

**Interfaces:**
- Produces routes (spec §4): `POST /tags` (find-or-create), `POST /notes/:id/tags` (`{ tagId }`), `DELETE /notes/:id/tags/:tagId` → `{ ok: true }`.
- Consumes: `TagService` from Task 6, pipe/filter from Task 8.

- [ ] **Step 1: Write failing e2e tests**

```ts
// apps/api/test/tags.e2e.test.ts  (same bootstrap pattern as notes.e2e.test.ts)
describe("tags over HTTP", () => {
  it("POST /tags is find-or-create (same id for same name, case-insensitive)", async () => {
    const a = await request(app.getHttpServer()).post("/tags")
      .set(auth(alice.token)).send({ name: "Product" }).expect(201);
    const b = await request(app.getHttpServer()).post("/tags")
      .set(auth(alice.token)).send({ name: "product" }).expect(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it("attach → detach → re-attach cycle over HTTP", async () => {
    const note = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "taggable via api" });
    const tag = await request(app.getHttpServer()).post("/tags")
      .set(auth(alice.token)).send({ name: "api-cycle" });
    await request(app.getHttpServer()).post(`/notes/${note.body.id}/tags`)
      .set(auth(alice.token)).send({ tagId: tag.body.id }).expect(201);
    await request(app.getHttpServer()).delete(`/notes/${note.body.id}/tags/${tag.body.id}`)
      .set(auth(alice.token)).expect(200);
    await request(app.getHttpServer()).post(`/notes/${note.body.id}/tags`)
      .set(auth(alice.token)).send({ tagId: tag.body.id }).expect(201);
  });

  it("attaching to Bob's note is 404", async () => {
    const bobNote = await request(app.getHttpServer()).post("/notes")
      .set(auth(bob.token)).send({ content: "bob's" });
    const tag = await request(app.getHttpServer()).post("/tags")
      .set(auth(alice.token)).send({ name: "trespass-api" });
    await request(app.getHttpServer()).post(`/notes/${bobNote.body.id}/tags`)
      .set(auth(alice.token)).send({ tagId: tag.body.id }).expect(404);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
// apps/api/src/tags.controller.ts
import { Body, Controller, Delete, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { createUserClient, TagService } from "@cortex/core";
import { attachTagInput, createTagInput, type AttachTagInput, type CreateTagInput } from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller()
@UseGuards(SupabaseAuthGuard)
export class TagsController {
  private svc(user: AuthedUser) { return new TagService(createUserClient(user.token), user.id); }

  @Post("tags")
  findOrCreate(@CurrentUser() user: AuthedUser,
               @Body(new ZodValidationPipe(createTagInput)) body: CreateTagInput) {
    return this.svc(user).findOrCreate(body);
  }

  @Post("notes/:id/tags")
  attach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) noteId: string,
         @Body(new ZodValidationPipe(attachTagInput)) body: AttachTagInput) {
    return this.svc(user).attach(noteId, body.tagId);
  }

  @Delete("notes/:id/tags/:tagId")
  async detach(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) noteId: string,
               @Param("tagId", ParseUUIDPipe) tagId: string) {
    await this.svc(user).detach(noteId, tagId);
    return { ok: true };
  }
}
```

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): tags controller - find-or-create, attach, detach"
```

---

### Task 11: `export.controller` + e2e

**Files:**
- Create: `apps/api/src/export.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/export.e2e.test.ts`

**Interfaces:**
- Produces: `GET /export` → `application/zip`, filename `cortex-export-YYYY-MM-DD.zip`, streamed via `ExportService.buildArchive(res)`.

- [ ] **Step 1: Write failing e2e test**

```ts
// apps/api/test/export.e2e.test.ts (same bootstrap; alice creates a titled+tagged note first)
import AdmZip from "adm-zip";
import { parse as parseYaml } from "yaml";

it("GET /export returns a zip whose frontmatter parses", async () => {
  const res = await request(app.getHttpServer()).get("/export")
    .set(auth(alice.token))
    .buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200)
    .expect("content-type", /application\/zip/);
  const zip = new AdmZip(res.body as Buffer);
  const names = zip.getEntries().map((e) => e.entryName);
  expect(names).toContain("manifest.json");
  const noteEntry = zip.getEntries().find((e) => e.entryName.startsWith("notes/"))!;
  const fm = noteEntry.getData().toString("utf8").match(/^---\n([\s\S]*?)\n---\n/);
  expect(() => parseYaml(fm![1])).not.toThrow();
});

it("GET /export without token is 401", async () => {
  await request(app.getHttpServer()).get("/export").expect(401);
});
```

- [ ] **Step 2: Run to verify failure.** (Add `adm-zip`, `@types/adm-zip`, `yaml` to `apps/api` devDependencies.)

- [ ] **Step 3: Implement**

```ts
// apps/api/src/export.controller.ts
import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { createUserClient, ExportService } from "@cortex/core";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";

@Controller("export")
@UseGuards(SupabaseAuthGuard)
export class ExportController {
  @Get()
  async export(@CurrentUser() user: AuthedUser, @Res() res: Response) {
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="cortex-export-${date}.zip"`);
    // Piped directly into the Express response — memory stays flat (spec §4.3).
    await new ExportService(createUserClient(user.token), user.id).buildArchive(res);
  }
}
```

- [ ] **Step 4: Run tests** — PASS. Run the full api suite (`pnpm --filter @cortex/api test`).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): streamed zip export endpoint"
```

---

### Task 12: Web — vitest setup + typed API client

**Files:**
- Modify: `apps/web/package.json` (add `vitest`, `@cortex/shared`, and a `"test": "vitest run"` script)
- Create: `apps/web/vitest.config.ts`, `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/api.test.ts`

**Interfaces:**
- Produces (consumed by all later web tasks):
  - `apiFetch(path: string, init: { method: string; token: string; body?: unknown }): Promise<Response>` — prefixes `NEXT_PUBLIC_API_URL`, sets `Authorization: Bearer <token>` + JSON headers.
  - `api.createNote(token, input: CreateNoteInput)`, `api.updateNote(token, id, input)`, `api.deleteNote(token, id)`, `api.restoreNote(token, id)`, `api.purgeNote(token, id)`, `api.createTag(token, input)`, `api.attachTag(token, noteId, input: AttachTagInput)`, `api.detachTag(token, noteId, tagId)` — each validates input with the shared zod schema **before** sending and throws `ApiError { status, issues? }` on non-2xx.
- Consumes: DTOs from `@cortex/shared`.

- [ ] **Step 1: Write failing tests** (mock `fetch` — no browser, no network):

```ts
// apps/web/src/lib/api.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("typed api client", () => {
  it("sends bearer token and JSON body", async () => {
    const spy = vi.fn().mockResolvedValue(okJson({ id: "1" }, 201));
    vi.stubGlobal("fetch", spy);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.test");
    await api.createNote("tok", { content: "hi" });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://api.test/notes");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body).content).toBe("hi");
  });

  it("rejects invalid input locally without calling fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(api.createNote("tok", { content: "x".repeat(100_001) } as any))
      .rejects.toBeInstanceOf(ApiError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws ApiError with status on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ message: "Not found" }, 404)));
    await expect(api.updateNote("tok", crypto.randomUUID(), { content: "x" }))
      .rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @cortex/web test` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/api.ts
import {
  attachTagInput, createNoteInput, createTagInput, updateNoteInput,
  type AttachTagInput, type CreateNoteInput, type CreateTagInput, type UpdateNoteInput,
} from "@cortex/shared";
import type { ZodType } from "zod";

export class ApiError extends Error {
  constructor(public status: number, public issues?: unknown) { super(`API ${status}`); }
}

async function send(path: string, method: string, token: string, body?: unknown): Promise<any> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const parsed = await res.json().catch(() => undefined);
    throw new ApiError(res.status, parsed?.issues);
  }
  return res.json();
}

function validated<T>(schema: ZodType<T>, value: T): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError(0, r.error.issues);
  return r.data;
}

export const api = {
  createNote: (token: string, input: CreateNoteInput) =>
    send("/notes", "POST", token, validated(createNoteInput, input)),
  updateNote: (token: string, id: string, input: UpdateNoteInput) =>
    send(`/notes/${id}`, "PATCH", token, validated(updateNoteInput, input)),
  deleteNote: (token: string, id: string) => send(`/notes/${id}`, "DELETE", token),
  restoreNote: (token: string, id: string) => send(`/notes/${id}/restore`, "POST", token),
  purgeNote: (token: string, id: string) => send(`/notes/${id}/purge`, "DELETE", token),
  createTag: (token: string, input: CreateTagInput) =>
    send("/tags", "POST", token, validated(createTagInput, input)),
  attachTag: (token: string, noteId: string, input: AttachTagInput) =>
    send(`/notes/${noteId}/tags`, "POST", token, validated(attachTagInput, input)),
  detachTag: (token: string, noteId: string, tagId: string) =>
    send(`/notes/${noteId}/tags/${tagId}`, "DELETE", token),
};
```

`vitest.config.ts`: minimal node-environment config (no jsdom needed — pure logic only per spec §7).

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): typed api client with local zod validation"
```

---

### Task 13: Web — view predicate (pure) + note list SSR page

**Files:**
- Create: `apps/web/src/lib/note-views.ts`, `apps/web/src/app/notes-query.ts` (server-only query builder), replace `apps/web/src/app/page.tsx`
- Test: `apps/web/src/lib/note-views.test.ts`

**Interfaces:**
- Produces:
  - `type NoteView = "inbox" | "active" | "archived" | "trash"`
  - `matchesView(note: { lifecycle: string; deleted_at: string | null }, view: NoteView): boolean` — THE predicate the Realtime handler reuses (Task 14); trash = `deleted_at !== null`; other views require `deleted_at === null` && matching lifecycle (`active` view shows `active` **and** `evergreen` — both are live working notes; spec lists 4 views over 5 states).
  - `page.tsx` — server component reading `searchParams` (`view`, `q`, `tag`), querying via the `@supabase/ssr` server client from `apps/web/src/lib/supabase/server.ts`: `deleted_at is null` (inverted for trash), lifecycle filter, `.textSearch('content_text', q, { type: 'websearch', config: 'english' })`, inner join `note_tags!inner(tag_id)` for the tag filter, `.order("updated_at", { ascending: false })`. Hydrates `<NoteList initialNotes={...} view={...} />` (Task 14).

- [ ] **Step 1: Write failing predicate tests**

```ts
// apps/web/src/lib/note-views.test.ts
import { describe, expect, it } from "vitest";
import { matchesView } from "./note-views";

const live = (lifecycle: string) => ({ lifecycle, deleted_at: null });

describe("matchesView", () => {
  it("inbox shows only live inbox notes", () => {
    expect(matchesView(live("inbox"), "inbox")).toBe(true);
    expect(matchesView(live("active"), "inbox")).toBe(false);
    expect(matchesView({ lifecycle: "inbox", deleted_at: "2026-08-01" }, "inbox")).toBe(false);
  });
  it("active shows active and evergreen", () => {
    expect(matchesView(live("active"), "active")).toBe(true);
    expect(matchesView(live("evergreen"), "active")).toBe(true);
    expect(matchesView(live("archived"), "active")).toBe(false);
  });
  it("trash shows any deleted note regardless of lifecycle", () => {
    expect(matchesView({ lifecycle: "archived", deleted_at: "2026-08-01" }, "trash")).toBe(true);
    expect(matchesView(live("archived"), "trash")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// apps/web/src/lib/note-views.ts
export type NoteView = "inbox" | "active" | "archived" | "trash";
export const NOTE_VIEWS: NoteView[] = ["inbox", "active", "archived", "trash"];

export function matchesView(
  note: { lifecycle: string; deleted_at: string | null },
  view: NoteView,
): boolean {
  if (view === "trash") return note.deleted_at !== null;
  if (note.deleted_at !== null) return false;
  if (view === "active") return note.lifecycle === "active" || note.lifecycle === "evergreen";
  return note.lifecycle === view;
}
```

- [ ] **Step 3: Build the SSR page** (server component; no test — thin I/O per spec §7):

```tsx
// apps/web/src/app/page.tsx (replaces the phase-0 protected home)
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server"; // existing phase-0 helper (match its actual export name)
import { NOTE_VIEWS, type NoteView } from "@/lib/note-views";
import { NoteList } from "./note-list";
import { QuickCapture } from "./quick-capture";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const params = await searchParams;
  const view = (NOTE_VIEWS as string[]).includes(params.view) ? (params.view as NoteView) : "inbox";
  const supabase = await createServerSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  let query = supabase.from("notes")
    .select(params.tag ? "*, note_tags!inner(tag_id)" : "*")
    .order("updated_at", { ascending: false });
  query = view === "trash" ? query.not("deleted_at", "is", null) : query.is("deleted_at", null);
  if (view === "active") query = query.in("lifecycle", ["active", "evergreen"]);
  else if (view !== "trash") query = query.eq("lifecycle", view);
  if (params.q) query = query.textSearch("content_text", params.q, { type: "websearch", config: "english" });
  if (params.tag) query = query.eq("note_tags.tag_id", params.tag).is("note_tags.deleted_at", null);

  const { data: notes, error } = await query;
  if (error) throw error; // rendered by error boundary (Task 17)

  return (
    <main>
      <QuickCapture token={session.access_token} />
      <nav>{/* view tabs: links to /?view=inbox|active|archived|trash; search input GET form preserving view */}</nav>
      <NoteList initialNotes={notes ?? []} view={view} userId={session.user.id} />
    </main>
  );
}
```

(`QuickCapture` and `NoteList` are created in Tasks 14–15 — create empty placeholder components in this task so the page compiles: `export function QuickCapture(props: { token: string }) { return null; }` etc., replaced by their real implementations in their own tasks.)

- [ ] **Step 4: Verify FTS uses the index (spec §8 risk)** — against the seeded local DB, run in `psql`:

```sql
explain analyze select id from notes
  where to_tsvector('english', content_text) @@ websearch_to_tsquery('english', 'pricing');
```

Confirm the plan shows `Bitmap Index Scan on notes_fts_idx` (not a sequential scan). Then reproduce the exact predicate PostgREST generates for `.textSearch('content_text', ...)` (check the request via the network tab or PostgREST logs) and `explain analyze` that too. If it misses the index, add a matching expression index or expose search as a SQL function — do not ship a silent seq scan.

- [ ] **Step 5: Verify build** — `pnpm --filter @cortex/web test` (predicate PASS) and `pnpm --filter @cortex/web typecheck && pnpm --filter @cortex/web build`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): note list SSR with view/search/tag filters + view predicate"
```

---

### Task 14: Web — `NoteList` client component + Realtime

**Files:**
- Create: `apps/web/src/app/note-list.tsx` (replaces placeholder)
- Test: covered by `note-views.test.ts` (the predicate is the fragile logic; the component is thin rendering per spec §7)

**Interfaces:**
- Consumes: `matchesView`, browser Supabase client from `apps/web/src/lib/supabase/client.ts`.
- Produces: `<NoteList initialNotes view userId />` — renders rows (title or first content line, relative updated time, tag chips), each linking to `/notes/[id]`; trash rows get Restore/Purge buttons (Task 17).

- [ ] **Step 1: Implement the component**

```tsx
// apps/web/src/app/note-list.tsx
"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client"; // existing phase-0 helper (match its actual export name)
import { matchesView, type NoteView } from "@/lib/note-views";

interface NoteRow { id: string; title: string | null; content: string; lifecycle: string; updated_at: string; deleted_at: string | null }

export function NoteList({ initialNotes, view, userId }: { initialNotes: NoteRow[]; view: NoteView; userId: string }) {
  const [notes, setNotes] = useState<NoteRow[]>(initialNotes);

  const refetch = useCallback(async () => {
    // postgres_changes drops events while disconnected and does NOT replay them —
    // refetch on every transition back to SUBSCRIBED, not only on mount (spec §5.4).
    const supabase = createBrowserSupabase();
    let q = supabase.from("notes").select("*").order("updated_at", { ascending: false });
    q = view === "trash" ? q.not("deleted_at", "is", null) : q.is("deleted_at", null);
    const { data } = await q;
    if (data) setNotes((data as NoteRow[]).filter((n) => matchesView(n, view)));
  }, [view]);

  useEffect(() => {
    const supabase = createBrowserSupabase();
    const channel = supabase
      .channel("notes-list")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "notes", filter: `user_id=eq.${userId}` },
        (payload) => {
          setNotes((prev) => {
            const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as NoteRow;
            const without = prev.filter((n) => n.id !== row.id); // dedupe by id — own-write echo is a no-op
            if (payload.eventType !== "DELETE" && matchesView(row, view)) {
              return [row, ...without].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
            }
            return without; // soft-deletes arrive as UPDATEs failing matchesView → drop (spec §5.4)
          });
        })
      .subscribe((status) => { if (status === "SUBSCRIBED") void refetch(); });
    return () => { void supabase.removeChannel(channel); };
  }, [userId, view, refetch]);

  return (
    <ul>
      {notes.map((n) => (
        <li key={n.id}>
          <Link href={`/notes/${n.id}`}>{n.title ?? n.content.split("\n")[0] ?? "(empty)"}</Link>
          <time dateTime={n.updated_at}>{new Date(n.updated_at).toLocaleString()}</time>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Manual verification (two tabs)** — run `pnpm --filter @cortex/web dev` + local API: create a note in tab A, it appears in tab B within a second; DevTools → offline → online: list refetches. (This is the spec §9 DoD check; Playwright deferred to 1b.)

- [ ] **Step 2b: Realtime isolation check (spec §8 risk)** — sign in as a *second* user in a separate browser profile and create notes there; assert none of them ever appear in the first user's list (supabase-js must be carrying the user's token on the socket via `realtime.setAuth` — this check proves it).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/note-list.tsx
git commit -m "feat(web): live note list - realtime patching, refetch on resubscribe"
```

---

### Task 15: Web — quick capture

**Files:**
- Create: `apps/web/src/app/quick-capture.tsx` (replaces placeholder)

**Interfaces:**
- Consumes: `api.createNote` (Task 12).
- Produces: persistent textarea; `Cmd/Ctrl+Enter` → `POST /notes` → clear box. **On failure the text stays in the box with an inline error** (spec §5.2). No optimistic insert — the Realtime echo dedupes by id (spec §5.2). While offline (`navigator.onLine === false`) capture is disabled behind a banner (spec §6).

- [ ] **Step 1: Implement**

```tsx
// apps/web/src/app/quick-capture.tsx
"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function QuickCapture({ token }: { token: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  async function submit() {
    if (!text.trim() || saving) return;
    setSaving(true); setError(null);
    try {
      await api.createNote(token, { content: text });
      setText(""); // cleared ONLY on success — a capture UI must never lose a thought
    } catch {
      setError("Couldn't save — your text is still here. Retry?");
    } finally {
      setSaving(false);
    }
  }

  if (!online) return <div role="status">Offline — capture disabled until the connection returns.</div>;

  return (
    <div>
      <textarea
        value={text}
        placeholder="quick thought..."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit(); }}
      />
      {error && <p role="alert">{error} <button onClick={() => void submit()}>Retry</button></p>}
    </div>
  );
}
```

- [ ] **Step 2: Manual verification** — capture with Cmd+Enter lands in inbox without reload; kill the API, capture fails, text remains + retry works.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/quick-capture.tsx
git commit -m "feat(web): quick capture - cmd+enter, failure keeps text"
```

---

### Task 16: Web — editor page with autosave

**Files:**
- Create: `apps/web/src/app/notes/[id]/page.tsx` (server component: fetch note + its tags via SSR client, 404 via `notFound()` when zero rows), `apps/web/src/app/notes/[id]/editor.tsx`
- Create: `apps/web/src/lib/use-debounced-save.ts`
- Test: `apps/web/src/lib/use-debounced-save.test.ts` (pure scheduling logic with fake timers)

**Interfaces:**
- Produces:
  - `createDebouncedSaver(save: (patch: Patch) => Promise<void>, delayMs: number, onStatus: (s: "idle"|"saving"|"saved"|"error") => void)` returns `{ queue(patch): void; flush(): Promise<void> }` — merges successive patches, fires `delayMs` (800 in the editor) after the last keystroke; `flush()` forces a pending save (called on blur and `beforeunload`); a failed save keeps the patch pending for retry.
  - Editor UI: title input + content textarea + status indicator `saving… / saved / save failed — retry`; failed save never clears local text (spec §5.3). Archive/delete buttons call `api.updateNote(..., { lifecycle: "archived" })` / `api.deleteNote` then navigate home.

- [ ] **Step 1: Write failing saver tests**

```ts
// apps/web/src/lib/use-debounced-save.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncedSaver } from "./use-debounced-save";

describe("createDebouncedSaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges patches and saves once after the delay", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = createDebouncedSaver(save, 800, () => {});
    s.queue({ content: "a" });
    s.queue({ content: "ab", title: "t" });
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ content: "ab", title: "t" });
  });

  it("flush saves immediately and cancels the timer", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = createDebouncedSaver(save, 800, () => {});
    s.queue({ content: "x" });
    await s.flush();
    expect(save).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledOnce(); // no double fire
  });

  it("reports error status and keeps the patch for retry", async () => {
    const statuses: string[] = [];
    const save = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const s = createDebouncedSaver(save, 800, (st) => statuses.push(st));
    s.queue({ content: "keep me" });
    await vi.advanceTimersByTimeAsync(800);
    expect(statuses).toContain("error");
    await s.flush(); // retry sends the same pending patch
    expect(save).toHaveBeenLastCalledWith({ content: "keep me" });
    expect(statuses[statuses.length - 1]).toBe("saved");
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// apps/web/src/lib/use-debounced-save.ts
export type SaveStatus = "idle" | "saving" | "saved" | "error";
type Patch = Record<string, unknown>;

export function createDebouncedSaver(
  save: (patch: Patch) => Promise<void>,
  delayMs: number,
  onStatus: (s: SaveStatus) => void,
) {
  let pending: Patch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function fire() {
    if (!pending) return;
    const patch = pending;
    onStatus("saving");
    try {
      await save(patch);
      // only clear if nothing new was queued while saving
      if (pending === patch) pending = null;
      onStatus("saved");
    } catch {
      onStatus("error"); // patch stays pending — retry via flush()
    }
  }

  return {
    queue(patch: Patch) {
      pending = { ...pending, ...patch };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fire(), delayMs);
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      await fire();
    },
  };
}
```

Editor component wires it up: `queue` on every keystroke, `flush` on blur and in a `beforeunload`/router-navigation cleanup; PATCHes only changed fields via `api.updateNote(token, id, patch)`.

- [ ] **Step 3: Run tests** — PASS. Manual check: edit, wait, reload — text persisted; kill API mid-edit → "save failed — retry", text intact.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): note editor with debounced autosave, flush on blur, retry on failure"
```

---

### Task 17: Web — tag chips, trash actions, error boundary

**Files:**
- Create: `apps/web/src/app/notes/[id]/tag-chips.tsx`, `apps/web/src/app/error.tsx`
- Modify: `apps/web/src/app/note-list.tsx` (Restore/Purge buttons in trash view), `apps/web/src/app/notes/[id]/editor.tsx` (mount TagChips)

**Interfaces:**
- Consumes: `api.createTag/attachTag/detachTag/restoreNote/purgeNote`.
- Produces: tag chips with `×` detach; a `+tag` combobox listing the user's existing tags (read via browser supabase client: `from("tags").select().is("deleted_at", null)`) with free-text create (find-or-create semantics come from the API); clicking a chip navigates to `/?tag=<id>`. Trash rows: Restore button; Purge button with `confirm()` (irreversible). `error.tsx`: SSR read failures render retry (spec §6).

- [ ] **Step 1: Implement** (representative core of `tag-chips.tsx`):

```tsx
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase/client";

interface TagRow { id: string; name: string }

export function TagChips({ token, noteId, initialTags }: { token: string; noteId: string; initialTags: TagRow[] }) {
  const [attached, setAttached] = useState<TagRow[]>(initialTags);
  const [all, setAll] = useState<TagRow[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    void createBrowserSupabase().from("tags").select("id, name").is("deleted_at", null)
      .then(({ data }) => setAll((data as TagRow[]) ?? []));
  }, []);

  async function add(name: string) {
    const tag = await api.createTag(token, { name });                 // find-or-create
    await api.attachTag(token, noteId, { tagId: tag.id });
    setAttached((prev) => prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]);
    setDraft("");
  }
  async function remove(tagId: string) {
    await api.detachTag(token, noteId, tagId);
    setAttached((prev) => prev.filter((t) => t.id !== tagId));
  }

  return (
    <div>
      {attached.map((t) => (
        <span key={t.id}>
          <Link href={`/?tag=${t.id}`}>#{t.name}</Link>
          <button aria-label={`remove ${t.name}`} onClick={() => void remove(t.id)}>×</button>
        </span>
      ))}
      <input list="all-tags" value={draft} placeholder="+tag"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) void add(draft.trim()); }} />
      <datalist id="all-tags">{all.map((t) => <option key={t.id} value={t.name} />)}</datalist>
    </div>
  );
}
```

Trash actions in `note-list.tsx` (rendered only when `view === "trash"`):

```tsx
<button onClick={() => void api.restoreNote(token, n.id)}>Restore</button>
<button onClick={() => { if (confirm("Permanently delete? This cannot be undone.")) void api.purgeNote(token, n.id); }}>
  Delete forever
</button>
```

(Realtime UPDATE/DELETE events remove the row from the trash list — no manual state surgery needed beyond the existing handler.)

- [ ] **Step 2: Manual verification against DoD** — create/attach/detach/re-attach same tag (no constraint error); chip click filters list; restore returns note to inbox view; purge removes permanently.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): tag chips + combobox, trash restore/purge, error boundary"
```

---

### Task 18: Web — export download + deploy checklist + DoD sweep

**Files:**
- Create: `apps/web/src/app/export-button.tsx` (mounted on the list page)
- Modify: `docs/deploy.md` (Railway env checklist)

**Interfaces:**
- Consumes: `GET /export` with bearer header — cannot be a plain `<a href>` (spec §4.3): fetch → blob → object URL → programmatic download.

- [ ] **Step 1: Implement**

```tsx
// apps/web/src/app/export-button.tsx
"use client";
export function ExportButton({ token }: { token: string }) {
  async function download() {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { alert("Export failed"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.headers.get("content-disposition")?.match(/filename="(.+)"/)?.[1] ?? "cortex-export.zip";
    a.click();
    URL.revokeObjectURL(url);
  }
  return <button onClick={() => void download()}>Export all</button>;
}
```

- [ ] **Step 2: Update `docs/deploy.md`** — add to the Railway checklist: `SUPABASE_ANON_KEY` **must** be set (writes fail in production without it while passing locally — spec §8); `SUPABASE_JWT_SECRET` must remain **unset** (forces the HS256 branch and rejects real ES256 tokens); `NEXT_PUBLIC_API_URL` on the web deployment. Also note the applied migrations `00010`/`00011` must be pushed to the hosted project (`supabase db push`).

- [ ] **Step 3: Full DoD sweep (spec §9)** — run every checklist item manually against the local stack; run `pnpm turbo run typecheck lint test` and confirm green; download the export zip and open a note file in Obsidian (frontmatter renders as properties).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src docs/deploy.md
git commit -m "feat(web): export download button + deploy checklist for 1a env vars"
```

---

## Definition of Done (from spec §9 — verify every box)

- [ ] Capture on `/` with `Cmd+Enter` appears in inbox without reload
- [ ] Edit at `/notes/[id]`; autosave reports `saved`; reload shows persisted text
- [ ] Archive moves note Inbox → Archived
- [ ] Delete → Trash; restore returns it; purge removes permanently (and purge-before-delete is 404)
- [ ] Tag create/attach/detach/re-attach with no constraint error
- [ ] Tag chip click filters the list
- [ ] Body-only search text finds the note
- [ ] Two tabs: capture in one appears in the other within a second
- [ ] Kill network → restore → list refetches correctly
- [ ] Export zip opens in Obsidian with valid frontmatter
- [ ] Bob cannot read/update/delete Alice's note — all 404
- [ ] `pnpm turbo run typecheck lint test` green in CI
