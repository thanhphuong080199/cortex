# Stage S1: The Chat-Only Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both clients become one chat surface — the note browser, the search UI and the capture widgets are deleted, mobile gains a real transcript that survives being offline, and the conversation becomes one continuous scrollable thread instead of a 4-hour window.

**Architecture:** Four parts, in dependency order. **Part A** (Tasks 1–2) widens the sync layer so `chat_messages` replicates down without becoming uploadable — this must land first because mobile's transcript reads it. **Part B** (Tasks 3–8) reduces web to a single column and deletes everything else. **Part C** (Tasks 9–14) rebuilds the mobile screen on the same shape, with its logic extracted into testable modules because mobile has no component-test harness at all. **Part D** (Tasks 15–16) rewrites the e2e suites onto the surfaces that still exist, and closes the stage.

**Tech Stack:** TypeScript, pnpm/Turborepo, Next.js App Router (`apps/web`), Expo/React Native + expo-router (`apps/mobile`), PowerSync, Supabase Postgres, Vitest, Playwright, Maestro.

**Spec:** `docs/superpowers/specs/2026-08-22-chat-only-shell-design.md`

**Merge point:** one branch, one PR. Part A alone is not shippable (it replicates a table nothing reads), and Part B alone leaves mobile's Maestro suite asserting against deleted screens. The stage merges whole.

---

## Spec corrections — read before Task 1

Four things found while verifying the tree at `67b421d`. None reverses a design decision; all four change what the implementer will find.

**1. The mobile app has no component-test harness.** `apps/mobile/vitest.config.ts` is `{ test: { environment: "node" } }` with the comment *"Pure-logic suites only: RN native modules are mocked per test file"*, there is no `@testing-library/react-native` in `apps/mobile/package.json`, and `find apps/mobile -name "*.test.tsx"` returns **zero** files against 17 `*.test.ts` files. The previous stage's plan contained a mobile test that called `render(<Markdown/>)`; it could never have run. **No task in this plan renders a React Native component in a test.** Mobile logic is extracted into `src/lib/` modules that import nothing from `react-native`, and the screens stay thin enough that Maestro is honest coverage for what is left.

**2. Web already has most of the chat shell.** `assistant-box.tsx` has the transcript, the bubbles, autoscroll, the empty state, the streaming hand-off and the offer row; `globals.css` has `.chat-pane`, `.chat-scroll`, `.chat-composer` and `.bubble`. Part B is therefore mostly *deletion plus four specific behaviour changes*, not a rewrite. Do not rebuild what is there.

**3. Web's offline behaviour today destroys the screen.** `assistant-box.tsx` ends with `if (!online) return <div className="banner">Offline — capture is disabled until the connection returns.</div>` — the entire transcript is replaced by one line. That was tolerable when the sidebar still rendered the notes; with the sidebar gone it means an offline user sees a single sentence and nothing else. Task 7 changes it to an indicator that leaves the thread on screen.

**4. Enter does not send today.** The composer's only key handler is `if ((e.metaKey || e.ctrlKey) && e.key === "Enter")`. Spec §2's "Enter sends, Shift+Enter breaks the line" is a behaviour change, not a description — Task 6.

**5. `note_edit_base` stays.** The spec was corrected on this before the plan was written, and the reason is worth repeating here: `connector.ts`'s `uploadData` queries that table directly with `SELECT base_content FROM note_edit_base WHERE note_id = ?`. Deleting the table means editing the upload path, which is how an offline capture reaches the server. The two modules that *fed* the table (`edit-base.ts`, `note-edits.ts`) go; the table and the connector branch stay and read empty forever.

---

## Global Constraints

- **Run package tests through turbo, never through the package directly.** `pnpm turbo run test --filter=@cortex/core` — not `pnpm --filter @cortex/core test`. `@cortex/shared` and `@cortex/core` resolve as compiled `dist/`, so the direct form tests stale output.
- **A cached turbo run is not a run.** Read the `Cached:` line in turbo's summary. With Docker down the database-backed suites replay a previous green without executing. Use `--force` on any gate whose result you are about to report.
- **No test may ever call the real Gemini API.** Use `createFakeAi` (`packages/core/src/ai/fake.ts`) or `bootstrapTestApp({ ai: createFakeAi() })`.
- **No note content, chat text, or model output in any log line or error message.** Report a length, never the payload.
- **Never print a line of `apps/api/.env`.** If a connection string must be redacted, split on the **last** `@`, not the first.
- **`supabase db push` targets the HOSTED project by default.** Use `pnpm supabase db push --local` while developing. The unflagged form is production.
- **Migration number: `00034`, and only Task 2 adds one.** The latest is `00033_memory_facts_assistant_offer.sql`.
- **CI already names every package this plan touches** — `.github/workflows/ci.yml`'s `checks` job filters `@cortex/shared`, `@cortex/sync`, `@cortex/mobile`, `@cortex/web`, `@cortex/db`, `@cortex/api`, `@cortex/core`. Every test in this plan lands inside one of those, so **no `ci.yml` change is required.** Task 16 verifies that still holds.
- **The user's language is Vietnamese.** Every new user-facing string in this plan is Vietnamese, matching mobile. Web's existing English strings are left alone — see "What this plan does not deliver".
- **Deleting a component and its test file together proves nothing.** For every deletion, the check is that no route renders it and no import survives: a typecheck plus a `grep`, written as an explicit step.
- **Out of scope, named so nobody adds it:** any API endpoint change; any change to the assistant turn, prompts, retrieval or grounding; any new way to delete or archive a note; device-written `chat_messages`; `chat_sessions` replication; a conversation list; a new capture widget of any kind.

---

## File Structure

**Created:**
- `supabase/migrations/00034_powersync_publication_chat_messages.sql` — puts `chat_messages` in the `powersync` publication (Task 2).
- `packages/shared/src/time.ts` gains two exported functions (Task 4) — no new file; it is already the home of time-zone-aware formatting.
- `apps/web/src/lib/transcript.ts` + `.test.ts` — the older-page fetch, as a function taking a client so it can be tested (Task 5).
- `apps/web/src/app/chat-header.tsx` — product name, connection indicator, `⋮` menu with sign-out (Task 7).
- `apps/mobile/src/theme.ts` + `.test.ts` — the token set, resolved by scheme (Task 9).
- `apps/mobile/src/lib/transcript.ts` + `.test.ts` — row→turn mapping, day grouping, live-turn merge. Pure; imports nothing from `react-native` (Task 10).
- `apps/mobile/src/screens/chat.tsx` — the screen (Task 12).
- `apps/mobile/src/components/connection-pill.tsx` — the indicator (Task 11).
- `apps/mobile/src/components/markdown.tsx` — gated on Task 13's spike (Task 14).

**Modified:**
- `packages/shared/src/dto/sync.ts` + `sync.test.ts` — `SYNC_TABLES` splits into `SYNCED_TABLES` and `UPLOADABLE_TABLES` (Task 1).
- `packages/sync/src/sync-rules.yaml`, `packages/sync/src/schema.ts`, `packages/sync/src/schema.test.ts` — `chat_messages` (Task 2).
- `packages/db/src/test/sync-rules-isolation.test.ts` — the new list, and a `chat_messages` fixture that needs a parent `chat_sessions` row (Task 2).
- `apps/web/src/app/page.tsx` — loses the entire notes read; keeps only auth and the transcript page (Task 3).
- `apps/web/src/app/layout.tsx` — renders the header instead of `AppShell` (Task 7).
- `apps/web/src/app/assistant-box.tsx` — pagination hook-up (Task 5), day separators (Task 4), Enter-to-send (Task 6), the offline change (Task 7).
- `apps/web/src/app/assistant-box.test.tsx` — the above.
- `apps/web/src/app/globals.css` — one column, assistant reply without a bubble, sticky composer; the sidebar/notes/widget rules are deleted (Tasks 6, 8).
- `apps/mobile/app/index.tsx` — renders the chat screen instead of `NoteList` (Task 12).
- `apps/mobile/src/screens/assistant-box.tsx` — becomes the composer + live turn only (Task 12).
- `apps/mobile/package.json` — markdown dependency, only if Task 13 passes.
- `.maestro/*.yaml` — rewritten (Task 15).
- `apps/web/e2e/*.spec.ts` — pruned and extended (Task 15).

**Deleted** (Tasks 8 and 11 — listed once, here, so the two tasks do not disagree):

Web: `sidebar.tsx`, `app-shell.tsx`, `note-list.tsx`, `checkin-widget.tsx`, `media-log-form.tsx`, `media-log-panel.tsx`, `export-button.tsx`, `search/page.tsx`, `search/search-client.tsx`, `search/search-form.tsx`, `search/search-form.test.tsx`, `notes/[id]/page.tsx`, `notes/[id]/editor.tsx`, `notes/[id]/tag-chips.tsx`, `lib/note-views.ts`, `lib/note-views.test.ts`, `lib/checkin.ts`, `lib/checkin.test.ts`, `lib/use-debounced-save.ts`, `lib/use-debounced-save.test.ts`.

Mobile: `screens/note-list.tsx`, `screens/note-editor.tsx`, `screens/export-button.tsx`, `app/notes/[id].tsx`, `lib/export.ts`, `lib/export.test.ts`, `lib/note-edits.ts`, `lib/edit-base.ts`, `lib/edit-base.test.ts`.

---

# Part A — the wire

### Task 1: `SYNC_TABLES` splits in two

`packages/shared/src/dto/sync.ts` currently says it out loud: *"Tables PowerSync replicates to Android clients, **and therefore** the only tables POST /sync/upload will write."* One list, two meanings — and `syncOp.table` is `z.enum(SYNC_TABLES)`.

`chat_messages` breaks that equivalence. It must replicate **down** so mobile can render a transcript offline, and it must never be writable **up**: the table holds the assistant's own replies, and a device that can insert into it can forge an answer the user never received. The grants allow it (`00006` gives `authenticated` full DML, scoped by RLS to the owner's rows), so the only thing standing in the way is this enum.

**Files:**
- Modify: `packages/shared/src/dto/sync.ts`
- Test: `packages/shared/src/dto/sync.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SYNCED_TABLES` (7 names, `chat_messages` last), `UPLOADABLE_TABLES` (the original 6), `type SyncTable = (typeof SYNCED_TABLES)[number]`, `type UploadableTable = (typeof UPLOADABLE_TABLES)[number]`. `SYNC_TABLES` **ceases to exist** — Task 2 updates its three remaining readers.

- [ ] **Step 1: Write the failing tests**

Replace the existing `SYNC_TABLES` references in `packages/shared/src/dto/sync.test.ts` and add:

```ts
describe("the download list and the upload list are not the same list", () => {
  // THE POINT OF THE WHOLE TASK. chat_messages replicates to the device and must never come
  // back up: it holds the assistant's replies, and an accepted upload op is a forged answer.
  // This is the assertion that turns red if someone later "simplifies" syncOp.table back to
  // SYNCED_TABLES because both lists look nearly identical.
  it("refuses an upload op naming chat_messages", () => {
    const parsed = syncUploadInput.safeParse({
      ops: [{ op_id: "1", op: "PUT", table: "chat_messages",
              id: "00000000-0000-0000-0000-000000000001", data: { content: "forged" } }],
    });
    expect(parsed.success).toBe(false);
  });

  it("still accepts an upload op for a table the device really writes", () => {
    const parsed = syncUploadInput.safeParse({
      ops: [{ op_id: "1", op: "PUT", table: "notes",
              id: "00000000-0000-0000-0000-000000000001", data: { content: "mine" } }],
    });
    expect(parsed.success).toBe(true);
  });

  // chat_messages must actually BE in the download list -- without this, deleting it from
  // SYNCED_TABLES would leave every assertion above green while mobile's transcript stayed empty.
  it("replicates chat_messages down", () => {
    expect([...SYNCED_TABLES]).toContain("chat_messages");
  });

  // Three lists that can drift is how a table becomes writable by accident. sync.ts's own
  // comment records that two hand-maintained copies of one list was already a bug here once.
  it("keeps every uploadable table in the synced list", () => {
    for (const t of UPLOADABLE_TABLES) expect([...SYNCED_TABLES]).toContain(t);
  });

  it("shares nothing with the server-only list", () => {
    const synced = new Set<string>(SYNCED_TABLES);
    for (const t of SERVER_ONLY_TABLES) expect(synced.has(t)).toBe(false);
  });
});
```

Update the file's import line to `import { SERVER_ONLY_TABLES, SYNCED_TABLES, UPLOADABLE_TABLES, syncUploadInput } from "./sync.js";` and change the two pre-existing tests that name `SYNC_TABLES` (the "rejects a table outside SYNC_TABLES" case and the sorted-equality case) to read `UPLOADABLE_TABLES` — the upload list is what both of them were really about.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/shared`
Expected: FAIL — `SYNCED_TABLES` and `UPLOADABLE_TABLES` do not exist.

- [ ] **Step 3: Split the list**

In `packages/shared/src/dto/sync.ts`, replace the `SYNC_TABLES` declaration and its doc comment with:

```ts
/**
 * Tables `POST /sync/upload` will write — everything a device is allowed to originate.
 *
 * A subset of SYNCED_TABLES, and the two were ONE list until 2026-08-22. Splitting them is
 * what lets chat_messages reach the device without becoming forgeable: the table holds the
 * assistant's own replies, `00006` grants `authenticated` full DML on it, and RLS scopes that
 * to the owner's rows — so an owner CAN insert a message their assistant never sent. Nothing
 * downstream of `syncOp` re-checks the table name; this enum is the check.
 */
export const UPLOADABLE_TABLES = [
  "notes", "tags", "note_tags", "links", "media_items", "checkins",
] as const;
export type UploadableTable = (typeof UPLOADABLE_TABLES)[number];

/**
 * Tables PowerSync replicates DOWN to the device. Everything uploadable, plus the ones the
 * server writes and the device only reads.
 *
 * `chat_messages` is the first of the read-only kind. It is here because chat is now the whole
 * app: opening it without a network and finding an empty screen is not a degraded experience
 * but a broken one (S1 spec §4).
 *
 * Server-only tables are deliberately absent (see `SERVER_ONLY_TABLES`); `integrations` in
 * particular holds credentials that must never reach a device.
 */
export const SYNCED_TABLES = [...UPLOADABLE_TABLES, "chat_messages"] as const;
export type SyncTable = (typeof SYNCED_TABLES)[number];
```

and change the op schema's table field:

```ts
  // UPLOADABLE, not SYNCED. See the comment on UPLOADABLE_TABLES: this line is the only thing
  // between a client and an inserted assistant reply.
  table: z.enum(UPLOADABLE_TABLES),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/shared`
Expected: PASS.

- [ ] **Step 5: Find every other reader**

```bash
grep -rn "SYNC_TABLES" --include=*.ts apps packages | grep -v node_modules | grep -v "/dist/"
```

Expected: exactly four hits, all handled in Task 2 — `packages/sync/src/schema.ts` (a comment), `packages/sync/src/schema.test.ts`, and two in `packages/db/src/test/sync-rules-isolation.test.ts`. If the grep shows anything else, that file needs updating too; decide per site whether it meant the download list or the upload list, and never guess.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/dto/
git commit -m "feat(shared): separate what replicates down from what may be uploaded"
```

---

### Task 2: `chat_messages` replicates

Three layers have to agree, and the isolation suite checks all three independently: the sync rules (what PowerSync is told to send), the client schema (what the device can see), and the Postgres publication (what enters the replication stream at all). A change to two of the three produces an empty transcript with every rule looking correct.

**Files:**
- Create: `supabase/migrations/00034_powersync_publication_chat_messages.sql`
- Modify: `packages/sync/src/sync-rules.yaml`, `packages/sync/src/schema.ts`, `packages/sync/src/schema.test.ts`
- Modify: `packages/db/src/test/sync-rules-isolation.test.ts`

**Interfaces:**
- Consumes: `SYNCED_TABLES` (Task 1).
- Produces: a `chat_messages` view on the device with columns `session_id, role, content, citations, retrieval_meta, created_at`. Tasks 10 and 11 query it.

- [ ] **Step 1: Point both suites at the new list**

In `packages/sync/src/schema.test.ts`, change the import to `SYNCED_TABLES` and line 9 to:

```ts
    expect(tableNames()).toEqual([...SYNCED_TABLES, "note_edit_base"].sort());
```

In `packages/db/src/test/sync-rules-isolation.test.ts`, change the import and all four `SYNC_TABLES` references to `SYNCED_TABLES`.

- [ ] **Step 2: Seed the fixture the new list demands**

`seedIds` throws `no rows seeded for <table>; the fixture did not cover it`, and `it.each(SYNCED_TABLES)` now includes `chat_messages`. A chat message needs a parent session — `chat_messages.session_id` is `not null references public.chat_sessions(id)`.

In the `beforeAll` of `sync-rules-isolation.test.ts`, add `"chat_messages"` and `"chat_sessions"` to the front of the delete loop (children first):

```ts
    for (const t of ["chat_messages", "chat_sessions", "links", "note_tags", "notes",
                     "tags", "media_items", "checkins"]) {
```

and inside the per-user seeding loop, after the notes are inserted:

```ts
    // chat_messages is the first READ-ONLY synced table: the server writes it, the device only
    // renders it. The parent session is a fixture requirement, not a feature -- session_id is
    // `not null references chat_sessions(id)`, so there is no such thing as a loose message.
    const session = await admin
      .from("chat_sessions").insert({ user_id: u.id }).select("id").single();
    if (session.error) throw session.error;
    const message = await admin
      .from("chat_messages")
      .insert({ user_id: u.id, session_id: session.data.id, role: "user",
                content: `message for ${name}` })
      .select("id").single();
    if (message.error) throw message.error;
    seeded.chat_messages = { ...(seeded.chat_messages ?? {}), [name]: message.data.id } as
      { alice: string; bob: string };
```

Match the surrounding code's exact idiom for populating `seeded` rather than this sketch if it differs — read the lines that populate `seeded.notes` and follow them.

- [ ] **Step 3: Run the two suites to verify they fail**

```bash
pnpm turbo run test --filter=@cortex/sync --force
pnpm turbo run test --filter=@cortex/db --force
```

Expected: FAIL. `@cortex/sync` fails on the table-name set; `@cortex/db` fails on the rules table set, on the scoping count, and on the publication.

**`--force` is not optional here.** These are the database-backed suites; with Docker down turbo replays a previous green and you will report a pass that never ran.

- [ ] **Step 4: Add the sync rule**

In `packages/sync/src/sync-rules.yaml`, add as the last query in `user_data.queries`:

```yaml
      # READ-ONLY on the device, and the only synced table of that kind. The server writes both
      # rows of every turn (turn.ts); nothing on the phone inserts here, and UPLOADABLE_TABLES
      # in @cortex/shared is what makes sure nothing can start to.
      #
      # No `deleted_at` filter, unlike checkins: chat_messages has no tombstone column at all
      # (00006 says so and explains why -- messages are append-only within a session).
      - SELECT * FROM chat_messages WHERE user_id = auth.user_id()
```

- [ ] **Step 5: Add the client schema entry**

In `packages/sync/src/schema.ts`, after `checkins` and before `note_edit_base`:

```ts
/**
 * Read-only on the device. `citations` and `retrieval_meta` are jsonb and arrive as JSON
 * STRINGS, the same way `notes.domain_meta` does -- whatever renders them parses them.
 *
 * `user_id` is omitted for the same reason every other table here omits it: the bucket is
 * already one user's, so the column would be a constant on every row.
 */
const chat_messages = new Table({
  session_id: column.text,
  role: column.text,
  content: column.text,
  citations: column.text,
  retrieval_meta: column.text,
  created_at: column.text,
});
```

and add it to the schema:

```ts
export const AppSchema = new Schema({
  notes, tags, note_tags, links, media_items, checkins, chat_messages, note_edit_base,
});
```

- [ ] **Step 6: Write the publication migration**

Create `supabase/migrations/00034_powersync_publication_chat_messages.sql`:

```sql
-- chat_messages joins the SCOPED powersync publication so the mobile chat can be read offline.
--
-- The publication is the layer BENEATH the sync rules: it is scoped by name rather than
-- FOR ALL TABLES precisely so a mistake in the rules cannot leak a server-only table
-- (docs/deploy.md §1). A table absent here replicates nothing no matter how correct its rule
-- looks, which is the failure this migration exists to prevent -- and
-- packages/db/src/test/sync-rules-isolation.test.ts asserts the publication's contents
-- directly, with no skip guard, so a missing ALTER is a red test rather than a silent
-- empty screen.
--
-- MUST ALSO BE APPLIED TO THE HOSTED PROJECT. `supabase db push` without --local targets
-- production; running it here is deliberate and is a deploy step, not a code change.
alter publication powersync add table public.chat_messages;
```

- [ ] **Step 7: Apply it locally and re-run the gates**

```bash
pnpm supabase db push --local
pnpm turbo run test --filter=@cortex/sync --force
pnpm turbo run test --filter=@cortex/db --force
```

Expected: PASS, both.

- [ ] **Step 8: Commit**

```bash
git add packages/sync/src packages/db/src/test supabase/migrations/00034_powersync_publication_chat_messages.sql
git commit -m "feat(sync): replicate chat_messages to the device, read-only"
```

---

# Part B — web

### Task 3: The page reads one table

`page.tsx` does two independent reads: `notes`, narrowed by `applyNoteFilters` for the sidebar, and `chat_messages` for the pane. The first one goes, along with the filter parsing, `href`, `domainHref` and the `AppShell`/`Sidebar` wrapping. The transcript read also stops being scoped to a session (spec §3).

`resolveCurrentSession` **stays in `turn.ts`** and is only removed from `page.tsx`. It decides how far back the model's prompt reaches; deleting it there would silently widen every prompt's history.

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Test: covered by Task 5's `apps/web/src/lib/transcript.test.ts` and by the e2e in Task 15 — this task has no unit test of its own and says so rather than inventing one.

**Interfaces:**
- Consumes: nothing.
- Produces: `<AssistantBox token userId initialTurns hasMore />`. `hasMore: boolean` is true when the first page filled, which is what tells the client there is anything older to fetch; `userId: string` is unused until Task 5 and is added here so the component's signature is settled in one place rather than twice.

- [ ] **Step 1: Rewrite the page**

Replace the whole body of `apps/web/src/app/page.tsx` with:

```tsx
import { redirect } from "next/navigation";
import { readCitation, type AnyCitation } from "@cortex/shared";
import { createClient } from "@/lib/supabase/server";
import { AssistantBox, type TranscriptTurn } from "./assistant-box";

/**
 * The first page of the thread, newest last.
 *
 * ONE table, and no session boundary. Until 2026-08-22 this file also read `notes` for a
 * sidebar, and scoped the transcript to `resolveCurrentSession` -- so a conversation from this
 * morning was simply gone by the afternoon, and finding it again was the note browser's job.
 * The browser is gone (S1 §1), so the thread has to be continuous (§3). `resolveCurrentSession`
 * still governs how far back the MODEL's prompt reaches, in turn.ts, which is a different
 * question and is deliberately left alone.
 *
 * 30, matching PAGE_SIZE in lib/transcript.ts. Ordered DESC in the query because that is the
 * direction the index runs (`chat_messages_user_idx (user_id, created_at desc)`, 00027), then
 * reversed for display -- an ASC query with a LIMIT would take the OLDEST thirty messages the
 * user ever sent.
 */
const PAGE_SIZE = 30;

export default async function Home() {
  const supabase = await createClient();
  // getUser() authenticates against the auth server; getSession() supplies the access token the
  // write API needs (getSession alone is not trustworthy server-side).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  // RLS (chat_messages_own, 00006) is the isolation layer, which is why this needs no user
  // filter beyond the one it already has for the index's leading column.
  const { data: messageRows } = await supabase
    .from("chat_messages").select("id, role, content, citations, retrieval_meta, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  const rows = messageRows ?? [];
  const turns: TranscriptTurn[] = [...rows].reverse().map((m) => {
    const row = m as {
      id: string; role: string; content: string;
      citations: unknown; retrieval_meta: { incomplete?: boolean } | null; created_at: string;
    };
    return {
      id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      createdAt: row.created_at,
      // readCitation is the one place a jsonb entry's shape is decided: a pre-C3 entry with no
      // `type` reads as a note, and anything unreadable is DROPPED rather than rendered. One
      // bad entry must not cost the user the rest of the transcript.
      citations: (Array.isArray(row.citations) ? row.citations : [])
        .map(readCitation)
        .filter((c): c is AnyCitation => c !== null),
      incomplete: row.retrieval_meta?.incomplete === true,
    };
  });

  return (
    <AssistantBox
      token={session.access_token}
      // Task 5's pagination query needs it, and the index leads on it.
      userId={user.id}
      initialTurns={turns}
      // A full page means there is probably more behind it. A short page is proof there is not,
      // and saves the client a round trip that would return zero rows.
      hasMore={rows.length === PAGE_SIZE}
    />
  );
}
```

- [ ] **Step 2: Add `createdAt` to the turn type**

In `apps/web/src/app/assistant-box.tsx`, add to `TranscriptTurn`:

```ts
  /** ISO. Feeds the day separators (Task 4) and the pagination cursor (Task 5). */
  createdAt: string;
```

and give `hasMore` a place in the props:

```ts
export function AssistantBox(
  { token, userId, initialTurns, hasMore }:
    { token: string; userId: string; initialTurns?: TranscriptTurn[]; hasMore?: boolean },
) {
```

Every existing test in `assistant-box.test.tsx` renders `<AssistantBox token="t" />` and now needs `userId="u1"` as well. That is a required prop on purpose: making it optional would let a page forget it and silently fall back to an unindexed scan.

Every place the component builds a turn of its own now needs a `createdAt`. There are two — the optimistic user bubble in `submit()` and `flushLiveIntoTurns` — and both use `new Date().toISOString()`. TypeScript will point at them; do not silence it with a cast.

- [ ] **Step 3: Typecheck**

Run: `pnpm turbo run typecheck --filter=@cortex/web`
Expected: errors ONLY in the files Task 8 deletes (`sidebar.tsx` and anything importing `note-views`), plus any turn-construction site missing `createdAt`. Fix the second kind; leave the first — Task 8 deletes those files. If an error appears anywhere else, stop and read it: the page contract changed and something you did not expect was reading it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/src/app/assistant-box.tsx
git commit -m "feat(web): read one continuous thread instead of a session and a note list"
```

---

### Task 4: Day separators

Removing the session boundary removes the only visual break in the thread. The replacement is a date line between messages that fall on different days **in the caller's time zone** — computed in UTC it lands in the wrong place for every Vietnamese evening, which is exactly the window `DEFAULT_TIME_ZONE`'s comment already describes.

Both clients need this, so it lives in `@cortex/shared` beside the other time-zone-aware formatting.

**Files:**
- Modify: `packages/shared/src/time.ts`
- Test: `packages/shared/src/time.test.ts`
- Modify: `apps/web/src/app/assistant-box.tsx`, `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: nothing.
- Produces: `dayKey(iso: string, timeZone: string): string` — `"YYYY-MM-DD"` in that zone, or `""` for an unparseable input. `daySeparatorLabel(iso: string, now: Date, timeZone: string): string` — `"Hôm nay"`, `"Hôm qua"`, or `"18 thg 8"`. Task 10 uses both on mobile.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/time.test.ts`:

```ts
describe("dayKey", () => {
  // THE CASE THE WHOLE FUNCTION EXISTS FOR, and the only one a UTC implementation gets wrong.
  // 2026-08-18T18:30Z is still the 18th in UTC and already the 19th in Ho Chi Minh City (UTC+7).
  // Evening is when this corpus is written, so a UTC key puts the separator a day late every
  // single time.
  it("uses the caller's zone, not UTC", () => {
    expect(dayKey("2026-08-18T18:30:00.000Z", "Asia/Ho_Chi_Minh")).toBe("2026-08-19");
    expect(dayKey("2026-08-18T18:30:00.000Z", "UTC")).toBe("2026-08-18");
  });

  // Two messages either side of local midnight must NOT share a key -- if they did there would
  // be no separator between them, which is the visible bug.
  it("separates two instants that straddle local midnight", () => {
    const before = dayKey("2026-08-18T16:59:00.000Z", "Asia/Ho_Chi_Minh"); // 23:59 local
    const after = dayKey("2026-08-18T17:01:00.000Z", "Asia/Ho_Chi_Minh"); // 00:01 local
    expect(before).not.toBe(after);
  });

  // Sortable, because the caller groups by it. "18/08/2026" would sort August before February.
  it("is zero-padded and year-first so it sorts", () => {
    expect(dayKey("2026-02-03T05:00:00.000Z", "Asia/Ho_Chi_Minh")).toBe("2026-02-03");
  });

  // Persisted rows predate every field this repo has added; a bad timestamp must not throw
  // inside a map() and take the whole transcript down.
  it("returns an empty string for an unparseable date", () => {
    expect(dayKey("not a date", "Asia/Ho_Chi_Minh")).toBe("");
  });
});

describe("daySeparatorLabel", () => {
  const tz = "Asia/Ho_Chi_Minh";
  // 2026-08-22T03:00Z is 10:00 on the 22nd, local.
  const now = new Date("2026-08-22T03:00:00.000Z");

  it("names today and yesterday rather than dating them", () => {
    expect(daySeparatorLabel("2026-08-22T01:00:00.000Z", now, tz)).toBe("Hôm nay");
    expect(daySeparatorLabel("2026-08-21T01:00:00.000Z", now, tz)).toBe("Hôm qua");
  });

  // RELATIVE TO `now`'s OWN LOCAL DAY, not to UTC's. At 03:00Z on the 22nd it is already the
  // 22nd locally; an implementation that takes "today" from the UTC date happens to agree here
  // and disagrees for every evening, so the case below is the one that pins it.
  it("still says today for a message sent this local evening", () => {
    const evening = new Date("2026-08-22T16:00:00.000Z"); // 23:00 local, same local day
    expect(daySeparatorLabel("2026-08-22T15:00:00.000Z", evening, tz)).toBe("Hôm nay");
  });

  it("dates anything older", () => {
    expect(daySeparatorLabel("2026-08-18T01:00:00.000Z", now, tz)).toMatch(/18/);
    expect(daySeparatorLabel("2026-08-18T01:00:00.000Z", now, tz)).not.toMatch(/Hôm/);
  });
});
```

Add both names to the file's import from `./time.js`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/shared`
Expected: FAIL — neither function exists.

- [ ] **Step 3: Implement**

Append to `packages/shared/src/time.ts`:

```ts
/**
 * A sortable calendar-day key in the given zone: "2026-08-19".
 *
 * `en-CA` because it yields ISO order (`YYYY-MM-DD`) in every runtime — the same trick
 * formatNoteDate uses with `en-GB`, and for the same reason: assembling the parts by hand
 * through `formatToParts` is two more chances to get locale ordering subtly wrong.
 *
 * The zone is the entire point. 18:30Z is still the 18th in UTC and already the 19th here, and
 * evening is when this corpus is written (see DEFAULT_TIME_ZONE) -- so a UTC key puts every
 * separator a day late.
 */
export function dayKey(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/**
 * What a day separator says: "Hôm nay", "Hôm qua", or "18 thg 8".
 *
 * Compared through dayKey rather than by subtracting milliseconds: "yesterday" is a calendar
 * relationship, and 25 hours ago can be either today or two days back depending on where the
 * local midnight fell.
 */
export function daySeparatorLabel(iso: string, now: Date, timeZone: string): string {
  const key = dayKey(iso, timeZone);
  if (key === "") return "";
  if (key === dayKey(now.toISOString(), timeZone)) return "Hôm nay";
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (key === dayKey(yesterday.toISOString(), timeZone)) return "Hôm qua";
  return new Intl.DateTimeFormat("vi-VN", { timeZone, day: "numeric", month: "short" })
    .format(new Date(iso));
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/shared`
Expected: PASS.

- [ ] **Step 5: Render them on web**

In `apps/web/src/app/assistant-box.tsx`, add `dayKey, daySeparatorLabel` to the `@cortex/shared` import and resolve the zone once per render, beside the other top-level consts:

```ts
  // Read once per render, not per row: Intl resolution is not free and the answer cannot change
  // between two rows of the same paint.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
```

Replace the opening of the `turns.map` with a version that emits a separator when the day changes:

```tsx
        {turns.map((t, i) => {
          const prev = i > 0 ? turns[i - 1] : undefined;
          const key = dayKey(t.createdAt, timeZone);
          // A separator before the FIRST row too (prev === undefined): the top of a loaded page
          // is a day boundary as far as the reader is concerned, and without it the oldest
          // visible day is the only undated one on screen.
          const showSeparator = key !== "" && (prev === undefined || dayKey(prev.createdAt, timeZone) !== key);
          return (
            <Fragment key={t.id}>
              {showSeparator && (
                <p className="day-separator" role="separator">
                  {daySeparatorLabel(t.createdAt, now, timeZone)}
                </p>
              )}
              {t.role === "user" ? (
                <div className="bubble user"><p>{t.content}</p></div>
              ) : (
                <div className="bubble assistant">
                  <Provenance citations={t.citations} />
                  {t.content && <div className="answer"><Markdown>{t.content}</Markdown></div>}
                  {t.incomplete && (
                    <p className="interrupted" role="note">Câu trả lời bị gián đoạn (interrupted).</p>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
```

Import `Fragment` from `react`.

- [ ] **Step 6: Style it**

In `apps/web/src/app/globals.css`, beside the other chat rules:

```css
/* A quiet rule with a date on it -- the thread's only structural break now that the session
   boundary is gone from the UI. */
.day-separator {
  align-self: center; margin: 8px 0 2px;
  color: var(--muted); font-size: 12px; letter-spacing: 0.02em;
}
```

- [ ] **Step 7: Run the web suite**

Run: `pnpm turbo run test --filter=@cortex/web`
Expected: PASS. Existing `assistant-box` tests that construct turns need `createdAt` added to their fixtures — that is Task 3's type change surfacing, not a regression.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/time.ts packages/shared/src/time.test.ts \
  apps/web/src/app/assistant-box.tsx apps/web/src/app/assistant-box.test.tsx \
  apps/web/src/app/globals.css
git commit -m "feat(chat): break the thread by day in the reader's own time zone"
```

---

### Task 5: Scroll up, load more

A continuous thread with 30 rows in it and no way to reach the 31st is a session window with extra steps.

**Files:**
- Create: `apps/web/src/lib/transcript.ts`, `apps/web/src/lib/transcript.test.ts`
- Modify: `apps/web/src/app/assistant-box.tsx`
- Test: `apps/web/src/app/assistant-box.test.tsx`

**Interfaces:**
- Consumes: `TranscriptTurn` (Task 3).
- Produces: `PAGE_SIZE = 30`; `fetchOlderTurns(client: TranscriptClient, userId: string, before: string): Promise<{ turns: TranscriptTurn[]; hasMore: boolean }>`, where `TranscriptClient` is the minimal shape it calls, so the test can pass a stub instead of a Supabase client. `userId` is passed explicitly even though RLS already scopes the read: `chat_messages_user_idx` leads on `user_id`, and a query that omits it scans instead of seeking.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/transcript.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fetchOlderTurns, PAGE_SIZE } from "./transcript";

/** The four chained calls the real query makes, ending in a thenable. */
function stubClient(rows: unknown[], capture?: { lt?: string; limit?: number }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    lt: (_col: string, value: string) => { if (capture) capture.lt = value; return builder; },
    order: () => builder,
    limit: (n: number) => { if (capture) capture.limit = n; return Promise.resolve({ data: rows, error: null }); },
  };
  return { from: () => builder } as never;
}

const row = (id: string, createdAt: string) => ({
  id, role: "user", content: `msg ${id}`, citations: [], retrieval_meta: null,
  created_at: createdAt,
});

const USER = "11111111-1111-1111-1111-111111111111";

describe("fetchOlderTurns", () => {
  // OLDEST FIRST on the way out, newest-first on the way in. The query has to run DESC to use
  // chat_messages_user_idx and to make LIMIT mean "the 30 nearest the cursor"; the transcript
  // renders ascending. Getting this backwards produces a thread that reads bottom-to-top only
  // in the pages loaded by scrolling -- a bug that looks like corrupted data.
  it("returns the page in display order, oldest first", async () => {
    const client = stubClient([
      row("c", "2026-08-20T10:00:00.000Z"),
      row("b", "2026-08-20T09:00:00.000Z"),
      row("a", "2026-08-20T08:00:00.000Z"),
    ]);
    const { turns } = await fetchOlderTurns(client, USER, "2026-08-20T11:00:00.000Z");
    expect(turns.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  // STRICTLY BEFORE the cursor. With `lte`, the message the cursor came from is returned again
  // on every page, and React renders a duplicate key for it.
  it("asks strictly before the cursor", async () => {
    const capture: { lt?: string; limit?: number } = {};
    await fetchOlderTurns(stubClient([], capture), USER, "2026-08-20T11:00:00.000Z");
    expect(capture.lt).toBe("2026-08-20T11:00:00.000Z");
    expect(capture.limit).toBe(PAGE_SIZE);
  });

  // A SHORT page is the end of the thread. Reporting hasMore: true there leaves the user
  // pulling forever against a query that will never return anything again.
  it("reports the end of the thread when the page is short", async () => {
    const { hasMore } = await fetchOlderTurns(
      stubClient([row("a", "2026-08-20T08:00:00.000Z")]), USER, "2026-08-20T11:00:00.000Z");
    expect(hasMore).toBe(false);
  });

  it("reports more when the page is full", async () => {
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) =>
      row(`r${i}`, new Date(Date.UTC(2026, 7, 20, 0, i)).toISOString()));
    const { hasMore } = await fetchOlderTurns(stubClient(rows), USER, "2026-08-20T11:00:00.000Z");
    expect(hasMore).toBe(true);
  });

  // Same rule page.tsx applies to the first page: one unreadable citation must cost that entry,
  // not the message and not the page.
  it("drops an unreadable citation without dropping the turn", async () => {
    const bad = { ...row("a", "2026-08-20T08:00:00.000Z"), citations: [{ nonsense: true }] };
    const { turns } = await fetchOlderTurns(stubClient([bad]), USER, "2026-08-20T11:00:00.000Z");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.citations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/web -- transcript`
Expected: FAIL — `./transcript` does not exist.

- [ ] **Step 3: Write the module**

Create `apps/web/src/lib/transcript.ts`:

```ts
import { readCitation, type AnyCitation } from "@cortex/shared";
import type { TranscriptTurn } from "@/app/assistant-box";

/**
 * One page of the thread. Matches PAGE_SIZE in page.tsx, which renders the first one -- two
 * different sizes would make "a full page means there is more" mean two different things.
 */
export const PAGE_SIZE = 30;

/**
 * Only the part of a Supabase client this function calls. Declared rather than imported so the
 * test can hand over a stub: a test that spins up a real client would be testing PostgREST.
 */
export interface TranscriptClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        lt(column: string, value: string): {
          order(column: string, opts: { ascending: boolean }): {
            limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
          };
        };
      };
    };
  };
}

/**
 * The page of messages immediately before `before` (an ISO timestamp), oldest first.
 *
 * DESC in the query, reversed on the way out. The index is
 * `chat_messages_user_idx (user_id, created_at desc)` (00027), and only a DESC query makes
 * LIMIT mean "the thirty nearest the cursor" -- an ASC query with a LIMIT returns the thirty
 * oldest messages the user ever wrote, from any year.
 *
 * `lt`, never `lte`: with `lte` the cursor's own message comes back on every page and React
 * renders a duplicate key.
 */
export async function fetchOlderTurns(
  client: TranscriptClient,
  userId: string,
  before: string,
): Promise<{ turns: TranscriptTurn[]; hasMore: boolean }> {
  const { data } = await client
    .from("chat_messages")
    .select("id, role, content, citations, retrieval_meta, created_at")
    // RLS scopes this read regardless. The filter is here for the INDEX:
    // chat_messages_user_idx leads on user_id, and a query without it scans.
    .eq("user_id", userId)
    .lt("created_at", before)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  const rows = (data ?? []) as {
    id: string; role: string; content: string;
    citations: unknown; retrieval_meta: { incomplete?: boolean } | null; created_at: string;
  }[];

  return {
    turns: [...rows].reverse().map((row) => ({
      id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      createdAt: row.created_at,
      citations: (Array.isArray(row.citations) ? row.citations : [])
        .map(readCitation)
        .filter((c): c is AnyCitation => c !== null),
      incomplete: row.retrieval_meta?.incomplete === true,
    })),
    hasMore: rows.length === PAGE_SIZE,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/web -- transcript`
Expected: PASS.

- [ ] **Step 5: Wire it to the scroll**

In `apps/web/src/app/assistant-box.tsx`, add state and a handler:

```ts
  const [more, setMore] = useState(hasMore ?? false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Scroll-anchored, and this is the fiddly half. Prepending rows moves everything the user was
  // reading downward by the height of what arrived; capturing scrollHeight before the paint and
  // restoring the delta after it is what keeps their place. Without it the thread jumps to the
  // top on every page and the user cannot read backwards at all.
  async function loadOlder() {
    const el = scrollRef.current;
    const oldest = turns[0];
    if (!el || !oldest || loadingOlder || !more) return;
    setLoadingOlder(true);
    const heightBefore = el.scrollHeight;
    try {
      const { turns: older, hasMore: stillMore } =
        await fetchOlderTurns(createClient(), userId, oldest.createdAt);
      setTurns((prev) => [...older, ...prev]);
      setMore(stillMore);
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - heightBefore; });
    } catch {
      // Leave `more` alone: a failed fetch is not proof the thread ended, and setting it false
      // would make one dropped request look permanently like the beginning of history.
    } finally {
      setLoadingOlder(false);
    }
  }
```

`userId` becomes a prop, passed from `page.tsx` (`userId={user.id}`). Add `onScroll` to the scroll container:

```tsx
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => { if (e.currentTarget.scrollTop < 80) void loadOlder(); }}
      >
```

and render the top affordance as the first child inside it:

```tsx
        {more && (
          <p className="chat-older" role="status">
            {loadingOlder ? "Đang tải…" : "Cuộn lên để xem thêm"}
          </p>
        )}
```

The autoscroll effect must not fight this. Change its dependency list so a prepend does not scroll to the bottom:

```ts
  // Only the LIVE parts of the turn scroll the thread down. `turns` was in this list, and with
  // pagination it must not be: loading older messages appends to the front, and an effect that
  // pins to the bottom on every `turns` change would undo the anchoring above instantly.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [attached, citations, web, answer, status, error, phase]);
```

Because `turns` leaves that list, a *newly sent* message would stop scrolling into view — so scroll explicitly at the end of the optimistic-bubble block in `submit()`:

```ts
    // The user just pressed Send; their own bubble must be visible. Explicit now that `turns`
    // no longer drives the autoscroll effect.
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
```

- [ ] **Step 6: Test the two behaviours that break in opposite directions**

Add to `apps/web/src/app/assistant-box.test.tsx`:

```tsx
const turn = (id: string, createdAt: string): TranscriptTurn => ({
  id, role: "user", content: `msg ${id}`, createdAt, citations: [], incomplete: false,
});

/**
 * jsdom reports 0 for every layout property, so a scroll test that does not define them is
 * asserting 0 === 0. These are defined on the prototype rather than the node because the
 * component looks them up through a ref it owns.
 */
function stubScrollMetrics(scrollHeight: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true, get: () => scrollHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true, get: () => 400,
  });
}

describe("loading older messages", () => {
  // A PREPEND MUST NOT JUMP THE READER TO THE BOTTOM. This is the assertion that fails if
  // someone puts `turns` back into the autoscroll effect's dependency list -- the single most
  // likely regression here, and one no snapshot would show.
  it("does not scroll to the bottom when older messages arrive", async () => {
    stubScrollMetrics(2000);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([
        { id: "old", role: "user", content: "cũ hơn", citations: [], retrieval_meta: null,
          created_at: "2026-08-19T02:00:00.000Z" },
      ]), { status: 200 })) as typeof fetch;

    render(
      <AssistantBox token="t" userId="u1" hasMore
        initialTurns={[turn("a", "2026-08-20T02:00:00.000Z")]} />,
    );
    const scroller = document.querySelector(".chat-scroll") as HTMLElement;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("cũ hơn")).toBeInTheDocument());
    // Anchored, not pinned: 2000 would be the bottom.
    expect(scroller.scrollTop).not.toBe(2000);
  });

  // A SHORT page is the end of the thread. Without this, the affordance stays forever and the
  // user keeps pulling against a query that will never return anything again.
  it("stops offering more once a short page comes back", async () => {
    stubScrollMetrics(2000);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;

    render(
      <AssistantBox token="t" userId="u1" hasMore
        initialTurns={[turn("a", "2026-08-20T02:00:00.000Z")]} />,
    );
    expect(screen.getByText(/Cuộn lên để xem thêm/)).toBeInTheDocument();

    const scroller = document.querySelector(".chat-scroll") as HTMLElement;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

    await waitFor(() => expect(screen.queryByText(/Cuộn lên để xem thêm/)).toBeNull());
  });
});
```

The stubbed `fetch` above stands in for the Supabase client's REST call. If `createClient()` cannot be reached that way from the test environment, inject the fetcher instead — give `AssistantBox` an optional `fetchOlder` prop defaulting to the real one, and pass a fake here. **Do not** weaken the assertions to avoid the injection; the anchoring behaviour is the whole point of the task.

- [ ] **Step 7: Run the web suite**

Run: `pnpm turbo run test --filter=@cortex/web`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/transcript.ts apps/web/src/lib/transcript.test.ts \
  apps/web/src/app/assistant-box.tsx apps/web/src/app/assistant-box.test.tsx \
  apps/web/src/app/page.tsx apps/web/src/app/globals.css
git commit -m "feat(web): load older messages when the thread is scrolled to the top"
```

---

### Task 6: The composer behaves like a chat composer

Two changes, both small, both wrong today: Enter does not send (only Cmd/Ctrl+Enter does), and the textarea is a fixed single row that scrolls internally instead of growing.

**Files:**
- Modify: `apps/web/src/app/assistant-box.tsx`, `apps/web/src/app/globals.css`
- Test: `apps/web/src/app/assistant-box.test.tsx`

**Interfaces:**
- Consumes: nothing. Produces: nothing importable.

- [ ] **Step 1: Write the failing tests**

```tsx
describe("the composer", () => {
  function stubFetch(calls: string[]) {
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : sse([["done", { messageId: "m1", sessionId: "s1" }]]);
    }) as typeof fetch;
  }

  it("sends on Enter", async () => {
    const calls: string[] = [];
    stubFetch(calls);
    render(<AssistantBox token="t" userId="u1" />);
    const box = screen.getByLabelText(/what are you thinking/i);
    await userEvent.type(box, "gửi bằng enter");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(calls.some((c) => c.endsWith("/notes"))).toBe(true));
  });

  // THE HALF THAT GETS DROPPED. A box where Enter sends must still let the user write a second
  // line, and this corpus is full of multi-line captures. Implementing only the test above
  // yields a composer that cannot type a paragraph -- and nothing else would notice.
  it("inserts a newline on Shift+Enter and does not send", async () => {
    const calls: string[] = [];
    stubFetch(calls);
    render(<AssistantBox token="t" userId="u1" />);
    const box = screen.getByLabelText(/what are you thinking/i) as HTMLTextAreaElement;
    await userEvent.type(box, "dòng một");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await userEvent.type(box, "dòng hai");

    expect(box.value).toContain("\n");
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/web -- assistant-box`
Expected: FAIL — plain Enter does nothing.

- [ ] **Step 3: Implement**

Replace the textarea's `onKeyDown`:

```tsx
          onKeyDown={(e) => {
            // Shift+Enter is a newline; the browser's default already does that, so the only
            // job here is to NOT intercept it. Cmd/Ctrl+Enter is kept as well -- it was the
            // only way to send until 2026-08-22 and muscle memory is cheap to honour.
            if (e.key !== "Enter") return;
            if (e.shiftKey) return;
            e.preventDefault();
            void submit();
          }}
```

and let it grow:

```tsx
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            // Reset before measuring: scrollHeight never shrinks on its own, so without the
            // first line the box grows and never comes back down after a delete.
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
          }}
```

`200` matches the `max-height` already on `.chat-composer textarea`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/web -- assistant-box`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/assistant-box.tsx apps/web/src/app/assistant-box.test.tsx
git commit -m "feat(web): Enter sends, Shift+Enter breaks the line, the box grows"
```

---

### Task 7: Header, connection, and the offline change

Three things land together because they are one strip of UI: the product name, the connection indicator that replaces `ExportButton`'s label as the proof the client is online, and the `⋮` menu whose only item is sign-out — which is where sign-out has to go, because `Sidebar` held it and `Sidebar` is about to be deleted.

The offline behaviour changes at the same time and for the same reason. Today `assistant-box.tsx` returns a single `<div className="banner">` **instead of the whole component** when offline. With the sidebar gone, that is the entire screen.

**Files:**
- Create: `apps/web/src/app/chat-header.tsx`
- Modify: `apps/web/src/app/layout.tsx`, `apps/web/src/app/assistant-box.tsx`, `apps/web/src/app/globals.css`
- Test: `apps/web/src/app/assistant-box.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `<ChatHeader />` — a client component taking no props. Sign-out posts to `/auth/signout`, the same endpoint `Sidebar`'s form used.

- [ ] **Step 1: Write the failing test**

```tsx
describe("going offline", () => {
  const stored = (
    { id: "a", role: "user", content: "câu cũ của tôi", createdAt: "2026-08-20T02:00:00.000Z",
      citations: [], incomplete: false } as TranscriptTurn
  );

  function goOffline() {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    window.dispatchEvent(new Event("offline"));
  }

  // THE THREAD MUST SURVIVE. Until 2026-08-22 this component returned a bare banner INSTEAD OF
  // ITSELF when offline -- survivable while a sidebar still rendered the notes, and not now:
  // the user would lose everything on screen the moment a train entered a tunnel.
  it("keeps the thread on screen when the connection drops", async () => {
    render(<AssistantBox token="t" userId="u1" initialTurns={[stored]} />);
    goOffline();
    await waitFor(() => expect(screen.getByText(/Mất mạng/)).toBeInTheDocument());
    expect(screen.getByText("câu cũ của tôi")).toBeInTheDocument();
  });

  // Sending is genuinely impossible -- the note goes through POST /notes. A composer that
  // silently fails is worse than one that explains, so both controls go down together.
  it("disables sending while offline", async () => {
    render(<AssistantBox token="t" userId="u1" initialTurns={[stored]} />);
    goOffline();
    await waitFor(() => expect(screen.getByRole("button", { name: /send/i })).toBeDisabled());
    expect(screen.getByLabelText(/what are you thinking/i)).toBeDisabled();
  });
});
```

Restore `navigator.onLine` in an `afterEach` if the file does not already — a leaked `false` makes every later test in the file render the offline notice.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/web -- assistant-box`
Expected: FAIL — the offline branch replaces the transcript.

- [ ] **Step 3: Change the offline branch**

Delete the early return:

```tsx
  if (!online) {
    return <div className="banner" role="status">Offline — capture is disabled until the connection returns.</div>;
  }
```

and instead render a notice above the composer, leaving the thread intact:

```tsx
      {!online && (
        <p className="chat-offline" role="status">
          Mất mạng — chưa gửi được. Hội thoại cũ vẫn xem được.
        </p>
      )}
```

Disable the two controls while offline:

```tsx
          disabled={busy || !online}
```

on both the `<textarea>` and the submit `<button>`.

- [ ] **Step 4: Write the header**

Create `apps/web/src/app/chat-header.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

/**
 * The only chrome left. Product name, a connection dot, and one menu holding sign-out.
 *
 * Sign-out lives here because Sidebar held it and Sidebar is gone -- there is no other surface
 * left to put it on, and an app you cannot sign out of is not shippable.
 *
 * The connection dot is not decoration either. `ExportButton`'s label was the plainest proof
 * that the client was online -- e2e keyed on it -- and export went with the sidebar. This is
 * its replacement, for the user and for the suite.
 */
export function ChatHeader() {
  const [online, setOnline] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  return (
    <header className="chat-header">
      <span className="chat-title">Cortex</span>
      {!online && (
        <span className="conn offline" data-testid="conn-status" role="status">Ngoại tuyến</span>
      )}
      {online && <span className="conn online" data-testid="conn-status" hidden>Trực tuyến</span>}
      <button
        type="button" className="menu-toggle" aria-haspopup="menu" aria-expanded={menuOpen}
        aria-label="Menu" onClick={() => setMenuOpen((v) => !v)}
      >
        ⋮
      </button>
      {menuOpen && (
        <form className="chat-menu" role="menu" action="/auth/signout" method="post">
          <button type="submit" role="menuitem">Đăng xuất</button>
        </form>
      )}
    </header>
  );
}
```

The online span is rendered `hidden` rather than omitted so `conn-status` is always in the DOM — an e2e assertion that has to distinguish "online" from "the element has not mounted yet" cannot do it against an absent node.

- [ ] **Step 5: Mount it and lay the page out**

In `apps/web/src/app/layout.tsx`, render `<ChatHeader />` above `{children}`. Read the file first: it currently wraps children in whatever the sidebar layout needed, and that wrapper goes.

In `globals.css`, replace the `.app-shell` / `.sidebar*` / `.main` block (lines ~158-186 and the `@media (min-width: 860px)` rules that reference the sidebar) with:

```css
/* ---- One column, one chat ---- */

.chat-header {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 10px;
  max-width: 720px; width: 100%; margin: 0 auto; padding: 10px 16px;
  background: var(--bg); border-bottom: 1px solid var(--line);
}
.chat-title { font-weight: 600; letter-spacing: -0.01em; }
.chat-header .conn { margin-left: auto; font-size: 12px; color: var(--muted); }
.chat-header .conn.offline { color: var(--danger); }
.chat-header .menu-toggle { padding: 4px 9px; line-height: 1; }
.chat-menu { position: absolute; top: 44px; right: 12px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; padding: 4px; }

body { display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; }

.chat-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.chat-scroll {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 10px;
  padding: 16px; max-width: 720px; width: 100%; margin: 0 auto;
}
.chat-older { align-self: center; color: var(--muted); font-size: 12px; margin: 0 0 4px; }
.chat-offline {
  max-width: 720px; width: 100%; margin: 0 auto; padding: 0 16px 6px;
  color: var(--danger); font-size: 13px;
}
.chat-composer, .chat-error { max-width: 720px; }
```

Then make the assistant's reply stop being a bubble (spec §2):

```css
/* NOT a bubble, unlike the user's message. A reply is allowed a table or a numbered list
   (FORMAT_RULE), and both need the column's full width -- a 78% bubble squeezes exactly the
   output the format rule deliberately permits. */
.bubble.assistant {
  align-self: stretch; max-width: 100%;
  background: none; border: none; border-radius: 0; padding: 10px 2px;
  display: flex; flex-direction: column; gap: 6px;
}
```

Leave `.bubble.user` exactly as it is.

- [ ] **Step 6: Run the suite and look at it**

```bash
pnpm turbo run test --filter=@cortex/web
pnpm --filter @cortex/web dev
```

Ask something that produces a list. Confirm: one centred column; the reply runs full width with no panel behind it; the composer sits at the bottom and grows as you type; the `⋮` menu signs out. Then open devtools, go offline, and confirm the thread is still on screen with the notice above the composer. **Report what you saw — this step has no automated equivalent.**

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/chat-header.tsx apps/web/src/app/layout.tsx \
  apps/web/src/app/assistant-box.tsx apps/web/src/app/assistant-box.test.tsx \
  apps/web/src/app/globals.css
git commit -m "feat(web): one header, one column, and a thread that survives going offline"
```

---

### Task 8: Delete the web browser

Everything the chat made redundant. This is the task that makes the previous five worth doing.

**Files:**
- Delete: the twenty web files listed under "Deleted" in File Structure.
- Modify: `apps/web/src/app/globals.css` — the widget, list and search rules.

**Interfaces:**
- Consumes: nothing. Produces: nothing.

- [ ] **Step 1: Delete the files**

```bash
git rm apps/web/src/app/sidebar.tsx apps/web/src/app/app-shell.tsx \
  apps/web/src/app/note-list.tsx apps/web/src/app/checkin-widget.tsx \
  apps/web/src/app/media-log-form.tsx apps/web/src/app/media-log-panel.tsx \
  apps/web/src/app/export-button.tsx \
  apps/web/src/lib/note-views.ts apps/web/src/lib/note-views.test.ts \
  apps/web/src/lib/checkin.ts apps/web/src/lib/checkin.test.ts \
  apps/web/src/lib/use-debounced-save.ts apps/web/src/lib/use-debounced-save.test.ts
git rm -r apps/web/src/app/search apps/web/src/app/notes
```

- [ ] **Step 2: Prove nothing still reaches them**

```bash
pnpm turbo run typecheck --filter=@cortex/web
grep -rn "note-views\|NoteList\|Sidebar\|AppShell\|CheckinWidget\|MediaLog\|ExportButton" \
  --include=*.ts --include=*.tsx apps/web/src
```

Expected: typecheck clean, grep silent. **A deleted component whose test was deleted with it proves nothing** — this grep is the actual check, and it is why it is a numbered step rather than an assumption.

- [ ] **Step 3: Delete the orphaned CSS**

In `globals.css`, delete the rule blocks for `.checkin*`, `.capture*`, `.media-*`, `nav.views`, `nav.domains`, `form.search`, `ul.notes`, `.chips` / `.chip`, `.editor-bar`, and `a.back`.

**Keep** `.hint`, `.error`, `.empty`, `.status`, `.banner` — the login and auth pages use them, and `assistant-box.tsx` uses `.hint` and `.error`. Check each with a grep before deleting it rather than deleting the block wholesale:

```bash
grep -rn "className=\"hint\"\|className=\"error\|className=\"banner\|className=\"empty\|className=\"status" \
  --include=*.tsx apps/web/src
```

- [ ] **Step 4: Run everything web**

```bash
pnpm turbo run typecheck --filter=@cortex/web
pnpm turbo run test --filter=@cortex/web
pnpm turbo run build --filter=@cortex/web
```

Expected: all PASS. The build is the one that catches a route still importing a deleted module through a path the typecheck happens to tolerate.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): delete the note browser, the search UI and the capture widgets"
```

---

# Part C — mobile

### Task 9: Tokens

Every colour and gap in mobile is a literal at its use site — `#ccc`, `#222`, `#eee`, `#1a73e8`, `padding: 16` — so nothing is consistent and nothing responds to dark mode. Web has had `:root` tokens with a `prefers-color-scheme` block since phase 1a.

**Files:**
- Create: `apps/mobile/src/theme.ts`, `apps/mobile/src/theme.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Theme = { bg: string; panel: string; text: string; muted: string; line: string; accent: string; danger: string }`; `LIGHT: Theme`; `DARK: Theme`; `themeFor(scheme: "light" | "dark" | null | undefined): Theme`. Tasks 11, 12 and 14 read them.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/theme.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DARK, LIGHT, themeFor } from "./theme";

describe("themeFor", () => {
  it("falls back to light when the scheme is unknown", () => {
    // useColorScheme() returns null while the value is being resolved, and on that frame the
    // screen still has to paint. Light is the safe landing: a dark theme flashed over a white
    // system background is the more jarring of the two mistakes.
    expect(themeFor(null)).toBe(LIGHT);
    expect(themeFor(undefined)).toBe(LIGHT);
  });

  it("returns dark for dark", () => {
    expect(themeFor("dark")).toBe(DARK);
  });

  // THE ONE THAT CATCHES A HALF-FINISHED THEME. A missing key reads as `undefined` at the use
  // site, and React Native renders `color: undefined` as inherited black -- invisible in light
  // mode and unreadable in dark. Nothing else would notice.
  it("defines every token in both schemes", () => {
    const keys = ["bg", "panel", "text", "muted", "line", "accent", "danger"] as const;
    for (const k of keys) {
      expect(typeof LIGHT[k], `LIGHT.${k}`).toBe("string");
      expect(typeof DARK[k], `DARK.${k}`).toBe("string");
    }
  });

  it("does not use the same value for text and background", () => {
    expect(LIGHT.text).not.toBe(LIGHT.bg);
    expect(DARK.text).not.toBe(DARK.bg);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile -- theme`
Expected: FAIL — `./theme` does not exist.

- [ ] **Step 3: Write it**

Create `apps/mobile/src/theme.ts`:

```ts
/**
 * Mobile's design tokens, with THE SAME NAMES web uses in globals.css's `:root` block.
 *
 * The two clients cannot share styling code -- React Native has no CSS -- but sharing the
 * vocabulary is what makes it possible to change one and notice the other. The values below are
 * copied from globals.css deliberately, not approximated.
 *
 * This file imports nothing from react-native on purpose: `useColorScheme` is called by the
 * component, and keeping this module pure is what lets it have a test at all (mobile's vitest
 * environment is `node`, and there is no component-test harness).
 */
export interface Theme {
  bg: string; panel: string; text: string; muted: string;
  line: string; accent: string; danger: string;
}

export const LIGHT: Theme = {
  bg: "#fbfbfa", panel: "#ffffff", text: "#1f1f1d", muted: "#6b6b66",
  line: "#e4e4e0", accent: "#3b6ef0", danger: "#b3261e",
};

export const DARK: Theme = {
  bg: "#17171a", panel: "#1f1f23", text: "#ececea", muted: "#9a9a94",
  line: "#32323a", accent: "#7d9dff", danger: "#f2705f",
};

/**
 * `useColorScheme()` returns null while the value is resolving, and the screen still paints on
 * that frame. Light is the safe landing -- a dark theme flashed over a white system background
 * is the more jarring of the two mistakes.
 */
export function themeFor(scheme: "light" | "dark" | null | undefined): Theme {
  return scheme === "dark" ? DARK : LIGHT;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/mobile -- theme`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/theme.ts apps/mobile/src/theme.test.ts
git commit -m "feat(mobile): one token set, sharing web's names"
```

---

### Task 10: The transcript's logic, where it can be tested

Mobile has **no component-test harness** (spec correction 1). The only way this screen gets real coverage is if its logic lives outside it. Everything that decides *what appears* goes here; the screen is left with `View`s and a `FlatList`.

**Files:**
- Create: `apps/mobile/src/lib/transcript.ts`, `apps/mobile/src/lib/transcript.test.ts`

**Interfaces:**
- Consumes: `dayKey`, `daySeparatorLabel` (Task 4).
- Produces:
  - `interface ChatRow { id: string; session_id: string; role: string; content: string; citations: string | null; retrieval_meta: string | null; created_at: string }` — a row as PowerSync returns it (jsonb as a JSON string).
  - `interface LiveTurn { noteId: string; text: string; answer: string; createdAt: string }`
  - `type Item = { kind: "separator"; id: string; label: string } | { kind: "message"; id: string; role: "user" | "assistant"; content: string; incomplete: boolean }`
  - `buildTranscript(rows: ChatRow[], live: LiveTurn | null, now: Date, timeZone: string): Item[]` — oldest first.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/lib/transcript.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTranscript, type ChatRow } from "./transcript";

const tz = "Asia/Ho_Chi_Minh";
const now = new Date("2026-08-22T03:00:00.000Z");

const row = (over: Partial<ChatRow> & { id: string; created_at: string }): ChatRow => ({
  session_id: "s1", role: "user", content: "hi", citations: null, retrieval_meta: null, ...over,
});

describe("buildTranscript", () => {
  it("emits a separator before the first message and at every day change", () => {
    const items = buildTranscript([
      row({ id: "a", created_at: "2026-08-21T02:00:00.000Z" }),
      row({ id: "b", created_at: "2026-08-21T04:00:00.000Z" }),
      row({ id: "c", created_at: "2026-08-22T02:00:00.000Z" }),
    ], null, now, tz);
    expect(items.map((i) => i.kind))
      .toEqual(["separator", "message", "message", "separator", "message"]);
  });

  // THE LIVE TURN, AND WHY IT IS TWO ITEMS. The user's message and the streaming answer are
  // both absent from chat_messages until the server has finished writing them -- so while a
  // turn is in flight the screen has to show a pair that no row exists for yet.
  it("appends the in-flight turn as a user message and an answer", () => {
    const items = buildTranscript([], {
      noteId: "n1", text: "mỏi mắt ăn gì", answer: "Cá hồi.",
      createdAt: "2026-08-22T02:30:00.000Z",
    }, now, tz);
    const messages = items.filter((i) => i.kind === "message");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "mỏi mắt ăn gì" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Cá hồi." });
  });

  // Half a turn. Before the first token arrives there is no answer to show, and rendering an
  // empty assistant row leaves a blank gap under the user's message for the whole silence.
  it("omits the answer half until a token has arrived", () => {
    const items = buildTranscript([], {
      noteId: "n1", text: "hỏi", answer: "", createdAt: "2026-08-22T02:30:00.000Z",
    }, now, tz);
    expect(items.filter((i) => i.kind === "message")).toHaveLength(1);
  });

  // THE DEDUP, and the reason the live turn is keyed on noteId. The replicated rows arrive a
  // second or two after the stream ends; for that window both exist, and without this the user
  // watches their own message appear twice.
  it("drops the live turn once its rows have replicated", () => {
    const items = buildTranscript([
      row({ id: "n1", created_at: "2026-08-22T02:30:00.000Z", content: "mỏi mắt ăn gì" }),
      row({ id: "m1", created_at: "2026-08-22T02:30:05.000Z", role: "assistant", content: "Cá hồi." }),
    ], {
      noteId: "n1", text: "mỏi mắt ăn gì", answer: "Cá hồi.",
      createdAt: "2026-08-22T02:30:00.000Z",
    }, now, tz);
    expect(items.filter((i) => i.kind === "message")).toHaveLength(2);
  });

  it("marks an interrupted answer from retrieval_meta", () => {
    const items = buildTranscript([
      row({ id: "a", created_at: "2026-08-22T02:00:00.000Z", role: "assistant",
            content: "một nửa", retrieval_meta: '{"incomplete":true}' }),
    ], null, now, tz);
    expect(items.find((i) => i.kind === "message")).toMatchObject({ incomplete: true });
  });

  // retrieval_meta is jsonb, and PowerSync hands jsonb over as a STRING. A row written before
  // the column existed reads as null, and a malformed one must not take the transcript with it.
  it("survives a null or malformed retrieval_meta", () => {
    const items = buildTranscript([
      row({ id: "a", created_at: "2026-08-22T02:00:00.000Z", retrieval_meta: null }),
      row({ id: "b", created_at: "2026-08-22T02:01:00.000Z", retrieval_meta: "{not json" }),
    ], null, now, tz);
    expect(items.filter((i) => i.kind === "message")).toHaveLength(2);
    expect(items.filter((i) => i.kind === "message").every((m) => m.incomplete === false)).toBe(true);
  });

  // Every FlatList key comes from here. Two identical keys is a silent render bug in React.
  it("gives every item a unique id", () => {
    const items = buildTranscript([
      row({ id: "a", created_at: "2026-08-21T02:00:00.000Z" }),
      row({ id: "b", created_at: "2026-08-22T02:00:00.000Z" }),
    ], { noteId: "n9", text: "x", answer: "y", createdAt: "2026-08-22T03:00:00.000Z" }, now, tz);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile -- transcript`
Expected: FAIL — `./transcript` does not exist.

- [ ] **Step 3: Write the module**

Create `apps/mobile/src/lib/transcript.ts`:

```ts
import { dayKey, daySeparatorLabel } from "@cortex/shared";

/**
 * A chat_messages row exactly as PowerSync's local view returns it.
 *
 * `citations` and `retrieval_meta` are jsonb in Postgres and arrive here as JSON STRINGS --
 * the same treatment `notes.domain_meta` already gets. Parsing them is this module's job, and
 * doing it here rather than in the screen is what lets the failure modes be tested.
 */
export interface ChatRow {
  id: string; session_id: string; role: string; content: string;
  citations: string | null; retrieval_meta: string | null; created_at: string;
}

/**
 * The turn currently streaming. It exists in no table: the server writes both of its rows, and
 * only after the fact -- so while the answer is arriving the screen has to render a pair that
 * nothing has persisted. Keyed by `noteId` because that is the id the DEVICE generated before
 * the turn started, which is what makes the dedup below possible at all.
 */
export interface LiveTurn {
  noteId: string; text: string; answer: string; createdAt: string;
}

export type Item =
  | { kind: "separator"; id: string; label: string }
  | { kind: "message"; id: string; role: "user" | "assistant"; content: string; incomplete: boolean };

/** Malformed or absent both mean "not interrupted". A parse error must not cost the transcript. */
function isIncomplete(meta: string | null): boolean {
  if (!meta) return false;
  try {
    return (JSON.parse(meta) as { incomplete?: unknown }).incomplete === true;
  } catch {
    return false;
  }
}

/**
 * The rendered list, oldest first, with a day separator before the first message and at every
 * change of local calendar day.
 *
 * The live turn is appended LAST and dropped the moment a replicated row carries its noteId:
 * the server's rows land a second or two after the stream ends, and for that window both exist.
 * Without the drop the user watches their own message appear twice, which reads as a bug in
 * sending rather than in rendering.
 */
export function buildTranscript(
  rows: ChatRow[], live: LiveTurn | null, now: Date, timeZone: string,
): Item[] {
  const items: Item[] = [];
  let lastKey = "";

  for (const row of rows) {
    const key = dayKey(row.created_at, timeZone);
    if (key !== "" && key !== lastKey) {
      items.push({ kind: "separator", id: `sep-${key}`, label: daySeparatorLabel(row.created_at, now, timeZone) });
      lastKey = key;
    }
    items.push({
      kind: "message", id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      incomplete: isIncomplete(row.retrieval_meta),
    });
  }

  if (live && !rows.some((r) => r.id === live.noteId)) {
    const key = dayKey(live.createdAt, timeZone);
    if (key !== "" && key !== lastKey) {
      items.push({ kind: "separator", id: `sep-${key}`, label: daySeparatorLabel(live.createdAt, now, timeZone) });
    }
    items.push({ kind: "message", id: `live-${live.noteId}`, role: "user", content: live.text, incomplete: false });
    // Only once a token has arrived. An empty assistant row is a blank gap held open for the
    // whole silence, and the composer's own spinner already says a turn is in flight.
    if (live.answer !== "") {
      items.push({ kind: "message", id: `live-answer-${live.noteId}`, role: "assistant", content: live.answer, incomplete: false });
    }
  }

  return items;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/mobile -- transcript`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/transcript.ts apps/mobile/src/lib/transcript.test.ts
git commit -m "feat(mobile): build the transcript in a module a test can reach"
```

---

### Task 11: The connection pill

`ExportButton`'s label was the plainest UI proof that PowerSync's download stream was alive; `02-online-basics.yaml` says so in its header comment and keys on it. Export is gone, so the proof has to be rebuilt — and it has to be rebuilt **before** the screen, because the screen renders it.

**Files:**
- Create: `apps/mobile/src/components/connection-pill.tsx`

**Interfaces:**
- Consumes: `themeFor` (Task 9), `useStatus` from `@powersync/react-native`.
- Produces: `<ConnectionPill />`, taking no props. Renders `testID="conn-status"` **always**, with text `Trực tuyến` or `Ngoại tuyến`. Task 12 mounts it; Task 15's flows assert on it.

- [ ] **Step 1: Write it**

```tsx
import { useStatus } from "@powersync/react-native";
import { useColorScheme, Text, View } from "react-native";

import { themeFor } from "../theme";

/**
 * Whether the download stream is alive, said out loud.
 *
 * Two jobs, and the second is the load-bearing one. For the user: in an app that is nothing but
 * a chat box, "you are offline, this reply came from your own notes" is the honest frame for
 * what offline-answer.ts produces. For the suite: ExportButton's label used to be the only UI
 * proof PowerSync was connected (02-online-basics.yaml keys on it), and export went with the
 * note browser.
 *
 * ALWAYS rendered, never conditionally, and with BOTH states carrying the same testID. A pill
 * that only exists when offline cannot be told apart from a screen that has not mounted yet --
 * an assertion against it would pass on a broken app.
 */
export function ConnectionPill() {
  const theme = themeFor(useColorScheme());
  const connected = useStatus().connected;
  return (
    <View style={{ alignItems: "center", paddingTop: 6 }}>
      <Text
        testID="conn-status"
        style={{ fontSize: 12, color: connected ? theme.muted : theme.danger }}
      >
        {connected ? "Trực tuyến" : "Ngoại tuyến"}
      </Text>
    </View>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm turbo run typecheck --filter=@cortex/mobile`
Expected: PASS. Nothing renders it yet — Task 12 does — so this is a compile check only. Device verification comes with Task 12, when there is a screen to see it on.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/components/connection-pill.tsx
git commit -m "feat(mobile): say whether the sync stream is alive"
```

---

### Task 12: The mobile chat screen

`app/index.tsx` renders `NoteList` with the assistant box as its **list header**. That is why the screen is ugly and why C4's own e2e notes complain that the header is taller than the viewport: the chat is a decoration on top of a note list. This inverts it — the chat is the screen, and the list is gone.

**Files:**
- Create: `apps/mobile/src/screens/chat.tsx`
- Modify: `apps/mobile/app/index.tsx`, `apps/mobile/src/screens/assistant-box.tsx`
- Delete: `screens/note-list.tsx`, `screens/note-editor.tsx`, `screens/export-button.tsx`, `app/notes/[id].tsx`, `lib/export.ts`, `lib/export.test.ts`, `lib/note-edits.ts`, `lib/edit-base.ts`, `lib/edit-base.test.ts`

**Interfaces:**
- Consumes: `buildTranscript`, `LiveTurn`, `Item` (Task 10); `themeFor` (Task 9); `<ConnectionPill />` (Task 11).
- Produces: `<Chat />`, taking no props. Keeps the testIDs Maestro depends on: `box-input`, `box-send`, `box-answer`, `box-status`, `box-offline-match`, `box-attached`, `box-mood`, `box-mood-undo`, `box-web-sources`, `box-web-chips`.

- [ ] **Step 1: Split the box in two**

`assistant-box.tsx` keeps everything about *running a turn* — `submit()`, the capture, the SSE loop, the mood mirror, the offline answer — and stops rendering the answer, because the transcript renders it now. Change its signature so the screen owns the live state:

```tsx
export function AssistantBox({ onLive }: { onLive: (live: LiveTurn | null) => void }) {
```

Call `onLive({ noteId: id, text: asked, answer: "", createdAt })` immediately after the local insert succeeds, update it on every `token` event, and call `onLive(null)` in the `finally`. **Do not** clear it before the replicated rows arrive — `buildTranscript`'s dedup handles the overlap, and clearing early makes the turn flicker out and back in.

Delete from its render: the `{answer ? <Text testID="box-answer">…}` line and the `matches.map(...)` block. Keep `box-status`, `box-attached`, `box-mood`, `box-mood-undo`, and both web blocks — the Google grounding entry point is a terms-of-service obligation (C3 §7.2), not a design choice, and it stays exactly where it is.

`box-answer` and `box-offline-match` move to the transcript in Step 2. **Both testIDs must still exist somewhere** or Maestro cannot tell a missing answer from a broken flow.

- [ ] **Step 2: Write the screen**

Create `apps/mobile/src/screens/chat.tsx`:

```tsx
import { useQuery } from "@powersync/react-native";
import { useColorScheme } from "react-native";
import { useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Text, View } from "react-native";

import { AssistantBox } from "./assistant-box";
import { ConnectionPill } from "../components/connection-pill";
import { buildTranscript, type ChatRow, type Item, type LiveTurn } from "../lib/transcript";
import { themeFor } from "../theme";

/**
 * The whole app. Until 2026-08-22 this screen was a note list with the chat box wedged in as
 * its ListHeaderComponent -- which is why every Maestro flow had to scroll past a header taller
 * than the viewport to reach anything.
 *
 * `inverted`, so the newest message sits at the bottom without measuring anything: FlatList
 * renders an inverted list from the bottom up, which is also what makes "load more when you
 * reach the top" fall out of `onEndReached` rather than needing a scroll listener. The data is
 * therefore passed NEWEST FIRST here, while buildTranscript returns oldest first -- reversed
 * once, at the boundary, with the reason written down.
 */
const PAGE = 50;

export function Chat() {
  const theme = themeFor(useColorScheme());
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [limit, setLimit] = useState(PAGE);

  // Reactive: a replicated row re-renders this by itself, which is what retires the live turn
  // when the server's copies land. DESC to take the NEWEST `limit` rows -- ASC with a LIMIT
  // would pin the screen to the oldest conversation the user ever had.
  const { data: rows = [] } = useQuery<ChatRow>(
    `SELECT id, session_id, role, content, citations, retrieval_meta, created_at
     FROM chat_messages ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );

  const items = useMemo(
    () => buildTranscript([...rows].reverse(), live, new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone),
    [rows, live],
  );
  const inverted = useMemo(() => [...items].reverse(), [items]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ConnectionPill />
      <FlatList
        inverted
        data={inverted}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        // Inverted, so "the end" is the TOP of the thread. 0.5 rather than 0.1: the rows are
        // tall and a tighter threshold fires only after the user has already hit the ceiling.
        onEndReachedThreshold={0.5}
        onEndReached={() => setLimit((n) => (rows.length >= n ? n + PAGE : n))}
        ListEmptyComponent={
          <Text style={{ color: theme.muted, textAlign: "center", paddingVertical: 40 }}>
            Bạn đang nghĩ gì?
          </Text>
        }
        renderItem={({ item }) => <Row item={item} />}
      />
      <AssistantBox onLive={setLive} />
    </KeyboardAvoidingView>
  );
}

function Row({ item }: { item: Item }) {
  const theme = themeFor(useColorScheme());
  if (item.kind === "separator") {
    return (
      <Text style={{ alignSelf: "center", color: theme.muted, fontSize: 12 }}>{item.label}</Text>
    );
  }
  if (item.role === "user") {
    return (
      <View style={{
        alignSelf: "flex-end", maxWidth: "82%", backgroundColor: theme.accent,
        borderRadius: 16, borderBottomRightRadius: 4, paddingVertical: 10, paddingHorizontal: 14,
      }}>
        <Text style={{ color: "#fff" }}>{item.content}</Text>
      </View>
    );
  }
  // No bubble, full width -- same reasoning as web: a reply may be a list or a table, and both
  // need the width FORMAT_RULE assumes they have.
  return (
    <View style={{ alignSelf: "stretch" }}>
      <Text testID="box-answer" style={{ color: theme.text }}>{item.content}</Text>
      {item.incomplete ? (
        <Text style={{ color: theme.muted, fontStyle: "italic", fontSize: 12 }}>
          Câu trả lời bị gián đoạn.
        </Text>
      ) : null}
    </View>
  );
}
```

`box-offline-match` has no home in the transcript — an offline answer is not a `chat_messages` row. Keep it in `assistant-box.tsx`, rendering the local matches below the composer exactly as it does now. Maestro `04a` step 8 keys on `box-status`, and the match rows are what make that status meaningful.

- [ ] **Step 3: Point the route at it**

In `apps/mobile/app/index.tsx`, replace the whole signed-in branch with `<Chat />`, and move sign-out into the header. Read the file first: the signed-out branch, the in-flight guard and the sign-out error handling all stay exactly as they are — `signOut` wipes local data before calling Supabase and re-raises if the wipe failed, and that reporting must not be lost.

Sign-out goes in the expo-router header rather than into an invented menu — the header is the only chrome left, matching web's `⋮`. `handleSignOut` and its error reporting stay in `index.tsx`, so the header renders a button that calls a handler passed down through `Stack.Screen`'s options:

```tsx
  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: "Cortex",
          headerRight: () => (
            <Pressable
              onPress={() => void handleSignOut()}
              disabled={loading}
              accessibilityRole="button"
              testID="sign-out"
              style={{ paddingHorizontal: 12, opacity: loading ? 0.5 : 1 }}
            >
              <Text>Đăng xuất</Text>
            </Pressable>
          ),
        }}
      />
      <Chat />
      {error ? <Text style={{ color: "crimson", padding: 12 }}>{error}</Text> : null}
    </>
  );
```

`error` still renders, and that matters: `signOut` wipes local data **before** calling Supabase and re-raises if the wipe did not finish. Fired and forgotten, a failed wipe leaves the user signed in with their notes still on the device — the exact outcome the wipe exists to prevent, presented as a button that did nothing.

- [ ] **Step 4: Delete the browser**

```bash
git rm apps/mobile/src/screens/note-list.tsx apps/mobile/src/screens/note-editor.tsx \
  apps/mobile/src/screens/export-button.tsx apps/mobile/app/notes/\[id\].tsx \
  apps/mobile/src/lib/export.ts apps/mobile/src/lib/export.test.ts \
  apps/mobile/src/lib/note-edits.ts apps/mobile/src/lib/edit-base.ts \
  apps/mobile/src/lib/edit-base.test.ts
```

**Do not touch `connector.ts` or `note_edit_base`.** The connector queries that table directly in `uploadData`; with no editor left the query returns nothing, which is harmless. Editing the upload path to delete a dead branch risks the one path that must never break — how a note captured offline reaches the server.

**Do not delete `lib/fts.ts` or `lib/semantic-search.ts`.** `offline-answer.ts` calls them, and that is now the only thing between the user and a dead app with no signal.

- [ ] **Step 5: Prove nothing still reaches them**

```bash
pnpm turbo run typecheck --filter=@cortex/mobile
grep -rn "note-list\|NoteList\|note-editor\|ExportButton\|note-edits\|edit-base" \
  --include=*.ts --include=*.tsx apps/mobile/src apps/mobile/app
```

Expected: typecheck clean; grep matches only `connector.ts`'s raw SQL string for `note_edit_base`.

- [ ] **Step 6: Run the mobile gates**

```bash
pnpm turbo run test --filter=@cortex/mobile
pnpm turbo run bundle --filter=@cortex/mobile
```

Expected: PASS. `bundle` is the one that catches a route importing a deleted screen — the typecheck can miss it through expo-router's file-based resolution.

- [ ] **Step 7: Run it on a device**

```bash
pnpm --filter @cortex/mobile android
```

Send two messages. Confirm: both appear as bubbles, the answer streams in below, the previous exchange is **still on screen** (the thing mobile could never do before), the composer stays above the keyboard, and a day separator appears at the top. Force-quit and reopen with the network off — the thread must still be there. **That last check is the whole point of Task 2; report it explicitly.**

Then verify Task 11's pill in **both** directions, which is the first chance to:

```bash
adb shell svc wifi disable && adb shell svc data disable
```

It must flip to `Ngoại tuyến` within a few seconds; turn the radios back on and it must flip back to `Trực tuyến`. **Report both directions** — a pill stuck on one value passes a one-sided check and makes every flow in Task 15 meaningless.

- [ ] **Step 8: Commit**

```bash
git add -A apps/mobile
git commit -m "feat(mobile): the chat is the screen, and it remembers"
```

---

### Task 13: Mobile markdown — the spike

**This task's deliverable is an answer, not code.** It was written into the previous stage's plan and never run: PR #24 touched no mobile file, `apps/mobile/package.json` has no markdown dependency, and `**Cá hồi**` still reaches the user as two literal asterisks.

The original `react-native-markdown-display` has not been published since 2023-12-11. The maintained fork `@ronradtke/react-native-markdown-display@9.0.3` was last published 2026-06-29. Its peer range (`react-native >=0.50.4`, `react >=16.2.0`) proves npm will install it and **nothing else** — not that it runs on RN 0.86 / React 19.2 / Expo 57.

Do not skip to Task 14. If this fails, Task 14 is cancelled, mobile keeps plain text, and the stage still closes.

- [ ] **Step 1: Install**

```bash
pnpm --filter @cortex/mobile add @ronradtke/react-native-markdown-display@^9.0.3
```

Record any peer warning verbatim. A warning is not a failure — it is the thing to check at runtime.

- [ ] **Step 2: Render a hardcoded string in the real app**

In `apps/mobile/src/screens/chat.tsx`'s `Row`, temporarily replace the assistant branch's `<Text testID="box-answer">{item.content}</Text>` with:

```tsx
      <View testID="box-answer">
        <Markdown>{"**đậm** và:\n\n- một\n- hai\n\n[link](https://example.com)"}</Markdown>
      </View>
```

and `import Markdown from "@ronradtke/react-native-markdown-display";` at the top. A hardcoded string, not `item.content`: this step is testing the library, and real model output would make a rendering bug and a content problem look identical.

- [ ] **Step 3: Run it on a device**

```bash
pnpm --filter @cortex/mobile android
```

Send a message so an assistant row exists. Check three things and write down which fail:
1. The app does not redbox on render.
2. Bold shows as bold, and the two list items appear as two rows.
3. Metro logs no `react-native-renderer` or `useSyncExternalStore` warning about an incompatible React version.

- [ ] **Step 4: Check the suite and the bundle**

```bash
pnpm turbo run typecheck --filter=@cortex/mobile
pnpm turbo run test --filter=@cortex/mobile
pnpm turbo run bundle --filter=@cortex/mobile
```

The mobile suite runs under Vitest in `node`, not on a device. A library reaching for a native module at import time breaks the suite even when the device render worked — that is a real failure and it blocks Task 14 exactly as much as a redbox does.

- [ ] **Step 5: Revert the probe and record the verdict**

```bash
git checkout apps/mobile/src/screens/chat.tsx
```

**If all four steps passed:** keep the dependency, commit it alone, proceed to Task 14.

```bash
git add apps/mobile/package.json pnpm-lock.yaml
git commit -m "chore(mobile): add markdown renderer, verified on RN 0.86 / React 19.2"
```

**If anything failed:** remove it and stop.

```bash
pnpm --filter @cortex/mobile remove @ronradtke/react-native-markdown-display
git checkout apps/mobile/package.json pnpm-lock.yaml
```

Report exactly what failed, **skip Task 14, and go to Task 15.** Do not substitute another library, hand-roll a renderer, or work around a native-module error — the spec's out-of-scope list names all three.

---

### Task 14: Markdown on mobile

**Gated on Task 13 passing.** If it did not, skip to Task 15.

**Files:**
- Create: `apps/mobile/src/components/markdown.tsx`
- Modify: `apps/mobile/src/screens/chat.tsx`

**Interfaces:**
- Consumes: `@ronradtke/react-native-markdown-display` (Task 13), `themeFor` (Task 9).
- Produces: `<Markdown testID?>{string}</Markdown>` — the same one-prop shape as `apps/web/src/app/markdown.tsx`, so the two call sites read alike.

- [ ] **Step 1: Write the component**

```tsx
import { useColorScheme, View } from "react-native";
import MarkdownDisplay from "@ronradtke/react-native-markdown-display";

import { themeFor } from "../theme";

/**
 * Mobile's markdown renderer, deliberately given the same one-prop shape as
 * apps/web/src/app/markdown.tsx. The libraries underneath are unrelated -- React Native has no
 * DOM, so react-markdown cannot be shared -- and that is exactly why the seam is worth keeping
 * identical.
 *
 * `testID` is threaded rather than hardcoded: `box-answer` is what the Maestro flows key on, and
 * a flow that cannot find the answer is indistinguishable from an answer that never arrived.
 *
 * No raw HTML, matching web's deliberate omission of rehype-raw. On both clients the safety is
 * the ABSENCE of a plugin rather than the presence of a sanitiser, and this string is model
 * output.
 */
export function Markdown({ children, testID }: { children: string; testID?: string }) {
  const theme = themeFor(useColorScheme());
  return (
    <View testID={testID}>
      <MarkdownDisplay style={{
        body: { color: theme.text },
        // Deliberately small, matching globals.css: a reply is a chat message, not a document.
        heading1: { fontSize: 16, fontWeight: "600" },
        heading2: { fontSize: 16, fontWeight: "600" },
        heading3: { fontSize: 16, fontWeight: "600" },
        link: { color: theme.accent },
        code_inline: { backgroundColor: theme.panel },
        fence: { backgroundColor: theme.panel },
      }}>
        {children}
      </MarkdownDisplay>
    </View>
  );
}
```

- [ ] **Step 2: Wire the transcript row**

In `chat.tsx`'s `Row`, the assistant branch becomes:

```tsx
      <Markdown testID="box-answer">{item.content}</Markdown>
```

The user branch stays a plain `<Text>`: that is the user's own typing, and running it through a markdown renderer would reinterpret an asterisk they meant literally.

- [ ] **Step 3: Verify on a device**

Ask something that produces a list. Confirm no literal `**` or `#` on screen, the list renders as rows, and a link opens. Report what you saw.

- [ ] **Step 4: Run the gates and commit**

```bash
pnpm turbo run test --filter=@cortex/mobile
pnpm turbo run bundle --filter=@cortex/mobile
git add apps/mobile/src/components/markdown.tsx apps/mobile/src/screens/chat.tsx
git commit -m "feat(mobile): render assistant replies as markdown"
```

---

# Part D — the suites, and the close

### Task 15: Move the e2e coverage onto the surfaces that still exist

**The largest task here, and the one most likely to be under-scoped.** `02`, `03`, `04a` and `04b` assert almost exclusively through the note list, the `search-input` box, the note editor, the view chips and the export button. All five are gone.

**The failure mode to avoid is a suite that stays green while asserting nothing.** Deleting a flow is an honest outcome; quietly weakening one until it passes is not.

**The mobile e2e suite is red from Task 12 until this task lands.** That is expected and is why they are adjacent — do not "fix" it in between by restoring a screen.

**Files:**
- Modify: `.maestro/02-online-basics.yaml`, `.maestro/03-server-to-device.yaml`, `.maestro/04a-offline-actions.yaml`, `.maestro/04b-reconnect-verify.yaml`, `.maestro/subflows/scroll-to-top.yaml`
- Create: `.maestro/scripts/server-seed-chat-message.js`
- Modify/Delete: `apps/web/e2e/*.spec.ts`

- [ ] **Step 1: Rewrite `02-online-basics.yaml`**

Replace the export-label check with the pill, and the list/search/view assertions with transcript ones:

```yaml
# ---- connected=true, stated in the UI ----
# Was "Export all notes" vs "Export needs a connection". Export went with the note browser;
# ConnectionPill is its replacement and carries the same meaning (useStatus().connected).
- extendedWaitUntil:
    visible:
      id: "conn-status"
    timeout: 60000
- assertVisible: "Trực tuyến"

# ---- capture a note, it appears immediately as a bubble ----
# No network involved: capture is one local INSERT, and the live turn renders from component
# state -- so the user's own message must appear with no wait at all.
- tapOn:
    id: "box-input"
- inputText: "vorpal blade went snicker snack"
- tapOn:
    id: "box-send"
- assertVisible:
    id: "box-input"
    text: "Bạn đang nghĩ gì?"
- assertVisible: "vorpal blade went snicker snack"
# The online half always resolves to the degraded path in CI: e2e-mobile.yml pins
# GEMINI_API_KEY to a dummy on purpose, so extractNote/generateStream fail deterministically.
# Assert that capture survives the AI failing, not that the AI succeeded.
- extendedWaitUntil:
    visible:
      id: "box-status"
    timeout: 30000
```

**Delete** the search section, the view-switching section, and both "not exercised here" trailer comments about mood and media — they described gaps in a screen that no longer exists. Delete `subflows/scroll-to-top.yaml` and every `runFlow` referencing it: it existed because the list header was taller than the viewport, and there is no list header any more.

- [ ] **Step 2: Rewrite `03-server-to-device.yaml`**

The whole flow becomes one assertion: **a row written on the server appears on the device by itself.** That is the property the old flow proved through the note list, and it is the only one this stage's UI can still observe.

Create `.maestro/scripts/server-seed-chat-message.js`, modelled on the existing `scripts/server-edit-note.js` (read it and follow its auth and client setup exactly). It inserts a `chat_sessions` row and a `chat_messages` row for the test user with content taken from an env var.

```yaml
# Server->device replication, asserted through the transcript.
#
# This used to be proved by editing a note on the server and watching the note LIST update.
# The list is gone (S1 §1), and chat_messages now replicates (S1 §4) -- so the same property is
# asserted one table over. If this times out, check the powersync container before the app: a
# dead download stream looks exactly like a broken screen from here.
- runScript:
    file: scripts/server-seed-chat-message.js
    env:
      CONTENT: "REPLICATEDFROMSERVER"

# It has to arrive on its own. No pull-to-refresh, no relaunch: useQuery is reactive, and
# needing a nudge here would itself be the bug.
- extendedWaitUntil:
    visible: "REPLICATEDFROMSERVER"
    timeout: 90000

# And it must survive a relaunch -- i.e. it reached local SQLite rather than a component's state.
- launchApp:
    clearState: false
- runFlow:
    when:
      visible: "DEVELOPMENT SERVERS"
    file: subflows/dismiss-dev-launcher.yaml
- extendedWaitUntil:
    visible: "REPLICATEDFROMSERVER"
    timeout: 60000
```

Delete the note-edit, FTS-staleness and purge sections. The purge case asserted a **hard delete** propagating; nothing in the chat UI can observe that any more, and `scripts/assert-offline-results.js` is where a countable version of it belongs if it is wanted back.

- [ ] **Step 3: Rewrite `04a-offline-actions.yaml`**

Keep three of its eight sections and delete the rest:

```yaml
# ---- 9. the pill goes offline ----
# The negative half of 02's assertion. If this still says "Trực tuyến", either the radios did
# not go down or PowerSync has not noticed, and nothing below means anything.
- extendedWaitUntil:
    visible: "Ngoại tuyến"
    timeout: 60000

# ---- 1. capture offline ----
- tapOn:
    id: "box-input"
- inputText: ${CAPTURE_MARKER}
- tapOn:
    id: "box-send"
- assertVisible:
    id: "box-input"
    text: "Bạn đang nghĩ gì?"
- assertVisible: ${CAPTURE_MARKER}

# ---- 5. double-tap Send ----
# The in-flight guard has to collapse this to ONE note; `disabled={busy}` cannot, because state
# updates are async and two taps in one frame both read busy === false. Counted server-side in
# 04b by assert-offline-results.js; this only creates the condition.
- tapOn:
    id: "box-input"
- inputText: ${DOUBLE_TAP_MARKER}
- doubleTapOn:
    id: "box-send"

# ---- 8. offline, the box answers from the local index ----
# THE ONE THAT NOW CARRIES THE MOST WEIGHT. With no note list, this is the only remaining proof
# that notes actually reached local SQLite: offlineAnswer() reads the device's own FTS index,
# so a hit here cannot come from the network.
- tapOn:
    id: "box-input"
- inputText: "định giá"
- tapOn:
    id: "box-send"
- extendedWaitUntil:
    visible:
      id: "box-status"
    timeout: 5000
- assertVisible:
    id: "box-offline-match"
```

Delete the export section, the trash section, the trash-and-restore section, the type-fast-and-leave section, the apostrophe/FTS section and **the entire conflict run**. The conflict run cannot be staged at all: it needs a device-side edit of an existing note, and there is no editor.

Add a comment at the top of the file recording what left and why, so the next reader does not think it was lost by accident:

```yaml
# Retired on 2026-08-22 with the screens that made them possible: offline trash/restore, the
# editor's debounce, the FTS5 apostrophe case, and the conflict run. The conflict run is not
# merely unasserted -- with no note editor, no device-side edit exists to conflict WITH, so the
# scenario cannot be constructed. notes/service.ts's server-side resolution keeps its unit
# tests. The apostrophe case keeps lib/fts.ts's.
```

- [ ] **Step 4: Rewrite `04b-reconnect-verify.yaml`**

```yaml
# Nothing below means anything until the device says it is connected again. Generous: a cold
# reconnect has to re-establish the stream AND drain the queue 04a filled.
- extendedWaitUntil:
    visible: "Trực tuyến"
    timeout: 180000

# ---- 1. the offline capture survived the round trip ----
- extendedWaitUntil:
    visible: ${CAPTURE_MARKER}
    timeout: 60000

# ---- everything that can only be counted ----
- runScript:
    file: scripts/assert-offline-results.js
```

Delete the two conflict searches and the trash-view section. Then **read `scripts/assert-offline-results.js`** and remove any assertion about the trashed note or the conflict copy — it is a host-side script and will otherwise fail against conditions 04a no longer creates. Keep the double-tap count; that one still holds and is now the only place it is checked.

- [ ] **Step 5: Prune and extend Playwright**

```bash
git rm apps/web/e2e/search-filter.spec.ts apps/web/e2e/edit-persist.spec.ts \
  apps/web/e2e/checkin-media.spec.ts
```

In `apps/web/e2e/capture.spec.ts`, keep "a captured note reaches the corpus" and "a failed capture keeps the text and offers a retry"; rewrite the first so it asserts the user's bubble appears in the transcript rather than a row in the list. Delete "the open page learns about the capture without a reload" — it asserted the Realtime-driven note list. Rewrite "capture is disabled with no connection" against the new offline notice from Task 7 instead of the removed banner.

In `apps/web/e2e/assistant-box.spec.ts`, keep all three tests and add one:

```ts
import { createClient } from "@supabase/supabase-js";

/**
 * 35 messages, and the count is the test. PAGE_SIZE is 30, so a seed of 12 would sit entirely
 * inside the first page and the assertion below would pass with pagination deleted -- the
 * "test that cannot fail" this repo has shipped before. 35 puts OLDESTMESSAGE strictly on the
 * second page, reachable only by scrolling.
 */
test("scrolling to the top loads older messages", async ({ page }) => {
  const admin = createClient(
    process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const userId = process.env.E2E_USER_ID!;
  const { data: session } = await admin
    .from("chat_sessions").insert({ user_id: userId }).select("id").single();

  const base = Date.parse("2026-08-01T00:00:00.000Z");
  await admin.from("chat_messages").insert(
    Array.from({ length: 35 }, (_, i) => ({
      user_id: userId, session_id: session!.id, role: "user",
      content: i === 0 ? "OLDESTMESSAGE" : `seeded ${i}`,
      created_at: new Date(base + i * 60_000).toISOString(),
    })),
  );

  await page.goto("/");
  await expect(page.getByText("seeded 34")).toBeVisible();
  await expect(page.getByText("OLDESTMESSAGE")).toHaveCount(0);

  await page.locator(".chat-scroll").evaluate((el) => { el.scrollTop = 0; });
  await expect(page.getByText("OLDESTMESSAGE")).toBeVisible({ timeout: 15000 });
});
```

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and the test user's id are already available to this suite — read `global-setup.ts` for the exact names it uses and match them rather than inventing new ones. If the user id is not currently exported, export it there; `global-setup.ts`'s own comment records that the specs are meant to be self-contained rather than depending on the workflow for extra variables.

- [ ] **Step 6: Run both suites**

```bash
pnpm --filter @cortex/web test:e2e
bash e2e/scripts/run-maestro.sh
```

Expected: PASS. Report the flow-by-flow output, not a summary — a Maestro flow that passes because every assertion was deleted looks identical to one that passes.

- [ ] **Step 7: Commit**

```bash
git add -A .maestro apps/web/e2e e2e/scripts
git commit -m "test(e2e): assert through the chat, and retire what the deleted screens proved"
```

---

### Task 16: Close the stage

- [ ] **Step 1: Full gate, uncached**

```bash
pnpm turbo run typecheck --force
pnpm turbo run test --force
pnpm turbo run build --filter=@cortex/web --force
pnpm turbo run bundle --filter=@cortex/mobile --force
```

Read the `Cached:` line in every summary. **A cached run is not a run** — with Docker down the database-backed suites replay a previous green without executing, and `26/26 successful` has already meant 23 replays in this repo before.

- [ ] **Step 2: Verify CI needs no change**

```bash
grep -n "filter=@cortex" .github/workflows/ci.yml
```

Every test this plan added lives in `@cortex/shared`, `@cortex/sync`, `@cortex/db`, `@cortex/web` or `@cortex/mobile`, all of which the `checks` job already names. Confirm that is still true; if any new suite landed in a package not listed, add the step now — an unnamed suite runs nowhere but this machine.

- [ ] **Step 3: The manual checks the suite cannot make**

Nothing in the suite proves the new shell looks good, and no test asserts a screen is not ugly. Run both clients and report, in words:

1. Web: one centred column, the reply full-width with no panel, the composer growing as you type, `⋮` signing out.
2. Web offline: the thread stays on screen, the notice sits above the composer, Send is disabled.
3. Mobile: two exchanges both visible at once, the composer above the keyboard, day separator at the top, `Trực tuyến` in the header.
4. Mobile, force-quit and reopened with no network: **the thread is still there.** This is the single property Task 2 exists for.
5. If Task 14 shipped: a reply containing a list renders as a list, with no literal `**` anywhere.

- [ ] **Step 4: Apply the migration to the hosted project**

```bash
pnpm supabase db push
```

**No `--local`, deliberately, and this is the one command in this plan that touches production.** Without it, `chat_messages` is not in the hosted `powersync` publication and the deployed mobile app shows an empty thread while every local test is green. Confirm afterwards that the hosted publication lists the table before reporting the stage done.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A
git commit -m "chore: close stage S1"
```

---

## What this plan does not deliver

Stated so the next stage inherits it as a decision rather than discovering it as a gap.

- **There is no way to delete or retract a note**, from the moment this merges until S4 ships. Spec §9.1 and §10. This is the largest known cost of the stage.
- **A turn taken offline still leaves no trace in the transcript.** The server writes `chat_messages` and offline there is no server. Spec §9.3.
- **Notes the assistant saved on its own are invisible.** Spec §9.2.
- **Web's UI copy is now mixed English and Vietnamese.** The strings this plan adds are Vietnamese, matching mobile and the user's own language; the ones it inherits (`What are you thinking?`, `Send`, `Couldn't save — your text is still here.`) are English. Neither is wrong on its own and the mixture is. A copy pass is worth one small task in a later stage; it was not folded in here because it would have touched every assertion in `assistant-box.test.tsx` at the same time as the behaviour changes did.
- **The conflict-copy scenario has no end-to-end coverage.** It is not unasserted by oversight — with no note editor there is no device-side edit to conflict with. `notes/service.ts` keeps its unit tests. Task 15, step 3.
- **A hard server-side delete propagating to the device is no longer asserted.** The old `03` proved it through the note list. A countable version belongs in `assert-offline-results.js` if it is wanted back.
- **Mobile markdown may not have shipped.** If Task 13's spike failed, Task 14 was skipped and mobile still renders plain text. A recorded outcome, not an oversight.
- **`search_notes` still returns no `source_type`**, so a note the assistant saved is cited exactly like the user's own thinking. Inherited unchanged from the previous stage; it belongs to the retrieval path and was deliberately kept out of a UI stage.
- **Nothing proves the shell looks good.** Task 16 step 3 is a person's judgement, and the plan says so rather than implying the suite covers it.
