# Phase 1c — Life-Domain Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Life-domain foundations from `docs/superpowers/specs/2026-08-01-life-domains-web-search-design.md` §§1-3: domain-typed notes, `media_items` / `checkins` / `flashcards` tables, the 2-tap mood widget, the media log form, domain filters, embedding-dimension migration for Gemini, and export coverage. **No AI in this phase** — enrichment, flashcard extraction, and domain suggestion are phase 2.

**Architecture:** Identical to 1a — reads browser → Supabase (RLS), writes browser → API → `packages/core` services with per-request JWT clients. New tables follow the same RLS/realtime/export discipline as `notes`.

**Tech Stack:** Same as 1a. No new external dependencies.

**Sequencing:** Executes **after** the 1a plan (`2026-08-01-phase-1a-web-notes.md`) is complete — it consumes `packages/core`, `ZodValidationPipe`, `CoreErrorFilter`, the web `api` client, the note-list page, and `QuickCapture`.

## Global Constraints

- Everything from the 1a plan's Global Constraints applies unchanged (404-not-403, no service-role key, DTOs in `packages/shared/src/dto/`, commit per task).
- **Flashcards get a table only in 1c** — no service, routes, or UI (extraction is phase 2, review UI is phase 6). Do not build them here.
- No `people` and no `recipes` tables (spec §2.1 — deliberate deferrals).
- Check-ins are **not notes**: they never touch the `notes` table, the inbox, or FTS.
- Domain values, verbatim from spec §2.1: `media`, `health`, `life`, `learning`, `finance`, `reflection`. Media kinds: `movie`, `tv`, `book`, `game`, `podcast`.
- The enum-parity test (`packages/db/src/test/enum-parity.test.ts`) reads live check constraints; every new constraint↔zod pair added here must be registered there (the pair list is documented at the top of `packages/shared/src/enums.ts`).

---

### Task 1: Migration 00012 — embedding dims 1024 → 1536 (Gemini)

**Files:**
- Create: `supabase/migrations/00012_embedding_dims_gemini.sql`
- Modify: `packages/shared/src/enums.ts` (EMBEDDING_DIM / EMBEDDING_MODEL constants)
- Modify: `packages/db/src/test/schema-content.test.ts` **if** it asserts the vector dimension (check first; update the expected dim to 1536)
- Test: `packages/db/src/test/embedding-dims.test.ts`

**Interfaces:**
- Produces: `note_chunks.embedding vector(1536)`, `memory_facts.embedding vector(1536)`; `EMBEDDING_DIM = 1536`, `EMBEDDING_MODEL = "gemini-embedding-001"` exported from `@cortex/shared` (consumed by phase 2's embedding client).

- [ ] **Step 1: Write the failing test** — assert the live column dimension via the `admin` client:

First open `packages/db/src/test/enum-parity.test.ts` and note the mechanism it uses to read live catalog rows (`pg_constraint`) from the local DB — reuse **that exact mechanism** (helper import, rpc, or direct pg connection, whatever it is) for this test's catalog query. The query and assertion are:

```ts
// packages/db/src/test/embedding-dims.test.ts
import { describe, expect, it } from "vitest";

// The dimension of a pgvector column is stored in pg_attribute.atttypmod:
const DIM_QUERY = `
  select c.relname as table_name, a.atttypmod as dim
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('note_chunks', 'memory_facts')
    and a.attname = 'embedding'`;

describe("embedding dimensions (Gemini switch, extension spec §1)", () => {
  it("note_chunks and memory_facts vectors are 1536-dim", async () => {
    const rows = await runCatalogQuery(DIM_QUERY); // the enum-parity mechanism
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.dim).toBe(1536); // literal on purpose: red against live 1024
  });
});
```

Assert **1536 literally**, not `EMBEDDING_DIM` — while shared still says 1024 the test must be red against the live columns, and after Step 3 both the constant and the columns agree. (Optionally add a second assertion `EMBEDDING_DIM === 1536` once Step 3 lands, tying shared to the schema.)

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @cortex/db test -- embedding-dims` → FAIL (dim is 1024).

- [ ] **Step 3: Write the migration and update constants**

```sql
-- supabase/migrations/00012_embedding_dims_gemini.sql
-- Provider switch Claude→Gemini (extension spec §1): voyage-3.5 (1024-dim) is
-- replaced by gemini-embedding-001 at 1536-dim (MRL truncation; MTEB-equal to 3072).
-- Both columns are empty (no enrichment pipeline exists yet), so this is a pure
-- type change. HNSW indexes must be rebuilt for the new dimension.
drop index if exists note_chunks_embedding_idx;   -- match the actual index name from 00002
alter table public.note_chunks
  alter column embedding type vector(1536);
create index note_chunks_embedding_idx
  on public.note_chunks using hnsw (embedding vector_cosine_ops);

drop index if exists memory_facts_embedding_idx;  -- match the actual index name from 00005
alter table public.memory_facts
  alter column embedding type vector(1536);
create index memory_facts_embedding_idx
  on public.memory_facts using hnsw (embedding vector_cosine_ops);
```

(Before writing: `grep -n "hnsw" supabase/migrations/00002_content.sql supabase/migrations/00005_memory_feedback.sql` and use the real index names.)

```ts
// packages/shared/src/enums.ts — replace the two constants
export const EMBEDDING_DIM = 1536;
export const EMBEDDING_MODEL = "gemini-embedding-001";
```

- [ ] **Step 4: Apply and verify** — `supabase db reset`, then `pnpm --filter @cortex/db test` (embedding-dims PASS **and** the whole existing suite stays green) and `pnpm --filter @cortex/shared test`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00012_embedding_dims_gemini.sql packages/shared/src/enums.ts packages/db/src/test
git commit -m "feat(db): 1536-dim embeddings for gemini-embedding-001 (provider switch)"
```

---

### Task 2: Migration 00013 — life-domain tables + notes domain columns

**Files:**
- Create: `supabase/migrations/00013_life_domains.sql`
- Modify: `packages/shared/src/enums.ts` (new zod enums + pair-list comment)
- Modify: `packages/db/src/test/enum-parity.test.ts` (register 3 new pairs)
- Modify: `packages/db/src/test/rls-isolation.test.ts` (extend to the 3 new tables)
- Test: `packages/db/src/test/life-domains-schema.test.ts`

**Interfaces:**
- Produces:
  - zod enums in `@cortex/shared`: `noteDomain = z.enum(["media","health","life","learning","finance","reflection"])`, `mediaKind = z.enum(["movie","tv","book","game","podcast"])`, `flashcardStatus = z.enum(["suggested","active","suspended"])`
  - Tables `media_items`, `checkins`, `flashcards` and columns `notes.domain`, `notes.domain_meta`, `notes.media_item_id` — exactly as in extension spec §2 (including `checkins.deleted_at` tombstone).
  - Enum-parity pairs: `noteDomain ↔ notes.domain_check`, `mediaKind ↔ media_items.kind_check`, `flashcardStatus ↔ flashcards.status_check`.

- [ ] **Step 1: Write failing schema tests**

```ts
// packages/db/src/test/life-domains-schema.test.ts
import { describe, expect, it } from "vitest";
import { makeUser } from "./clients";

describe("life-domain schema (extension spec §2)", () => {
  it("notes accept a valid domain and reject an invalid one", async () => {
    const { client, id } = await makeUser("domains-schema@test.local");
    const ok = await client.from("notes")
      .insert({ user_id: id, content: "ran 5k", domain: "health", domain_meta: { activity_type: "run" } })
      .select().single();
    expect(ok.error).toBeNull();
    const bad = await client.from("notes")
      .insert({ user_id: id, content: "x", domain: "astrology" });
    expect(bad.error?.code).toBe("23514"); // check violation
  });

  it("media_items dedupe on (user_id, kind, lower(title)) among live rows", async () => {
    const { client, id } = await makeUser("media-schema@test.local");
    const a = await client.from("media_items")
      .insert({ user_id: id, kind: "movie", title: "Dune" }).select().single();
    expect(a.error).toBeNull();
    const dup = await client.from("media_items")
      .insert({ user_id: id, kind: "movie", title: "dune" });
    expect(dup.error?.code).toBe("23505");
  });

  it("checkins require mood or energy", async () => {
    const { client, id } = await makeUser("checkins-schema@test.local");
    const ok = await client.from("checkins").insert({ user_id: id, mood: 4 });
    expect(ok.error).toBeNull();
    const bad = await client.from("checkins").insert({ user_id: id, label: "meh" });
    expect(bad.error?.code).toBe("23514");
    const range = await client.from("checkins").insert({ user_id: id, mood: 6 });
    expect(range.error?.code).toBe("23514");
  });

  it("flashcards table exists with suggested default", async () => {
    const { client, id } = await makeUser("cards-schema@test.local");
    const { data: note } = await client.from("notes")
      .insert({ user_id: id, content: "hola = hello", domain: "learning" }).select().single();
    const card = await client.from("flashcards")
      .insert({ user_id: id, note_id: note!.id, front: "hola", back: "hello" }).select().single();
    expect(card.error).toBeNull();
    expect(card.data!.status).toBe("suggested");
  });
});
```

Also extend `rls-isolation.test.ts` with the three new tables following its existing per-table pattern (insert as Alice via her client, select as Bob, assert `[]` — the file already loops a table list or repeats a block; follow whichever pattern it uses).

- [ ] **Step 2: Run to verify failure** — tables/columns don't exist → FAIL.

- [ ] **Step 3: Write the migration** (B-before-A ordering: `media_items` first, its FK target — spec §2 note):

```sql
-- supabase/migrations/00013_life_domains.sql
-- Extension spec §2: typed notes + media_items + checkins + flashcards.
-- Follow the RLS/grant pattern of 00002_content.sql exactly (default-deny,
-- per-op policies with user_id = (select auth.uid()); 00009 already revoked
-- default ACL grants, so grant select/insert/update/delete to authenticated).

create table public.media_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null constraint media_items_kind_check
    check (kind in ('movie','tv','book','game','podcast')),
  title text not null,
  year int,
  creator text,
  external_meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index media_items_user_kind_title_uidx
  on public.media_items (user_id, kind, lower(title)) where deleted_at is null;

alter table public.notes
  add column domain text constraint notes_domain_check
    check (domain in ('media','health','life','learning','finance','reflection')),
  add column domain_meta jsonb not null default '{}',
  add column media_item_id uuid references public.media_items(id) on delete set null;
create index notes_user_domain_idx on public.notes (user_id, domain) where domain is not null;

create table public.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mood smallint check (mood between 1 and 5),
  energy smallint check (energy between 1 and 5),
  label text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint checkins_mood_or_energy check (mood is not null or energy is not null)
);
create index checkins_user_created_idx on public.checkins (user_id, created_at desc);

create table public.flashcards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid references public.notes(id) on delete cascade,
  front text not null,
  back text not null,
  source text not null default 'ai' check (source in ('user','ai')),
  status text not null default 'suggested' constraint flashcards_status_check
    check (status in ('suggested','active','suspended')),
  due_at timestamptz,
  interval_days real not null default 1,
  ease real not null default 2.0,
  lapses int not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index flashcards_user_due_idx on public.flashcards (user_id, due_at)
  where status = 'active' and deleted_at is null;

-- RLS: copy the exact policy/grant block style from 00002 for each table.
alter table public.media_items enable row level security;
alter table public.checkins enable row level security;
alter table public.flashcards enable row level security;
-- (per-op policies: using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))
--  + grant select, insert, update, delete on each table to authenticated)

-- Realtime for live UI (same reason as 00010):
alter publication supabase_realtime add table public.media_items, public.checkins, public.flashcards;
```

Add to `packages/shared/src/enums.ts` (and extend the pair-list comment at the top of the file):

```ts
export const noteDomain = z.enum(["media", "health", "life", "learning", "finance", "reflection"]);
export const mediaKind = z.enum(["movie", "tv", "book", "game", "podcast"]);
export const flashcardStatus = z.enum(["suggested", "active", "suspended"]);
```

Register the three pairs in `enum-parity.test.ts` following its existing list:
`noteDomain ↔ notes_domain_check`, `mediaKind ↔ media_items_kind_check`, `flashcardStatus ↔ flashcards_status_check`.

- [ ] **Step 4: Apply and verify** — `supabase db reset`; `pnpm --filter @cortex/db test` fully green (new schema tests, extended RLS isolation, enum parity, default grants — 00009's revoke pattern means the grants test will fail loudly if the grant block was forgotten).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00013_life_domains.sql packages/shared/src/enums.ts packages/db/src/test
git commit -m "feat(db): life-domain schema - media_items, checkins, flashcards, notes.domain"
```

---

### Task 3: DTOs — domains, check-ins, media log

**Files:**
- Create: `packages/shared/src/dto/domains.ts`, `packages/shared/src/dto/checkins.ts`, `packages/shared/src/dto/media.ts`
- Modify: `packages/shared/src/dto/notes.ts` (add `domain`/`domainMeta` to create/update), `packages/shared/src/dto/index.ts`
- Test: `packages/shared/src/dto/domains.test.ts`, `packages/shared/src/dto/checkins.test.ts`, `packages/shared/src/dto/media.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 4-7 services/controllers and Tasks 9-11 web):
  - `domainMetaSchemas: Record<NoteDomain, ZodType>` and `validateDomainMeta(domain, meta)` — per-domain jsonb validation (spec §2.1 shapes, verbatim)
  - `createCheckinInput` — `{ mood?: 1..5, energy?: 1..5, label?: ≤100 }`, refined: at least one of mood/energy
  - `logMediaInput` — `{ kind: mediaKind, title: 1..500, year?: 1000..2100, rating?: 1..5, impression?: ≤100_000, consumedAt?: ISO date }`
  - `createNoteInput`/`updateNoteInput` gain optional `domain: noteDomain` and `domainMeta: record` (validated against the domain's schema in the service, since the pair is cross-field)

- [ ] **Step 1: Write failing tests**

```ts
// packages/shared/src/dto/checkins.test.ts
import { describe, expect, it } from "vitest";
import { createCheckinInput } from "./checkins";

describe("createCheckinInput", () => {
  it("accepts mood-only, energy-only, both", () => {
    expect(createCheckinInput.safeParse({ mood: 3 }).success).toBe(true);
    expect(createCheckinInput.safeParse({ energy: 5 }).success).toBe(true);
    expect(createCheckinInput.safeParse({ mood: 1, energy: 2, label: "meh" }).success).toBe(true);
  });
  it("rejects neither, and out-of-range values", () => {
    expect(createCheckinInput.safeParse({ label: "just words" }).success).toBe(false);
    expect(createCheckinInput.safeParse({ mood: 0 }).success).toBe(false);
    expect(createCheckinInput.safeParse({ mood: 6 }).success).toBe(false);
  });
});
```

```ts
// packages/shared/src/dto/domains.test.ts
import { describe, expect, it } from "vitest";
import { validateDomainMeta } from "./domains";

describe("validateDomainMeta", () => {
  it("media meta accepts rating 1-5, rejects 6", () => {
    expect(validateDomainMeta("media", { rating: 5 }).success).toBe(true);
    expect(validateDomainMeta("media", { rating: 6 }).success).toBe(false);
  });
  it("health meta accepts freeform-extracted fields", () => {
    expect(validateDomainMeta("health", { activity_type: "run", duration_min: 30 }).success).toBe(true);
  });
  it("reflection meta must be empty-ish", () => {
    expect(validateDomainMeta("reflection", {}).success).toBe(true);
    expect(validateDomainMeta("reflection", { anything: 1 }).success).toBe(false);
  });
});
```

```ts
// packages/shared/src/dto/media.test.ts
import { describe, expect, it } from "vitest";
import { logMediaInput } from "./media";

describe("logMediaInput", () => {
  it("accepts a minimal movie log", () => {
    expect(logMediaInput.safeParse({ kind: "movie", title: "Dune" }).success).toBe(true);
  });
  it("rejects unknown kind and empty title", () => {
    expect(logMediaInput.safeParse({ kind: "vinyl", title: "x" }).success).toBe(false);
    expect(logMediaInput.safeParse({ kind: "book", title: "" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// packages/shared/src/dto/domains.ts
import { z, type ZodType } from "zod";
import { noteDomain } from "../enums";
export type NoteDomain = z.infer<typeof noteDomain>;

// Extension spec §2.1 — extracted structure, freeform text stays source of truth.
export const domainMetaSchemas: Record<NoteDomain, ZodType> = {
  media: z.object({
    rating: z.number().int().min(1).max(5).optional(),
    consumed_at: z.iso.date().optional(),
    status: z.enum(["finished", "in_progress", "abandoned"]).optional(),
  }).strict(),
  health: z.object({
    activity_type: z.string().max(100).optional(),
    duration_min: z.number().int().positive().optional(),
    intensity: z.number().int().min(1).max(5).optional(),
  }).strict(),
  finance: z.object({
    amount: z.number().optional(),
    currency: z.string().length(3).optional(),
    decision_type: z.enum(["purchase", "investment", "other"]).optional(),
  }).strict(),
  learning: z.object({
    language: z.string().max(50).optional(),
    topic: z.string().max(200).optional(),
  }).strict(),
  life: z.object({}).strict(),
  reflection: z.object({}).strict(),
};

export function validateDomainMeta(domain: NoteDomain, meta: unknown) {
  return domainMetaSchemas[domain].safeParse(meta);
}
```

```ts
// packages/shared/src/dto/checkins.ts
import { z } from "zod";
export const createCheckinInput = z.object({
  mood: z.number().int().min(1).max(5).optional(),
  energy: z.number().int().min(1).max(5).optional(),
  label: z.string().max(100).optional(),
}).refine((o) => o.mood !== undefined || o.energy !== undefined, "mood or energy required");
export type CreateCheckinInput = z.infer<typeof createCheckinInput>;
```

```ts
// packages/shared/src/dto/media.ts
import { z } from "zod";
import { mediaKind } from "../enums";
export const logMediaInput = z.object({
  kind: mediaKind,
  title: z.string().trim().min(1).max(500),
  year: z.number().int().min(1000).max(2100).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  impression: z.string().max(100_000).optional(),
  consumedAt: z.iso.date().optional(),
});
export type LogMediaInput = z.infer<typeof logMediaInput>;
```

In `notes.ts`: add `domain: noteDomain.optional()` to `createNoteInput`, and add `domain: noteDomain.nullable().optional()` to the `updateNoteInput` object (inside the object, before its non-empty refine) — nullable on update only, so a wrong domain can be cleared with `{ domain: null }` while create never takes null.

- [ ] **Step 3: Run tests** — `pnpm --filter @cortex/shared test` → all PASS (including 1a's DTO tests).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): domain, checkin, media-log DTOs"
```

---

### Task 4: `CheckinService`

**Files:**
- Create: `packages/core/src/checkins/service.ts`, `packages/core/src/checkins/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/checkins/service.test.ts`

**Interfaces:**
- Produces (consumed by Task 6):
  - `class CheckinService { constructor(client: SupabaseClient, userId: string) }`
  - `create(input: CreateCheckinInput): Promise<Checkin>`
  - `softDelete(id: string): Promise<{ id: string }>` — mis-tap eraser; foreign/missing → `not_found`
  - `Checkin = { id, user_id, mood, energy, label, created_at, deleted_at }`

- [ ] **Step 1: Write failing tests**

```ts
// packages/core/src/checkins/service.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase";
import { makeUser } from "../test/harness";
import { CheckinService } from "./service";

let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
let svc: CheckinService;

beforeAll(async () => {
  alice = await makeUser("core-checkins-alice@test.local");
  bob = await makeUser("core-checkins-bob@test.local");
  svc = new CheckinService(createUserClient(alice.token), alice.id);
});

describe("CheckinService", () => {
  it("creates a mood-only check-in", async () => {
    const c = await svc.create({ mood: 4, label: "good" });
    expect(c.mood).toBe(4);
    expect(c.energy).toBeNull();
  });
  it("soft-deletes own check-in", async () => {
    const c = await svc.create({ energy: 2 });
    await svc.softDelete(c.id);
    const { data } = await alice.client.from("checkins").select("deleted_at").eq("id", c.id).single();
    expect(data!.deleted_at).not.toBeNull();
  });
  it("deleting Bob's check-in is not_found", async () => {
    const bobs = await new CheckinService(createUserClient(bob.token), bob.id).create({ mood: 1 });
    await expect(svc.softDelete(bobs.id)).rejects.toMatchObject({ kind: "not_found" });
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// packages/core/src/checkins/service.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateCheckinInput } from "@cortex/shared";
import { mapPostgrestError } from "../errors";

export interface Checkin {
  id: string; user_id: string; mood: number | null; energy: number | null;
  label: string | null; created_at: string; deleted_at: string | null;
}

export class CheckinService {
  constructor(private client: SupabaseClient, private userId: string) {}

  async create(input: CreateCheckinInput): Promise<Checkin> {
    const { data, error } = await this.client.from("checkins")
      .insert({ user_id: this.userId, mood: input.mood ?? null, energy: input.energy ?? null, label: input.label ?? null })
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as Checkin;
  }

  async softDelete(id: string): Promise<{ id: string }> {
    const { data, error } = await this.client.from("checkins")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .select("id").single();
    if (error) throw mapPostgrestError(error);
    return data as { id: string };
  }
}
```

- [ ] **Step 3: Run tests** — PASS. **Step 4: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): CheckinService create/softDelete"
```

---

### Task 5: `MediaService` — find-or-create item + log note

**Files:**
- Create: `packages/core/src/media/service.ts`, `packages/core/src/media/index.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/notes/service.ts` (create() passes through `domain`, `domain_meta`, `media_item_id`)
- Test: `packages/core/src/media/service.test.ts`

**Interfaces:**
- Produces (consumed by Task 7):
  - `class MediaService { constructor(client: SupabaseClient, userId: string) }`
  - `findOrCreateItem(input: { kind, title, year?, creator? }): Promise<MediaItem>` — case-insensitive on title within (user, kind); 23505 race → retry select once (same pattern as `TagService.findOrCreate`)
  - `logMedia(input: LogMediaInput): Promise<{ item: MediaItem; note: Note }>` — find-or-create the item, then create a note: `domain:'media'`, `media_item_id`, `title` = item title, `content` = impression ?? `""`, `domain_meta` = `{ rating, consumed_at, status:'finished' }` (only defined fields), validated by `validateDomainMeta` before insert
  - `MediaItem = { id, user_id, kind, title, year, creator, external_meta, created_at, deleted_at }`
- Consumes: `NoteService.create` extended signature — `create(input: CreateNoteInput & { domain?; domainMeta?; mediaItemId? })`.

- [ ] **Step 1: Write failing tests**

```ts
// packages/core/src/media/service.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase";
import { makeUser } from "../test/harness";
import { MediaService } from "./service";

let svc: MediaService;
beforeAll(async () => {
  const alice = await makeUser("core-media-alice@test.local");
  svc = new MediaService(createUserClient(alice.token), alice.id);
});

describe("MediaService.findOrCreateItem", () => {
  it("dedupes case-insensitively within kind", async () => {
    const a = await svc.findOrCreateItem({ kind: "movie", title: "Dune", year: 2021 });
    const b = await svc.findOrCreateItem({ kind: "movie", title: "DUNE" });
    expect(b.id).toBe(a.id);
    const book = await svc.findOrCreateItem({ kind: "book", title: "Dune" });
    expect(book.id).not.toBe(a.id); // same title, different kind = different item
  });
});

describe("MediaService.logMedia", () => {
  it("creates item + media note with rating in domain_meta", async () => {
    const { item, note } = await svc.logMedia({
      kind: "book", title: "Thinking, Fast and Slow", rating: 5, impression: "changed how I see bias",
    });
    expect(note.domain).toBe("media");
    expect((note as any).media_item_id).toBe(item.id);
    expect((note as any).domain_meta.rating).toBe(5);
    expect(note.content).toBe("changed how I see bias");
  });

  it("a rewatch is a second note against the same item", async () => {
    const first = await svc.logMedia({ kind: "movie", title: "Arrival", rating: 4 });
    const second = await svc.logMedia({ kind: "movie", title: "Arrival", rating: 5, impression: "better on rewatch" });
    expect(second.item.id).toBe(first.item.id);
    expect(second.note.id).not.toBe(first.note.id);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// packages/core/src/media/service.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateDomainMeta, type LogMediaInput } from "@cortex/shared";
import { mapPostgrestError } from "../errors";
import { NoteService, type Note } from "../notes/service";

export interface MediaItem {
  id: string; user_id: string; kind: string; title: string; year: number | null;
  creator: string | null; external_meta: Record<string, unknown>;
  created_at: string; deleted_at: string | null;
}

export class MediaService {
  constructor(private client: SupabaseClient, private userId: string) {}

  async findOrCreateItem(input: { kind: string; title: string; year?: number; creator?: string }): Promise<MediaItem> {
    const existing = await this.client.from("media_items")
      .select().eq("user_id", this.userId).eq("kind", input.kind)
      .ilike("title", input.title).is("deleted_at", null).maybeSingle();
    if (existing.error) throw mapPostgrestError(existing.error);
    if (existing.data) return existing.data as MediaItem;

    const inserted = await this.client.from("media_items")
      .insert({ user_id: this.userId, kind: input.kind, title: input.title,
                year: input.year ?? null, creator: input.creator ?? null })
      .select().single();
    if (!inserted.error) return inserted.data as MediaItem;
    if (inserted.error.code === "23505") { // race: retry the select once (TagService pattern)
      const retry = await this.client.from("media_items")
        .select().eq("user_id", this.userId).eq("kind", input.kind)
        .ilike("title", input.title).is("deleted_at", null).single();
      if (retry.error) throw mapPostgrestError(retry.error);
      return retry.data as MediaItem;
    }
    throw mapPostgrestError(inserted.error);
  }

  async logMedia(input: LogMediaInput): Promise<{ item: MediaItem; note: Note }> {
    const item = await this.findOrCreateItem(input);
    const meta: Record<string, unknown> = {};
    if (input.rating !== undefined) meta.rating = input.rating;
    if (input.consumedAt !== undefined) meta.consumed_at = input.consumedAt;
    meta.status = "finished";
    const check = validateDomainMeta("media", meta);
    if (!check.success) throw { kind: "internal", cause: check.error };

    const notes = new NoteService(this.client, this.userId);
    const note = await notes.create({
      content: input.impression ?? "", title: item.title,
      domain: "media", domainMeta: meta, mediaItemId: item.id,
    });
    return { item, note };
  }
}
```

Extend `NoteService.create` (and the `Note` interface with `domain`, `domain_meta`, `media_item_id` fields):

```ts
  async create(input: CreateNoteInput & { domainMeta?: Record<string, unknown>; mediaItemId?: string }): Promise<Note> {
    const { data, error } = await this.client.from("notes")
      .insert({
        user_id: this.userId, content: input.content, title: input.title ?? null,
        domain: input.domain ?? null,
        domain_meta: input.domainMeta ?? {},
        media_item_id: input.mediaItemId ?? null,
      })
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as Note;
  }
```

(`CreateNoteInput` already carries optional `domain` after Task 3.) Also pass `domain` through in `NoteService.update` (`if (input.domain !== undefined) patch.domain = input.domain;`).

- [ ] **Step 3: Run tests** — `pnpm --filter @cortex/core test` → all PASS (including 1a suites).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): MediaService find-or-create item + media log notes; notes carry domain"
```

---

### Task 6: API — `checkins.controller`

**Files:**
- Create: `apps/api/src/checkins.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/checkins.e2e.test.ts`

**Interfaces:**
- Produces routes: `POST /checkins` (201 → Checkin), `DELETE /checkins/:id` (200 → `{ id }`). Reads stay on supabase-js (1a architecture).

- [ ] **Step 1: Write failing e2e tests** (same bootstrap pattern as `notes.e2e.test.ts`):

```ts
describe("checkins over HTTP", () => {
  it("401 without token", async () => {
    await request(app.getHttpServer()).post("/checkins").send({ mood: 3 }).expect(401);
  });
  it("400 when neither mood nor energy", async () => {
    await request(app.getHttpServer()).post("/checkins")
      .set(auth(alice.token)).send({ label: "words only" }).expect(400);
  });
  it("201 creates and DELETE soft-deletes", async () => {
    const res = await request(app.getHttpServer()).post("/checkins")
      .set(auth(alice.token)).send({ mood: 4, energy: 3, label: "good" }).expect(201);
    await request(app.getHttpServer()).delete(`/checkins/${res.body.id}`)
      .set(auth(alice.token)).expect(200);
  });
  it("deleting Bob's check-in is 404", async () => {
    const bobs = await request(app.getHttpServer()).post("/checkins")
      .set(auth(bob.token)).send({ mood: 2 });
    await request(app.getHttpServer()).delete(`/checkins/${bobs.body.id}`)
      .set(auth(alice.token)).expect(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// apps/api/src/checkins.controller.ts
import { Body, Controller, Delete, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { CheckinService, createUserClient } from "@cortex/core";
import { createCheckinInput, type CreateCheckinInput } from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("checkins")
@UseGuards(SupabaseAuthGuard)
export class CheckinsController {
  private svc(user: AuthedUser) { return new CheckinService(createUserClient(user.token), user.id); }

  @Post()
  create(@CurrentUser() user: AuthedUser,
         @Body(new ZodValidationPipe(createCheckinInput)) body: CreateCheckinInput) {
    return this.svc(user).create(body);
  }

  @Delete(":id")
  remove(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc(user).softDelete(id);
  }
}
```

- [ ] **Step 3: Run tests** — PASS. **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): checkins controller - 2-tap mood/energy writes"
```

---

### Task 7: API — `media.controller` + notes accept domain

**Files:**
- Create: `apps/api/src/media.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/media.e2e.test.ts`

**Interfaces:**
- Produces: `POST /media-log` (body: `logMediaInput`) → `{ item, note }`. `POST /notes` / `PATCH /notes/:id` accept the optional `domain` field (no controller change needed — the DTOs from Task 3 flow through 1a's pipes; the e2e here proves it).

- [ ] **Step 1: Write failing e2e tests**

```ts
describe("media log over HTTP", () => {
  it("logs a movie and returns item + media note", async () => {
    const res = await request(app.getHttpServer()).post("/media-log")
      .set(auth(alice.token))
      .send({ kind: "movie", title: "Dune Part 3", rating: 4, impression: "spice" })
      .expect(201);
    expect(res.body.note.domain).toBe("media");
    expect(res.body.note.media_item_id).toBe(res.body.item.id);
  });
  it("rejects unknown kind with field path", async () => {
    const res = await request(app.getHttpServer()).post("/media-log")
      .set(auth(alice.token)).send({ kind: "vinyl", title: "x" }).expect(400);
    expect(res.body.issues[0].path).toBe("kind");
  });
});

describe("notes accept domain", () => {
  it("POST /notes with domain=health persists it", async () => {
    const res = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "ran 5k, felt strong", domain: "health" }).expect(201);
    expect(res.body.domain).toBe("health");
  });
  it("PATCH can set and clear domain", async () => {
    const note = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "maybe finance?" });
    const set = await request(app.getHttpServer()).patch(`/notes/${note.body.id}`)
      .set(auth(alice.token)).send({ domain: "finance" }).expect(200);
    expect(set.body.domain).toBe("finance");
    const cleared = await request(app.getHttpServer()).patch(`/notes/${note.body.id}`)
      .set(auth(alice.token)).send({ domain: null }).expect(200);
    expect(cleared.body.domain).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// apps/api/src/media.controller.ts
import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { createUserClient, MediaService } from "@cortex/core";
import { logMediaInput, type LogMediaInput } from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("media-log")
@UseGuards(SupabaseAuthGuard)
export class MediaController {
  @Post()
  log(@CurrentUser() user: AuthedUser,
      @Body(new ZodValidationPipe(logMediaInput)) body: LogMediaInput) {
    return new MediaService(createUserClient(user.token), user.id).logMedia(body);
  }
}
```

(If the PATCH-clear test fails: ensure `updateNoteInput.domain` is `noteDomain.nullable().optional()` per Task 3, and `NoteService.update` passes `domain` through including `null`.)

- [ ] **Step 3: Run tests** — PASS. **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): media-log endpoint; notes carry domain end-to-end"
```

---

### Task 8: Export covers the new tables

**Files:**
- Modify: `packages/core/src/export/service.ts`
- Test: `packages/core/src/export/service.test.ts` (extend)

**Interfaces:**
- Produces: `manifest.json` gains `media_items`, `checkins`, `flashcards` arrays (live rows only); note frontmatter gains `domain` when set (spec §2.3 "included in /export").

- [ ] **Step 1: Extend the failing test**

```ts
it("manifest includes life-domain tables and note frontmatter carries domain", async () => {
  // in beforeAll: alice also logs a media note (MediaService), a checkin, and a flashcard row
  const manifest = JSON.parse(zip.readAsText("manifest.json"));
  expect(manifest.media_items.length).toBeGreaterThanOrEqual(1);
  expect(manifest.checkins.length).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(manifest.flashcards)).toBe(true);
  const mediaNote = zip.getEntries()
    .map((e) => e.getData().toString("utf8"))
    .find((t) => t.includes("domain: media"));
  expect(mediaNote).toBeDefined();
});
```

- [ ] **Step 2: Run to verify failure**, then implement — in `buildArchive`, add three queries to the `Promise.all` (`media_items`, `checkins`, `flashcards`, each `.is("deleted_at", null)`), include them in the manifest object, and add `...(note.domain ? { domain: note.domain } : {})` to the frontmatter object (also add `domain` to the notes select).

- [ ] **Step 3: Run tests** — PASS. **Step 4: Commit**

```bash
git add packages/core/src/export
git commit -m "feat(core): export covers media_items, checkins, flashcards + domain frontmatter"
```

---

### Task 9: Web — mood/energy widget

**Files:**
- Create: `apps/web/src/app/checkin-widget.tsx`, `apps/web/src/lib/checkin.ts`
- Modify: `apps/web/src/app/page.tsx` (mount above QuickCapture), `apps/web/src/lib/api.ts` (add `createCheckin`, `deleteCheckin`)
- Test: `apps/web/src/lib/checkin.test.ts`

**Interfaces:**
- Consumes: `api.createCheckin(token, input: CreateCheckinInput)` (add to the Task-12-of-1a client following the same `validated()` pattern).
- Produces: header strip — 5 mood buttons (1-5), tapping one POSTs immediately (tap #1 = select, that's the whole gesture: **one tap logs mood**); an expandable row adds energy + a 1-word label + undo ("logged ✓ — undo" calls `deleteCheckin`). `buildCheckinPayload` is the pure, tested part.

- [ ] **Step 1: Write failing test for the payload builder**

```ts
// apps/web/src/lib/checkin.test.ts
import { describe, expect, it } from "vitest";
import { buildCheckinPayload } from "./checkin";

describe("buildCheckinPayload", () => {
  it("mood tap alone is a valid payload", () => {
    expect(buildCheckinPayload({ mood: 4 })).toEqual({ mood: 4 });
  });
  it("trims label and drops it when empty", () => {
    expect(buildCheckinPayload({ mood: 2, label: "  tired  " })).toEqual({ mood: 2, label: "tired" });
    expect(buildCheckinPayload({ mood: 2, label: "   " })).toEqual({ mood: 2 });
  });
  it("returns null when neither mood nor energy picked", () => {
    expect(buildCheckinPayload({ label: "words" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// apps/web/src/lib/checkin.ts
import type { CreateCheckinInput } from "@cortex/shared";

export function buildCheckinPayload(
  raw: { mood?: number; energy?: number; label?: string },
): CreateCheckinInput | null {
  if (raw.mood === undefined && raw.energy === undefined) return null;
  const payload: CreateCheckinInput = {};
  if (raw.mood !== undefined) payload.mood = raw.mood;
  if (raw.energy !== undefined) payload.energy = raw.energy;
  const label = raw.label?.trim();
  if (label) payload.label = label;
  return payload;
}
```

```tsx
// apps/web/src/app/checkin-widget.tsx
"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { buildCheckinPayload } from "@/lib/checkin";

const MOODS = ["😞", "😕", "😐", "🙂", "😄"]; // 1..5

export function CheckinWidget({ token }: { token: string }) {
  const [lastId, setLastId] = useState<string | null>(null);
  const [error, setError] = useState(false);

  async function logMood(mood: number) {
    setError(false);
    const payload = buildCheckinPayload({ mood });
    if (!payload) return;
    try {
      const c = await api.createCheckin(token, payload);
      setLastId(c.id); // "logged ✓ — undo"
    } catch { setError(true); }
  }
  async function undo() {
    if (!lastId) return;
    await api.deleteCheckin(token, lastId).catch(() => {});
    setLastId(null);
  }

  return (
    <div aria-label="mood check-in">
      {MOODS.map((m, i) => (
        <button key={i} aria-label={`mood ${i + 1}`} onClick={() => void logMood(i + 1)}>{m}</button>
      ))}
      {lastId && <span role="status">logged ✓ <button onClick={() => void undo()}>undo</button></span>}
      {error && <span role="alert">couldn't log — tap again</span>}
    </div>
  );
}
```

- [ ] **Step 3: Manual verification** — one tap logs a check-in (row visible in Supabase table editor); undo removes it; total interaction is sub-second.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): 2-tap mood/energy check-in widget with undo"
```

---

### Task 10: Web — media log form

**Files:**
- Create: `apps/web/src/app/media-log-form.tsx`
- Modify: `apps/web/src/app/page.tsx` (a "Log media" button opening the form), `apps/web/src/lib/api.ts` (add `logMedia`)

**Interfaces:**
- Consumes: `api.logMedia(token, input: LogMediaInput)`; browser supabase client for autocomplete reads.
- Produces: mini-form — kind select, title input with `<datalist>` autocomplete over the user's existing `media_items` (`from("media_items").select("id, kind, title").is("deleted_at", null)`), 5-star rating, freeform impression textarea, submit → `POST /media-log` → form closes, note appears in list via Realtime. Failure keeps all fields (same never-lose-input rule as QuickCapture).

- [ ] **Step 1: Implement** (find-or-create is server-side; the client just sends the typed title — matching an autocomplete entry or not):

```tsx
// apps/web/src/app/media-log-form.tsx
"use client";
import { useEffect, useState } from "react";
import { mediaKind } from "@cortex/shared";
import { api } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase/client";

export function MediaLogForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [kind, setKind] = useState<string>("movie");
  const [title, setTitle] = useState("");
  const [rating, setRating] = useState<number | undefined>();
  const [impression, setImpression] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<{ title: string; kind: string }[]>([]);

  useEffect(() => {
    void createBrowserSupabase().from("media_items").select("title, kind").is("deleted_at", null)
      .then(({ data }) => setItems(data ?? []));
  }, []);

  async function submit() {
    setError(null);
    try {
      await api.logMedia(token, {
        kind: kind as any, title,
        ...(rating ? { rating } : {}), ...(impression.trim() ? { impression } : {}),
      });
      onDone(); // note arrives in the list via Realtime — no manual insert
    } catch {
      setError("Couldn't save — everything you typed is still here.");
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <select value={kind} onChange={(e) => setKind(e.target.value)}>
        {mediaKind.options.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <input list="media-titles" required value={title} placeholder="title"
        onChange={(e) => setTitle(e.target.value)} />
      <datalist id="media-titles">
        {items.filter((i) => i.kind === kind).map((i) => <option key={i.title} value={i.title} />)}
      </datalist>
      <div role="radiogroup" aria-label="rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button type="button" key={n} aria-pressed={rating === n}
            onClick={() => setRating(rating === n ? undefined : n)}>
            {n <= (rating ?? 0) ? "★" : "☆"}
          </button>
        ))}
      </div>
      <textarea value={impression} placeholder="impressions..."
        onChange={(e) => setImpression(e.target.value)} />
      {error && <p role="alert">{error}</p>}
      <button type="submit">Log</button>
    </form>
  );
}
```

- [ ] **Step 2: Manual verification** — log "Dune" twice: second log autocompletes, both notes point at one `media_items` row (check table editor); rating lands in `domain_meta`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): media log form - autocomplete, stars, freeform impression"
```

---

### Task 11: Web — domain chips on capture + domain filter

**Files:**
- Modify: `apps/web/src/app/quick-capture.tsx` (optional one-tap domain chip row), `apps/web/src/app/page.tsx` (`?domain=` filter + filter chips row), `apps/web/src/lib/note-views.ts`
- Test: `apps/web/src/lib/note-views.test.ts` (extend)

**Interfaces:**
- Produces: `matchesView(note, view, domain?)` — third optional arg; when set, note must also have `note.domain === domain`. The list page reads `searchParams.domain` (validated against `noteDomain.options`), adds `.eq("domain", domain)` to the SSR query, and passes it into `NoteList` so the Realtime handler filters consistently. QuickCapture gains a chip row (`media · health · life · learning · finance · reflection`, single-select toggle) that sends `domain` with `createNote`.

- [ ] **Step 1: Extend the failing predicate test**

```ts
it("domain filter narrows any view", () => {
  const health = { lifecycle: "inbox", deleted_at: null, domain: "health" };
  const plain = { lifecycle: "inbox", deleted_at: null, domain: null };
  expect(matchesView(health, "inbox", "health")).toBe(true);
  expect(matchesView(plain, "inbox", "health")).toBe(false);
  expect(matchesView(health, "inbox")).toBe(true); // no filter = unchanged behavior
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// note-views.ts — new signature (backwards compatible)
export function matchesView(
  note: { lifecycle: string; deleted_at: string | null; domain?: string | null },
  view: NoteView,
  domain?: string,
): boolean {
  if (domain && note.domain !== domain) return false;
  if (view === "trash") return note.deleted_at !== null;
  if (note.deleted_at !== null) return false;
  if (view === "active") return note.lifecycle === "active" || note.lifecycle === "evergreen";
  return note.lifecycle === view;
}
```

Wire through: `page.tsx` validates `params.domain` against `noteDomain.options`, adds `.eq("domain", domain)`, renders domain filter chips as links (`/?view=...&domain=media`), passes `domain` prop to `NoteList` (which passes it to every `matchesView` call). QuickCapture keeps a `selectedDomain` state chip row and includes `...(selectedDomain ? { domain: selectedDomain } : {})` in `api.createNote`.

- [ ] **Step 3: Run tests + manual verification** — `pnpm --filter @cortex/web test` PASS; capture with `health` chip → appears under `/?domain=health`, absent under `/?domain=media`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): domain chips on capture + domain filtering in list and realtime"
```

---

### Task 12: Deploy + docs sweep

**Files:**
- Modify: `docs/deploy.md`

- [ ] **Step 1: Update deploy checklist** — migrations `00012`/`00013` must be pushed to the hosted project (`supabase db push`); no new env vars in 1c (Gemini keys arrive in phase 2 — note that explicitly so nobody adds them early); PowerSync sync-rule additions for `media_items`/`checkins`/`flashcards` are a **1b** item, cross-referenced.

- [ ] **Step 2: Full verification** — `pnpm turbo run typecheck lint test` green; manual demo sweep of the phase DoD below.

- [ ] **Step 3: Commit**

```bash
git add docs/deploy.md
git commit -m "docs(deploy): 1c migration push checklist; gemini env deferred to phase 2"
```

---

## Definition of Done (extension spec §7, phase 1c row)

- [ ] One tap on a mood face logs a check-in; undo removes it
- [ ] Log a movie with stars + impression; logging it again autocompletes and reuses the same `media_items` row
- [ ] Capture a note with the `health` chip; it appears under the health domain filter and nowhere else domain-filtered
- [ ] PATCH can set and clear a note's domain; invalid domains are 400 (API) / 23514 (DB)
- [ ] Export zip: manifest contains `media_items`, `checkins`, `flashcards`; media note frontmatter carries `domain: media`
- [ ] Bob cannot read or delete Alice's check-ins, media items, or flashcards (RLS isolation suite green)
- [ ] Embedding columns are `vector(1536)`; `EMBEDDING_MODEL` is `gemini-embedding-001`; full db suite green
- [ ] `pnpm turbo run typecheck lint test` green
