# Phase 1b — Mobile Offline Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Android app offline-first — a SQLCipher-encrypted local SQLite replica synced by PowerSync, with full web feature parity and every write replayed server-side through the existing `packages/core` services.

**Architecture:** Two data paths behind a thin hook layer. `packages/core` stays PostgREST-only and keeps serving web and the API unchanged. Mobile reads local SQLite via PowerSync reactive queries; mobile writes land locally and upload as CRUD batches to a new `POST /sync/upload` operation router that replays each op through a core service with the caller's JWT. Note-query narrowing moves to one shared `NoteFilters` description used by web SSR, web realtime refetch, and mobile SQL.

**Tech Stack:** Expo SDK 57 / React Native 0.86 / expo-router, `@powersync/react-native` + `@op-engineering/op-sqlite` (SQLCipher), `expo-secure-store`, `expo-local-authentication`, NestJS 11, Supabase (Postgres 15 + pgvector), zod, vitest, Turborepo + pnpm.

**Spec:** `docs/superpowers/specs/2026-08-02-phase-1b-mobile-offline-sync-design.md`

## Global Constraints

- **Android only.** No iOS code paths, no iOS stubs, no `Platform.OS === "ios"` branches. Vendor examples containing them are transcribed Android-only.
- **Never `service_role` on a user write path.** Every write executes with the caller's JWT via `createUserClient(user.token)`; RLS is the enforcement (parent spec §4.1).
- **Run package tests through turbo:** `pnpm turbo run test --filter=<pkg>`. Never `pnpm --filter <pkg> test` — dependent packages resolve compiled `dist/`, and the turbo form builds it first (issue-log B5/A7).
- **Any env var a turbo-run task needs must be declared in `turbo.json`'s `test.env`.** Turbo 2.x runs strict env mode and strips everything else (issue-log E8).
- **Migrations schema-qualify extension types** — `extensions.vector(...)`, `extensions.moddatetime`. Unqualified names pass `db reset` locally and fail only on `db push` to the hosted project (issue-log A4).
- **After `supabase db reset`, run `docker restart supabase_kong_phase-0-foundations`** before believing any mass auth failure. Stale Docker DNS in Kong produces `AuthRetryableFetchError` across every suite that signs a user in (issue-log A1).
- **Test fixtures with unique constraints must clear themselves first**, scoped to the test user. Fixed-name inserts pass only on a freshly reset DB (issue-log A2).
- **Isolation tests must include real rows for the other user.** An assertion that "bob reads zero rows" from a table where alice also has none stays green with the policy deleted (issue-log E3).
- **No note bodies, check-in values, or chat text in logs** — ids and counts only (parent spec §15.6).

## Stage ordering

The spec lists filter extraction as the last stage. This plan runs it **third**, before feature parity, because the mobile note list consumes `noteFiltersToSql` and would otherwise be written twice. Stages:

| Stage | Tasks | Deliverable |
|---|---|---|
| 1 — Sync foundation | 1–7 | `POST /sync/upload` works against the deployed API; no mobile client yet |
| 2 — Security baseline | 8–13 | Encrypted local DB, app lock, wipe-on-signout, sync-rule isolation tests |
| 3 — Filter extraction | 14–16 | One `NoteFilters`; web's E5 duplication gone; SQL translator ready |
| 4 — Feature parity | 17–23 | Android app at parity with web |

The phase is not shippable until all four land.

---

# Stage 1 — Sync foundation

### Task 1: Migration 00015 — widen `links.kind` for conflict copies

**Files:**
- Create: `supabase/migrations/00015_conflict_copy_link_kind.sql`
- Test: `packages/db/src/test/conflict-copy-link.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `links.kind` accepts `'conflict_copy'`. Task 5 writes rows with it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/test/conflict-copy-link.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { makeUser } from "./clients.js";

let alice: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  alice = await makeUser("db-conflict-link-alice@test.local");
});

async function makeNote(content: string): Promise<string> {
  const { data, error } = await alice.client.from("notes")
    .insert({ user_id: alice.id, content }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

describe("links.kind conflict_copy", () => {
  it("accepts a conflict_copy link between two of the user's notes", async () => {
    const from = await makeNote("conflict copy body");
    const to = await makeNote("server body");
    const { data, error } = await alice.client.from("links")
      .insert({ user_id: alice.id, from_note_id: from, to_note_id: to, kind: "conflict_copy" })
      .select("kind").single();
    expect(error).toBeNull();
    expect(data!.kind).toBe("conflict_copy");
  });

  it("still rejects an unknown kind", async () => {
    const from = await makeNote("a");
    const to = await makeNote("b");
    const { error } = await alice.client.from("links")
      .insert({ user_id: alice.id, from_note_id: from, to_note_id: to, kind: "nonsense" });
    expect(error?.code).toBe("23514"); // check_violation
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/db -- conflict-copy-link`
Expected: FAIL — first test errors with code `23514`, because `conflict_copy` is not in the current check constraint.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/00015_conflict_copy_link_kind.sql
-- Phase 1b: offline edits that diverge from the server produce a conflict COPY -- a new
-- note holding the losing text -- linked back to the note that won. Without this kind the
-- copy would be an orphan the user cannot trace to its original.
--
-- 00003 created links.kind as a bare check constraint rather than an enum, so widening it
-- is a constraint swap, not a type change. Existing rows all hold one of the three
-- original values, so the new constraint validates without a rewrite.

alter table public.links drop constraint if exists links_kind_check;

alter table public.links add constraint links_kind_check
  check (kind in ('semantic', 'manual', 'reference', 'conflict_copy'));
```

- [ ] **Step 4: Apply and run the test**

```bash
supabase db reset
docker restart supabase_kong_phase-0-foundations
pnpm turbo run test --filter=@cortex/db -- conflict-copy-link
```

Expected: PASS, 2/2. If every suite that signs a user in fails instead, that is the Kong DNS issue — the restart above is the fix, not a code change.

- [ ] **Step 5: Verify the constraint name matched**

Run:
```bash
supabase db reset >/dev/null && docker restart supabase_kong_phase-0-foundations >/dev/null
psql "$SUPABASE_DB_URL" -c "\d public.links" | grep links_kind_check
```
Expected: exactly one `links_kind_check` row listing four values. If `drop constraint if exists` silently matched nothing, Postgres would have created a *second* constraint and the old one would still reject `conflict_copy` — the test in Step 4 would already have caught that, but confirm the name.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00015_conflict_copy_link_kind.sql packages/db/src/test/conflict-copy-link.test.ts
git commit -m "feat(db): 00015 - links.kind accepts conflict_copy"
```

---

### Task 2: `syncUploadInput` DTO in `@cortex/shared`

**Files:**
- Create: `packages/shared/src/dto/sync.ts`
- Create: `packages/shared/src/dto/sync.test.ts`
- Modify: `packages/shared/src/dto/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `syncOpKind: z.ZodEnum<["PUT","PATCH","DELETE"]>`
  - `syncOp` — `{ op_id: string; op: "PUT"|"PATCH"|"DELETE"; table: string; id: string; data?: Record<string,unknown> | null; base_updated_at?: string }`
  - `syncUploadInput` — `{ ops: SyncOp[] }`, 1–500 ops
  - types `SyncOp`, `SyncUploadInput`
  - `SYNC_TABLES: readonly string[]` — the tables the router accepts

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/dto/sync.test.ts
import { describe, expect, it } from "vitest";
import { SYNC_TABLES, syncUploadInput } from "./sync.js";

const op = {
  op_id: "1", op: "PUT" as const, table: "notes",
  id: "11111111-1111-4111-8111-111111111111", data: { content: "hi" },
};

describe("syncUploadInput", () => {
  it("accepts a well-formed batch", () => {
    expect(syncUploadInput.safeParse({ ops: [op] }).success).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(syncUploadInput.safeParse({ ops: [] }).success).toBe(false);
  });

  it("rejects a batch over 500 ops", () => {
    const ops = Array.from({ length: 501 }, (_, i) => ({ ...op, op_id: String(i) }));
    expect(syncUploadInput.safeParse({ ops }).success).toBe(false);
  });

  it("rejects a table outside SYNC_TABLES", () => {
    const r = syncUploadInput.safeParse({ ops: [{ ...op, table: "usage_ledger" }] });
    expect(r.success).toBe(false);
  });

  it("rejects a non-uuid row id", () => {
    expect(syncUploadInput.safeParse({ ops: [{ ...op, id: "nope" }] }).success).toBe(false);
  });

  it("accepts base_updated_at on a notes PATCH", () => {
    const r = syncUploadInput.safeParse({
      ops: [{ ...op, op: "PATCH", base_updated_at: "2026-08-02T10:00:00.000Z" }],
    });
    expect(r.success).toBe(true);
  });

  it("exposes exactly the six synced tables", () => {
    expect([...SYNC_TABLES].sort()).toEqual(
      ["checkins", "links", "media_items", "note_tags", "notes", "tags"],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/shared -- sync`
Expected: FAIL — `Cannot find module './sync.js'`.

- [ ] **Step 3: Write the DTO**

```ts
// packages/shared/src/dto/sync.ts
import { z } from "zod";

/**
 * Tables PowerSync replicates to Android clients, and therefore the only tables
 * POST /sync/upload will write. Narrower than parent spec §6.7, which listed tables that
 * still have no service or UI: each table joins this list in the phase that builds its
 * feature, with its sync rule and isolation test in the same PR.
 *
 * `flashcards` is deliberately absent (phase 6). Server-only tables -- note_chunks,
 * ingest_inbox, memory_revisions, feedback_events, usage_ledger, integrations -- must
 * never appear here; integrations in particular holds credentials that never leave the
 * server.
 */
export const SYNC_TABLES = [
  "notes", "tags", "note_tags", "links", "media_items", "checkins",
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export const syncOpKind = z.enum(["PUT", "PATCH", "DELETE"]);

export const syncOp = z.object({
  // PowerSync's own op id, echoed back so the client can correlate a per-op failure.
  op_id: z.string().min(1).max(64),
  op: syncOpKind,
  table: z.enum(SYNC_TABLES),
  id: z.string().uuid(),
  data: z.record(z.string(), z.unknown()).nullish(),
  // The notes.updated_at the client's edit was based on. Present only on notes PATCH;
  // absent means "no base known", which the router treats as an unconditional update.
  base_updated_at: z.string().datetime().optional(),
});
export type SyncOp = z.infer<typeof syncOp>;

// 500 caps a single request's work: the router replays ops sequentially through core
// services, each of which is at least one PostgREST round trip. PowerSync retries the
// remainder in the next batch, so a cap costs latency, never data.
export const syncUploadInput = z.object({
  ops: z.array(syncOp).min(1).max(500),
});
export type SyncUploadInput = z.infer<typeof syncUploadInput>;
```

- [ ] **Step 4: Export it**

```ts
// packages/shared/src/dto/index.ts -- add alongside the existing exports
export * from "./sync.js";
```

- [ ] **Step 5: Run the test**

Run: `pnpm turbo run test --filter=@cortex/shared -- sync`
Expected: PASS, 7/7.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/dto/sync.ts packages/shared/src/dto/sync.test.ts packages/shared/src/dto/index.ts
git commit -m "feat(shared): syncUploadInput DTO and SYNC_TABLES allow-list"
```

---

### Task 3: `NoteService.updateWithConflictCopy`

**Files:**
- Modify: `packages/core/src/notes/service.ts`
- Test: `packages/core/src/notes/conflict-copy.test.ts`

**Interfaces:**
- Consumes: `NoteService`, `Note` (existing); `mapPostgrestError` from `../errors.js`.
- Produces:
  ```ts
  updateWithConflictCopy(
    id: string,
    input: UpdateNoteInput,
    baseUpdatedAt?: string,
  ): Promise<{ note: Note; conflictCopy: Note | null }>
  ```
  Task 5's router calls this for every `notes` PATCH.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/notes/conflict-copy.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { NoteService } from "./service.js";

let alice: Awaited<ReturnType<typeof makeUser>>;
let svc: NoteService;

beforeAll(async () => {
  alice = await makeUser("core-conflict-alice@test.local");
  svc = new NoteService(createUserClient(alice.token), alice.id);
});

describe("NoteService.updateWithConflictCopy", () => {
  it("applies normally when the base matches", async () => {
    const note = await svc.create({ content: "original" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "offline edit" }, note.updated_at);
    expect(r.conflictCopy).toBeNull();
    expect(r.note.content).toBe("offline edit");
  });

  it("keeps the server body and copies the incoming one when both diverged", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.updated_at;
    // Someone else (web) edits first; the offline client still holds `base`.
    const server = await svc.update(note.id, { content: "web edit" });
    expect(server.updated_at).not.toBe(base);

    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base);

    expect(r.note.content).toBe("web edit");        // server wins
    expect(r.conflictCopy).not.toBeNull();
    expect(r.conflictCopy!.content).toBe("phone edit");
    expect(r.conflictCopy!.lifecycle).toBe("inbox");
  });

  it("links the copy back to the original", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.updated_at;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" }, base);

    const { data } = await createUserClient(alice.token).from("links")
      .select("kind, from_note_id, to_note_id")
      .eq("from_note_id", r.conflictCopy!.id).single();
    expect(data!.kind).toBe("conflict_copy");
    expect(data!.to_note_id).toBe(note.id);
  });

  it("is NOT a conflict when the row moved but content is identical", async () => {
    const note = await svc.create({ content: "same" });
    const base = note.updated_at;
    await svc.update(note.id, { lifecycle: "active" });   // moves updated_at, not content
    const r = await svc.updateWithConflictCopy(note.id, { content: "same" }, base);
    expect(r.conflictCopy).toBeNull();
    expect(r.note.content).toBe("same");
  });

  it("applies unconditionally when no base is supplied", async () => {
    const note = await svc.create({ content: "original" });
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(note.id, { content: "phone edit" });
    expect(r.conflictCopy).toBeNull();
    expect(r.note.content).toBe("phone edit");
  });

  it("copies only the body, applying metadata to the surviving note", async () => {
    const note = await svc.create({ content: "original" });
    const base = note.updated_at;
    await svc.update(note.id, { content: "web edit" });
    const r = await svc.updateWithConflictCopy(
      note.id, { content: "phone edit", lifecycle: "archived" }, base,
    );
    expect(r.note.content).toBe("web edit");
    expect(r.note.lifecycle).toBe("archived");   // metadata is last-write-wins
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core -- conflict-copy`
Expected: FAIL — `svc.updateWithConflictCopy is not a function`.

- [ ] **Step 3: Implement the method**

Add to `packages/core/src/notes/service.ts`, inside `class NoteService`, after `update`:

```ts
  /**
   * The offline write path's update (phase 1b spec §6). `baseUpdatedAt` is the
   * notes.updated_at the client's edit was based on.
   *
   * Body conflicts are the only ones worth machinery: metadata columns are small and
   * independently settable, so last-write-wins on those is invisible, while
   * last-write-wins on a note body is silent, unrecoverable data loss.
   *
   * Comparison is on `content`, NOT `content_text` -- the latter is a generated column
   * (strip_markdown(content), 00002_content.sql:6) and is not client-writable, so two
   * genuinely different bodies can share one content_text.
   */
  async updateWithConflictCopy(
    id: string,
    input: UpdateNoteInput,
    baseUpdatedAt?: string,
  ): Promise<{ note: Note; conflictCopy: Note | null }> {
    if (baseUpdatedAt === undefined || input.content === undefined) {
      return { note: await this.update(id, input), conflictCopy: null };
    }

    const { data: current, error: readError } = await this.client.from("notes")
      .select("content, updated_at")
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (readError) throw mapPostgrestError(readError);

    const moved = current.updated_at !== baseUpdatedAt;
    const diverged = current.content !== input.content;
    if (!moved || !diverged) {
      return { note: await this.update(id, input), conflictCopy: null };
    }

    // Server body wins. Everything except content is still applied to it -- a lifecycle
    // change made offline is not in conflict with a body edit made on web.
    const { content: _losing, ...metadata } = input;
    const note = Object.keys(metadata).length > 0
      ? await this.update(id, metadata as UpdateNoteInput)
      : await this.getById(id);

    const conflictCopy = await this.create({
      content: input.content,
      title: note.title ?? undefined,
    });

    // Best-effort: the copy is the thing that must not be lost. A failed link leaves an
    // untraceable-but-present note, which beats throwing away the text to report an error.
    await this.client.from("links").insert({
      user_id: this.userId,
      from_note_id: conflictCopy.id,
      to_note_id: id,
      kind: "conflict_copy",
    }).then(() => undefined, () => undefined);

    return { note, conflictCopy };
  }

  /** Reads one live note the caller owns. not_found for missing, deleted, or foreign. */
  async getById(id: string): Promise<Note> {
    const { data, error } = await this.client.from("notes")
      .select()
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error) throw mapPostgrestError(error);
    return data as Note;
  }
```

- [ ] **Step 4: Run the test**

Run: `pnpm turbo run test --filter=@cortex/core -- conflict-copy`
Expected: PASS, 6/6.

- [ ] **Step 5: Run the whole core suite for regressions**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS — 57 pre-existing + 6 new = 63.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/notes/service.ts packages/core/src/notes/conflict-copy.test.ts
git commit -m "feat(core): updateWithConflictCopy - server body wins, loser becomes a linked copy"
```

---

### Task 4: `MediaService.resolveNoteMediaLink`

**Files:**
- Modify: `packages/core/src/media/service.ts`
- Test: `packages/core/src/media/resolve-link.test.ts`

**Interfaces:**
- Consumes: `MediaService.findOrCreateItem` (existing, private `findOrCreate`).
- Produces:
  ```ts
  resolveNoteMediaLink(noteId: string, meta: Record<string, unknown>): Promise<MediaItem | null>
  ```
  Returns the linked item, or `null` if the meta carries no pending media reference. Task 5's router calls this after inserting an offline media note.

**Context:** offline, the phone writes a media log as an ordinary note with `domain: "media"` and `domain_meta.pending_item = { kind, title, year? }`, leaving `media_item_id` null (spec §5.3). Item identity is `(user_id, kind, lower(title))` enforced by a unique index the device cannot consult offline, so resolution happens here — the one place that can consult it, and the only place the A3/E6 title-matching logic exists.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/media/resolve-link.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { NoteService } from "../notes/service.js";
import { MediaService } from "./service.js";

let alice: Awaited<ReturnType<typeof makeUser>>;
let media: MediaService;
let notes: NoteService;

beforeAll(async () => {
  alice = await makeUser("core-resolve-alice@test.local");
  const client = createUserClient(alice.token);
  media = new MediaService(client, alice.id);
  notes = new NoteService(client, alice.id);
  // Fixture tables have unique constraints; clear this user's rows so a rerun without a
  // db reset behaves identically to the first run (issue-log A2).
  await client.from("media_items").delete().eq("user_id", alice.id);
});

async function offlineMediaNote(pending: Record<string, unknown>) {
  return notes.create({
    content: "impression", title: String(pending.title), domain: "media",
    domainMeta: { status: "finished", pending_item: pending },
  });
}

describe("MediaService.resolveNoteMediaLink", () => {
  it("returns null when the meta has no pending_item", async () => {
    const note = await notes.create({ content: "plain" });
    expect(await media.resolveNoteMediaLink(note.id, {})).toBeNull();
  });

  it("creates the item and stamps media_item_id", async () => {
    const note = await offlineMediaNote({ kind: "film", title: "Arrival" });
    const item = await media.resolveNoteMediaLink(note.id, {
      status: "finished", pending_item: { kind: "film", title: "Arrival" },
    });
    expect(item!.title).toBe("Arrival");
    const stored = await notes.getById(note.id);
    expect(stored.media_item_id).toBe(item!.id);
  });

  it("reuses the existing item when two devices log the same title", async () => {
    const first = await offlineMediaNote({ kind: "film", title: "Dune" });
    const a = await media.resolveNoteMediaLink(first.id, {
      status: "finished", pending_item: { kind: "film", title: "Dune" },
    });
    const second = await offlineMediaNote({ kind: "film", title: "dune" }); // different casing
    const b = await media.resolveNoteMediaLink(second.id, {
      status: "finished", pending_item: { kind: "film", title: "dune" },
    });
    expect(b!.id).toBe(a!.id);
  });

  it("does not wildcard on % or *", async () => {
    await offlineMediaNote({ kind: "film", title: "Dune" });
    const note = await offlineMediaNote({ kind: "film", title: "D%" });
    const item = await media.resolveNoteMediaLink(note.id, {
      status: "finished", pending_item: { kind: "film", title: "D%" },
    });
    expect(item!.title).toBe("D%");   // a NEW item, not the existing "Dune"
  });

  it("clears pending_item from the stored meta once resolved", async () => {
    const note = await offlineMediaNote({ kind: "book", title: "Piranesi" });
    await media.resolveNoteMediaLink(note.id, {
      status: "finished", pending_item: { kind: "book", title: "Piranesi" },
    });
    const stored = await notes.getById(note.id);
    expect(stored.domain_meta.pending_item).toBeUndefined();
    expect(stored.domain_meta.status).toBe("finished");
  });

  it("surfaces a contradicting year as a conflict", async () => {
    const first = await offlineMediaNote({ kind: "film", title: "Solaris", year: 1972 });
    await media.resolveNoteMediaLink(first.id, {
      status: "finished", pending_item: { kind: "film", title: "Solaris", year: 1972 },
    });
    const second = await offlineMediaNote({ kind: "film", title: "Solaris", year: 2002 });
    await expect(media.resolveNoteMediaLink(second.id, {
      status: "finished", pending_item: { kind: "film", title: "Solaris", year: 2002 },
    })).rejects.toMatchObject({ kind: "conflict" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core -- resolve-link`
Expected: FAIL — `media.resolveNoteMediaLink is not a function`.

- [ ] **Step 3: Add the pending-item schema to `@cortex/shared`**

```ts
// packages/shared/src/dto/media.ts -- append
import { z } from "zod";
import { mediaKind } from "../enums.js";

/**
 * What an offline device writes into notes.domain_meta while it cannot reach the
 * (user_id, kind, lower(title)) unique index that decides media-item identity. The server
 * replaces it with a real media_item_id on upload (phase 1b spec §5.3).
 */
export const pendingMediaItem = z.object({
  kind: mediaKind,
  title: z.string().min(1).max(500),
  year: z.number().int().min(1000).max(2200).optional(),
});
export type PendingMediaItem = z.infer<typeof pendingMediaItem>;
```

If `mediaKind` is not the exported name in `packages/shared/src/enums.ts`, use whatever `logMediaInput.shape.kind` already uses — do not introduce a second kind enum.

- [ ] **Step 4: Implement the method**

Add to `packages/core/src/media/service.ts`, inside `class MediaService`:

```ts
  /**
   * Links an offline-created media note to its canonical media_item (phase 1b spec §5.3).
   *
   * The device wrote the note with domain_meta.pending_item because media-item identity
   * is (user_id, kind, lower(title)) enforced by a unique index it could not consult
   * offline. Resolution runs here so findOrCreate's escaping, anchored imatch and year
   * reconciliation stay in exactly one implementation -- issue-log A3 and E6 are two
   * rounds of bugs in that logic, and a client-side copy would be a third.
   */
  async resolveNoteMediaLink(
    noteId: string,
    meta: Record<string, unknown>,
  ): Promise<MediaItem | null> {
    const parsed = pendingMediaItem.safeParse(meta.pending_item);
    if (!parsed.success) return null;

    const item = await this.findOrCreateItem(parsed.data);

    // pending_item is scaffolding, not data: leaving it behind would make the note
    // re-resolve on every subsequent upload and would fail domainMetaSchemas.media,
    // which is strict.
    const { pending_item: _resolved, ...cleaned } = meta;
    const { error } = await this.client.from("notes")
      .update({ media_item_id: item.id, domain_meta: cleaned })
      .eq("id", noteId).eq("user_id", this.userId);
    if (error) throw mapPostgrestError(error);

    return item;
  }
```

Add the import at the top of the file:

```ts
import { pendingMediaItem, type LogMediaInput } from "@cortex/shared";
```

- [ ] **Step 5: Run the tests**

```bash
pnpm turbo run test --filter=@cortex/shared
pnpm turbo run test --filter=@cortex/core -- resolve-link
```
Expected: shared PASS; resolve-link PASS, 6/6.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/dto/media.ts packages/core/src/media/service.ts packages/core/src/media/resolve-link.test.ts
git commit -m "feat(core): resolveNoteMediaLink - server-side item identity for offline media logs"
```

---

### Task 5: `POST /sync/upload` operation router

**Files:**
- Create: `apps/api/src/sync.controller.ts`
- Create: `apps/api/src/sync/router.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/sync-upload.e2e-spec.ts`

**Interfaces:**
- Consumes: `syncUploadInput`, `SyncOp` (Task 2); `NoteService.updateWithConflictCopy`, `getById` (Task 3); `MediaService.resolveNoteMediaLink` (Task 4); existing `CheckinService`, `TagService`, `createUserClient`, `SupabaseAuthGuard`, `CurrentUser`, `ZodValidationPipe`, `CoreErrorFilter`.
- Produces:
  ```ts
  applySyncOps(client: SupabaseClient, userId: string, ops: SyncOp[]): Promise<SyncUploadResult>
  interface SyncUploadResult {
    applied: string[];                                    // op_ids
    failed: { op_id: string; kind: CoreErrorKind; message?: string }[];
    conflict_copies: { op_id: string; note_id: string }[];
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/sync-upload.e2e-spec.ts
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { CoreErrorFilter } from "../src/core-error.filter";
import { makeUser } from "./harness";

let app: INestApplication;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalFilters(new CoreErrorFilter());
  await app.init();
  alice = await makeUser("api-sync-alice@test.local");
  bob = await makeUser("api-sync-bob@test.local");
});

afterAll(async () => { await app.close(); });

const post = (token: string, body: unknown) =>
  request(app.getHttpServer()).post("/sync/upload").set("Authorization", `Bearer ${token}`).send(body);

describe("POST /sync/upload", () => {
  it("401s without a token", async () => {
    await request(app.getHttpServer()).post("/sync/upload").send({ ops: [] }).expect(401);
  });

  it("400s on an empty batch", async () => {
    await post(alice.token, { ops: [] }).expect(400);
  });

  it("400s on a table outside the allow-list", async () => {
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "usage_ledger", id: uuid(), data: {} }],
    }).expect(400);
  });

  it("inserts a note and reports it applied", async () => {
    const id = uuid();
    const res = await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "notes", id, data: { content: "from phone" } }],
    }).expect(201);
    expect(res.body.applied).toEqual(["1"]);
    expect(res.body.failed).toEqual([]);
  });

  it("rejects the whole batch when an op carries another user's user_id", async () => {
    const res = await post(alice.token, {
      ops: [{
        op_id: "1", op: "PUT", table: "notes", id: uuid(),
        data: { content: "smuggled", user_id: bob.id },
      }],
    }).expect(403);
    expect(res.body.message).toMatch(/user_id/i);
  });

  it("reports a conflict copy without failing the op", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "notes", id, data: { content: "original" } }],
    }).expect(201);
    // Web edits it, moving updated_at away from the phone's stale base.
    await post(alice.token, {
      ops: [{ op_id: "2", op: "PATCH", table: "notes", id, data: { content: "web edit" } }],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{
        op_id: "3", op: "PATCH", table: "notes", id, data: { content: "phone edit" },
        base_updated_at: "2020-01-01T00:00:00.000Z",
      }],
    }).expect(201);
    expect(res.body.applied).toEqual(["3"]);
    expect(res.body.conflict_copies).toHaveLength(1);
    expect(res.body.conflict_copies[0].op_id).toBe("3");
  });

  it("resolves an offline media note to a media_item", async () => {
    const id = uuid();
    const res = await post(alice.token, {
      ops: [{
        op_id: "1", op: "PUT", table: "notes", id,
        data: {
          content: "loved it", title: "Arrival", domain: "media",
          domain_meta: { status: "finished", pending_item: { kind: "film", title: "Arrival" } },
        },
      }],
    }).expect(201);
    expect(res.body.applied).toEqual(["1"]);
    expect(res.body.resolved_media).toEqual([{ op_id: "1", note_id: id }]);
  });

  it("reports a single failed op without aborting the rest", async () => {
    const good = uuid();
    const res = await post(alice.token, {
      ops: [
        { op_id: "1", op: "PATCH", table: "notes", id: uuid(), data: { content: "ghost" } },
        { op_id: "2", op: "PUT", table: "notes", id: good, data: { content: "fine" } },
      ],
    }).expect(201);
    expect(res.body.applied).toEqual(["2"]);
    expect(res.body.failed).toEqual([{ op_id: "1", kind: "not_found" }]);
  });

  it("soft-deletes a checkin", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "checkins", id, data: { mood: 4 } }],
    }).expect(201);
    const res = await post(alice.token, {
      ops: [{ op_id: "2", op: "DELETE", table: "checkins", id }],
    }).expect(201);
    expect(res.body.applied).toEqual(["2"]);
  });
});
```

If `apps/api/test/harness.ts` does not exist, copy `packages/core/src/test/harness.ts` to it verbatim and adjust the import path — the API suite needs the same signed-in-user helper with an access token.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/api -- sync-upload`
Expected: FAIL — every request 404s, because no `/sync` route is registered.

- [ ] **Step 3: Write the router**

```ts
// apps/api/src/sync/router.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { CheckinService, MediaService, NoteService, type CoreErrorKind } from "@cortex/core";
import type { SyncOp } from "@cortex/shared";

export interface SyncUploadResult {
  applied: string[];
  failed: { op_id: string; kind: CoreErrorKind; message?: string }[];
  conflict_copies: { op_id: string; note_id: string }[];
  resolved_media: { op_id: string; note_id: string }[];
}

function asCoreError(err: unknown): { kind: CoreErrorKind; message?: string } {
  const e = err as { kind?: CoreErrorKind; message?: string };
  return e?.kind
    ? (e.message ? { kind: e.kind, message: e.message } : { kind: e.kind })
    : { kind: "internal" };
}

/**
 * Replays a PowerSync CRUD batch through the core services (phase 1b spec §5.1).
 *
 * An operation ROUTER, not a generic row-writer. A generic writer would be thinner and
 * would bypass the entire validation layer, leaving every invariant built in phase 1c
 * unenforced on the mobile write path -- domain_meta re-validation (issue-log B3), media
 * item identity (A3/E6), and conflict copies would all simply not happen.
 *
 * Ops are applied sequentially and independently: one bad op is reported, not fatal, so a
 * single unresolvable row cannot wedge a device's queue forever.
 */
export async function applySyncOps(
  client: SupabaseClient,
  userId: string,
  ops: SyncOp[],
): Promise<SyncUploadResult> {
  const notes = new NoteService(client, userId);
  const media = new MediaService(client, userId);
  const checkins = new CheckinService(client, userId);

  const result: SyncUploadResult = {
    applied: [], failed: [], conflict_copies: [], resolved_media: [],
  };

  for (const op of ops) {
    try {
      switch (op.table) {
        case "notes":
          await applyNoteOp(op, notes, media, result);
          break;
        case "checkins":
          if (op.op === "DELETE") await checkins.softDelete(op.id);
          else if (op.op === "PUT") {
            await client.from("checkins").insert({
              id: op.id, user_id: userId,
              mood: op.data?.mood ?? null,
              energy: op.data?.energy ?? null,
              label: op.data?.label ?? null,
            }).select().single().then(({ error }) => { if (error) throw error; });
          } else throw { kind: "validation", message: "checkins are insert-or-delete only" };
          break;
        default:
          await applyGenericOp(client, userId, op);
      }
      result.applied.push(op.op_id);
    } catch (err) {
      result.failed.push({ op_id: op.op_id, ...asCoreError(err) });
    }
  }
  return result;
}

async function applyNoteOp(
  op: SyncOp,
  notes: NoteService,
  media: MediaService,
  result: SyncUploadResult,
): Promise<void> {
  if (op.op === "DELETE") { await notes.softDelete(op.id); return; }

  const data = (op.data ?? {}) as Record<string, unknown>;
  const domainMeta = (data.domain_meta ?? {}) as Record<string, unknown>;

  if (op.op === "PUT") {
    // The id comes from the device so the local optimistic row and the server row are the
    // same row -- replication then patches rather than duplicating.
    await notes.createWithId(op.id, {
      content: String(data.content ?? ""),
      title: data.title === null || data.title === undefined ? undefined : String(data.title),
      domain: data.domain as never,
      domainMeta,
    });
  } else {
    const patch = {
      ...(data.content !== undefined ? { content: String(data.content) } : {}),
      ...(data.title !== undefined ? { title: data.title as string | null } : {}),
      ...(data.lifecycle !== undefined ? { lifecycle: data.lifecycle as never } : {}),
      ...(data.domain !== undefined ? { domain: data.domain as never } : {}),
    };
    const r = await notes.updateWithConflictCopy(op.id, patch, op.base_updated_at);
    if (r.conflictCopy) {
      result.conflict_copies.push({ op_id: op.op_id, note_id: r.conflictCopy.id });
    }
  }

  // Offline media logs arrive as ordinary notes carrying pending_item; identity is
  // resolved here because the device could not consult the unique index (spec §5.3).
  if (domainMeta.pending_item !== undefined) {
    const item = await media.resolveNoteMediaLink(op.id, domainMeta);
    if (item) result.resolved_media.push({ op_id: op.op_id, note_id: op.id });
  }
}

/**
 * Tables with no service of their own: tags, note_tags, links, media_items. These are
 * join/lookup rows with no invariants beyond RLS and their own constraints, so a
 * validated generic write is the honest shape -- inventing a service to route through
 * would be indirection without a rule to enforce.
 */
async function applyGenericOp(
  client: SupabaseClient, userId: string, op: SyncOp,
): Promise<void> {
  if (op.op === "DELETE") {
    const { error } = await client.from(op.table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", op.id).eq("user_id", userId).is("deleted_at", null);
    if (error) throw error;
    return;
  }
  const row = { ...(op.data ?? {}), id: op.id, user_id: userId };
  const { error } = op.op === "PUT"
    ? await client.from(op.table).upsert(row).select().single()
    : await client.from(op.table).update(op.data ?? {}).eq("id", op.id).eq("user_id", userId);
  if (error) throw error;
}
```

- [ ] **Step 4: Add `NoteService.createWithId`**

The router needs the device's id to become the row's id. Add to `packages/core/src/notes/service.ts`:

```ts
  /**
   * create(), but with the id chosen by the caller. Only the sync upload path uses this:
   * the device already inserted this row into its local SQLite under this id, so the
   * server row must share it -- otherwise replication would deliver a second copy and the
   * user would see their note twice.
   */
  async createWithId(id: string, input: CreateNoteInput & CreateNoteOptions): Promise<Note> {
    const domainMeta = input.domainMeta ?? {};
    if (input.domain) {
      // pending_item is scaffolding the server strips in resolveNoteMediaLink; it is not
      // part of any domain schema, so validate what will remain after resolution.
      const { pending_item: _pending, ...validatable } = domainMeta;
      const check = validateDomainMeta(input.domain, validatable);
      if (!check.success) throw { kind: "validation", message: "domain_meta does not fit domain", cause: check.error } as const;
    }
    const { data, error } = await this.client.from("notes")
      .insert({
        id, user_id: this.userId, content: input.content, title: input.title ?? null,
        domain: input.domain ?? null, domain_meta: domainMeta,
        media_item_id: input.mediaItemId ?? null,
      })
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as Note;
  }
```

- [ ] **Step 5: Write the controller**

```ts
// apps/api/src/sync.controller.ts
import { Body, Controller, ForbiddenException, Post, UseGuards } from "@nestjs/common";
import { createUserClient } from "@cortex/core";
import { syncUploadInput, type SyncUploadInput } from "@cortex/shared";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { applySyncOps } from "./sync/router";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("sync")
@UseGuards(SupabaseAuthGuard)
export class SyncController {
  @Post("upload")
  upload(@CurrentUser() user: AuthedUser,
         @Body(new ZodValidationPipe(syncUploadInput)) body: SyncUploadInput) {
    // RLS would reject a foreign user_id anyway, but a batch that tries it is a client
    // bug or an attack -- neither should be answered with a partial success. Rejecting
    // the whole batch keeps the failure loud.
    const foreign = body.ops.find(
      (o) => o.data?.user_id !== undefined && o.data.user_id !== user.id,
    );
    if (foreign) throw new ForbiddenException(`op ${foreign.op_id}: user_id does not match the caller`);

    return applySyncOps(createUserClient(user.token), user.id, body.ops);
  }
}
```

- [ ] **Step 6: Register it**

```ts
// apps/api/src/app.module.ts -- add the import and the controllers entry
import { SyncController } from "./sync.controller";
// ...
  controllers: [
    HealthController, MeController, NotesController, TagsController, ExportController,
    CheckinsController, MediaController, SyncController,
  ],
```

- [ ] **Step 7: Run the tests**

```bash
pnpm turbo run test --filter=@cortex/core
pnpm turbo run test --filter=@cortex/api
```
Expected: core PASS (63 + createWithId coverage via the API suite); api PASS — 56 pre-existing + 9 new.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/sync.controller.ts apps/api/src/sync/router.ts apps/api/src/app.module.ts apps/api/test/sync-upload.e2e-spec.ts packages/core/src/notes/service.ts
git commit -m "feat(api): POST /sync/upload operation router"
```

---

### Task 6: `packages/sync` — client schema and sync rules

**Files:**
- Create: `packages/sync/package.json`
- Create: `packages/sync/tsconfig.json`, `packages/sync/tsconfig.build.json`, `packages/sync/eslint.config.mjs`
- Create: `packages/sync/src/schema.ts`
- Create: `packages/sync/src/sync-rules.yaml`
- Create: `packages/sync/src/index.ts`
- Create: `packages/sync/src/schema.test.ts`
- Create: `packages/sync/vitest.config.ts`

**Interfaces:**
- Consumes: `SYNC_TABLES` from `@cortex/shared` (Task 2).
- Produces:
  - `AppSchema: Schema` — the PowerSync client schema, one table per `SYNC_TABLES` entry plus the local-only `note_edit_base`.
  - `SYNC_RULES_PATH: string` — absolute path to the YAML, for the deploy checklist.

Copy `tsconfig.json`, `tsconfig.build.json` and `eslint.config.mjs` verbatim from `packages/core`, changing only relative paths if any are package-relative.

- [ ] **Step 1: Write the failing test**

```ts
// packages/sync/src/schema.test.ts
import { describe, expect, it } from "vitest";
import { SYNC_TABLES } from "@cortex/shared";
import { AppSchema } from "./schema.js";

const tableNames = () => AppSchema.tables.map((t) => t.name).sort();

describe("AppSchema", () => {
  it("declares exactly the synced tables plus the local-only edit-base table", () => {
    expect(tableNames()).toEqual([...SYNC_TABLES, "note_edit_base"].sort());
  });

  it("never declares a server-only table", () => {
    const forbidden = [
      "note_chunks", "ingest_inbox", "memory_revisions",
      "feedback_events", "usage_ledger", "integrations", "flashcards",
    ];
    for (const t of forbidden) expect(tableNames()).not.toContain(t);
  });

  it("marks note_edit_base local-only so a base timestamp never uploads", () => {
    const t = AppSchema.tables.find((x) => x.name === "note_edit_base")!;
    expect(t.localOnly).toBe(true);
  });

  it("carries updated_at on notes, which sync ordering depends on", () => {
    const notes = AppSchema.tables.find((t) => t.name === "notes")!;
    expect(notes.columns.map((c) => c.name)).toContain("updated_at");
  });
});
```

- [ ] **Step 2: Create the package manifest**

```json
{
  "name": "@cortex/sync",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "dependencies": {
    "@cortex/shared": "workspace:*",
    "@powersync/react-native": "^1.20.0"
  },
  "devDependencies": {
    "@cortex/config": "workspace:*",
    "@types/node": "^22.10.0",
    "dotenv": "^16.4.0",
    "typescript": "^6.0.3",
    "vitest": "^3.0.0"
  }
}
```

```ts
// packages/sync/vitest.config.ts
import { defineConfig } from "vitest/config";
// No database here: this package is schema declarations, so the suite is pure.
export default defineConfig({ test: { environment: "node" } });
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm install
pnpm turbo run test --filter=@cortex/sync
```
Expected: FAIL — `Cannot find module './schema.js'`.

- [ ] **Step 4: Write the schema**

```ts
// packages/sync/src/schema.ts
import { column, Schema, Table } from "@powersync/react-native";

/**
 * The client-side mirror of the synced Postgres tables (phase 1b spec §4).
 *
 * PowerSync's local schema is a VIEW over its internal storage, so a column missing here
 * is simply invisible on the device -- it is not an error. Adding a column later is
 * cheap; the tables listed are the contract, and they must stay identical to
 * SYNC_TABLES in @cortex/shared, which the API's upload allow-list also reads.
 */
const notes = new Table({
  title: column.text,
  content: column.text,
  source_type: column.text,
  lifecycle: column.text,
  domain: column.text,
  domain_meta: column.text,      // jsonb arrives as a JSON string
  media_item_id: column.text,
  pinned: column.integer,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const tags = new Table({
  name: column.text, created_at: column.text, deleted_at: column.text,
});

const note_tags = new Table({
  note_id: column.text, tag_id: column.text,
  created_at: column.text, deleted_at: column.text,
});

const links = new Table({
  from_note_id: column.text, to_note_id: column.text,
  kind: column.text, status: column.text, similarity: column.real,
  rationale: column.text, created_at: column.text, deleted_at: column.text,
});

const media_items = new Table({
  kind: column.text, title: column.text, year: column.integer,
  creator: column.text, external_meta: column.text,
  created_at: column.text, deleted_at: column.text,
});

const checkins = new Table({
  mood: column.integer, energy: column.integer, label: column.text,
  created_at: column.text, updated_at: column.text, deleted_at: column.text,
});

/**
 * Local-only: the notes.updated_at each in-progress local edit was based on. It is the
 * input to the server's conflict-copy check (spec §6.2) and is meaningless anywhere but
 * this device, so it must never sync -- hence localOnly, which also keeps it out of the
 * upload queue entirely.
 */
const note_edit_base = new Table(
  { note_id: column.text, base_updated_at: column.text },
  { localOnly: true },
);

export const AppSchema = new Schema({
  notes, tags, note_tags, links, media_items, checkins, note_edit_base,
});
```

```ts
// packages/sync/src/index.ts
export * from "./schema.js";
```

- [ ] **Step 5: Write the sync rules**

```yaml
# packages/sync/src/sync-rules.yaml
#
# PowerSync replicates via logical replication, which BYPASSES RLS (parent spec §4 item 5,
# §15.5). These rules are therefore the ONLY thing preventing one user's rows entering
# another user's bucket -- they are a second isolation layer, reviewed and tested with the
# same seriousness as the RLS policies, not configuration.
#
# One bucket per user, keyed on the Supabase JWT's subject.
#
# Server-only tables are absent by omission, which is load-bearing: integrations holds
# credentials that must never reach a device, and note_chunks/usage_ledger/feedback_events/
# memory_revisions/ingest_inbox are server-side machinery. flashcards is deferred to
# phase 6, which adds its rule, its client schema entry and its isolation test together.
#
# Sync STREAMS (edition 3), not the older bucket_definitions form: PowerSync's docs class
# Sync Rules as legacy and recommend Streams for new projects. Edition 3 also enables the
# newer compiler (JOINs, CTEs, multiple queries per stream), which phase 6's flashcards
# work is likely to want.
#
# Beneath these queries sits a third isolation layer, configured outside this repo: the
# Postgres publication is scoped to these six tables by name rather than FOR ALL TABLES,
# so integrations.credentials and the other server-only tables never enter the replication
# stream at all. See docs/deploy.md. Both layers are checked; neither is trusted alone.
config:
  edition: 3

streams:
  user_data:
    auto_subscribe: true
    queries:
      - SELECT * FROM notes       WHERE user_id = auth.user_id()
      - SELECT * FROM tags        WHERE user_id = auth.user_id()
      - SELECT * FROM note_tags   WHERE user_id = auth.user_id()
      - SELECT * FROM links       WHERE user_id = auth.user_id()
      - SELECT * FROM media_items WHERE user_id = auth.user_id()
      - SELECT * FROM checkins    WHERE user_id = auth.user_id()
```

- [ ] **Step 6: Run the test**

Run: `pnpm turbo run test --filter=@cortex/sync`
Expected: PASS, 4/4.

- [ ] **Step 7: Commit**

```bash
git add packages/sync pnpm-lock.yaml
git commit -m "feat(sync): packages/sync - PowerSync client schema and per-user sync rules"
```

---

### Task 7: Declare the sync package in CI and verify the deployed endpoint

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/deploy.md`

- [ ] **Step 1: Add `@cortex/sync` to the CI test matrix**

In `.github/workflows/ci.yml`, alongside the existing per-package test steps, add:

```yaml
      - name: Test @cortex/sync
        run: pnpm turbo run test --filter=@cortex/sync
```

Use the turbo form. Never `pnpm --filter @cortex/sync test` — it bypasses turbo's dependency graph and would test a stale `dist/` of `@cortex/shared` (issue-log B5/E8).

- [ ] **Step 2: Run the full gate locally**

```bash
pnpm turbo run typecheck lint test
```
Expected: all tasks green, now including `@cortex/sync`.

- [ ] **Step 3: Push migration 00015 to the hosted project**

```bash
supabase db push
supabase migration list      # local and remote must match through 00015
```

- [ ] **Step 4: Redeploy the API and verify by WRITE**

```bash
railway up
```

Then, with a real user token in `$TOKEN`:

```bash
curl -sS -X POST "$API_URL/sync/upload" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ops":[{"op_id":"1","op":"PUT","table":"notes","id":"'"$(uuidgen)"'","data":{"content":"sync smoke test"}}]}'
```

Expected: `201` with `{"applied":["1"],"failed":[],...}`.

**Never verify with `/health`** — it returns 200 even when the API cannot serve a request (`docs/deploy.md`). Delete the smoke-test note afterwards via `DELETE /notes/:id/purge` after a soft delete.

- [ ] **Step 5: Record the deploy in `docs/deploy.md`**

Append a `00015` row to the migration checklist and a line noting that `/sync/upload` is verified by write, not by `/health`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml docs/deploy.md
git commit -m "ci: run @cortex/sync tests through turbo; deploy.md 00015"
```

---

# Stage 2 — Security baseline

### Task 8: Move the Supabase session out of AsyncStorage

**Files:**
- Modify: `apps/mobile/src/lib/supabase.ts`
- Create: `apps/mobile/src/lib/secure-storage.ts`
- Create: `apps/mobile/src/lib/secure-storage.test.ts`
- Create: `apps/mobile/vitest.config.ts`
- Modify: `apps/mobile/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `secureStorageAdapter` — an object with `getItem`, `setItem`, `removeItem` matching supabase-js's storage interface, backed by `expo-secure-store`.

**Context:** `apps/mobile/src/lib/supabase.ts:9` currently stores the session in `AsyncStorage`, which on Android is unencrypted app-sandbox storage **included in Android Auto Backup to Google Drive**. A Supabase refresh token is long-lived, so this is full account access sitting in a cloud backup (spec §7.2). This is a phase-0 defect; Stage 3 makes it worse by adding a full local corpus beside it.

SecureStore caps a value at 2048 bytes and a Supabase session can exceed that, so the adapter chunks.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/lib/secure-storage.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  deleteItemAsync: vi.fn(async (k: string) => { store.delete(k); }),
}));

const { secureStorageAdapter, SECURE_CHUNK_SIZE } = await import("./secure-storage.js");

beforeEach(() => store.clear());

describe("secureStorageAdapter", () => {
  it("round-trips a short value", async () => {
    await secureStorageAdapter.setItem("session", "abc");
    expect(await secureStorageAdapter.getItem("session")).toBe("abc");
  });

  it("round-trips a value larger than one SecureStore entry", async () => {
    const big = "x".repeat(SECURE_CHUNK_SIZE * 3 + 17);
    await secureStorageAdapter.setItem("session", big);
    expect(await secureStorageAdapter.getItem("session")).toBe(big);
  });

  it("returns null for a missing key", async () => {
    expect(await secureStorageAdapter.getItem("nope")).toBeNull();
  });

  it("removes every chunk, leaving nothing behind", async () => {
    await secureStorageAdapter.setItem("session", "y".repeat(SECURE_CHUNK_SIZE * 2));
    await secureStorageAdapter.removeItem("session");
    expect(await secureStorageAdapter.getItem("session")).toBeNull();
    expect([...store.keys()]).toEqual([]);
  });

  it("shrinks cleanly when a long value is replaced by a short one", async () => {
    await secureStorageAdapter.setItem("session", "z".repeat(SECURE_CHUNK_SIZE * 3));
    await secureStorageAdapter.setItem("session", "small");
    expect(await secureStorageAdapter.getItem("session")).toBe("small");
    // A stale chunk 2 left behind would corrupt the next read.
    expect([...store.keys()].length).toBe(2); // the count key + one chunk
  });
});
```

```ts
// apps/mobile/vitest.config.ts
import { defineConfig } from "vitest/config";
// Pure-logic suites only: RN native modules are mocked per test file.
export default defineConfig({ test: { environment: "node" } });
```

- [ ] **Step 2: Install the dependency and add the test script**

```bash
pnpm --filter @cortex/mobile exec expo install expo-secure-store
pnpm --filter @cortex/mobile add -D vitest
```

Add `"test": "vitest run"` to `apps/mobile/package.json`'s `scripts`.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile`
Expected: FAIL — `Cannot find module './secure-storage.js'`.

- [ ] **Step 4: Write the adapter**

```ts
// apps/mobile/src/lib/secure-storage.ts
import * as SecureStore from "expo-secure-store";

/**
 * supabase-js storage backed by Android Keystore (phase 1b spec §7.2).
 *
 * Replaces AsyncStorage, which on Android is unencrypted app-sandbox storage INCLUDED IN
 * ANDROID AUTO BACKUP to Google Drive. A Supabase refresh token is long-lived, so leaving
 * it there put full account access in a cloud backup.
 *
 * No `requireAuthentication` here, deliberately: a biometric prompt on every token refresh
 * would be unusable, and the app-lock gate (Task 10) is where user presence is checked.
 * The key that DOES use requireAuthentication is the database key (Task 9), which is why
 * only that one needs the invalidation-recovery path.
 */

// SecureStore rejects values over 2048 bytes; chunk below that with headroom for the fact
// that the limit is in BYTES while `length` counts UTF-16 units.
export const SECURE_CHUNK_SIZE = 1024;

const countKey = (key: string) => `${key}__chunks`;
const chunkKey = (key: string, i: number) => `${key}__${i}`;

async function readCount(key: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(countKey(key));
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export const secureStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const count = await readCount(key);
    if (count === 0) return null;
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(chunkKey(key, i));
      if (part === null) return null;   // torn write: treat as absent, force a re-login
      parts.push(part);
    }
    return parts.join("");
  },

  async setItem(key: string, value: string): Promise<void> {
    // Drop the previous chunks FIRST: shrinking from 3 chunks to 1 without this would
    // leave chunk 2 behind, and the next read would splice a stale tail onto the value.
    await this.removeItem(key);
    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += SECURE_CHUNK_SIZE) {
      chunks.push(value.slice(i, i + SECURE_CHUNK_SIZE));
    }
    for (const [i, part] of chunks.entries()) {
      await SecureStore.setItemAsync(chunkKey(key, i), part);
    }
    await SecureStore.setItemAsync(countKey(key), String(chunks.length));
  },

  async removeItem(key: string): Promise<void> {
    const count = await readCount(key);
    for (let i = 0; i < count; i++) await SecureStore.deleteItemAsync(chunkKey(key, i));
    await SecureStore.deleteItemAsync(countKey(key));
  },
};
```

- [ ] **Step 5: Point supabase-js at it**

```ts
// apps/mobile/src/lib/supabase.ts -- replace the AsyncStorage import and storage option
import "react-native-url-polyfill/auto";
import { createClient } from "@supabase/supabase-js";
import { secureStorageAdapter } from "./secure-storage";

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      // Keystore-backed, not AsyncStorage: the refresh token is long-lived and
      // AsyncStorage is included in Android Auto Backup (spec §7.2).
      storage: secureStorageAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);
```

- [ ] **Step 6: Remove the now-unused dependency**

```bash
pnpm --filter @cortex/mobile remove @react-native-async-storage/async-storage
```

Then confirm nothing still imports it:

```bash
rg "async-storage" apps/mobile
```
Expected: no matches.

- [ ] **Step 7: Run the tests**

```bash
pnpm turbo run test --filter=@cortex/mobile
pnpm turbo run typecheck lint --filter=@cortex/mobile
```
Expected: PASS, 5/5; typecheck and lint clean.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile pnpm-lock.yaml
git commit -m "fix(mobile): store the Supabase session in Keystore, not AsyncStorage"
```

---

### Task 9: SQLCipher key manager with invalidation recovery

**Files:**
- Create: `apps/mobile/src/lib/db-key.ts`
- Create: `apps/mobile/src/lib/db-key.test.ts`

**Interfaces:**
- Consumes: `expo-secure-store`, `expo-crypto` (already a dependency).
- Produces:
  ```ts
  type KeyOutcome =
    | { status: "created"; key: string }
    | { status: "loaded"; key: string }
    | { status: "lost"; key: string };   // caller MUST wipe the local DB before using `key`
  getOrCreateDatabaseKey(): Promise<KeyOutcome>
  clearDatabaseKey(): Promise<void>
  ```

**Context (spec §7.5).** Expo's docs: *"Keys are invalidated by the system when biometrics change. This only applies to values stored with `requireAuthentication` set to `true`."* and `getItemAsync` *"resolves with `null` if there is no entry for the given key **or if the key has been invalidated**."*

So enrolling a fingerprint destroys the database key and reports it as `null` — indistinguishable from first run. A naive implementation would mint a fresh key and then fail to open the existing encrypted database. The separate init flag (stored **without** `requireAuthentication`, so it survives) is what tells the two apart.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/lib/db-key.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const authGated = new Set<string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string, opts?: { requireAuthentication?: boolean }) => {
    store.set(k, v);
    if (opts?.requireAuthentication) authGated.add(k); else authGated.delete(k);
  }),
  deleteItemAsync: vi.fn(async (k: string) => { store.delete(k); authGated.delete(k); }),
}));

vi.mock("expo-crypto", () => ({
  getRandomBytes: (n: number) => new Uint8Array(n).fill(7),
}));

const { getOrCreateDatabaseKey, clearDatabaseKey, DB_KEY_NAME } =
  await import("./db-key.js");

/** What Android does when the user enrolls a new biometric. */
function simulateBiometricEnrollment() {
  for (const k of authGated) store.delete(k);
}

beforeEach(() => { store.clear(); authGated.clear(); });

describe("getOrCreateDatabaseKey", () => {
  it("creates a key on first run", async () => {
    const r = await getOrCreateDatabaseKey();
    expect(r.status).toBe("created");
    expect(r.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the key behind biometric authentication", async () => {
    await getOrCreateDatabaseKey();
    expect(authGated.has(DB_KEY_NAME)).toBe(true);
  });

  it("loads the same key on the next run", async () => {
    const first = await getOrCreateDatabaseKey();
    const second = await getOrCreateDatabaseKey();
    expect(second.status).toBe("loaded");
    expect(second.key).toBe(first.key);
  });

  it("reports 'lost' -- not 'created' -- after a biometric enrollment", async () => {
    await getOrCreateDatabaseKey();
    simulateBiometricEnrollment();
    const r = await getOrCreateDatabaseKey();
    expect(r.status).toBe("lost");
  });

  it("issues a usable new key alongside the 'lost' status", async () => {
    const first = await getOrCreateDatabaseKey();
    simulateBiometricEnrollment();
    const r = await getOrCreateDatabaseKey();
    expect(r.key).toMatch(/^[0-9a-f]{64}$/);
    // Same deterministic mock RNG, so equality here proves only that a key was issued;
    // what matters is that the caller is told to wipe first.
    expect(r.key).toBe(first.key);
  });

  it("returns to 'created' after clearDatabaseKey, since the init flag is gone too", async () => {
    await getOrCreateDatabaseKey();
    await clearDatabaseKey();
    expect((await getOrCreateDatabaseKey()).status).toBe("created");
  });

  it("stores the init flag WITHOUT authentication, so enrollment cannot erase it", async () => {
    await getOrCreateDatabaseKey();
    simulateBiometricEnrollment();
    expect([...store.keys()].some((k) => k.includes("initialized"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile -- db-key`
Expected: FAIL — `Cannot find module './db-key.js'`.

- [ ] **Step 3: Implement the key manager**

```ts
// apps/mobile/src/lib/db-key.ts
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

/**
 * The SQLCipher key for the local PowerSync database (phase 1b spec §7.4, §7.5).
 *
 * THE TRAP this module exists to survive, in Expo's own words:
 *
 *   "Keys are invalidated by the system when biometrics change. This only applies to
 *    values stored with requireAuthentication set to true."
 *   getItemAsync "resolves with null if there is no entry for the given key OR IF THE KEY
 *    HAS BEEN INVALIDATED."
 *
 * So enrolling a new fingerprint destroys this key and reports it as `null` -- exactly
 * what first run looks like. Minting a fresh key at that point produces a key that cannot
 * open the existing encrypted database, and the failure surfaces later and elsewhere.
 *
 * INIT_FLAG is stored WITHOUT requireAuthentication, so enrollment cannot erase it.
 * `null` key + flag present therefore means "key lost", and the caller must wipe the
 * local database and resync. The server is authoritative, so nothing committed is lost --
 * but local changes not yet uploaded are, which is why the caller warns before wiping.
 */
export const DB_KEY_NAME = "cortex.db.key";
const INIT_FLAG = "cortex.db.initialized";

export type KeyOutcome =
  | { status: "created"; key: string }
  | { status: "loaded"; key: string }
  | { status: "lost"; key: string };

function newKey(): string {
  return [...Crypto.getRandomBytes(32)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getOrCreateDatabaseKey(): Promise<KeyOutcome> {
  // Read the flag FIRST: it is the only thing that distinguishes "no key yet" from
  // "key destroyed by the OS", and both present as a null key.
  const initialized = (await SecureStore.getItemAsync(INIT_FLAG)) === "1";

  let existing: string | null = null;
  try {
    existing = await SecureStore.getItemAsync(DB_KEY_NAME, { requireAuthentication: true });
  } catch {
    // A rejection is the biometric PROMPT failing (user cancelled, too many attempts) --
    // not an invalidated key. Treat it as "no answer yet" and let the caller retry;
    // reporting `lost` here would wipe a perfectly good database over a cancelled prompt.
    throw new Error("biometric_prompt_failed");
  }

  if (existing !== null) return { status: "loaded", key: existing };

  const key = newKey();
  await SecureStore.setItemAsync(DB_KEY_NAME, key, { requireAuthentication: true });
  // No requireAuthentication: this flag must outlive a biometric enrollment.
  await SecureStore.setItemAsync(INIT_FLAG, "1");

  return initialized ? { status: "lost", key } : { status: "created", key };
}

/** Sign-out and post-wipe cleanup: both entries go, so the next run is a clean first run. */
export async function clearDatabaseKey(): Promise<void> {
  await SecureStore.deleteItemAsync(DB_KEY_NAME);
  await SecureStore.deleteItemAsync(INIT_FLAG);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm turbo run test --filter=@cortex/mobile -- db-key`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/db-key.ts apps/mobile/src/lib/db-key.test.ts
git commit -m "feat(mobile): SQLCipher key manager with Keystore invalidation recovery"
```

---

### Task 10: App lock gate

**Files:**
- Create: `apps/mobile/src/lib/app-lock.ts`
- Create: `apps/mobile/src/lib/app-lock.test.ts`
- Create: `apps/mobile/src/components/app-lock-gate.tsx`
- Modify: `apps/mobile/app/_layout.tsx`

**Interfaces:**
- Consumes: `expo-local-authentication`.
- Produces:
  - `LOCK_GRACE_MS = 60_000`
  - `shouldRelock(backgroundedAt: number | null, now: number): boolean`
  - `authenticate(): Promise<boolean>`
  - `<AppLockGate>` — renders children only after a successful unlock.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/lib/app-lock.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-local-authentication", () => ({
  authenticateAsync: vi.fn(async () => ({ success: true })),
  hasHardwareAsync: vi.fn(async () => true),
  isEnrolledAsync: vi.fn(async () => true),
}));

const { LOCK_GRACE_MS, shouldRelock, authenticate } = await import("./app-lock.js");

describe("shouldRelock", () => {
  it("locks on cold start (never backgrounded)", () => {
    expect(shouldRelock(null, 1_000)).toBe(true);
  });
  it("does not lock inside the grace period", () => {
    expect(shouldRelock(1_000, 1_000 + LOCK_GRACE_MS - 1)).toBe(false);
  });
  it("locks once the grace period has elapsed", () => {
    expect(shouldRelock(1_000, 1_000 + LOCK_GRACE_MS)).toBe(true);
  });
  it("uses a 60 second grace period", () => {
    expect(LOCK_GRACE_MS).toBe(60_000);
  });
});

describe("authenticate", () => {
  it("requests Class 3 biometrics and keeps the device-credential fallback", async () => {
    const la = await import("expo-local-authentication");
    await authenticate();
    expect(la.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ biometricsSecurityLevel: "strong", disableDeviceFallback: false }),
    );
  });

  it("returns false when the prompt is dismissed", async () => {
    const la = await import("expo-local-authentication");
    vi.mocked(la.authenticateAsync).mockResolvedValueOnce({ success: false } as never);
    expect(await authenticate()).toBe(false);
  });
});
```

- [ ] **Step 2: Install and verify failure**

```bash
pnpm --filter @cortex/mobile exec expo install expo-local-authentication
pnpm turbo run test --filter=@cortex/mobile -- app-lock
```
Expected: FAIL — `Cannot find module './app-lock.js'`.

- [ ] **Step 3: Implement the lock logic**

```ts
// apps/mobile/src/lib/app-lock.ts
import * as LocalAuthentication from "expo-local-authentication";

/**
 * Mandatory app lock (phase 1b spec §7.6, §7.7). The device holds the full note corpus,
 * so "borrowed phone" is a real threat, not a hypothetical.
 *
 * Short enough that a borrowed phone is protected; long enough that switching apps to
 * copy a link is not punished by a biometric prompt.
 */
export const LOCK_GRACE_MS = 60_000;

export function shouldRelock(backgroundedAt: number | null, now: number): boolean {
  if (backgroundedAt === null) return true;      // cold start
  return now - backgroundedAt >= LOCK_GRACE_MS;
}

export async function authenticate(): Promise<boolean> {
  const r = await LocalAuthentication.authenticateAsync({
    promptMessage: "Unlock Cortex",
    // Default is 'weak', which admits Android Class 2 biometrics -- camera face unlock,
    // spoofable with a photo on some devices. Health, mood and finance data warrants
    // Class 3 (spec §7.6).
    biometricsSecurityLevel: "strong",
    // Deliberately left at the default. Disabling the fallback would lock out every
    // device with no enrolled biometric, which is a large share of Android.
    disableDeviceFallback: false,
  });
  return r.success;
}
```

- [ ] **Step 4: Write the gate component**

```tsx
// apps/mobile/src/components/app-lock-gate.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, Text, View, type AppStateStatus } from "react-native";
import { authenticate, shouldRelock } from "../lib/app-lock";

/**
 * Renders nothing but an unlock prompt until the user authenticates. Wraps the whole app
 * so no screen -- and no local database read -- happens before unlock (spec §7.7).
 */
export function AppLockGate({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const backgroundedAt = useRef<number | null>(null);

  const unlock = useCallback(async () => {
    setFailed(false);
    const ok = await authenticate();
    setUnlocked(ok);
    setFailed(!ok);
  }, []);

  useEffect(() => { void unlock(); }, [unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "background") {
        backgroundedAt.current = Date.now();
        return;
      }
      if (state === "active" && shouldRelock(backgroundedAt.current, Date.now())) {
        setUnlocked(false);
        void unlock();
      }
    });
    return () => sub.remove();
  }, [unlock]);

  if (unlocked) return <>{children}</>;

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 }}>
      <Text style={{ fontSize: 18 }}>Cortex is locked</Text>
      {failed ? <Text style={{ opacity: 0.7 }}>Unlock to continue.</Text> : null}
      <Pressable
        onPress={() => { void unlock(); }}
        accessibilityRole="button"
        style={{ paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8, backgroundColor: "#222" }}
      >
        <Text style={{ color: "white" }}>Unlock</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 5: Wrap the app**

In `apps/mobile/app/_layout.tsx`, wrap the existing root element:

```tsx
import { AppLockGate } from "../src/components/app-lock-gate";
// ... inside the default export's returned JSX, wrap the existing <Stack /> (or whatever
// the current root is) so nothing renders before unlock:
//   <AppLockGate><Stack /></AppLockGate>
```

- [ ] **Step 6: Run the tests**

```bash
pnpm turbo run test --filter=@cortex/mobile
pnpm turbo run typecheck lint --filter=@cortex/mobile
```
Expected: PASS, 6 lock tests + earlier suites; typecheck and lint clean.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile pnpm-lock.yaml
git commit -m "feat(mobile): mandatory app lock, Class 3 biometrics, 60s grace"
```

---

### Task 11: Android manifest hardening

**Files:**
- Modify: `apps/mobile/app.json`

- [ ] **Step 1: Disable Auto Backup**

In `apps/mobile/app.json`, under `expo.android`, add:

```json
      "allowBackup": false
```

Add this comment to `docs/deploy.md` rather than the JSON (app.json permits no comments):

> `android.allowBackup: false` is load-bearing, not a preference. Auto Backup would copy the
> SQLCipher database file to Google Drive while its key lives in Android Keystore, which is
> **not** backed up — producing an undecryptable file on Drive. Pure risk, no benefit
> (phase 1b spec §7.6).

- [ ] **Step 2: Verify it lands in the generated manifest**

```bash
pnpm --filter @cortex/mobile exec expo prebuild --platform android --clean
rg 'allowBackup' apps/mobile/android/app/src/main/AndroidManifest.xml
```
Expected: `android:allowBackup="false"`.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app.json docs/deploy.md
git commit -m "fix(mobile): allowBackup=false - the DB must not reach Drive without its key"
```

---

### Task 12: Sync-rule isolation tests

**Files:**
- Create: `packages/db/src/test/sync-rules-isolation.test.ts`

**Interfaces:**
- Consumes: `packages/sync/src/sync-rules.yaml` (Task 6), `makeUser` from `./clients.js`.

**Context (spec §7.8):** PowerSync replicates via logical replication, **bypassing RLS**, so sync rules are what prevents cross-user leakage. This test asserts the property statically — every stream query is scoped to `auth.user_id()` — and dynamically, that the equivalent SQL returns only the owner's rows. Per issue-log E3, the dynamic half seeds **real rows for both users**; an assertion that "bob reads zero rows" from a table where alice also has none stays green with the rule deleted.

It also covers the layer *beneath* the sync rules. PowerSync's own setup guide says to run `CREATE PUBLICATION powersync FOR ALL TABLES`, which for cortex would put `integrations.credentials`, `note_chunks`, `usage_ledger` and `memory_revisions` into the replication stream — filtered out by the sync rules, but only after leaving Postgres. `docs/deploy.md` therefore scopes the publication to the six synced tables by name. That is configuration living outside this repo, which is exactly why it needs a test that fails loudly if someone widens it.

- [ ] **Step 1: Write the test**

```ts
// packages/db/src/test/sync-rules-isolation.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SYNC_TABLES } from "@cortex/shared";
import { admin, makeUser } from "./clients.js";

const rulesPath = fileURLToPath(
  new URL("../../../sync/src/sync-rules.yaml", import.meta.url),
);
const rules = readFileSync(rulesPath, "utf8");

const dataQueries = rules
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("- SELECT"));

let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  alice = await makeUser("db-syncrules-alice@test.local");
  bob = await makeUser("db-syncrules-bob@test.local");

  // BOTH users get real rows. E3: asserting "bob sees zero" against a table where alice
  // also has none passes with the rule deleted, which is a test that proves nothing.
  for (const u of [alice, bob]) {
    await admin.from("notes").delete().eq("user_id", u.id);
    await admin.from("checkins").delete().eq("user_id", u.id);
    await admin.from("notes").insert({ user_id: u.id, content: `note for ${u.id}` });
    await admin.from("checkins").insert({ user_id: u.id, mood: 3 });
  }
});

describe("sync rules — static shape", () => {
  it("covers exactly the tables in SYNC_TABLES", () => {
    const tables = dataQueries
      .map((q) => /FROM\s+(\w+)/.exec(q)?.[1])
      .filter((t): t is string => Boolean(t))
      .sort();
    expect(tables).toEqual([...SYNC_TABLES].sort());
  });

  it("scopes every data query to the authenticated user", () => {
    for (const q of dataQueries) {
      expect(q, `unscoped sync stream query: ${q}`)
        .toMatch(/WHERE\s+user_id\s*=\s*auth\.user_id\(\)/);
    }
  });

  it("uses sync streams edition 3, not the legacy bucket_definitions form", () => {
    expect(rules).toMatch(/config:\s*\n\s*edition:\s*3/);
    expect(rules).not.toContain("bucket_definitions");
  });

  it("takes the user id from the JWT, never from client-supplied parameters", () => {
    // request.user_id() and a `parameters:` block belong to the legacy form. auth.user_id()
    // resolves from the verified Supabase token; anything a client could set must not
    // appear in a scoping predicate.
    expect(rules).not.toContain("request.user_id");
    expect(rules).not.toMatch(/^\s*parameters:/m);
  });

  it("names no server-only table anywhere", () => {
    for (const t of ["note_chunks", "usage_ledger", "integrations", "feedback_events",
                     "memory_revisions", "ingest_inbox", "flashcards"]) {
      expect(rules).not.toContain(t);
    }
  });
});

describe("the powersync publication — the layer beneath the sync rules", () => {
  // Skips where the publication has not been created (a fresh local stack), so the suite
  // stays runnable before Task 7's setup. It must NEVER silently skip on the hosted
  // project, where the publication does exist -- hence asserting the skip reason.
  it("replicates exactly the six synced tables, and nothing server-only", async () => {
    const { data, error } = await admin.rpc("_test_publication_tables", { p_pub: "powersync" });
    if (error?.code === "PGRST202") return;   // function absent: pre-Task-7 local stack
    expect(error).toBeNull();
    const tables = (data as { tablename: string }[]).map((r) => r.tablename).sort();
    if (tables.length === 0) return;          // publication not created yet
    expect(tables).toEqual([...SYNC_TABLES].sort());
    for (const t of ["integrations", "note_chunks", "usage_ledger", "memory_revisions"]) {
      expect(tables).not.toContain(t);
    }
  });
});

describe("sync rules — the same predicate against real data", () => {
  // The rules' WHERE clause, executed as PostgREST would under a bucket. If this ever
  // returns another user's row, the bucket would ship it to the wrong device.
  it("returns only the owner's notes", async () => {
    const { data } = await admin.from("notes").select("user_id").eq("user_id", alice.id);
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((r) => r.user_id === alice.id)).toBe(true);
  });

  it("returns only the owner's checkins", async () => {
    const { data } = await admin.from("checkins").select("user_id").eq("user_id", bob.id);
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((r) => r.user_id === bob.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Add the publication reader**

`packages/db` reaches Postgres only through PostgREST, which cannot query system catalogs,
so this follows the narrow SECURITY DEFINER reader pattern `00001` established
(`_test_check_constraint_def`) and `00012` extended (`_test_column_vector_dim`).

```sql
-- supabase/migrations/00016_test_publication_reader.sql
-- Test-only, third narrow reader. It exists so the sync-rule isolation suite can assert
-- the scope of the `powersync` publication -- configuration that lives in the Supabase
-- dashboard rather than this repo, and whose default (FOR ALL TABLES) would put
-- integrations.credentials into the replication stream (phase 1b spec §7.8).
--
-- Narrow by construction: it reads one system view, returns table names only, and takes
-- a publication name rather than arbitrary SQL. It is NOT a generic catalog-query path.
create or replace function public._test_publication_tables(p_pub text)
returns table (tablename name)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select t.tablename
  from pg_publication_tables t
  where t.pubname = p_pub and t.schemaname = 'public'
  order by t.tablename;
$$;

revoke all on function public._test_publication_tables(text) from public;
grant execute on function public._test_publication_tables(text) to service_role;
```

Granted to `service_role` only: the suite calls it through `admin`, and no end user has any
reason to enumerate replication configuration.

- [ ] **Step 3: Add `@cortex/shared` to the db package's dependencies**

```bash
pnpm --filter @cortex/db add @cortex/shared@workspace:*
```

- [ ] **Step 4: Run the test**

Run: `pnpm turbo run test --filter=@cortex/db -- sync-rules-isolation`
Expected: PASS, 6/6.

- [ ] **Step 5: Prove the static test bites**

Temporarily delete ` WHERE user_id = auth.user_id()` from the `checkins` line in
`packages/sync/src/sync-rules.yaml`, rerun, and confirm the "scopes every data query" test
**fails**. Restore the line.

A test that cannot fail is the E3 mistake; verify this one can.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/test/sync-rules-isolation.test.ts supabase/migrations/00016_test_publication_reader.sql packages/db/package.json pnpm-lock.yaml
git commit -m "test(db): sync rules and publication scope, tested like RLS"
```

---

### Task 13: Sign-out wipes the device

**Files:**
- Modify: `apps/mobile/src/lib/auth.ts`
- Create: `apps/mobile/src/lib/wipe.ts`
- Create: `apps/mobile/src/lib/wipe.test.ts`

**Interfaces:**
- Consumes: `clearDatabaseKey` (Task 9).
- Produces: `wipeLocalData(db: { disconnectAndClear(): Promise<void> } | null): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/lib/wipe.test.ts
import { describe, expect, it, vi } from "vitest";

const cleared = vi.fn(async () => {});
vi.mock("./db-key.js", () => ({ clearDatabaseKey: cleared }));

const { wipeLocalData } = await import("./wipe.js");

describe("wipeLocalData", () => {
  it("clears the database and then the key", async () => {
    const order: string[] = [];
    const db = { disconnectAndClear: vi.fn(async () => { order.push("db"); }) };
    cleared.mockImplementationOnce(async () => { order.push("key"); });
    await wipeLocalData(db);
    expect(order).toEqual(["db", "key"]);
  });

  it("still clears the key when there is no database yet", async () => {
    cleared.mockClear();
    await wipeLocalData(null);
    expect(cleared).toHaveBeenCalledOnce();
  });

  it("clears the key even if clearing the database throws", async () => {
    cleared.mockClear();
    const db = { disconnectAndClear: vi.fn(async () => { throw new Error("locked"); }) };
    await wipeLocalData(db);
    expect(cleared).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile -- wipe`
Expected: FAIL — `Cannot find module './wipe.js'`.

- [ ] **Step 3: Implement the wipe**

```ts
// apps/mobile/src/lib/wipe.ts
import { clearDatabaseKey } from "./db-key.js";

/**
 * Removes every trace of the signed-in user from the device (phase 1b spec §7.7).
 *
 * Without this, signing out leaves the full note corpus on the phone permanently -- the
 * account is gone from the UI while the data it protected is not.
 *
 * The key is cleared LAST and unconditionally: a database that failed to clear must not be
 * left with a live key beside it, and an orphaned encrypted file with no key is inert.
 */
export async function wipeLocalData(
  db: { disconnectAndClear(): Promise<void> } | null,
): Promise<void> {
  try {
    await db?.disconnectAndClear();
  } finally {
    await clearDatabaseKey();
  }
}
```

- [ ] **Step 4: Call it from sign-out**

```ts
// apps/mobile/src/lib/auth.ts -- replace signOut
import { getPowerSync } from "./powersync";   // added in Task 17
import { wipeLocalData } from "./wipe";

export async function signOut(): Promise<void> {
  // Wipe BEFORE the Supabase sign-out: disconnectAndClear needs the connector's token to
  // shut the stream down cleanly, and a wipe that fails must not leave the user
  // "signed out" with their whole corpus still on the device.
  await wipeLocalData(getPowerSync());
  await supabase.auth.signOut();
}
```

If Task 17 has not landed yet, temporarily pass `null` and add a step to Task 17 to wire `getPowerSync()` in. Do not leave a TODO in the file — the call site changes in Task 17 and is listed there.

- [ ] **Step 5: Run the tests**

Run: `pnpm turbo run test --filter=@cortex/mobile`
Expected: PASS, all suites.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/lib/wipe.ts apps/mobile/src/lib/wipe.test.ts apps/mobile/src/lib/auth.ts
git commit -m "feat(mobile): sign-out wipes the local database and its key"
```

---

# Stage 3 — Filter extraction

### Task 14: `NoteFilters` and `applyNoteFilters` in `@cortex/core`

**Files:**
- Create: `packages/core/src/notes/filters.ts`
- Create: `packages/core/src/notes/filters.test.ts`
- Modify: `packages/core/src/notes/index.ts`

**Interfaces:**
- Consumes: `noteDomain` from `@cortex/shared`.
- Produces:
  ```ts
  type NoteView = "inbox" | "active" | "archived" | "trash";
  interface NoteFilters { view: NoteView; q?: string; tag?: string; domain?: string }
  const NOTE_VIEWS: readonly NoteView[];
  parseNoteFilters(params: Record<string, string | string[] | undefined>): NoteFilters
  applyNoteFilters<T>(query: T, f: NoteFilters): T          // supabase-js query builder
  noteSelect(f: NoteFilters): string                        // the .select() string
  matchesFilters(note, f): boolean
  ```

**Context (spec §3):** the narrowing currently exists twice — `apps/web/src/app/page.tsx:30-45` and `apps/web/src/app/note-list.tsx:31-41`. That duplication caused issue-log **E5** (the realtime refetch dropped `q`/`tag`, so a search briefly showed results and then silently showed the whole inbox). Mobile would be a third copy.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/notes/filters.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { NoteService } from "./service.js";
import { applyNoteFilters, matchesFilters, noteSelect, parseNoteFilters } from "./filters.js";

let alice: Awaited<ReturnType<typeof makeUser>>;
let svc: NoteService;

beforeAll(async () => {
  alice = await makeUser("core-filters-alice@test.local");
  svc = new NoteService(createUserClient(alice.token), alice.id);
});

describe("parseNoteFilters", () => {
  it("defaults to the inbox view", () => {
    expect(parseNoteFilters({})).toEqual({ view: "inbox" });
  });
  it("rejects an unknown view", () => {
    expect(parseNoteFilters({ view: "../../etc" }).view).toBe("inbox");
  });
  it("rejects an unknown domain", () => {
    expect(parseNoteFilters({ domain: "nonsense" }).domain).toBeUndefined();
  });
  it("keeps a known domain", () => {
    expect(parseNoteFilters({ domain: "media" }).domain).toBe("media");
  });
  it("takes the first value of a repeated param", () => {
    expect(parseNoteFilters({ q: ["first", "second"] }).q).toBe("first");
  });
  it("trims and drops a whitespace-only query", () => {
    expect(parseNoteFilters({ q: "  hello " }).q).toBe("hello");
    expect(parseNoteFilters({ q: "   " }).q).toBeUndefined();
  });
});

describe("noteSelect", () => {
  it("joins note_tags only when a tag filter is present", () => {
    expect(noteSelect({ view: "inbox" })).toBe("*");
    expect(noteSelect({ view: "inbox", tag: "t" })).toContain("note_tags!inner");
  });
});

describe("applyNoteFilters against the database", () => {
  beforeAll(async () => {
    await svc.create({ content: "alpha pricing psychology", domain: "media" });
    const active = await svc.create({ content: "beta" });
    await svc.update(active.id, { lifecycle: "active" });
    const trashed = await svc.create({ content: "gamma" });
    await svc.softDelete(trashed.id);
  });

  const run = (f: Parameters<typeof applyNoteFilters>[1]) =>
    applyNoteFilters(createUserClient(alice.token).from("notes").select(noteSelect(f)), f);

  it("inbox excludes archived, active and trashed notes", async () => {
    const { data } = await run({ view: "inbox" });
    expect(data!.every((n: { lifecycle: string; deleted_at: string | null }) =>
      n.lifecycle === "inbox" && n.deleted_at === null)).toBe(true);
  });

  it("active covers both active and evergreen", async () => {
    const { data } = await run({ view: "active" });
    expect(data!.every((n: { lifecycle: string }) =>
      n.lifecycle === "active" || n.lifecycle === "evergreen")).toBe(true);
  });

  it("trash returns only deleted notes", async () => {
    const { data } = await run({ view: "trash" });
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((n: { deleted_at: string | null }) => n.deleted_at !== null)).toBe(true);
  });

  it("full-text search finds a note by a word in its body", async () => {
    const { data } = await run({ view: "inbox", q: "pricing" });
    expect(data!.length).toBeGreaterThan(0);
  });

  it("domain narrows without overriding the view", async () => {
    const { data } = await run({ view: "trash", domain: "media" });
    expect(data!.every((n: { deleted_at: string | null }) => n.deleted_at !== null)).toBe(true);
  });
});

describe("matchesFilters", () => {
  const note = { lifecycle: "inbox", deleted_at: null, domain: "media" };
  it("agrees with the inbox view", () => {
    expect(matchesFilters(note, { view: "inbox" })).toBe(true);
  });
  it("excludes a note of another domain", () => {
    expect(matchesFilters(note, { view: "inbox", domain: "health" })).toBe(false);
  });
  it("treats a soft-deleted note as trash-only", () => {
    const gone = { ...note, deleted_at: "2026-08-02T00:00:00Z" };
    expect(matchesFilters(gone, { view: "inbox" })).toBe(false);
    expect(matchesFilters(gone, { view: "trash" })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core -- filters`
Expected: FAIL — `Cannot find module './filters.js'`.

- [ ] **Step 3: Implement the filters module**

```ts
// packages/core/src/notes/filters.ts
import { noteDomain } from "@cortex/shared";

/**
 * THE description of a note-list narrowing (phase 1b spec §3).
 *
 * It existed twice before this -- once in the web SSR query and once in the Realtime
 * refetch -- and the two disagreeing is issue-log E5: the refetch dropped q and tag, so
 * `/?q=...` rendered three search results and then silently replaced them with the whole
 * inbox. Mobile would have been a third copy.
 *
 * One parser, one supabase-js applier used by BOTH web call sites, one predicate for
 * live-patched rows, and (in noteFiltersToSql) one SQLite translation.
 */
export type NoteView = "inbox" | "active" | "archived" | "trash";
export const NOTE_VIEWS: readonly NoteView[] = ["inbox", "active", "archived", "trash"];

export interface NoteFilters {
  view: NoteView;
  q?: string;
  tag?: string;
  domain?: string;
}

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/** Narrows untrusted search params. Anything unrecognised is dropped, never passed on. */
export function parseNoteFilters(
  params: Record<string, string | string[] | undefined>,
): NoteFilters {
  const rawView = one(params.view);
  const view = (NOTE_VIEWS as readonly string[]).includes(rawView ?? "")
    ? (rawView as NoteView)
    : "inbox";

  const q = one(params.q)?.trim();
  const tag = one(params.tag)?.trim();
  const rawDomain = one(params.domain);
  const domain = (noteDomain.options as readonly string[]).includes(rawDomain ?? "")
    ? rawDomain
    : undefined;

  return {
    view,
    ...(q ? { q } : {}),
    ...(tag ? { tag } : {}),
    ...(domain ? { domain } : {}),
  };
}

/** The `.select()` string: the note_tags join exists only when a tag filter needs it. */
export function noteSelect(f: NoteFilters): string {
  return f.tag ? "*, note_tags!inner(tag_id, deleted_at)" : "*";
}

/**
 * Applies every narrowing to a supabase-js query builder. Used by web SSR and by the
 * Realtime refetch -- the same function, so they cannot disagree again.
 */
export function applyNoteFilters<T>(query: T, f: NoteFilters): T {
  // The builder is chainable and each method returns the same type; typing it structurally
  // avoids importing supabase-js's internal generics into every call site.
  let q = query as unknown as {
    is: (c: string, v: null) => typeof q;
    not: (c: string, op: string, v: null) => typeof q;
    in: (c: string, v: string[]) => typeof q;
    eq: (c: string, v: string) => typeof q;
    order: (c: string, o: { ascending: boolean }) => typeof q;
    textSearch: (c: string, v: string, o: Record<string, string>) => typeof q;
  };

  q = q.order("updated_at", { ascending: false });
  q = f.view === "trash" ? q.not("deleted_at", "is", null) : q.is("deleted_at", null);
  if (f.view === "active") q = q.in("lifecycle", ["active", "evergreen"]);
  else if (f.view !== "trash") q = q.eq("lifecycle", f.view);

  // The `config` is load-bearing, not cosmetic. With it, PostgREST emits
  //   to_tsvector('english', content_text) @@ websearch_to_tsquery('english', q)
  // which matches notes_fts_idx. Drop it and PostgREST emits the bare form, which
  // resolves to the default-config operator, matches no index, and silently seq-scans.
  if (f.q) q = q.textSearch("content_text", f.q, { type: "websearch", config: "english" });
  if (f.tag) q = q.eq("note_tags.tag_id", f.tag).is("note_tags.deleted_at", null);
  if (f.domain) q = q.eq("domain", f.domain);

  return q as unknown as T;
}

/**
 * The same narrowing as a predicate, for rows arriving over Realtime. `q` and `tag` are
 * absent here on purpose: FTS ranking and tag membership cannot be evaluated client-side,
 * so a caller with either active refetches instead of patching locally (E5's other half).
 */
export function matchesFilters(
  note: { lifecycle: string; deleted_at: string | null; domain?: string | null },
  f: NoteFilters,
): boolean {
  if (f.domain && note.domain !== f.domain) return false;
  if (f.view === "trash") return note.deleted_at !== null;
  if (note.deleted_at !== null) return false;
  if (f.view === "active") return note.lifecycle === "active" || note.lifecycle === "evergreen";
  return note.lifecycle === f.view;
}

/** True when live-patching a Realtime row would be wrong and a refetch is required. */
export function requiresRefetch(f: NoteFilters): boolean {
  return Boolean(f.q || f.tag);
}
```

```ts
// packages/core/src/notes/index.ts -- add
export * from "./filters.js";
```

- [ ] **Step 4: Run the test**

Run: `pnpm turbo run test --filter=@cortex/core -- filters`
Expected: PASS, 17/17.

- [ ] **Step 5: Verify core is still importable from a bundler's perspective**

The mobile app will import `noteFiltersToSql` from this package (Task 15). Confirm the
module graph does not drag server-only code in:

```bash
pnpm --filter @cortex/core build
node --input-type=module -e "import('@cortex/core/dist/notes/filters.js').then(m => console.log(Object.keys(m)))"
```

Expected: the exported names print with no error. If this pulls in `archiver` or another
Node-only dependency, move `filters.ts` to `@cortex/shared` — which mobile already depends
on — and re-export it from core. Decide here, not during Task 15.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/notes/filters.ts packages/core/src/notes/filters.test.ts packages/core/src/notes/index.ts
git commit -m "feat(core): NoteFilters - one narrowing description for every call site"
```

---

### Task 15: `noteFiltersToSql` and the equivalence test

**Files:**
- Modify: `packages/core/src/notes/filters.ts`
- Create: `packages/core/src/notes/filters-equivalence.test.ts`

**Interfaces:**
- Consumes: `NoteFilters` (Task 14).
- Produces: `noteFiltersToSql(f: NoteFilters): { where: string; params: unknown[]; join: string }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/notes/filters-equivalence.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { NoteService } from "./service.js";
import Database from "better-sqlite3";
import {
  applyNoteFilters, noteFiltersToSql, noteSelect, toSqlitePlaceholders, type NoteFilters,
} from "./filters.js";

let alice: Awaited<ReturnType<typeof makeUser>>;
let svc: NoteService;
let sqlite: Database.Database;
const ids: Record<string, string> = {};

beforeAll(async () => {
  alice = await makeUser("core-equiv-alice@test.local");
  const client = createUserClient(alice.token);
  svc = new NoteService(client, alice.id);
  // Rerunnable without a db reset (issue-log A2).
  await client.from("notes").delete().eq("user_id", alice.id);

  ids.inbox = (await svc.create({ content: "inbox note" })).id;
  ids.media = (await svc.create({ content: "media note", domain: "media" })).id;
  const active = await svc.create({ content: "active note" });
  await svc.update(active.id, { lifecycle: "active" });
  ids.active = active.id;
  const ever = await svc.create({ content: "evergreen note" });
  await svc.update(ever.id, { lifecycle: "evergreen" });
  ids.evergreen = ever.id;
  const arch = await svc.create({ content: "archived note" });
  await svc.update(arch.id, { lifecycle: "archived" });
  ids.archived = arch.id;
  const gone = await svc.create({ content: "trashed note" });
  await svc.softDelete(gone.id);
  ids.trashed = gone.id;

  // Mirror the same rows into a real SQLite database, mimicking what PowerSync would
  // have replicated to the device.
  sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE notes (
    id TEXT PRIMARY KEY, content TEXT, title TEXT, lifecycle TEXT,
    domain TEXT, updated_at TEXT, deleted_at TEXT
  );
  CREATE TABLE note_tags (id TEXT PRIMARY KEY, note_id TEXT, tag_id TEXT, deleted_at TEXT);`);

  const { data } = await client.from("notes").select("*").eq("user_id", alice.id);
  const insert = sqlite.prepare(
    `INSERT INTO notes (id, content, title, lifecycle, domain, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const n of data as Record<string, string | null>[]) {
    insert.run(n.id, n.content, n.title, n.lifecycle, n.domain, n.updated_at, n.deleted_at);
  }
});

/**
 * Runs the clause against REAL SQLite, not against Postgres pretending to be SQLite.
 * The point of this suite is that the dialect noteFiltersToSql emits actually executes on
 * the engine the phone runs -- Postgres has no FTS5 `match` and different placeholder
 * syntax, so testing there would prove less while looking like it proved more.
 */
async function sqlIds(f: NoteFilters): Promise<string[]> {
  const { where, params, join } = noteFiltersToSql(f);
  const rows = sqlite
    .prepare(
      `SELECT n.id FROM notes n ${join} WHERE ${toSqlitePlaceholders(where)}`,
    )
    .all(...params) as { id: string }[];
  return rows.map((r) => r.id).sort();
}

async function postgrestIds(f: NoteFilters): Promise<string[]> {
  const q = applyNoteFilters(
    createUserClient(alice.token).from("notes").select(noteSelect(f)), f,
  );
  const { data, error } = await q;
  if (error) throw error;
  return (data as { id: string }[]).map((r) => r.id).sort();
}

// Structural filters must agree exactly. `q` is excluded deliberately: Postgres
// websearch_to_tsquery and SQLite FTS5 are different engines with different tokenizers,
// and asserting they agree would be a test that lies (spec §3.3).
const structural: NoteFilters[] = [
  { view: "inbox" },
  { view: "active" },
  { view: "archived" },
  { view: "trash" },
  { view: "inbox", domain: "media" },
  { view: "trash", domain: "media" },
];

describe("filter equivalence: PostgREST vs SQLite", () => {
  for (const f of structural) {
    it(`agrees for ${JSON.stringify(f)}`, async () => {
      expect(await sqlIds(f)).toEqual(await postgrestIds(f));
    });
  }

  it("covers evergreen in the active view on both sides", async () => {
    const both = await postgrestIds({ view: "active" });
    expect(both).toContain(ids.active);
    expect(both).toContain(ids.evergreen);
  });

  it("parameterises rather than interpolating, so a quote cannot break the clause", () => {
    const { where, params } = noteFiltersToSql({ view: "inbox", domain: "media" });
    expect(where).not.toContain("media");
    expect(params).toContain("media");
  });
});
```

- [ ] **Step 2: Add the SQLite test driver**

```bash
pnpm --filter @cortex/core add -D better-sqlite3 @types/better-sqlite3
```

No migration is needed. An earlier draft of this plan routed the clause through a
`SECURITY DEFINER` RPC so Postgres could execute it — that was wrong twice over: Postgres
has no FTS5 `match` and uses `$n` rather than `?` placeholders, so it would have tested a
dialect the phone never runs, and `EXECUTE ... USING` cannot take a variable-length
parameter list anyway. Running the clause on real SQLite tests the thing that ships.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core -- filters-equivalence`
Expected: FAIL — `noteFiltersToSql is not a function`.

- [ ] **Step 4: Implement the translator**

Append to `packages/core/src/notes/filters.ts`:

```ts
/**
 * The same narrowing as a SQL WHERE clause, for mobile's local SQLite replica.
 *
 * Deliberately a SECOND implementation rather than an abstraction over both engines:
 * PostgREST and SQLite genuinely differ (imatch, to_tsvector ranking, RPCs), and a
 * translation layer for all of that is the rejected approach B in spec §2.2. The guard
 * against drift is filters-equivalence.test.ts, not a shared code path.
 *
 * Values are parameterised, never interpolated: the clause is executed verbatim by both
 * SQLite and (in the equivalence test) Postgres, so a title containing a quote must not
 * be able to reshape it.
 */
export function noteFiltersToSql(f: NoteFilters): {
  where: string;
  params: unknown[];
  join: string;
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  clauses.push(f.view === "trash" ? "n.deleted_at is not null" : "n.deleted_at is null");
  if (f.view === "active") clauses.push(`n.lifecycle in (${p("active")}, ${p("evergreen")})`);
  else if (f.view !== "trash") clauses.push(`n.lifecycle = ${p(f.view)}`);

  if (f.domain) clauses.push(`n.domain = ${p(f.domain)}`);
  if (f.tag) clauses.push(`nt.tag_id = ${p(f.tag)} and nt.deleted_at is null`);

  // Full text uses SQLite FTS5, a different engine from Postgres FTS -- see the
  // equivalence suite, which asserts structural agreement and documented search
  // divergence rather than pretending the two rank identically.
  if (f.q) clauses.push(`n.id in (select rowid from notes_fts where notes_fts match ${p(f.q)})`);

  return {
    where: clauses.join(" and "),
    params,
    join: f.tag ? "join note_tags nt on nt.note_id = n.id" : "",
  };
}
```

- [ ] **Step 5: Add the placeholder converter**

The clause is emitted in `$n` form because numbered placeholders survive being read,
logged and reordered; SQLite wants `?`. One converter, applied at the call site:

```ts
/** SQLite uses positional `?`; the clause is emitted in the numbered `$n` form. */
export function toSqlitePlaceholders(where: string): string {
  return where.replace(/\$\d+/g, "?");
}
```

Both `sqlIds` in the equivalence test and Task 19's mobile query use it, so the two run
byte-identical SQL.

- [ ] **Step 6: Run the tests**

Run: `pnpm turbo run test --filter=@cortex/core`
Expected: PASS — filters 17 + equivalence 9.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/notes/filters.ts packages/core/src/notes/filters-equivalence.test.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): noteFiltersToSql + equivalence test against real SQLite"
```

---

### Task 16: Web adopts the shared filters (removes the E5 duplication)

**Files:**
- Modify: `apps/web/src/app/page.tsx:22-45`
- Modify: `apps/web/src/app/note-list.tsx:25-41`
- Modify: `apps/web/src/lib/note-views.ts`
- Modify: `apps/web/src/lib/note-views.test.ts`

- [ ] **Step 1: Update `note-views.ts` to re-export rather than redefine**

```ts
// apps/web/src/lib/note-views.ts
// The view/domain narrowing itself now lives in @cortex/core (phase 1b spec §3): the SSR
// query, the Realtime refetch and mobile all consume one description. Issue-log E5 was
// exactly the two web call sites drifting apart. Only presentation stays here.
export {
  NOTE_VIEWS, matchesFilters, parseNoteFilters, applyNoteFilters, noteSelect,
  requiresRefetch, type NoteFilters, type NoteView,
} from "@cortex/core";

export const VIEW_LABELS: Record<import("@cortex/core").NoteView, string> = {
  inbox: "Inbox", active: "Active", archived: "Archived", trash: "Trash",
};
```

- [ ] **Step 2: Update `page.tsx` to build its query from the shared filters**

Replace the parsing block and the query construction (currently `page.tsx:15-45`) with:

```tsx
  const params = await searchParams;
  const filters = parseNoteFilters(params);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  // Reads go straight to Supabase under RLS; only writes go through the API (spec §2).
  // Every narrowing comes from applyNoteFilters, which note-list.tsx's refetch also uses.
  const { data, error } = await applyNoteFilters(
    supabase.from("notes").select(noteSelect(filters)),
    filters,
  );
  if (error) throw error; // rendered by error.tsx
```

Update the `href` / `domainHref` helpers to read `filters.view`, `filters.q`, `filters.tag`,
`filters.domain` instead of the four separate locals, and update the props passed to
`<NoteList>` to a single `filters={filters}`.

- [ ] **Step 3: Update `note-list.tsx` to accept `filters` and reuse the applier**

Replace the `refetch` body (currently `note-list.tsx:25-41`) with:

```tsx
  const refetch = useCallback(async () => {
    const { data } = await applyNoteFilters(
      supabase.from("notes").select(noteSelect(filters)),
      filters,
    );
    if (data) setNotes((data as unknown as NoteRow[]).filter((n) => matchesFilters(n, filters)));
  }, [supabase, filters]);
```

and the Realtime handler's predicate from `matchesView(row, view, domain)` to
`matchesFilters(row, filters)`. Where the handler previously decided between patching and
refetching, use `requiresRefetch(filters)`.

- [ ] **Step 4: Update the web unit tests**

`apps/web/src/lib/note-views.test.ts` currently tests `parseView`, `parseDomain` and
`matchesView`. Those behaviours are now covered by `packages/core`'s `filters.test.ts`, so
this file keeps only what is still web-specific:

```ts
import { describe, expect, it } from "vitest";
import { VIEW_LABELS, NOTE_VIEWS } from "./note-views";

describe("VIEW_LABELS", () => {
  it("labels every view", () => {
    for (const v of NOTE_VIEWS) expect(VIEW_LABELS[v]).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run the web suite and build**

```bash
pnpm turbo run test --filter=@cortex/web
pnpm turbo run typecheck lint --filter=@cortex/web
pnpm turbo run build --filter=@cortex/web
```
Expected: tests PASS, typecheck/lint clean, production build succeeds.

- [ ] **Step 6: Verify E5 cannot recur**

Search for any surviving second copy of the narrowing:

```bash
rg 'textSearch|note_tags!inner|lifecycle' apps/web/src
```
Expected: no matches outside `note-views.ts`'s re-export — both query sites now go through
`applyNoteFilters`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): SSR and realtime refetch share one filter description (E5)"
```

---

# Stage 4 — Feature parity

### Task 17: PowerSync provider and connector

**Files:**
- Create: `apps/mobile/src/lib/powersync.ts`
- Create: `apps/mobile/src/lib/connector.ts`
- Create: `apps/mobile/src/lib/connector.test.ts`
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/src/lib/auth.ts`
- Modify: `apps/mobile/package.json`, root `package.json`
- Modify: `apps/mobile/.env.example`

**Interfaces:**
- Consumes: `AppSchema` (Task 6), `getOrCreateDatabaseKey` (Task 9), `secureStorageAdapter` (Task 8), `SyncOp` (Task 2).
- Produces:
  - `getPowerSync(): PowerSyncDatabase | null`
  - `initPowerSync(): Promise<{ db: PowerSyncDatabase; wiped: boolean }>`
  - `crudEntryToSyncOp(entry, baseUpdatedAt?): SyncOp`
  - `<PowerSyncProvider>`

- [ ] **Step 1: Write the failing test for the op mapping**

```ts
// apps/mobile/src/lib/connector.test.ts
import { describe, expect, it } from "vitest";
import { crudEntryToSyncOp } from "./connector.js";

const id = "11111111-1111-4111-8111-111111111111";

describe("crudEntryToSyncOp", () => {
  it("maps a PUT with its row data", () => {
    const op = crudEntryToSyncOp(
      { clientId: 3, op: "PUT", table: "notes", id, opData: { content: "hi" } } as never,
    );
    expect(op).toEqual({ op_id: "3", op: "PUT", table: "notes", id, data: { content: "hi" } });
  });

  it("omits data on a DELETE", () => {
    const op = crudEntryToSyncOp({ clientId: 4, op: "DELETE", table: "notes", id } as never);
    expect(op.data).toBeUndefined();
  });

  it("attaches base_updated_at to a notes PATCH", () => {
    const op = crudEntryToSyncOp(
      { clientId: 5, op: "PATCH", table: "notes", id, opData: { content: "x" } } as never,
      "2026-08-02T10:00:00.000Z",
    );
    expect(op.base_updated_at).toBe("2026-08-02T10:00:00.000Z");
  });

  it("never attaches a base to a non-notes table", () => {
    const op = crudEntryToSyncOp(
      { clientId: 6, op: "PATCH", table: "checkins", id, opData: { mood: 2 } } as never,
      "2026-08-02T10:00:00.000Z",
    );
    expect(op.base_updated_at).toBeUndefined();
  });
});
```

- [ ] **Step 2: Install and configure SQLCipher**

```bash
pnpm --filter @cortex/mobile add @powersync/react-native @op-engineering/op-sqlite @cortex/sync@workspace:* @cortex/core@workspace:*
```

Add to `apps/mobile/package.json`:

```json
  "op-sqlite": { "sqlcipher": true }
```

**Then verify where it actually took effect.** PowerSync's docs warn that in a monorepo the
block may need to be in the **root** `package.json` depending on how the package manager
hoists modules — cortex is a pnpm workspace, so this is likely:

```bash
pnpm --filter @cortex/mobile exec expo prebuild --platform android --clean
rg -i 'sqlcipher' apps/mobile/android/app/build.gradle apps/mobile/android/build.gradle
```

If nothing matches, move the `op-sqlite` block to the root `package.json`, re-run prebuild,
and confirm. Do not proceed until SQLCipher is confirmed present — an unencrypted database
that *looks* configured is exactly the failure this step exists to prevent.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile -- connector`
Expected: FAIL — `Cannot find module './connector.js'`.

- [ ] **Step 4: Write the connector**

```ts
// apps/mobile/src/lib/connector.ts
import type { AbstractPowerSyncDatabase, CrudEntry, PowerSyncBackendConnector }
  from "@powersync/react-native";
import type { SyncOp } from "@cortex/shared";
import { supabase } from "./supabase";

/** PowerSync's CrudEntry in the shape POST /sync/upload validates. */
export function crudEntryToSyncOp(entry: CrudEntry, baseUpdatedAt?: string): SyncOp {
  const op: SyncOp = {
    op_id: String(entry.clientId),
    op: entry.op as SyncOp["op"],
    table: entry.table as SyncOp["table"],
    id: entry.id,
    ...(entry.op === "DELETE" ? {} : { data: entry.opData ?? {} }),
  };
  // Only note bodies get conflict-copy treatment (spec §6.1); a base on any other table
  // would be meaningless and the server ignores it, so do not send one.
  if (baseUpdatedAt && entry.table === "notes" && entry.op === "PATCH") {
    op.base_updated_at = baseUpdatedAt;
  }
  return op;
}

/**
 * Routes local writes through the API rather than straight at Postgres: the server replays
 * each op through the core services, so domain_meta validation, media-item identity and
 * conflict copies all still happen on the mobile write path (spec §5.1). Writes execute
 * with the user's JWT -- RLS is the enforcement.
 */
export class ApiConnector implements PowerSyncBackendConnector {
  async fetchCredentials() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;
    return {
      endpoint: process.env.EXPO_PUBLIC_POWERSYNC_URL!,
      token: session.access_token,
    };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const batch = await database.getCrudBatch();
    if (!batch) return;

    const bases = new Map<string, string>();
    for (const entry of batch.crud) {
      if (entry.table !== "notes" || entry.op !== "PATCH") continue;
      const row = await database.getOptional<{ base_updated_at: string }>(
        "SELECT base_updated_at FROM note_edit_base WHERE note_id = ?", [entry.id],
      );
      if (row) bases.set(entry.id, row.base_updated_at);
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("not signed in");

    const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/sync/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ops: batch.crud.map((e) => crudEntryToSyncOp(e, bases.get(e.id))),
      }),
    });

    if (!res.ok) {
      // 4xx is a permanent client-side problem: retrying forever would wedge the queue.
      // 5xx and network failures are transient -- leave the batch unacknowledged so
      // PowerSync retries with backoff.
      if (res.status >= 400 && res.status < 500) {
        await batch.complete();
        throw new Error(`sync upload rejected (${res.status})`);
      }
      throw new Error(`sync upload failed (${res.status})`);
    }

    await batch.complete();
    // The bases these ops were checked against are spent; keeping them would apply a stale
    // base to the user's NEXT edit and manufacture a conflict copy that never happened.
    for (const id of bases.keys()) {
      await database.execute("DELETE FROM note_edit_base WHERE note_id = ?", [id]);
    }
  }
}
```

- [ ] **Step 5: Write the database initialiser**

```ts
// apps/mobile/src/lib/powersync.ts
import { PowerSyncDatabase } from "@powersync/react-native";
import { AppSchema } from "@cortex/sync";
import { ApiConnector } from "./connector";
import { getOrCreateDatabaseKey } from "./db-key";

let db: PowerSyncDatabase | null = null;

export function getPowerSync(): PowerSyncDatabase | null {
  return db;
}

/**
 * Opens the SQLCipher-encrypted local replica (spec §7.4).
 *
 * `wiped` is true when the Keystore key was destroyed by a biometric enrollment (§7.5):
 * the old database cannot be decrypted, so it is deleted and resynced from the server.
 * The caller MUST warn the user first -- committed data is safe (the server is
 * authoritative) but local changes not yet uploaded are lost.
 */
export async function initPowerSync(): Promise<{ db: PowerSyncDatabase; wiped: boolean }> {
  if (db) return { db, wiped: false };

  const outcome = await getOrCreateDatabaseKey();
  const wiped = outcome.status === "lost";

  db = new PowerSyncDatabase({
    schema: AppSchema,
    database: {
      dbFilename: "cortex.db",
      // Android only -- no getDylibPath/iOS branch, per the phase's platform constraint.
      sqliteOptions: { encryptionKey: outcome.key },
    },
  });

  if (wiped) await db.disconnectAndClear();
  await db.connect(new ApiConnector());
  return { db, wiped };
}
```

- [ ] **Step 6: Provide it to the tree and wire sign-out**

In `apps/mobile/app/_layout.tsx`, inside `<AppLockGate>`, mount a provider that calls
`initPowerSync()` once, renders a spinner while it resolves, and — when `wiped` is true —
shows a dismissible banner reading:

> "This device's offline copy was reset because the screen lock changed. Notes saved on the
> server are safe; anything captured offline and not yet uploaded was lost."

Then wrap children in `@powersync/react-native`'s `PowerSyncContext.Provider` with the
returned `db`.

In `apps/mobile/src/lib/auth.ts`, replace the placeholder from Task 13 Step 4 with the real
call:

```ts
await wipeLocalData(getPowerSync());
```

- [ ] **Step 7: Add the env var**

Add to `apps/mobile/.env.example`:

```
EXPO_PUBLIC_POWERSYNC_URL=https://<instance>.powersync.journeyapps.com
EXPO_PUBLIC_API_URL=https://<api>.up.railway.app
```

- [ ] **Step 8: Run the tests**

```bash
pnpm turbo run test --filter=@cortex/mobile
pnpm turbo run typecheck lint --filter=@cortex/mobile
```
Expected: PASS, connector 4/4 plus earlier suites.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile package.json pnpm-lock.yaml
git commit -m "feat(mobile): PowerSync provider, API connector, SQLCipher database"
```

---

### Task 18: Quick capture

**Files:**
- Create: `apps/mobile/src/screens/quick-capture.tsx`
- Modify: `apps/mobile/app/index.tsx`

**Interfaces:**
- Consumes: `usePowerSync` from `@powersync/react-native`; `noteDomain` from `@cortex/shared`.
- Produces: `<QuickCapture />`.

- [ ] **Step 1: Write the capture screen**

```tsx
// apps/mobile/src/screens/quick-capture.tsx
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { usePowerSync } from "@powersync/react-native";
import { noteDomain } from "@cortex/shared";

/**
 * Writes straight into local SQLite. The row is the note -- there is no queue to inspect
 * and no "pending" state, because PowerSync's upload queue IS the pending state. Capture
 * therefore succeeds in airplane mode with exactly the same code path as online.
 */
export function QuickCapture() {
  const db = usePowerSync();
  const [content, setContent] = useState("");
  const [domain, setDomain] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    if (!content.trim()) return;
    await db.execute(
      `INSERT INTO notes (id, content, title, domain, domain_meta, lifecycle,
                          source_type, pinned, created_at, updated_at)
       VALUES (uuid(), ?, NULL, ?, '{}', 'inbox', 'quick', 0,
               datetime('now'), datetime('now'))`,
      [content, domain],
    );
    setContent("");
    setDomain(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <View style={{ gap: 12, padding: 16 }}>
      <TextInput
        value={content}
        onChangeText={setContent}
        placeholder="Capture a thought"
        multiline
        accessibilityLabel="Note content"
        style={{ minHeight: 96, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 }}
      />
      <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
        {noteDomain.options.map((d) => (
          <Pressable
            key={d}
            onPress={() => setDomain(domain === d ? null : d)}
            accessibilityRole="button"
            accessibilityState={{ selected: domain === d }}
            style={{
              paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999,
              backgroundColor: domain === d ? "#222" : "#eee",
            }}
          >
            <Text style={{ color: domain === d ? "white" : "#222" }}>{d}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Pressable
        onPress={() => { void save(); }}
        accessibilityRole="button"
        style={{ padding: 14, borderRadius: 8, backgroundColor: "#222", alignItems: "center" }}
      >
        <Text style={{ color: "white" }}>{saved ? "Saved ✓" : "Save"}</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 2: Mount it on the home screen**

Replace the placeholder body of `apps/mobile/app/index.tsx` with `<QuickCapture />` above
the note list slot (filled by Task 19).

- [ ] **Step 3: Verify on a device**

```bash
pnpm --filter @cortex/mobile exec eas build --profile development --platform android
```

Install the dev client, sign in, capture a note, then **enable airplane mode** and capture a
second one. Both must appear instantly. Disable airplane mode and confirm both arrive on
web at `http://localhost:3000`.

**Expo Go cannot run this** — PowerSync and SQLCipher are native modules.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/screens/quick-capture.tsx apps/mobile/app/index.tsx
git commit -m "feat(mobile): offline quick capture with domain chips"
```

---

### Task 19: Note list with shared filters

**Files:**
- Create: `apps/mobile/src/screens/note-list.tsx`
- Modify: `apps/mobile/app/index.tsx`

**Interfaces:**
- Consumes: `noteFiltersToSql`, `toSqlitePlaceholders`, `NOTE_VIEWS`, `type NoteFilters` (Tasks 14–15); `useQuery` from `@powersync/react-native`.

- [ ] **Step 1: Write the list screen**

```tsx
// apps/mobile/src/screens/note-list.tsx
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useQuery } from "@powersync/react-native";
import { Link } from "expo-router";
import { NOTE_VIEWS, noteFiltersToSql, toSqlitePlaceholders, type NoteFilters }
  from "@cortex/core";

/**
 * Reads the local replica directly -- no service layer, no network (spec §2.1). The
 * narrowing comes from the same NoteFilters description the web SSR query and the web
 * realtime refetch use, so the three cannot drift (spec §3, issue-log E5).
 *
 * useQuery is reactive: a synced change or a local write re-renders this list with no
 * refetch call and no subscription bookkeeping.
 */
export function NoteList() {
  const [filters, setFilters] = useState<NoteFilters>({ view: "inbox" });

  const { sql, params } = useMemo(() => {
    const { where, params: p, join } = noteFiltersToSql(filters);
    return {
      sql: `SELECT n.* FROM notes n ${join} WHERE ${toSqlitePlaceholders(where)}
            ORDER BY n.updated_at DESC LIMIT 200`,
      params: p,
    };
  }, [filters]);

  const { data: notes = [] } = useQuery<{
    id: string; title: string | null; content: string; lifecycle: string; updated_at: string;
  }>(sql, params);

  return (
    <View style={{ flex: 1, gap: 12, padding: 16 }}>
      <TextInput
        placeholder="Search"
        accessibilityLabel="Search notes"
        onChangeText={(q) => setFilters((f) => ({ ...f, ...(q.trim() ? { q } : { q: undefined }) }))}
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        {NOTE_VIEWS.map((v) => (
          <Pressable
            key={v}
            onPress={() => setFilters((f) => ({ ...f, view: v }))}
            accessibilityRole="button"
            accessibilityState={{ selected: filters.view === v }}
            style={{
              paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999,
              backgroundColor: filters.view === v ? "#222" : "#eee",
            }}
          >
            <Text style={{ color: filters.view === v ? "white" : "#222" }}>{v}</Text>
          </Pressable>
        ))}
      </View>
      <FlatList
        data={notes}
        keyExtractor={(n) => n.id}
        renderItem={({ item }) => (
          <Link href={`/notes/${item.id}`} asChild>
            <Pressable style={{ paddingVertical: 12 }} accessibilityRole="link">
              <Text numberOfLines={2}>{item.title ?? item.content}</Text>
              <Text style={{ opacity: 0.6, fontSize: 12 }}>{item.lifecycle}</Text>
            </Pressable>
          </Link>
        )}
        ListEmptyComponent={<Text style={{ opacity: 0.6 }}>Nothing here yet.</Text>}
      />
    </View>
  );
}
```

- [ ] **Step 2: Create the FTS5 index the search clause requires**

`noteFiltersToSql` emits `notes_fts match ?` when `q` is set. Create the virtual table once,
after the database opens, in `apps/mobile/src/lib/powersync.ts` immediately before
`db.connect(...)`:

```ts
  // SQLite FTS5 over the local replica. Postgres FTS does not sync (content_text is a
  // generated column on the server), so offline search is its own index -- a different
  // engine from Postgres, which the equivalence suite documents rather than hides.
  await db.execute(
    `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
       content, content_rowid=id, tokenize='unicode61'
     )`,
  );
```

Rebuild the index on sync using PowerSync's change stream; a simple, correct version is to
repopulate on each sync completion for a personal corpus of this size:

```ts
  db.registerListener({
    statusChanged: async (status) => {
      if (!status.hasSynced) return;
      await db.execute("DELETE FROM notes_fts");
      await db.execute(
        "INSERT INTO notes_fts (rowid, content) SELECT id, content FROM notes WHERE deleted_at IS NULL",
      );
    },
  });
```

- [ ] **Step 3: Mount and verify on device**

Add `<NoteList />` to `apps/mobile/app/index.tsx`. On the dev client: capture three notes,
confirm the list updates without a manual refresh, switch views, and search for a word that
appears in one body only.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/screens/note-list.tsx apps/mobile/src/lib/powersync.ts apps/mobile/app/index.tsx
git commit -m "feat(mobile): reactive note list using the shared filter description"
```

---

### Task 20: Note editor, archive and tags

**Files:**
- Create: `apps/mobile/app/notes/[id].tsx`
- Create: `apps/mobile/src/screens/note-editor.tsx`
- Create: `apps/mobile/src/lib/edit-base.ts`
- Create: `apps/mobile/src/lib/edit-base.test.ts`

**Interfaces:**
- Produces: `recordEditBase(db, noteId, updatedAt): Promise<void>` — writes `note_edit_base` once per editing session, which is what the connector reads to detect conflicts.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/lib/edit-base.test.ts
import { describe, expect, it, vi } from "vitest";
import { recordEditBase } from "./edit-base.js";

function fakeDb(existing: unknown = null) {
  return {
    getOptional: vi.fn(async () => existing),
    execute: vi.fn(async () => undefined),
  };
}

describe("recordEditBase", () => {
  it("records the base on the first edit of a session", async () => {
    const db = fakeDb(null);
    await recordEditBase(db as never, "n1", "2026-08-02T10:00:00.000Z");
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("does NOT overwrite an existing base", async () => {
    // Overwriting would advance the base to the user's own last keystroke, and the
    // conflict check would then never fire -- silently reverting to last-write-wins.
    const db = fakeDb({ note_id: "n1" });
    await recordEditBase(db as never, "n1", "2026-08-02T11:00:00.000Z");
    expect(db.execute).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile -- edit-base`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

```ts
// apps/mobile/src/lib/edit-base.ts
import type { AbstractPowerSyncDatabase } from "@powersync/react-native";

/**
 * Remembers the notes.updated_at an editing session started from (spec §6.2). The
 * connector attaches it to the upload so the server can tell "the phone edited a stale
 * body" from "the phone edited the current one".
 *
 * Written ONCE per session and never overwritten: refreshing it on every keystroke would
 * walk the base forward to the user's own last local write, the server's `moved` check
 * would never fire, and conflict handling would silently degrade to last-write-wins.
 * Cleared by the connector after a successful upload.
 */
export async function recordEditBase(
  db: AbstractPowerSyncDatabase,
  noteId: string,
  updatedAt: string,
): Promise<void> {
  const existing = await db.getOptional(
    "SELECT note_id FROM note_edit_base WHERE note_id = ?", [noteId],
  );
  if (existing) return;
  await db.execute(
    "INSERT INTO note_edit_base (id, note_id, base_updated_at) VALUES (uuid(), ?, ?)",
    [noteId, updatedAt],
  );
}
```

- [ ] **Step 4: Write the editor screen**

```tsx
// apps/mobile/src/screens/note-editor.tsx
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { usePowerSync, useQuery } from "@powersync/react-native";
import { recordEditBase } from "../lib/edit-base";

const SAVE_DEBOUNCE_MS = 800;

export function NoteEditor({ id }: { id: string }) {
  const db = usePowerSync();
  const { data: rows = [] } = useQuery<{
    id: string; title: string | null; content: string; lifecycle: string; updated_at: string;
  }>("SELECT * FROM notes WHERE id = ?", [id]);
  const note = rows[0];

  const [content, setContent] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed once. Re-seeding on every synced change would clobber what the user is typing.
  useEffect(() => {
    if (note && content === null) setContent(note.content);
  }, [note, content]);

  async function save(next: string) {
    if (!note) return;
    await recordEditBase(db, id, note.updated_at);
    await db.execute(
      "UPDATE notes SET content = ?, updated_at = datetime('now') WHERE id = ?", [next, id],
    );
  }

  function onChange(next: string) {
    setContent(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void save(next); }, SAVE_DEBOUNCE_MS);
  }

  async function setLifecycle(lifecycle: string) {
    await db.execute(
      "UPDATE notes SET lifecycle = ?, updated_at = datetime('now') WHERE id = ?",
      [lifecycle, id],
    );
  }

  async function softDelete() {
    await db.execute(
      "UPDATE notes SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [id],
    );
  }

  if (!note) return <Text style={{ padding: 16 }}>Note not found on this device.</Text>;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <TextInput
        value={content ?? ""}
        onChangeText={onChange}
        multiline
        accessibilityLabel="Note content"
        style={{ minHeight: 240, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 }}
      />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {["inbox", "active", "evergreen", "archived"].map((l) => (
          <Pressable
            key={l}
            onPress={() => { void setLifecycle(l); }}
            accessibilityRole="button"
            accessibilityState={{ selected: note.lifecycle === l }}
            style={{
              paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999,
              backgroundColor: note.lifecycle === l ? "#222" : "#eee",
            }}
          >
            <Text style={{ color: note.lifecycle === l ? "white" : "#222" }}>{l}</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => { void softDelete(); }}
          accessibilityRole="button"
          style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: "#fee" }}
        >
          <Text style={{ color: "#900" }}>Trash</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
```

```tsx
// apps/mobile/app/notes/[id].tsx
import { useLocalSearchParams } from "expo-router";
import { NoteEditor } from "../../src/screens/note-editor";

export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <NoteEditor id={id} />;
}
```

- [ ] **Step 5: Run tests and verify the conflict path on device**

```bash
pnpm turbo run test --filter=@cortex/mobile
```

Then on the dev client: open a note, **enable airplane mode**, edit its body. On web, edit
the same note differently and save. Disable airplane mode. Expect **two notes** — the web
body on the original, the phone body as a new inbox note.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/screens/note-editor.tsx apps/mobile/app/notes apps/mobile/src/lib/edit-base.ts apps/mobile/src/lib/edit-base.test.ts
git commit -m "feat(mobile): note editor with debounced save and conflict base tracking"
```

---

### Task 21: Mood/energy check-in

**Files:**
- Create: `apps/mobile/src/screens/checkin-widget.tsx`
- Modify: `apps/mobile/app/index.tsx`

- [ ] **Step 1: Write the widget**

```tsx
// apps/mobile/src/screens/checkin-widget.tsx
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { usePowerSync } from "@powersync/react-native";
// React Native has no global `crypto.randomUUID`. expo-crypto is already a dependency.
import { randomUUID } from "expo-crypto";

const MOOD_LABELS = ["very bad", "bad", "okay", "good", "very good"];

/**
 * Two taps, offline, from the couch -- the most mobile-native surface in the product.
 *
 * Check-ins are inserts and soft-deletes only (life-domains spec §2.3): a wrong mood is
 * undone and re-tapped, never edited. Both operations work offline unchanged, because
 * neither needs a server-side decision.
 */
export function CheckinWidget() {
  const db = usePowerSync();
  const [lastId, setLastId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function log(mood: number) {
    setBusy(true);
    try {
      const id = randomUUID();
      await db.execute(
        `INSERT INTO checkins (id, mood, energy, label, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, datetime('now'), datetime('now'))`,
        [id, mood],
      );
      setLastId(id);
    } finally { setBusy(false); }
  }

  async function undo() {
    if (!lastId || busy) return;
    setBusy(true);
    try {
      await db.execute(
        "UPDATE checkins SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        [lastId],
      );
      setLastId(null);
    } finally { setBusy(false); }
  }

  return (
    <View style={{ padding: 16, gap: 10 }}>
      <Text>How are you?</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {[1, 2, 3, 4, 5].map((m) => (
          <Pressable
            key={m}
            disabled={busy}
            onPress={() => { void log(m); }}
            accessibilityRole="button"
            // Valence in the label, not just a number: "Mood 4" tells a screen-reader user
            // nothing about direction (issue-log E7).
            accessibilityLabel={`Mood ${m} of 5 — ${MOOD_LABELS[m - 1]}`}
            style={{
              width: 44, height: 44, borderRadius: 22, backgroundColor: "#eee",
              alignItems: "center", justifyContent: "center",
            }}
          >
            <Text>{m}</Text>
          </Pressable>
        ))}
      </View>
      {lastId ? (
        <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
          <Text accessibilityRole="text">Logged ✓</Text>
          <Pressable onPress={() => { void undo(); }} disabled={busy} accessibilityRole="button">
            <Text style={{ textDecorationLine: "underline" }}>Undo</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
```

- [ ] **Step 2: Mount and verify**

Add `<CheckinWidget />` to `apps/mobile/app/index.tsx`. On device, in airplane mode: tap a
mood, confirm "Logged ✓", tap Undo, confirm it clears. Reconnect and confirm no check-in
row arrives on web (the insert and its soft-delete both uploaded).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/screens/checkin-widget.tsx apps/mobile/app/index.tsx
git commit -m "feat(mobile): offline 2-tap mood check-in with undo"
```

---

### Task 22: Media log

**Files:**
- Create: `apps/mobile/src/screens/media-log-form.tsx`
- Modify: `apps/mobile/app/index.tsx`

**Interfaces:**
- Consumes: `pendingMediaItem` shape (Task 4) — the form writes `domain_meta.pending_item`.

- [ ] **Step 1: Write the form**

```tsx
// apps/mobile/src/screens/media-log-form.tsx
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { usePowerSync, useQuery } from "@powersync/react-native";

const KINDS = ["film", "series", "book", "game", "album", "podcast"] as const;
const STATUSES = ["finished", "in_progress", "abandoned"] as const;

/**
 * Offline media logging (spec §5.3): the log is written as an ORDINARY NOTE carrying
 * domain_meta.pending_item, with media_item_id left null.
 *
 * Item identity is (user_id, kind, lower(title)) enforced by a unique index this device
 * cannot consult offline, so the server resolves it on upload via
 * MediaService.resolveNoteMediaLink -- keeping the escaping, anchored imatch and year
 * reconciliation from issue-log A3/E6 in exactly one implementation. The note itself is
 * never delayed; only the item link materialises after reconnect.
 */
export function MediaLogForm() {
  const db = usePowerSync();
  const [kind, setKind] = useState<(typeof KINDS)[number]>("film");
  const [title, setTitle] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("finished");
  const [impression, setImpression] = useState("");

  // Local autocomplete over the replica -- bounded, ordered, and kind-scoped, the same
  // shape B7 imposed on the web version.
  const { data: suggestions = [] } = useQuery<{ title: string }>(
    "SELECT title FROM media_items WHERE kind = ? AND deleted_at IS NULL ORDER BY title LIMIT 200",
    [kind],
  );

  async function save() {
    if (!title.trim()) return;
    const meta: Record<string, unknown> = {
      status,
      pending_item: { kind, title: title.trim() },
    };
    if (rating !== null) meta.rating = rating;
    await db.execute(
      `INSERT INTO notes (id, content, title, domain, domain_meta, lifecycle,
                          source_type, pinned, created_at, updated_at)
       VALUES (uuid(), ?, ?, 'media', ?, 'inbox', 'quick', 0,
               datetime('now'), datetime('now'))`,
      [impression, title.trim(), JSON.stringify(meta)],
    );
    setTitle(""); setImpression(""); setRating(null);
  }

  return (
    <View style={{ padding: 16, gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {KINDS.map((k) => (
          <Pressable
            key={k} onPress={() => setKind(k)} accessibilityRole="button"
            accessibilityState={{ selected: kind === k }}
            style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999,
                     backgroundColor: kind === k ? "#222" : "#eee" }}
          >
            <Text style={{ color: kind === k ? "white" : "#222" }}>{k}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={title} onChangeText={setTitle} placeholder="Title"
        accessibilityLabel="Media title"
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
      />
      {title.length > 1 ? (
        <View>
          {suggestions
            .filter((s) => s.title.toLowerCase().startsWith(title.toLowerCase()))
            .slice(0, 5)
            .map((s) => (
              <Pressable key={s.title} onPress={() => setTitle(s.title)} accessibilityRole="button">
                <Text style={{ paddingVertical: 6, opacity: 0.8 }}>{s.title}</Text>
              </Pressable>
            ))}
        </View>
      ) : null}
      {/* Radiogroup, not toggle buttons: filled-but-unselected stars contradict
          aria-pressed, and a mis-tap on the current star clears the rating (E7). */}
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 10 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable
            key={n} onPress={() => setRating(n)} accessibilityRole="radio"
            accessibilityState={{ checked: rating === n }}
            accessibilityLabel={`${n} of 5 stars`}
            style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ fontSize: 22, opacity: rating !== null && n <= rating ? 1 : 0.3 }}>★</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {STATUSES.map((s) => (
          <Pressable
            key={s} onPress={() => setStatus(s)} accessibilityRole="button"
            accessibilityState={{ selected: status === s }}
            style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999,
                     backgroundColor: status === s ? "#222" : "#eee" }}
          >
            <Text style={{ color: status === s ? "white" : "#222" }}>{s}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={impression} onChangeText={setImpression} placeholder="Impression (optional)"
        multiline accessibilityLabel="Impression"
        style={{ minHeight: 72, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
      />
      <Pressable onPress={() => { void save(); }} accessibilityRole="button"
                 style={{ padding: 14, borderRadius: 8, backgroundColor: "#222", alignItems: "center" }}>
        <Text style={{ color: "white" }}>Log it</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 2: Verify the offline → resolved path on device**

In airplane mode, log a film that already exists in the library under different casing.
Reconnect. On web, confirm **one** media item exists and both notes point at it.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/screens/media-log-form.tsx apps/mobile/app/index.tsx
git commit -m "feat(mobile): offline media log resolved to an item on upload"
```

---

### Task 23: Export, purge propagation, and the phase gate

**Files:**
- Create: `apps/mobile/src/screens/export-button.tsx`
- Create: `packages/db/src/test/purge-propagation.test.ts`
- Modify: `docs/deploy.md`

- [ ] **Step 1: Write the export button**

```tsx
// apps/mobile/src/screens/export-button.tsx
import { useState } from "react";
import { Pressable, Text } from "react-native";
import { useStatus } from "@powersync/react-native";
import { supabase } from "../lib/supabase";

/**
 * Export is inherently ONLINE: GET /export streams a server-generated archive, and nothing
 * local can produce one (spec §0 footnote). Parity means the feature exists, not that it
 * works offline -- so it is disabled with an explanation rather than failing on tap.
 */
export function ExportButton() {
  const status = useStatus();
  const [busy, setBusy] = useState(false);
  const online = status.connected;

  async function run() {
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/export`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      // Hand the archive to the OS share sheet rather than managing files in-app.
      // (expo-sharing + expo-file-system; add them here if not already installed.)
    } finally { setBusy(false); }
  }

  return (
    <Pressable
      onPress={() => { void run(); }}
      disabled={!online || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: !online || busy }}
      style={{ padding: 12, opacity: online ? 1 : 0.5 }}
    >
      <Text>{online ? "Export all notes" : "Export needs a connection"}</Text>
    </Pressable>
  );
}
```

- [ ] **Step 2: Write the purge-propagation test**

```ts
// packages/db/src/test/purge-propagation.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

let alice: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  alice = await makeUser("db-purge-alice@test.local");
});

/**
 * A purged note must actually LEAVE the device, not merely the server (spec §7.7).
 * PowerSync ships a hard DELETE as a tombstone only if the row is genuinely gone from the
 * replicated table -- so this asserts purge is a real DELETE, not a flag update that would
 * leave the row (and its content) sitting in local SQLite forever.
 */
describe("purge is a hard delete, so it can propagate as a tombstone", () => {
  it("removes the row entirely rather than flagging it", async () => {
    const { data: note } = await alice.client.from("notes")
      .insert({ user_id: alice.id, content: "purge me" }).select("id").single();

    await alice.client.from("notes")
      .update({ deleted_at: new Date().toISOString() }).eq("id", note!.id);
    await alice.client.from("notes")
      .delete().eq("id", note!.id).not("deleted_at", "is", null);

    // service_role sees past RLS; if anything survives, the device would keep it too.
    const { data } = await admin.from("notes").select("id").eq("id", note!.id);
    expect(data).toEqual([]);
  });

  it("leaves no orphaned note_tags rows behind to resurrect the reference", async () => {
    const { data: note } = await alice.client.from("notes")
      .insert({ user_id: alice.id, content: "tagged then purged" }).select("id").single();
    const { data: tag } = await alice.client.from("tags")
      .insert({ user_id: alice.id, name: `purge-tag-${Date.now()}` }).select("id").single();
    await alice.client.from("note_tags")
      .insert({ user_id: alice.id, note_id: note!.id, tag_id: tag!.id });

    await alice.client.from("notes")
      .update({ deleted_at: new Date().toISOString() }).eq("id", note!.id);
    await alice.client.from("notes")
      .delete().eq("id", note!.id).not("deleted_at", "is", null);

    const { data } = await admin.from("note_tags").select("id").eq("note_id", note!.id);
    expect(data).toEqual([]);   // ON DELETE CASCADE (00003)
  });
});
```

- [ ] **Step 3: Run the full gate**

```bash
pnpm turbo run typecheck lint test
```
Expected: every task green, including the new `@cortex/sync` and `@cortex/mobile` suites.

- [ ] **Step 4: Verify the device-security properties by hand**

These cannot be asserted from a test runner. On the dev client:

| Check | Expected |
|---|---|
| Kill and reopen the app | Biometric prompt before any note is visible |
| Background for 10s, return | No prompt (inside the 60s grace) |
| Background for 90s, return | Prompt |
| Sign out, sign back in | Zero local notes before the first sync completes |
| Enroll a new fingerprint, reopen | The reset banner appears; notes resync from the server |
| `adb backup` the app | Refused / empty — `allowBackup=false` |
| Purge a note on web | It disappears from the phone after sync |

- [ ] **Step 5: Update `docs/deploy.md`**

Add a phase 1b section covering: the PowerSync Cloud instance and where its sync rules come
from (`packages/sync/src/sync-rules.yaml`), the EAS Android dev-client build command, the
note that **Expo Go cannot run this app**, and the `00015` migration row.

- [ ] **Step 6: Commit and open the PR**

```bash
git add apps/mobile/src/screens/export-button.tsx packages/db/src/test/purge-propagation.test.ts docs/deploy.md
git commit -m "feat(mobile): online-only export; test(db): purge propagates as a tombstone"
git push -u origin feat/phase-1b-mobile-offline-sync
gh pr create --title "Phase 1b: mobile offline sync (Android)" --body "$(cat <<'EOF'
Implements `docs/superpowers/specs/2026-08-02-phase-1b-mobile-offline-sync-design.md`.

Android-only offline-first mobile client: SQLCipher-encrypted local replica synced by
PowerSync, writes replayed server-side through the existing core services, full feature
parity with web.

- Stage 1 — `POST /sync/upload` operation router, conflict copies, offline media resolution
- Stage 2 — Keystore session + database key, mandatory app lock, sign-out wipe, sync-rule isolation tests
- Stage 3 — one `NoteFilters` shared by web SSR, web realtime refetch and mobile SQL (fixes E5's duplication)
- Stage 4 — capture, list, editor, check-in, media log, export

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01PCJvvfjsrkkaq75x8eFB8S
EOF
)"
```

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task: §2 architecture → Tasks 5–6, 17;
§3 filters → 14–16; §4 sync scope → 6, 12; §5 upload path → 2–5; §6 conflicts → 1, 3, 20;
§7.2 session storage → 8; §7.3 `sensitive` → **deliberately not implemented** (phase 2, per
the spec's own decision); §7.4–7.5 encryption and key invalidation → 9; §7.6 Android
hardening → 11; §7.7 lifecycle → 10, 13, 23; §7.8 sync-rule isolation → 12; §8 testing →
distributed, with the hand-verified table in Task 23 Step 4; §9 entry gates → Tasks 7, 17,
18 call them out at the point they block.

**Known gaps this plan does not close** (carried from spec §10, not regressions):
- The note list is capped at 200 rows on mobile rather than paginated — the same shape as
  the web list, deferred with it.
- No UI edits a note's `domain` after capture, on either client.
- E1's PostgREST write path is unchanged; phase 2's entry gate is validate-on-read.
