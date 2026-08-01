# Cortex Phase 1a — Web Notes (online-only) Design

**Status:** approved 2026-08-01
**Parent spec:** `docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md`
**Predecessor:** Phase 0 — Foundations (complete; API live, web + mobile login verified)

## 1. Why this phase exists, and why it is not all of Phase 1

The parent spec's Phase 1 ("Notes + offline sync", wk 2–3) bundles five subsystems:
PowerSync service + sync rules, the `/sync/upload` conflict handler, the mobile note
UI with local FTS, the web note UI, and the export endpoint. That is more than one
spec can carry coherently, so Phase 1 is split:

| Sub-phase | Contents | Spec |
| --- | --- | --- |
| **1a (this doc)** | Web notes CRUD, Realtime, manual tags, FTS search, trash, export endpoint. Online-only. No PowerSync. | this file |
| **1b (next)** | PowerSync on mobile, `POST /sync/upload`, conflict handling per parent §8.2, mobile UI, local FTS | to be written |

**Why web first.** 1a is a complete, dogfoodable product within days, so real notes
start accumulating immediately — and every later phase (embeddings in 2, digests in
7, the memory layer in 8) is only impressive with months of accumulated data. Schema
v1 is already locked and applied from Phase 0, so deferring sync risks little: 1b
consumes the same tables 1a writes.

**Goal of 1a:** capture a thought on the web in under two seconds, find it again by
text or tag weeks later, and get every byte back out as markdown.

**Non-goals:** offline anything, mobile beyond its existing login shell, semantic
search or embeddings (Phase 2), AI tag suggestions (Phase 2), pinning, pagination.

## 2. Architecture

```
Browser (Next.js 15, app router)
  ├── reads  ─→ @supabase/ssr server client   (SSR: list, detail, search, filters)
  │         ─→ browser client + Realtime      (live patching of the list)
  │                                            └─ RLS enforced
  └── writes ─→ fetch(API, Bearer <access_token>)
                     │
              apps/api (NestJS)  notes.controller · tags.controller · export.controller
                     │
              packages/core      ← NEW: framework-free domain logic
                notes/service.ts · organize/service.ts (tags) · export/service.ts
                     │  supabase-js client built per-request from the caller's JWT
                     ▼
              Supabase Postgres — RLS is the enforcement, not app code
```

### 2.1 Why reads and writes take different paths

Reads go straight to Supabase (parent §5 principle 1: web "reads/writes via
supabase-js (RLS) and the API, with Supabase Realtime subscriptions for live
updates"). Writes go through NestJS for one concrete reason that lands in Phase 2:

> Parent §9: enrichment jobs are "enqueued by the API at commit time, **not** by DB
> triggers — keeps logic in TypeScript."

If web writes bypassed the API, Phase 2's `note.enrich` would have to either retrofit
every write onto the API anyway or introduce the DB triggers the parent spec
explicitly rejects. Building the write path now makes Phase 2 purely additive. It
also means 1b's `/sync/upload` extends a tested `NoteService` rather than inventing a
second one, and it puts domain logic in `packages/core` — the parent's "one core,
many faces" principle (§5.5) — before two clients duplicate it.

Rejected alternatives: **all-direct supabase-js** (fastest to ship, but pays the
Phase 2 retrofit and duplicates logic in 1b); **all-through-API including reads**
(single choke point, but discards Supabase Realtime for hand-rolled SSE and
contradicts the parent's stated read path).

### 2.2 Package layout

**New — `packages/core`.** Framework-free domain logic, module folders per parent
§12.3, each with `service.ts` and an `index.ts` manifest:

- `notes/` — `NoteService`: create, update, softDelete, restore, purge
- `organize/` — `TagService`: find-or-create, attach, detach
- `export/` — `ExportService`: streams the zip archive
- `supabase.ts` — `createUserClient(jwt)` factory

Services take a Supabase client and a user id and know nothing about HTTP. That is
what lets 1b's sync-upload handler and Phase 2's job workers call the same code the
web app calls today.

**Deliberately deferred — `registry.ts`.** Parent §12.3 specifies a registry
composing routes, job handlers, and MCP tools. None of those exist yet; three plain
Nest controllers are clearer than a composition layer with nothing to compose. It
arrives in Phase 2, when `jobs.ts` gives it something to register.

**Extended — `packages/shared`.** Gains zod DTOs under `src/dto/`, consumed by
NestJS validation pipes *and* by web's typed fetch client.

**Extended — `supabase/migrations`, `apps/api`, `apps/web`** (see §3, §4, §5).

**Untouched — `apps/mobile`.** Stays a login shell until 1b.

## 3. Database changes

Schema v1 from Phase 0 covers 1a's data needs. Two small migrations are still
required.

### `00010_realtime_publication.sql`

```sql
alter publication supabase_realtime add table public.notes, public.tags, public.note_tags;
```

Supabase ships `supabase_realtime` as an **empty** publication; without this, no
`postgres_changes` events broadcast at all and the live list silently never updates.

### `00011_note_tags_partial_unique.sql`

`note_tags` carries a `deleted_at` column alongside a **non-partial**
`unique (note_id, tag_id)` constraint. Soft-deleting a tag link and then re-adding
the same tag therefore violates the constraint. The fix mirrors what `tags` already
does — drop the total constraint, add a partial unique index:

```sql
alter table public.note_tags drop constraint note_tags_note_id_tag_id_key;
create unique index note_tags_note_tag_uidx
  on public.note_tags (note_id, tag_id) where deleted_at is null;
```

This makes the existing `deleted_at` column meaningful and keeps detach/re-attach —
an ordinary user action — from erroring.

**Already correct, relied upon, not re-specified:** `notes.updated_at` is maintained
by an `extensions.moddatetime` trigger (`00002`); `notes_fts_idx` is a GIN index on
`to_tsvector('english', content_text)` (`00002`); `content_text` is a generated
column projecting markdown to plain text; `00009` revoked the default-ACL
`TRUNCATE/REFERENCES/TRIGGER/MAINTAIN` grants, so tables added later inherit clean
privileges.

## 4. API surface

Eight routes, all behind the existing `SupabaseAuthGuard` (JWKS/ES256 path). Reads
never touch the API, which is why the surface stays this small.

```
POST   /notes                    { content, title? }              → Note
PATCH  /notes/:id                { content?, title?, lifecycle? } → Note
DELETE /notes/:id                soft — sets deleted_at           → { id, deleted_at }
POST   /notes/:id/restore        clears deleted_at                → Note
DELETE /notes/:id/purge          hard delete (cascades)           → { id }
POST   /tags                     { name, color? }  find-or-create → Tag
POST   /notes/:id/tags           { tagId }                        → NoteTag
DELETE /notes/:id/tags/:tagId    soft                             → { ok: true }
GET    /export                   → application/zip
```

Archive is not its own route — it is `PATCH { lifecycle: "archived" }`, since
lifecycle is one column with four legal values already constrained by the schema.
Purge exists because a trash that cannot be emptied is just a second archive.
`DELETE /notes/:id/purge` is valid **only on an already-soft-deleted note** — a note
with `deleted_at is null` returns 404, so permanent deletion always requires two
deliberate steps and can never be reached by a single mis-click. It relies on the
schema's existing `on delete cascade` for `note_chunks`, `attachments`, `note_tags`,
and `links`, and `on delete set null` for `tasks`.

### 4.1 Authentication on the write path

The guard verifies the bearer token, then `createUserClient(jwt)` builds a
per-request supabase-js client carrying that same token:

```ts
createClient(url, anonKey, {
  global: { headers: { Authorization: `Bearer ${jwt}` } },
  auth: { persistSession: false },
});
```

No service-role key on this path — parent §8.2: *"server code is not trusted with a
service key on this path."* RLS is the enforcement.

**Deploy consequence:** the Railway service currently runs with only `SUPABASE_URL`
and `PORT`. `SUPABASE_ANON_KEY` must be added before this path works in production.
`SUPABASE_JWT_SECRET` must remain **unset** (see `docs/deploy.md` — the project
issues ES256 tokens; setting it forces the HS256 branch and rejects every real
token).

### 4.2 Contracts

zod schemas in `packages/shared/src/dto/`, reusing the `noteLifecycle` enum shipped
in Phase 0:

```ts
export const createNoteInput = z.object({
  content: z.string().max(100_000),
  title: z.string().max(500).optional(),
});

export const updateNoteInput = z.object({
  content:   z.string().max(100_000).optional(),
  title:     z.string().max(500).nullable().optional(),
  lifecycle: noteLifecycle.optional(),
}).refine((o) => Object.keys(o).length > 0, "at least one field required");

export const createTagInput = z.object({
  name:  z.string().trim().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const attachTagInput = z.object({ tagId: z.uuid() });
```

A `ZodValidationPipe` in `apps/api` applies them; web imports the same schemas for
its typed fetch client. One definition, both ends, no codegen — parent §12.1's stated
reason for REST+zod over tRPC.

### 4.3 Export

`GET /export` streams a zip built with `archiver` piped directly into the Express
response, so memory stays flat regardless of corpus size. Frontmatter is serialized
with the `yaml` package rather than string-concatenated: a title containing `: ` or a
quote silently corrupts hand-rolled YAML, and this is the one format whose entire
purpose is being readable by other tools.

```
cortex-export-2026-08-01.zip
├─ manifest.json          full structured dump: notes, tags, note_tags
├─ README.md              what this archive is, how to import it
└─ notes/
   ├─ pricing-psychology-a1b2c3d4.md
   └─ sync-conflict-notes-e5f6a7b8.md
```

Each note file carries YAML frontmatter (`id`, `title`, `tags`, `lifecycle`,
`created_at`, `updated_at`) followed by the raw markdown `content`, so the archive
drops into Obsidian or Logseq unmodified. Filenames are a kebab-case slug of the
title — or the first line of content when untitled — suffixed with the first 8
characters of the note id to guarantee uniqueness. Soft-deleted notes are excluded.
Scope is RLS-bounded: the caller's own notes, nothing else.

New API dependencies: `archiver`, `yaml`.

**UX consequence:** because `/export` requires a bearer header it cannot be a plain
`<a href>`. Web fetches it, converts the response to a blob, and triggers the
download from an object URL.

## 5. Web application

### 5.1 Screens

**`/` — note list.** A server component reading `searchParams`
(`?view=inbox|active|archived|trash`, `?q=`, `?tag=`) and issuing one query:
`deleted_at is null` (inverted for trash), the lifecycle filter,
`.textSearch('content_text', q, { type: 'websearch', config: 'english' })` for
search, an inner join on `note_tags` for the tag filter, ordered by
`updated_at desc`. Results hydrate a client `<NoteList>`.

Above the list sits the persistent quick-capture textarea: type, `Cmd+Enter`, the
note lands in the inbox and the box clears.

```
┌─ Cortex ─────────────────────────┐
│ ┌──────────────────────────┐     │
│ │ quick thought...         │     │
│ │                 [Cmd+⏎]  │     │
│ └──────────────────────────┘     │
│  Inbox  Active  Archived  Trash  │
│  [search…]                       │
│ ──────────────────────────────── │
│  Pricing psychology          2m  │
│  #ideas #product                 │
│ ──────────────────────────────── │
│  Sync conflict notes         1h  │
└──────────────────────────────────┘
```

**`/notes/[id]` — editor.** Full-page markdown editor with title, body, tag chips
with a `+tag` combobox, archive/delete actions, and a save-status indicator.

### 5.2 Capture

`Cmd+Enter` → `POST /notes` → prepend the returned row, clear the box. No optimistic
temp-id insert: the Realtime echo would then need reconciling against a placeholder,
and ~150 ms is imperceptible for a capture box. The Realtime handler dedupes by `id`,
so the echo of the client's own write is a no-op.

On failure the text stays in the box with an inline error — a capture UI that can
lose your thought is worse than no capture UI.

### 5.3 Autosave

The editor holds local state, debounces 800 ms after the last keystroke, and
`PATCH`es only the changed fields. It flushes on blur and on navigation away. Status
renders as `saving… / saved / save failed — retry`. A failed save never clears local
text.

Concurrency is last-write-wins at row level, which is correct for 1a: one user, one
online client. Multi-device conflict resolution is 1b's problem and is specified in
parent §8.2.

### 5.4 Realtime

`<NoteList>` subscribes to `postgres_changes` on `notes` filtered to
`user_id=eq.<id>`, patching rows in place. Soft-deletes arrive as UPDATEs carrying
`deleted_at`, so the handler re-tests each changed row against the current view and
drops it when it no longer matches.

**`postgres_changes` drops events while disconnected — it does not replay them.** The
list therefore refetches on every transition back into `SUBSCRIBED`, not only on
mount. Without that, a dropped connection leaves a stale list that looks perfectly
healthy.

### 5.5 Tags

`POST /tags` is find-or-create, case-insensitive, matching the existing
`(user_id, lower(name)) where deleted_at is null` index. Attaching writes `note_tags`
with `source: 'user'`, `status: 'accepted'`. Detaching sets `deleted_at` — which is
exactly why migration `00011` exists. Clicking a tag chip filters the list.

## 6. Error handling

**Foreign resources return 404, not 403.** When Bob `PATCH`es Alice's note, RLS makes
the UPDATE match zero rows. Returning 403 would confirm the note exists, letting any
authenticated user probe for other users' note ids. "Not found" and "not yours" are
deliberately indistinguishable, and `packages/core`'s test suite asserts it rather
than leaving it to reviewer memory.

| Condition | Response |
| --- | --- |
| zod validation failure | 400 with field paths |
| missing/invalid bearer token | 401 (existing guard) |
| note belongs to another user, or does not exist | 404 |
| unique-violation race in tag find-or-create (`23505`) | retry the select once, then return the existing row |
| unmapped PostgREST error | 500, details logged, not echoed to the client |

A `mapPostgrestError()` helper in `packages/core` keeps PostgREST codes from leaking
into HTTP responses.

Web-side: save failures keep the user's text and offer retry; SSR read failures
render an error boundary with retry; the offline state disables capture behind a
banner rather than accepting input it cannot persist.

## 7. Testing

| Layer | Approach |
| --- | --- |
| `packages/core` | Integration tests against the local Supabase stack, reusing Phase 0's `makeUser` harness: CRUD lifecycle, tag find-or-create idempotency and case-insensitivity, the detach→re-attach cycle migration `00011` exists to permit, and cross-user 404s |
| `apps/api` | supertest e2e extending the existing `app.e2e.test.ts`: validation rejects, 401s, foreign-note 404s, and an export test that unzips the response and asserts the frontmatter parses and the manifest matches |
| `packages/shared` | DTO unit tests (vitest), as with the Phase 0 enums |
| `apps/web` | Vitest on pure logic only: the view-matching predicate the Realtime handler uses, the typed API client, and export slug generation. No browser. |

Playwright is deliberately deferred to 1b, where the airplane-mode sync demo is worth
protecting and the UI has stopped changing shape. Browser E2E now would cost CI time
and flake maintenance on flows still being designed, while the genuinely fragile
logic in 1a — the view predicate, which decides whether a changed row still belongs
in the visible list — is pure and testable without a browser.

CI needs no structural change: the existing workflow already starts the local
Supabase stack, and turbo picks `packages/core` up from the workspace glob.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| PostgREST's `textSearch` may not generate a predicate matching `notes_fts_idx` exactly, silently falling back to a sequential scan | Verify with `explain analyze` against a seeded local DB during implementation; if it misses, add a matching index or expose search as a SQL function |
| Realtime + RLS requires the socket to carry the user's token (`realtime.setAuth`) | supabase-js v2 does this automatically post-sign-in; assert it explicitly by confirming a second user's inserts never arrive |
| Railway free trial lapses ~2026-08-31, taking the write path down with it | Note-taking depends on the API by design in this phase. Move to Hobby ($5/mo) before the lapse, or accept a read-only web app until redeployed |
| `SUPABASE_ANON_KEY` missing on Railway makes every write fail in production while passing locally | Deploy checklist item; the export e2e test run against the live URL catches it |

## 9. Definition of done

- [ ] Capture a note on `/` with `Cmd+Enter`; it appears in the inbox list without a reload
- [ ] Edit it at `/notes/[id]`; autosave reports `saved`; reload shows the persisted text
- [ ] Archive it; it leaves Inbox and appears under Archived
- [ ] Delete it; it appears under Trash; restore returns it; purge removes it permanently
- [ ] Create and attach a tag, detach it, re-attach the same tag — no constraint error
- [ ] Click a tag chip; the list filters to that tag
- [ ] Search text that appears only in the body of one note; that note is the result
- [ ] Open two browser tabs; a capture in one appears in the other within a second
- [ ] Kill the network, restore it; the list refetches and is correct
- [ ] `GET /export` downloads a zip whose `.md` files carry valid YAML frontmatter and open in Obsidian
- [ ] Bob's token cannot read, update, or delete Alice's note — all return 404
- [ ] `pnpm turbo run typecheck lint test` green in CI
