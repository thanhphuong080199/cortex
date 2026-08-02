# Cortex — Phase 1b: Mobile Offline Sync: Design

**Status:** approved 2026-08-02 (sections reviewed and accepted in design session)
**Parent spec:** `docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md`
**Amends:** parent §8 (sync design), §11 (isolation), §12.3 (repo layout), §13 (phases);
adds parent §15 (security & data protection)
**Prerequisite state:** Phases 0, 1a and 1c complete and merged to `main`. Schema through
`00014` live on the hosted project. API deployed on Railway. `apps/mobile` is a login
shell only — four files, no data layer.

---

## 0. Summary and decisions log

Phase 1b makes the mobile app offline-first: the phone holds a local SQLite replica,
writes land locally and upload when connectivity returns. This closes phase 1 and
retires the roadmap's least-reversible architectural risk (parent §13).

Decisions made in the design session:

| Decision | Choice |
| --- | --- |
| Mobile feature scope | **Full parity with web** — notes, tags, check-in, media log, domain chips, export¹ |

¹ Export is inherently online: it is a `GET /export` call against the API that streams a
generated archive. On mobile it is offered when connected and disabled with an explanatory
label when not. "Parity" means the feature exists, not that it works offline — nothing
local can produce a server-generated export.
| Platforms | **Android only.** iOS is not built, not tested, and not supported this phase |
| Data access architecture | Two paths behind a thin hook layer; `packages/core` stays PostgREST-only |
| Upload endpoint shape | **Operation router** — `(table, op)` maps to a core service method |
| Offline media logging | Note offline, `media_item_id` linked server-side on upload |
| Note conflicts | Conflict-copy on divergent bodies; metadata columns stay last-write-wins |
| Filter logic | Extracted to `packages/core/src/notes/filters.ts`, shared by all three call sites |
| PowerSync hosting | **PowerSync Cloud**, free tier |
| Local database | SQLCipher-encrypted; key in Android Keystore |
| App lock | **Mandatory** biometric/device-credential gate |
| `sensitive` tier | Specced here (§7.3), **implemented in phase 2** when enrichment exists |

This phase is large — sync infrastructure, six feature surfaces, and a security baseline.
The implementation is expected to land as **staged PRs** rather than one: (1) sync
foundation and `POST /sync/upload`, (2) security baseline, (3) feature parity, (4) filter
extraction and its equivalence tests. Each stage is independently reviewable; the phase
is not shippable until all four land.

### What this phase deliberately does not do

- **No iOS.** Every platform branch resolves to Android. `Platform.OS === 'ios'` paths in
  vendor examples are omitted, not stubbed — a stub implies support that does not exist.
- **No `flashcards` sync.** The table exists but has no service and no UI anywhere. Phase
  6 adds its sync rule, its client schema and its isolation test in one coherent PR,
  per parent §11's rule that sync rules are reviewed alongside RLS whenever a synced
  table changes.
- **No web offline.** Parent §4.8 settled this; web stays online-only.
- **No `sensitive` implementation.** §7.3 specifies it; phase 2 builds it, because every
  behaviour it governs (embedding, tagging, digests, grounding) is a phase-2-or-later
  subsystem. Building the column now with nothing reading it would be untested schema.

---

## 1. The problem this phase actually solves

All business logic lives in `packages/core` and speaks PostgREST through a
`SupabaseClient`:

```ts
// packages/core/src/media/service.ts:22
export class MediaService {
  constructor(private client: SupabaseClient, private userId: string) {}
```

Offline, there is no PostgREST. The design question is how mobile reads and writes
without a second copy of that logic.

This is not theoretical. `MediaService.findOrCreateItem` took **two rounds of bug fixes**
to get right (`docs/phase-1c-issue-log.md` A3 and E6): `.ilike()` treated `%` and `_` as
wildcards so logging `"D%"` attached the note to an existing `"Dune"`; then PostgREST's
own mapping of `*` to `%` inside like operands meant `"M*A*S*H"` still scanned as
`M%A%S%H`. Any client-side copy of this logic is a third instance of code that has
already been wrong twice, and it will drift.

---

## 2. Architecture: two data paths behind a thin hook layer

### 2.1 The shape

| Direction | Web | Mobile |
| --- | --- | --- |
| **Read** | PostgREST under RLS (unchanged) | Local SQLite, reactive queries |
| **Write** | API (unchanged) | Local SQLite → PowerSync queue → `POST /sync/upload` |
| **Live updates** | Supabase Realtime (unchanged) | PowerSync replication |

`packages/core` is untouched as a dependency of web and the API. Mobile reads never go
through a service layer — they are plain SQL against the local replica. Mobile writes
land locally for instant UI, and PowerSync's `uploadData` hook posts the CRUD batch to a
new endpoint that **replays each operation through the existing core services** with the
caller's JWT.

Net effect: business logic executes exactly once, on the server, in code that already has
tests. Platform divergence is confined to the read-hook layer — the containment parent
§14 names as the mitigation for the "two data-access paths" risk.

### 2.2 Rejected alternatives

**Abstract the data layer so core services run on both sides.** A `DataSource` interface
with PostgREST and SQLite implementations, making `NoteService` platform-agnostic.
Rejected: it requires a query translator for PostgREST semantics SQLite does not have —
`imatch`, `to_tsvector` ranking, RPCs, and `23505` race handling against a unique index
that **does not exist offline**. Large new surface; every bug in it presents as a sync bug.

**PowerSync for reads only, writes online through the REST API.** No upload hook, no
conflict machinery, days saved. Rejected: it is not offline-first, which is the phase's
entire purpose.

**Route reads through the API for both clients.** Considered during the session and
rejected on three grounds. (1) It does not address offline at all — offline means the API
is unreachable, so mobile must read local SQLite regardless; routing online reads through
the API would give mobile *two* read paths instead of one. (2) Web's Supabase Realtime
subscription (`00010_realtime_publication.sql`) cannot be routed through REST without
building a WebSocket relay, so the direct path survives anyway — a third path is added,
not a second removed. (3) It adds a network hop to SSR, which currently reaches Postgres
in one.

The valid kernel of that idea is addressed in §3 instead: the duplication that has
actually caused a bug is query *narrowing rules*, not transport.

### 2.3 Repo layout additions

```
packages/sync/                      NEW  PowerSync client schema, sync-rule source, RN init
packages/core/src/notes/filters.ts  NEW  parseNoteFilters / applyNoteFilters / noteFiltersToSql
apps/api/src/sync.controller.ts     NEW  POST /sync/upload (operation router)
apps/mobile/                        GROWS capture, list, editor, tags, check-in, media, export
supabase/migrations/00015_*.sql     NEW  widen links.kind
```

`packages/sync` is the isolation boundary parent §14 requires for the PowerSync vendor
risk: the sync layer is replaceable without touching feature code.

---

## 3. Shared filter logic (fixes E5 structurally)

### 3.1 The existing defect

Note-list query narrowing — lifecycle views, FTS with the load-bearing `config: "english"`,
the `note_tags!inner` join, the domain filter — is written in `apps/web/src/app/page.tsx`
and written **again** in `note-list.tsx` for the realtime refetch path. That duplication is
the direct cause of issue-log **E5**: the refetch dropped `q` and `tag`, so `/?q=...`
rendered three search results and then silently replaced them with the whole inbox.

Mobile would be the third copy.

### 3.2 The fix

```
packages/core/src/notes/filters.ts

  parseNoteFilters(params): NoteFilters     // one parser, all call sites
  applyNoteFilters(query, f)                // supabase-js: web SSR AND web refetch
  noteFiltersToSql(f): { where, params }    // SQLite: mobile
```

Web's two call sites collapse to one function, so E5's class of bug disappears
structurally rather than by remembering. Mobile translates the same declarative
`NoteFilters` to local SQL.

`noteFiltersToSql` is the only part of `packages/core` mobile imports. Core currently
imports `@supabase/supabase-js` types throughout and ships compiled `dist/`, so the
implementation must confirm this import does not drag server-oriented code into the RN
bundle — if it does, `filters.ts` moves to `@cortex/shared`, which mobile already depends
on. Treated as a step to verify, not an assumption.

### 3.3 The honest weakness, and its guard

`applyNoteFilters` and `noteFiltersToSql` are two implementations and **can drift**. The
guard is an equivalence test: one `NoteFilters` value, one shared fixture corpus, both
paths must return the same set of note ids. Cheap to write, catches drift immediately.

Search is where the two legitimately differ: Postgres FTS with `websearch_to_tsquery`
versus SQLite FTS5. The equivalence test therefore asserts identical results for
structural filters (lifecycle, domain, tag, trash) and **documented, asserted difference**
for full-text ranking — mobile search is a different engine, and pretending otherwise
would produce a test that lies.

---

## 4. Sync scope

Synced to Android clients:

`notes`, `tags`, `note_tags`, `links`, `media_items`, `checkins`

Server-only:

`note_chunks`, `ingest_inbox`, `memory_revisions`, `feedback_events`, `usage_ledger`,
`integrations` (credentials never leave the server), `flashcards` (deferred to phase 6,
§0).

This narrows parent §6.7, which listed tables that do not yet have services or UI. Each
table joins the sync set in the phase that builds its feature, with its sync rule and
isolation test in the same PR.

Sync rules define one bucket per user, keyed on `request.user_id()` from the Supabase JWT.

---

## 5. The upload path

### 5.1 Operation router, not a generic row-writer

`POST /sync/upload` receives a PowerSync CRUD batch. Two possible shapes:

A **generic row-writer** translates each operation into the corresponding PostgREST
insert/update/delete. Thin and easy — and it **bypasses the entire validation layer**,
meaning every invariant built in phase 1c is unenforced on the mobile write path.

An **operation router** maps `(table, op)` to a core service method, falling back to a
validated generic writer only for tables with no service. This preserves:

- `notes` updates run the conflict-copy check (§6);
- notes carrying unresolved media meta trigger `findOrCreateItem` (§5.3);
- `domain_meta` is re-validated when `domain` changes — the B3 fix;
- zod DTOs from `packages/shared` validate every payload, as on the REST path.

The router is chosen.

### 5.2 Authorisation

Writes execute with the **caller's JWT**, never `service_role` — parent §4.1 and the
existing REST controllers' discipline. RLS is the enforcement; the endpoint is not
trusted with elevated credentials. A batch is rejected wholesale if any operation's
`user_id` disagrees with the JWT subject.

### 5.3 Offline media logging

The media log is written locally as an **ordinary note** (`domain='media'`, title, rating
and impression in `domain_meta`). It appears instantly offline and rides the normal note
sync path. `media_item_id` stays null.

On upload, the router detects a note with unresolved media meta and calls the existing
`MediaService.findOrCreateItem`, then stamps `media_item_id`. Replication returns the
linked row to the device.

Why this and not a local provisional `media_items` row: item identity is
`(user_id, kind, lower(title))` enforced by a unique index the device cannot consult
offline. Two phones offline both logging "Dune" would create two items. Resolving
identity at the one place that can resolve it means the A3/E6 logic — escaping, anchored
`imatch`, year reconciliation, orphan compensation — stays in exactly one implementation.

Accepted cost: on-device, the item link and any year conflict (409) only materialise after
reconnect. The note itself is never delayed.

---

## 6. Conflict handling

### 6.1 Policy

| Data | Policy |
| --- | --- |
| `notes.content` | Conflict-copy when divergent |
| All other note columns (`lifecycle`, `domain`, `pinned`, …) | Last-write-wins |
| `checkins`, `media_items`, `tags`, `note_tags`, `links` | Last-write-wins |

Metadata columns are small and independently settable; a conflict copy for a lifecycle
toggle would be noise. Note bodies are the only place where last-write-wins is silent,
unrecoverable data loss.

### 6.2 Mechanism

The client includes `baseUpdatedAt` — the `updated_at` its edit was based on — in the
upload payload. The server:

1. reads the current row;
2. if `updated_at == baseUpdatedAt`, applies the update normally;
3. if `updated_at` has moved **and** `content` differs, keeps the server row and writes
   the incoming text as a **new note** (`lifecycle='inbox'`) plus a `links` row of kind
   `conflict_copy` pointing back at the original;
4. if `updated_at` moved but `content` is identical, applies the metadata update — this
   is not a conflict.

Comparison is on `content`, **not** `content_text`: `content_text` is a generated column
(`strip_markdown(content)`, `00002_content.sql:6`) and is not client-writable.

`baseUpdatedAt` is a request field, not a schema change — no column is added.

### 6.3 Migration `00015`

`links.kind` is currently `check (kind in ('semantic','manual','reference'))`
(`00003_organization.sql:37`). `00015` widens it to include `conflict_copy`.

Per the lesson recorded in issue-log A4, the migration qualifies any extension type as
`extensions.<type>` — this one uses none, but the rule is checked in review.

---

## 7. Security and data protection

Phase 1b creates a threat surface that did not previously exist, because before this
phase no user data lived on a device. Parent §11 covers auth, RLS and sync-rule
isolation, and the life-domains spec §5 covers the privacy model — **neither covers
device-local data**. Parent §15 (added by this spec) is the consolidated statement; this
section is what phase 1b builds.

### 7.1 New exposures introduced by this phase

| Exposure | Detail |
| --- | --- |
| Full plaintext corpus on the phone | Device lost, stolen or borrowed exposes everything |
| A third vendor holds a full copy | PowerSync Cloud reads via logical replication, which **bypasses RLS** (parent §4 item 5). Previously only Supabase and Railway touched the data |
| Sign-out leaves data behind | Without an explicit wipe, `signOut()` leaves the replica on the device permanently |
| Purge may not reach the device | A permanently deleted note must actually leave local SQLite, not just the server |

### 7.2 Pre-existing defect fixed in this phase

`apps/mobile/src/lib/supabase.ts:9` stores the Supabase session in `AsyncStorage`:

```ts
auth: { storage: AsyncStorage, ... }   // refresh token, unencrypted
```

On Android that is unencrypted SharedPreferences/SQLite in the app sandbox, **included in
Android Auto Backup to Google Drive**. A Supabase refresh token is long-lived: whoever
holds it has the user's full data access.

Fixed by moving session storage to `expo-secure-store` (Android Keystore-backed). This is
a phase-0 defect, not a hypothetical, and phase 1b makes it materially worse by adding a
full local corpus beside it.

### 7.3 The `sensitive` tier — specified here, built in phase 2

Add `notes.sensitive boolean not null default false`. When true:

| Subsystem | Behaviour |
| --- | --- |
| AI enrichment (phase 2) | Not chunked, not embedded, not auto-tagged — **no bytes leave your infrastructure for Gemini** |
| RAG chat (phase 3) | Excluded from retrieval by default |
| Digests (phase 7) | Excluded entirely |
| Memory layer (phase 8) | Produces no `memory_facts` |
| Web-search grounding | Never included in a query |
| UI | Content masked in list views until tapped |

This is a real mechanism rather than a half-measure: it does not pretend to be
encryption, it simply keeps the row off every path that reaches a third party. It is
consistent with life-domains §5, which rejected column encryption on the grounds that the
key necessarily sits beside the data — E2EE's costs without its guarantee.

Accepted cost: FTS and semantic search will not find sensitive notes. That is the
deliberate trade, and it is the correct direction for this data.

**Cortex is not a password manager.** Parent §4 item 5 rules out E2EE because server-side
AI must read plaintext. Consequently a password stored in a note is replicated to the
phone (this phase), sent to Gemini for embedding (phase 2), pulled into chat prompts
(phase 3), summarised into digests (phase 7), written to plaintext Markdown by export,
and present in every Supabase backup. Account credentials belong in a purpose-built
password manager, whose defining property — the server never sees plaintext — cortex
structurally cannot have. Cortex holds *"bank account X, opened March 2024, used for
rent"*; not its password. This is stated in parent §15 and in the tester-disclosure doc.

### 7.4 Local database encryption

PowerSync's React Native SDK supports SQLCipher through `@op-engineering/op-sqlite`:

```jsonc
// package.json
{ "op-sqlite": { "sqlcipher": true } }
```
```ts
const db = new PowerSyncDatabase({
  schema,
  database: { dbFilename: "cortex.db", sqliteOptions: { encryptionKey } },
});
```

The key is generated on first run and stored in Android Keystore via `expo-secure-store`.
It is never in AsyncStorage and never in a backup.

**Monorepo gotcha, per PowerSync's own docs:** depending on how the package manager
hoists modules, the `op-sqlite` block may need to live in the **root** `package.json`
rather than `apps/mobile/package.json`. Cortex is a pnpm workspace, so this is likely.
The implementation plan treats it as a step to verify, not an assumption.

### 7.5 Android Keystore key invalidation — designed for, not discovered

Expo's SecureStore documentation states:

> *"Keys are invalidated by the system when biometrics change. This only applies to values
> stored with `requireAuthentication` set to `true`."* — and `getItemAsync` *"resolves with
> `null` if there is no entry for the given key **or if the key has been invalidated**."*

So enrolling a new fingerprint destroys the SQLCipher key and makes the local encrypted
database permanently unreadable — and the API reports this as `null`, indistinguishable
from "no key yet". A naive implementation would generate a fresh key and then fail to open
an existing database.

Required design:

1. A separate SecureStore flag (stored **without** `requireAuthentication`) records that
   the database was initialised. `null` key **plus** the flag set means *key lost*, not
   *first run*.
2. Key lost ⇒ **wipe the local database, generate a new key, resync from the server.** The
   server is authoritative, so no committed data is lost.
3. **Local changes not yet uploaded are lost** in that recovery. The user is warned
   explicitly before the wipe; it never happens silently.
4. This path has a test.

### 7.6 Android hardening

| Setting | Value | Reason |
| --- | --- | --- |
| `biometricsSecurityLevel` | `'strong'` | Default is `'weak'`, which admits Android Class 2 biometrics (camera face unlock, spoofable with a photo on some devices). Health and finance data warrants Class 3 |
| `disableDeviceFallback` | `false` (default) | Devices with no enrolled biometric still lock via PIN/pattern. Disabling fallback would lock those users out entirely |
| `android:allowBackup` | `false` | Auto Backup would copy the database file to Google Drive while the Keystore key is **not** backed up — an undecryptable file on Drive is pure risk with no benefit |

### 7.7 Device lifecycle

- **App lock is mandatory**: biometric or device credential before the local database is
  unlocked, on every cold start and on return from background after more than **60
  seconds** (a named constant, not a magic number — short enough that a borrowed phone
  is protected, long enough that switching apps to copy a link is not punished).
- **Sign-out wipes**: `disconnectAndClear()` plus deletion of the SQLCipher key from
  Keystore. Tested.
- **Purge reaches the device**: PowerSync tombstones handle this, but it is tested
  explicitly. "Permanently deleted but still on the phone" is the worst kind of silent bug.

### 7.8 Sync rules are a second isolation layer, tested like RLS

Because PowerSync bypasses RLS, sync rules are the **only** thing preventing user A's rows
entering user B's bucket. Parent §11 requires review alongside RLS; this spec requires
**automated tests** in the manner of `rls-isolation.test.ts`.

Per issue-log **E3**, those tests must include real fixture rows for the other user.
E3's assertions were vacuous precisely because Alice had no rows in the tables being
checked, so deleting a policy outright kept the suite green.

---

## 8. Testing

| Area | Test |
| --- | --- |
| Filter equivalence | One `NoteFilters` + shared fixture → PostgREST and SQLite return the same id set for structural filters; full-text difference asserted explicitly (§3.3) |
| Sync-rule isolation | Cross-user bucket leakage, with real rows for both users (§7.8) |
| Conflict-copy | Same note edited offline on device and online on web → two notes, no text lost |
| Upload router | Each `(table, op)` reaches the intended service; media meta resolves; `domain_meta` re-validated; batch rejected on `user_id` mismatch |
| Sign-out wipe | Local database and Keystore key both gone |
| Purge propagation | Purged note absent from local SQLite after sync |
| Key invalidation | Simulated `null` key with the init flag set → wipe, warn, resync (§7.5) |
| Session storage | Session absent from AsyncStorage; present in SecureStore |

Package tests run through turbo (`pnpm turbo run test --filter=<pkg>`), never
`pnpm --filter <pkg> test` — issue-log B5/E8. Any environment variable a workflow exports
for a turbo-run task must be declared in `turbo.json` or it does not exist to that task.

---

## 9. Entry gates (user actions, not implementable)

1. **PowerSync Cloud instance** created and connected to the hosted Supabase project;
   connection details and sync rules uploaded.
2. **Railway decision (issue-log B4)** — the free trial lapses around 2026-08-31. Without
   a live API, `POST /sync/upload` does not exist and mobile cannot upload at all. This
   phase's write path depends on it.
3. **Android dev-client build** via EAS. PowerSync and SQLCipher are native modules;
   **Expo Go cannot run this app.** `eas.json` exists but has never produced a build.

---

## 10. Open items carried forward

- **B2** — the phase-1c browser click-through still needs a Google-signed-in human.
- **E1** — `domain_meta` remains client-writable through PostgREST by a row's owner.
  Unchanged by this phase; phase 2's entry gate is validate-on-read.
- **Note list is unbounded** (`page.tsx`, `note-list.tsx`). Mobile inherits the same shape
  against local SQLite, where it matters less (no network per row) but is still wrong.
  Pagination remains deferred; noted so it is not rediscovered as new.
