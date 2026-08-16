# Stage C2 — the box on mobile: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mobile's three capture widgets with one assistant box that saves locally first, streams an answer when online, answers from the local FTS5 index when offline, and lets the AI write the check-in and media rows the user used to fill in by hand.

**Architecture:** The note is written to local SQLite under a client-generated uuid *before* any network call, so every downstream failure costs the answer and never the text. `POST /assistant` gains get-or-create so it can answer about a note PowerSync has not uploaded yet; `NoteService.createWithId` is create-if-absent, so the upload that arrives later cannot clobber what the turn enriched. Mood and media identity move into the extraction step: the model emits them, the server writes them, and the client mirrors the check-in row locally so Undo has something to delete.

**Tech Stack:** Expo SDK 57 / RN 0.86 / React 19 (Android only), PowerSync + op-sqlite + SQLCipher + FTS5, NestJS, Supabase Postgres + pgvector, Gemini (`gemini-embedding-001`, `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview`), vitest, Maestro.

**Spec:** `docs/superpowers/specs/2026-08-15-stage-c2-mobile-box-design.md`

## Global Constraints

- **Logic never lives in a `.tsx`.** The mobile vitest project is `environment: node`; any module that reaches React Native dies as a Rollup Flow parse error. Anything that can be wrong goes in `src/lib/`.
- **Gates run through turbo**: `pnpm turbo run test --filter=<pkg>`, never `pnpm --filter <pkg> test` — `shared` and `core` resolve as compiled `dist/`. Read the `Cached:` line before believing a pass; with Docker down, "26/26 successful" has been 23 replays. Use `--force` when in doubt.
- **`@cortex/db`, `@cortex/api` and `@cortex/core` tests need the local Supabase stack up.** `apps/api/.env` must never be printed, in whole or in part.
- **No CI workflow changes are needed.** `.github/workflows/ci.yml` already has per-package steps for `@cortex/shared`, `@cortex/sync`, `@cortex/mobile`, `@cortex/web`, `@cortex/db`, `@cortex/api` and `@cortex/core`. New *suites* inside those packages are picked up automatically; only a new *package* would need a step. (The spec's §9 says "every new suite must be named in `ci.yml`" — that is the rule for new packages, and it was over-stated. Nothing in this plan adds a package.)
- **The repo is `core.autocrlf=true`.** Use Edit/Write, never shell rewrites, and pass commit messages via heredoc.
- **Every test must be able to fail.** Before committing one, name the one-line implementation change that turns it red. If you cannot, the test is decoration.
- Vietnamese is the primary corpus language. Copy that a user reads is Vietnamese; identifiers, comments and log lines are English.

---

### Task 1: Prove `expo/fetch` streams on a real Android build

The whole online branch assumes SSE arrives incrementally on device. Expo Go cannot answer this — it needs a development build. Learning the answer now costs one APK; learning it at Task 6 costs the shape of the contract.

**Files:**
- Create: `apps/mobile/src/lib/assistant/SPIKE.md` (deleted in Task 6, its finding moved into the spec)
- Modify: `docs/superpowers/specs/2026-08-15-stage-c2-mobile-box-design.md` (record the outcome in §8)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded yes/no that Task 6 depends on. No code ships from this task.

- [ ] **Step 1: Add a temporary throwaway screen that streams and counts**

Put this in `apps/mobile/app/spike.tsx` so expo-router serves it at `/spike`:

```tsx
import { fetch as expoFetch } from "expo/fetch";
import { useState } from "react";
import { Button, Text, View } from "react-native";
import { supabase } from "@/lib/supabase";

export default function Spike() {
  const [log, setLog] = useState("idle");

  async function go() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return setLog("not signed in");
    const started = Date.now();
    const res = await expoFetch(`${process.env.EXPO_PUBLIC_API_URL}/assistant`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      // Any note id that exists on the server. Paste one in before building.
      body: JSON.stringify({ noteId: "PASTE_A_REAL_NOTE_ID" }),
    });
    if (!res.body) return setLog("no body — streaming is unavailable");
    const reader = res.body.getReader();
    let chunks = 0;
    let firstAt = 0;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      chunks += 1;
      if (chunks === 1) firstAt = Date.now() - started;
    }
    setLog(`chunks=${chunks} firstChunkMs=${firstAt} totalMs=${Date.now() - started}`);
  }

  return (
    <View style={{ flex: 1, justifyContent: "center", gap: 16, padding: 24 }}>
      <Button title="stream" onPress={() => void go()} />
      <Text testID="spike-log">{log}</Text>
    </View>
  );
}
```

- [ ] **Step 2: Build and run it on a device**

Run: `pnpm turbo run build --filter=@cortex/mobile` then produce a development build (`.github/workflows/android-apk.yml` is the reference for how the APK is produced in CI). Install, sign in, open `/spike`, press the button.

Expected, if streaming works: `chunks` is well above 1 and `firstChunkMs` is a fraction of `totalMs`.
The failure signal is `chunks=1`, or `no body` — both mean the response is buffered.

- [ ] **Step 3: Record the finding in the spec**

Add to §8 of the spec, under task 1, one of:

```markdown
**Spike result 2026-__-__:** `expo/fetch` streams on a development build —
chunks=N, first chunk at Xms of Yms total. The SSE contract stands as designed.
```

or, if it buffered:

```markdown
**Spike result 2026-__-__:** `expo/fetch` delivered the body in ONE chunk
(chunks=1). SSE is unusable on device. `POST /assistant` grows an
`Accept: application/json` variant that returns the whole turn as one object,
and the box shows a thinking state instead of streaming tokens. Task 6's
rendering changes accordingly; nothing else in this plan moves.
```

- [ ] **Step 4: Delete the spike screen**

```bash
git rm apps/mobile/app/spike.tsx
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-15-stage-c2-mobile-box-design.md
git commit -F - <<'EOF'
spike: confirm whether expo/fetch streams on a real Android build

Expo Go cannot answer this and the whole online branch depends on it, so it
goes first. The finding is recorded in the C2 spec's task list; the throwaway
screen is not kept.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Move the SSE reader into `@cortex/shared` and put a test on it

`readEvents` in `apps/web/src/app/assistant-box.tsx` has four subtleties that were each paid for once — buffer tail, `\r\n`, the final `decoder.decode()` flush, `cancel()` over `releaseLock()`. Mobile needs all four. It currently has no test at all.

**Files:**
- Create: `packages/shared/src/sse.ts`
- Create: `packages/shared/src/sse.test.ts`
- Modify: `packages/shared/src/index.ts` (add the export)
- Modify: `apps/web/src/app/assistant-box.tsx:17-54` (delete the local copy, import instead)

**Interfaces:**
- Consumes: nothing.
- Produces: `readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>` where `SseEvent = { type: string; data: Record<string, unknown> }`.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/sse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readEvents } from "./sse.js";

/** A body that hands out exactly the byte slices given, in order. */
function bodyOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const ev of readEvents(body)) out.push(ev);
  return out;
}

describe("readEvents", () => {
  it("parses whole events", async () => {
    const events = await collect(
      bodyOf('event: token\ndata: {"text":"hi"}\n\nevent: done\ndata: {"messageId":"m1"}\n\n'),
    );
    expect(events).toEqual([
      { type: "token", data: { text: "hi" } },
      { type: "done", data: { messageId: "m1" } },
    ]);
  });

  // Red when the buffer tail is dropped: parsing half a JSON object throws.
  it("holds the tail when a chunk ends mid-event", async () => {
    const events = await collect(bodyOf('event: token\ndata: {"te', 'xt":"split"}\n\n'));
    expect(events).toEqual([{ type: "token", data: { text: "split" } }]);
  });

  // Red when the trailing flush is removed: a final event with no blank line vanishes and the
  // box sits there looking like it is still thinking.
  it("flushes a final event that has no trailing blank line", async () => {
    const events = await collect(bodyOf('event: done\ndata: {"messageId":"m2"}'));
    expect(events).toEqual([{ type: "done", data: { messageId: "m2" } }]);
  });

  // Red when the \r\n normalisation goes: the split on "\n\n" never matches.
  it("accepts CRLF line endings", async () => {
    const events = await collect(bodyOf('event: token\r\ndata: {"text":"crlf"}\r\n\r\n'));
    expect(events).toEqual([{ type: "token", data: { text: "crlf" } }]);
  });

  // Red when decoder.decode() is called without { stream: true }, or the final flush is
  // dropped: a multi-byte character split across chunks decodes to U+FFFD. The answers are
  // Vietnamese, so this is the common case, not an exotic one.
  it("reassembles a multi-byte character split across two chunks", async () => {
    const encoded = new TextEncoder().encode('event: token\ndata: {"text":"đã"}\n\n');
    const cut = 28; // lands inside the two bytes of "đ"
    const head = new TextDecoder("utf-8", { fatal: false }).decode(encoded.slice(0, cut));
    expect(head.endsWith("�")).toBe(true); // the split really is mid-character

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, cut));
        controller.enqueue(encoded.slice(cut));
        controller.close();
      },
    });
    expect(await collect(body)).toEqual([{ type: "token", data: { text: "đã" } }]);
  });

  // Red when a comment or keepalive line makes the parser throw instead of being skipped.
  it("ignores a block with no data line", async () => {
    const events = await collect(bodyOf(': keepalive\n\nevent: token\ndata: {"text":"x"}\n\n'));
    expect(events).toEqual([{ type: "token", data: { text: "x" } }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/shared --force`
Expected: FAIL — `Cannot find module './sse.js'`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/sse.ts` — moved verbatim from the web box, with its comments, because each one records a bug:

```ts
export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Reads an SSE body. Holds the tail: a network chunk can end mid-event, and parsing half a
 * JSON object throws. Same rule the server-side reader in gemini.ts follows.
 *
 * Lives in @cortex/shared rather than in either client because both need all four of its
 * subtleties, and two copies means paying for each of them twice.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parse = (raw: string): SseEvent | null => {
    const type = raw.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim();
    const data = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
    return type && data ? { type, data: JSON.parse(data) as Record<string, unknown> } : null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const raw of events) {
        const ev = parse(raw);
        if (ev) yield ev;
      }
    }
    // Flush the tail. A `done` event that arrives without a trailing blank line would
    // otherwise be dropped, and the box would sit there looking like it was still thinking.
    // decoder.decode() with no argument releases held multi-byte bytes -- the answers are
    // Vietnamese.
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
    for (const raw of buffer.split("\n\n")) {
      const ev = parse(raw);
      if (ev) yield ev;
    }
  } finally {
    // cancel(), not releaseLock(): releaseLock leaves the body unconsumed, so navigating away
    // mid-answer would leave the connection open instead of tearing it down.
    await reader.cancel().catch(() => {});
  }
}
```

Add to `packages/shared/src/index.ts`, beside the other barrel exports:

```ts
export * from "./sse.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/shared --force`
Expected: PASS, 6 tests.

- [ ] **Step 5: Point the web box at the shared copy**

In `apps/web/src/app/assistant-box.tsx`, delete lines 17–54 (the local `readEvents`) and add to the imports at the top:

```ts
import { readEvents, type Citation } from "@cortex/shared";
```

(The file already imports `Citation` from `@cortex/shared` on line 3 — merge, do not add a second import statement.)

- [ ] **Step 6: Verify web still builds and its tests pass**

Run: `pnpm turbo run build typecheck lint --filter=@cortex/web --force && pnpm turbo run test --filter=@cortex/web --force`
Expected: PASS. Web behaviour is unchanged by design; if a web test fails, the move was not verbatim.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/sse.ts packages/shared/src/sse.test.ts packages/shared/src/index.ts apps/web/src/app/assistant-box.tsx
git commit -F - <<'EOF'
refactor: move readEvents into @cortex/shared, with the test it never had

Four subtleties, each a bug someone already paid for once: holding the buffer
tail across chunk boundaries, normalising CRLF, flushing decoder.decode() with
no argument so held multi-byte bytes are released, and cancel() rather than
releaseLock() in finally. Mobile needs all four in Task 6.

The multi-byte test is not hypothetical -- it splits "đã" across two chunks and
asserts the naive decode really does produce U+FFFD first, so the test cannot
pass by accident.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: `captureNote` writes an id the caller chose

`CAPTURE_NOTE_SQL` uses SQLite's `uuid()`, so the client never learns what it wrote. Task 6 has to name the note in the request that asks for an answer about it, before PowerSync has uploaded anything.

**Files:**
- Modify: `apps/mobile/src/lib/capture.ts`
- Modify: `apps/mobile/src/lib/capture.test.ts`
- Modify: `apps/mobile/src/screens/quick-capture.tsx:43` (the one existing call site)

**Interfaces:**
- Consumes: nothing.
- Produces: `captureNote(db: CaptureTarget, input: CaptureInput, id: string): Promise<boolean>` — returns `false` without writing when the content is whitespace, exactly as before.

- [ ] **Step 1: Write the failing test**

Replace the `"gives every note a distinct id"` test in `apps/mobile/src/lib/capture.test.ts` with these two, and update the helper calls in the rest of the file to pass an id (`randomUUID()` is already imported there):

```ts
  it("writes the id it was given", async () => {
    const id = randomUUID();
    await captureNote(target(db), { content: "a thought", domain: null }, id);

    // Red the moment the SQL goes back to uuid(): the row exists but under a different id,
    // and the caller's copy names a note the server will never see.
    expect(rows()[0].id).toBe(id);
  });

  it("does not write at all when the content is whitespace, even with an id", async () => {
    const write = vi.fn();
    const wrote = await captureNote({ execute: write }, { content: "  \n ", domain: null }, randomUUID());

    expect(wrote).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile --force`
Expected: FAIL — `Expected 3 arguments, but got 2` at typecheck, or the id assertion failing.

- [ ] **Step 3: Write the implementation**

In `apps/mobile/src/lib/capture.ts`, change the statement and the signature:

```ts
/**
 * `?` for the id, not `uuid()`. The PowerSync core extension's `uuid()` generates a perfectly
 * good id but never tells the caller what it was, and the assistant box has to name this note
 * in a request that goes out before PowerSync has uploaded anything. Same reason logCheckin
 * has always generated client-side: the caller needs the id back.
 */
export const CAPTURE_NOTE_SQL = `INSERT INTO notes (id, content, title, domain, domain_meta, lifecycle,
                    source_type, pinned, created_at, updated_at)
     VALUES (?, ?, NULL, ?, '{}', 'inbox', 'quick', 0,
             ${NOW_ISO}, ${NOW_ISO})`;

export async function captureNote(
  db: CaptureTarget,
  input: CaptureInput,
  id: string,
): Promise<boolean> {
  const content = input.content.trim();
  if (!content) return false;
  await db.execute(CAPTURE_NOTE_SQL, [id, content, input.domain]);
  return true;
}
```

Update the placeholder-count assertion in the existing `"binds content and domain in the order the columns expect"` test from `toHaveLength(2)` to `toHaveLength(3)`.

- [ ] **Step 4: Update the existing call site**

`apps/mobile/src/screens/quick-capture.tsx` — add the import and pass an id:

```tsx
import { randomUUID } from "expo-crypto";
```

```tsx
        const wrote = await captureNote(db, { content, domain }, randomUUID());
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm turbo run test typecheck --filter=@cortex/mobile --force`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/lib/capture.ts apps/mobile/src/lib/capture.test.ts apps/mobile/src/screens/quick-capture.tsx
git commit -F - <<'EOF'
feat(mobile): captureNote takes the id instead of letting SQL invent one

PowerSync's uuid() writes a fine id and never says what it was. The assistant
box has to name this note in a request that leaves the device before the CRUD
queue has uploaded anything, so the caller has to choose it -- the precedent is
logCheckin, which has always generated client-side for the same reason.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Answer from the local FTS5 index when there is no connection

Offline the box still captures and still answers — from `notes_fts`, with no AI, no cost and no queued request that fires later and surprises someone.

**Files:**
- Create: `apps/mobile/src/lib/assistant/offline-answer.ts`
- Create: `apps/mobile/src/lib/assistant/offline-answer.test.ts`

**Interfaces:**
- Consumes: `toFtsQuery` from `@cortex/shared`; the `notes_fts` table `setupNotesFts` creates.
- Produces:
  ```ts
  export interface OfflineMatch { id: string; snippet: string }
  export interface FtsReadTarget { getAll<T>(sql: string, params?: unknown[]): Promise<T[]> }
  export const OFFLINE_MATCH_LIMIT = 3;
  export async function offlineAnswer(db: FtsReadTarget, text: string): Promise<OfflineMatch[]>
  ```

- [ ] **Step 1: Write the failing test**

`apps/mobile/src/lib/assistant/offline-answer.test.ts`:

```ts
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { offlineAnswer, type FtsReadTarget } from "./offline-answer.js";

/** The real FTS5 shape from lib/fts.ts: the uuid is its own UNINDEXED column, not the rowid. */
function sqlite() {
  const db = new Database(":memory:");
  db.exec(`CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, content, tokenize='unicode61')`);
  return db;
}

function target(db: Database.Database): FtsReadTarget {
  return {
    getAll: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all((params ?? []) as never[]) as T[],
  };
}

function put(db: Database.Database, id: string, content: string) {
  db.prepare("INSERT INTO notes_fts(id, content) VALUES (?, ?)").run(id, content);
}

let db: Database.Database;
beforeEach(() => { db = sqlite(); });
afterEach(() => { db.close(); });

describe("offlineAnswer", () => {
  it("returns the notes that match, with a snippet of each", async () => {
    put(db, "n1", "định giá theo giá trị chứ không theo chi phí");
    put(db, "n2", "hôm nay chạy bộ 5km");

    const hits = await offlineAnswer(target(db), "định giá");

    expect(hits.map((h) => h.id)).toEqual(["n1"]);
    expect(hits[0].snippet).toContain("định giá");
  });

  /**
   * Red the moment toFtsQuery is dropped and the raw text is bound: FTS5 parses the bound
   * value as a query language, and an apostrophe raises `fts5: syntax error near "'"`. This
   * is the single most likely simplification someone will make to this file.
   */
  it("does not throw on punctuation a person actually types", async () => {
    put(db, "n1", "don't ship it on a friday");

    for (const q of ["don't", 'foo"', "hello AND", "!!!", "-hello", "content:hello"]) {
      await expect(offlineAnswer(target(db), q)).resolves.toBeInstanceOf(Array);
    }
  });

  /**
   * Red when the empty-term guard is removed. `match ''` is itself an FTS5 syntax error, so
   * without this the box crashes on a query of nothing but punctuation -- and it must not
   * merely not-throw, it must not run a query at all.
   */
  it("makes no query when the text escapes to nothing", async () => {
    const getAll = vi.fn();
    const hits = await offlineAnswer({ getAll }, "   \n\t ");

    expect(hits).toEqual([]);
    expect(getAll).not.toHaveBeenCalled();
  });

  // Red when the LIMIT is dropped: three is what the box can show without becoming a list.
  it("returns at most three matches", async () => {
    for (const i of [1, 2, 3, 4, 5]) put(db, `n${i}`, "pricing psychology note");

    expect(await offlineAnswer(target(db), "pricing")).toHaveLength(3);
  });

  it("returns an empty array when nothing matches, without throwing", async () => {
    put(db, "n1", "unrelated");
    expect(await offlineAnswer(target(db), "khôngcótừnày")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile --force`
Expected: FAIL — `Cannot find module './offline-answer.js'`.

- [ ] **Step 3: Write the implementation**

`apps/mobile/src/lib/assistant/offline-answer.ts`:

```ts
import { toFtsQuery } from "@cortex/shared";

export interface OfflineMatch {
  id: string;
  snippet: string;
}

/** Anything that can run a parameterised read -- PowerSync's db, or SQLite in a test. */
export interface FtsReadTarget {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Three is what the box can show without turning an answer into a list. */
export const OFFLINE_MATCH_LIMIT = 3;

/**
 * `snippet(notes_fts, 1, ...)`: column 1 is `content`. Column 0 is the UNINDEXED uuid, and
 * asking FTS5 to snippet an unindexed column returns an empty string with no error.
 */
const SEARCH_SQL = `SELECT id, snippet(notes_fts, 1, '', '', '…', 12) AS snippet
     FROM notes_fts WHERE notes_fts MATCH ? LIMIT ${OFFLINE_MATCH_LIMIT}`;

/**
 * The offline half of a turn (spec §4): no AI, no cost, no request queued to fire later.
 *
 * Also the fallback for every ONLINE failure -- a fetch that throws, a non-2xx, a stream that
 * dies before the first token. An offline-shaped answer beats an error message, because the
 * local index is there either way.
 *
 * `toFtsQuery` is reused rather than reimplemented. FTS5 parses the string bound to `MATCH` as
 * a query language, so binding prevents injection but not parsing: an apostrophe, a stray
 * quote, a trailing `AND` each raise a syntax error, and people type all three. See the
 * helper's own docstring for the full list.
 */
export async function offlineAnswer(db: FtsReadTarget, text: string): Promise<OfflineMatch[]> {
  const query = toFtsQuery(text);
  // `match ''` is a syntax error in its own right, so an input of nothing but whitespace or
  // punctuation must cost no query at all -- not a query that happens to return nothing.
  if (!query) return [];
  return db.getAll<OfflineMatch>(SEARCH_SQL, [query]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/mobile --force`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/assistant/offline-answer.ts apps/mobile/src/lib/assistant/offline-answer.test.ts
git commit -F - <<'EOF'
feat(mobile): answer from the local FTS5 index when there is no connection

Offline the box still captures and still answers -- "no connection, but N of
your notes match" plus snippets. No AI, no cost, nothing queued to fire later
and surprise someone.

toFtsQuery is reused, not reimplemented: FTS5 parses the value bound to MATCH
as a query language, so an apostrophe is a syntax error, and the test walks the
punctuation people actually type. An input that escapes to nothing runs no
query at all, because `match ''` raises too.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: `POST /assistant` gets-or-creates the note

On mobile the note is always missing on the first turn: it exists in local SQLite and PowerSync has not uploaded it. This task also lands the two fixes C2 makes non-optional — real `domainMeta` on `attached`, and a `sessionId` whose owner is checked.

**Files:**
- Modify: `packages/shared/src/dto/assistant.ts`
- Modify: `packages/shared/src/dto/assistant.test.ts`
- Modify: `packages/core/src/assistant/turn.ts:44-72` and `:127-129`
- Modify: `apps/api/test/assistant.e2e.test.ts`

**Interfaces:**
- Consumes: `NoteService.createWithId(id, input)` from `@cortex/core`.
- Produces:
  - `assistantInput` accepting `{ noteId, sessionId?, content?, createdAt? }`, still `.strict()`.
  - `runTurn(deps, { userId, noteId, sessionId?, content?, createdAt?, budgetUsd, signal? })`.
  - the `attached` event carrying `domainMeta: Record<string, unknown>` populated from the extraction.

- [ ] **Step 1: Write the failing DTO test**

Add to `packages/shared/src/dto/assistant.test.ts`:

```ts
  it("accepts content and createdAt for a note the server has never seen", () => {
    const r = assistantInput.safeParse({
      noteId: crypto.randomUUID(),
      content: "vừa xem xong Inception",
      createdAt: "2026-08-15T03:04:05.000Z",
    });
    expect(r.success).toBe(true);
  });

  // Red if content is added without a floor: the create path would insert an empty note.
  it("rejects empty content rather than creating an empty note", () => {
    const r = assistantInput.safeParse({ noteId: crypto.randomUUID(), content: "" });
    expect(r.success).toBe(false);
  });

  it("rejects a createdAt that is not a timestamp", () => {
    const r = assistantInput.safeParse({ noteId: crypto.randomUUID(), createdAt: "yesterday" });
    expect(r.success).toBe(false);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/shared --force`
Expected: FAIL — `.strict()` rejects the unknown keys `content` and `createdAt`.

- [ ] **Step 3: Extend the DTO**

`packages/shared/src/dto/assistant.ts`:

```ts
export const assistantInput = z
  .object({
    noteId: z.string().uuid(),
    sessionId: z.string().uuid().optional(),
    /**
     * Present when the caller has a note the server may not have yet -- mobile writes to local
     * SQLite first and PowerSync uploads on its own schedule, so the first turn about a note
     * always races the upload. The turn creates it if it is missing (get-or-create) and
     * otherwise ignores this: once the row exists, the text comes from `content_text` in the
     * database and never from the caller's copy of it.
     *
     * The cap matches createNoteInput's 100_000. Restating it as a smaller number here would
     * make the same note acceptable through POST /notes and rejected through here.
     */
    content: z.string().min(1).max(100_000).optional(),
    /** An offline capture's real timestamp, not the reconnect time. Same field NoteService takes. */
    createdAt: z.string().datetime().optional(),
  })
  .strict();
```

- [ ] **Step 4: Run the DTO tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/shared --force`
Expected: PASS.

- [ ] **Step 5: Write the failing tests**

Two levels, because they catch different things. First, `packages/core/src/assistant/turn.test.ts`, which drives `runTurn` against the hand-built Supabase double `dbs()` — fast, no stack, and it already records every insert.

`dbs()` currently always resolves the note read to the `NOTE` fixture. Give it an option:

```ts
function dbs(opts: { over?: boolean; history?: HistoryRow[]; note?: typeof NOTE | null } = {}) {
```

and where the `notes` select on `"id, content_text"` is routed, resolve to `opts.note === undefined ? NOTE : opts.note`. Widen the fixture so the created timestamp is available:

```ts
const NOTE = {
  id: "n1", user_id: "u1",
  content_text: "hôm nay tôi chạy bộ ở công viên",
  created_at: "2026-08-14T01:02:03.000Z",
};
```

and route the new column string `"id, content_text, created_at"` to it. Then the tests:

```ts
  /**
   * The mobile case. The device wrote the note into its own SQLite and PowerSync has not
   * uploaded it, so the server has never seen the id. Red the moment the create branch is
   * removed: the first event becomes `error: note not found`.
   */
  it("creates the note when it is missing and content was supplied", async () => {
    const { client, inserted } = dbs({ note: null });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: ai() },
      { userId: "u1", noteId: "n1", content: "ghi chú chưa từng lên server", budgetUsd: 100 },
    ));

    expect(events.map((e) => e.type)).not.toContain("error");
    expect(inserted.notes?.[0]).toMatchObject({
      id: "n1", user_id: "u1", content: "ghi chú chưa từng lên server",
    });
  });

  it("still reports note not found when the id is unknown and no content was sent", async () => {
    const { client } = dbs({ note: null });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: ai() },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));

    expect(events[0]).toEqual({ type: "error", message: "note not found" });
  });

  /**
   * Red when the hardcoded `domainMeta: {}` comes back: the box loses the ability to say what
   * it filed, which Task 8 depends on entirely.
   */
  it("puts the extraction's real domain_meta on the attached event", async () => {
    const { client } = dbs();
    const scripted = ai({ domain: "media", domain_meta: { rating: 8.5 } });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: scripted },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));

    const attached = events.find((e) => e.type === "attached");
    expect(attached).toMatchObject({ domainMeta: { rating: 8.5 } });
  });
```

`ai()` in that file scripts a fixed `generateJson`; give it an optional override so a test can choose the classification:

```ts
  const ai = (value: Record<string, unknown> = {}) =>
    createFakeAi({
      generateJson: async () => ({
        value: { intent: "statement", complexity: "simple", domain: null,
                 domain_meta: {}, tags: [], mood: null, ...value },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      }),
      // ... the existing generateStream, unchanged
    });
```

Second, one end-to-end check in `apps/api/test/assistant.e2e.test.ts` that the wiring survives a real request and a real database. Add `createUserClient` to the existing `@cortex/core` import at the top of that file:

```ts
import { createFakeAi, createUserClient } from "@cortex/core";
```

```ts
  it("creates a note the server has never seen, through a real request", async () => {
    const id = crypto.randomUUID();
    const res = await request(app.getHttpServer())
      .post("/assistant").set(auth(alice.token))
      .send({ noteId: id, content: "ghi chú chưa từng lên server" });

    expect(res.status).toBe(200);
    const { data } = await createUserClient(alice.token)
      .from("notes").select("content").eq("id", id).single();
    expect(data?.content).toBe("ghi chú chưa từng lên server");
  });

  /**
   * The PowerSync upload that arrives afterwards must not overwrite what the turn enriched.
   * createWithId is create-if-absent; red if it ever becomes an upsert.
   */
  it("leaves an existing note untouched when the same id arrives again", async () => {
    const id = crypto.randomUUID();
    await request(app.getHttpServer()).post("/assistant").set(auth(alice.token))
      .send({ noteId: id, content: "bản gốc" });
    await request(app.getHttpServer()).post("/assistant").set(auth(alice.token))
      .send({ noteId: id, content: "bản ghi đè" });

    const { data } = await createUserClient(alice.token)
      .from("notes").select("content").eq("id", id).single();
    expect(data?.content).toBe("bản gốc");
  });

  /**
   * A session id the caller does not own must not pull someone else's history into this
   * turn's prompt. Red when the .eq("user_id") on the session lookup is removed.
   *
   * `bob` does not exist in this file yet -- makeUser is imported already, so create him here
   * rather than adding a second user to the shared beforeAll that no other test needs.
   */
  it("does not read another user's session", async () => {
    const bob = await makeUser("api-assistant-bob@test.local");
    const bobDb = createUserClient(bob.token);
    const { data: session } = await bobDb
      .from("chat_sessions").insert({ user_id: bob.id }).select("id").single();
    await bobDb.from("chat_messages").insert({
      user_id: bob.id, session_id: session!.id, role: "user", content: "bob's private thought",
    });

    await request(app.getHttpServer()).post("/assistant").set(auth(alice.token))
      .send({ noteId, sessionId: session!.id });

    // alice's turn must not have been written into bob's session.
    const { data: messages } = await bobDb
      .from("chat_messages").select("content").eq("session_id", session!.id);
    expect(messages?.map((m) => m.content)).toEqual(["bob's private thought"]);
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core --filter=@cortex/api --force` (the local Supabase stack must be up)
Expected: FAIL — `runTurn` yields `note not found` where a note should have been created, `attached` carries `{}`, and the session test finds alice's turn written into bob's session.

- [ ] **Step 7: Implement get-or-create and the session ownership check**

In `packages/core/src/assistant/turn.ts`, extend the args and replace the note read:

```ts
export async function* runTurn(
  deps: { userDb: SupabaseClient; serviceDb: SupabaseClient; ai: AiClient },
  args: {
    userId: string; noteId: string; sessionId?: string;
    content?: string; createdAt?: string;
    budgetUsd: number; signal?: AbortSignal;
  },
): AsyncGenerator<AssistantEvent> {
  const { userDb, serviceDb, ai } = deps;
  const requestId = randomUUID();

  // The user's client, so RLS is what proves ownership -- and the note's text comes from the
  // database, never from the caller's copy of it.
  const { data: existing, error: noteErr } = await userDb
    .from("notes").select("id, content_text, created_at").eq("id", args.noteId).maybeSingle();
  if (noteErr) {
    yield { type: "error", message: "note not found" };
    return;
  }

  // Mobile writes to local SQLite first and PowerSync uploads on its own schedule, so the
  // FIRST turn about a note always races the upload and would otherwise always lose. Creating
  // it here is safe against that upload precisely because createWithId is create-if-absent: a
  // 23505 returns the existing row rather than overwriting it, so whichever writer arrives
  // first wins and the second is a no-op.
  let note = existing as { content_text: string; created_at: string } | null;
  if (!note) {
    if (args.content === undefined) {
      yield { type: "error", message: "note not found" };
      return;
    }
    try {
      const created = await new NoteService(userDb, args.userId).createWithId(args.noteId, {
        content: args.content,
        ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
      });
      note = { content_text: created.content, created_at: created.created_at };
    } catch (err) {
      console.error(`[assistant] could not create note ${args.noteId}: ${errorMessage(err)}`);
      yield { type: "error", message: "note not found" };
      return;
    }
  }
  const text = note.content_text;
  const noteCreatedAt = note.created_at;
```

Add the import at the top of the file:

```ts
import { NoteService } from "../notes/service.js";
```

Then replace the session resolution block so a supplied `sessionId` is verified:

```ts
  // A client-supplied sessionId is UNVERIFIED input. Without this read the history query below
  // is scoped by session alone, so a guessed id would select another user's conversation into
  // this turn's prompt. C2 makes /assistant the only write path a mobile client has, which is
  // what makes the check worth its round trip.
  let sessionId: string | undefined;
  if (args.sessionId) {
    const { data: owned } = await userDb
      .from("chat_sessions").select("id")
      .eq("id", args.sessionId).eq("user_id", args.userId).maybeSingle();
    sessionId = (owned as { id: string } | null)?.id;
  }
  const { data: last } = await userDb
    .from("chat_messages").select("session_id, created_at")
    .eq("user_id", args.userId).order("created_at", { ascending: false }).limit(1);
  const lastRow = (last ?? [])[0] as { session_id: string; created_at: string } | undefined;
  sessionId = sessionId ?? lastRow?.session_id;
  if (!sessionId || isStale(lastRow?.created_at ?? null, new Date())) {
    const { data: created } = await userDb
      .from("chat_sessions").insert({ user_id: args.userId }).select("id").single();
    sessionId = (created as { id: string } | null)?.id ?? sessionId ?? randomUUID();
  }
```

Note `noteCreatedAt` is unused until Task 7 — leave the binding in place; Task 7's check-in needs it.

- [ ] **Step 8: Make `attached` carry the real `domainMeta`**

`extractNote` computes and stores the meta and then throws it away at the boundary. First widen its return in `packages/core/src/enrich/extract.ts`:

```ts
export async function extractNote(
  deps: { db: SupabaseClient; ai: AiClient },
  note: EnrichTarget,
): Promise<{
  tags: number;
  tagNames: string[];
  domain: string | null;
  domainMeta: Record<string, unknown>;
  intent: "question" | "statement";
  complexity: "simple" | "complex";
}> {
```

and its return statement:

```ts
  return {
    tags: accepted.length,
    tagNames: accepted,
    domain,
    // The meta that was just written to the row. Returned rather than re-read: the box has to
    // be able to say WHAT it filed ("Inception (2010) · 8.5/10"), and turn.ts hardcoded `{}`
    // here, which made that impossible.
    domainMeta: meta,
    intent: value.intent === "question" ? "question" : "statement",
    complexity: value.complexity === "complex" ? "complex" : "simple",
  };
```

then in `turn.ts` replace the hardcoded `domainMeta: {}`:

```ts
  yield extracted
    ? { type: "attached", domain: extracted.domain, domainMeta: extracted.domainMeta,
        tags: extracted.tagNames }
    : { type: "attached", domain: null, domainMeta: {}, tags: [], degraded: true };
```

- [ ] **Step 9: Pass the new fields through the controller**

`apps/api/src/assistant.controller.ts:59-68` — the body is already validated. Add two lines to the args object, matching how `sessionId` is already passed:

```ts
        {
          userId: user.id,
          noteId: body.noteId,
          sessionId: body.sessionId,
          content: body.content,
          createdAt: body.createdAt,
          budgetUsd,
          signal: abort.signal,
        },
```

Nothing else in the controller changes. The SSE writer below it is `const { type, ...data } = event`, so the `mood` event Task 7 adds serialises as `event: mood\ndata: {"checkinId":"…","mood":4}` with no further work — which is what `streamAssistantTurn`'s mapper in Task 6 already expects.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/shared --filter=@cortex/core --filter=@cortex/api --force`
Expected: PASS. Check the `Cached:` line — a replay here proves nothing.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src/dto/assistant.ts packages/shared/src/dto/assistant.test.ts packages/core/src/assistant/turn.ts packages/core/src/enrich/extract.ts apps/api/src/assistant.controller.ts apps/api/test/assistant.e2e.test.ts
git commit -F - <<'EOF'
feat(api): POST /assistant gets-or-creates the note, and checks who owns a session

On mobile the note is ALWAYS missing on the first turn -- it exists in local
SQLite and PowerSync uploads on its own schedule. The turn now creates it when
content is supplied, which is safe against the upload that follows because
createWithId is create-if-absent: a 23505 returns the existing row rather than
overwriting it, so whichever writer arrives first wins.

Two fixes C2 makes non-optional ride along:

- `attached` carried a hardcoded domainMeta: {} while extractNote had just
  computed and stored the real thing. On web that was cosmetic. On mobile it is
  the difference between the box being able to say what it filed and not.
- a client-supplied sessionId was trusted, so the history read was scoped by
  session alone. It is now verified against the caller's user_id.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: The box on mobile, replacing quick capture

**Files:**
- Create: `apps/mobile/src/lib/assistant/stream.ts`
- Create: `apps/mobile/src/lib/assistant/stream.test.ts`
- Create: `apps/mobile/src/screens/assistant-box.tsx`
- Modify: `apps/mobile/app/index.tsx:73-79` (drop `QuickCapture` from the header)
- Delete: `apps/mobile/src/screens/quick-capture.tsx`

**Interfaces:**
- Consumes: `captureNote(db, input, id)` (Task 3), `offlineAnswer(db, text)` (Task 4), `readEvents` (Task 2).
- Produces:
  ```ts
  export type BoxEvent =
    | { type: "attached"; domain: string | null; domainMeta: Record<string, unknown>; tags: string[]; degraded?: boolean }
    | { type: "citations"; citations: Citation[] }
    | { type: "token"; text: string }
    | { type: "mood"; checkinId: string; mood: number }      // emitted from Task 7
    | { type: "declined" }
    | { type: "done" }
    | { type: "error"; message: string };

  export async function* streamAssistantTurn(args: {
    noteId: string; content: string; createdAt: string;
    token: string; apiUrl: string; fetchFn?: typeof fetch;
  }): AsyncGenerator<BoxEvent>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/mobile/src/lib/assistant/stream.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { streamAssistantTurn, StreamUnavailableError } from "./stream.js";

function sseResponse(body: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

const args = {
  noteId: "11111111-1111-4111-8111-111111111111",
  content: "vừa xem xong Inception",
  createdAt: "2026-08-15T03:04:05.000Z",
  token: "jwt",
  apiUrl: "https://api.test",
};

async function collect(gen: AsyncGenerator<unknown>) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("streamAssistantTurn", () => {
  it("sends the note id, the content and the capture time", async () => {
    const fetchFn = vi.fn().mockResolvedValue(sseResponse('event: done\ndata: {}\n\n'));
    await collect(streamAssistantTurn({ ...args, fetchFn }));

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.test/assistant");
    // Red if content or createdAt is dropped: the server cannot create the note, and every
    // first turn on mobile answers "note not found".
    expect(JSON.parse(init.body)).toEqual({
      noteId: args.noteId, content: args.content, createdAt: args.createdAt,
    });
    expect(init.headers.authorization).toBe("Bearer jwt");
  });

  it("yields typed events in the order the server sent them", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse(
        'event: attached\ndata: {"domain":"media","domainMeta":{"rating":8.5},"tags":["phim"]}\n\n' +
        'event: token\ndata: {"text":"Đã "}\n\n' +
        'event: token\ndata: {"text":"ghi."}\n\n' +
        'event: done\ndata: {"messageId":"m1","sessionId":"s1"}\n\n',
      ),
    );

    expect(await collect(streamAssistantTurn({ ...args, fetchFn }))).toEqual([
      { type: "attached", domain: "media", domainMeta: { rating: 8.5 }, tags: ["phim"] },
      { type: "token", text: "Đã " },
      { type: "token", text: "ghi." },
      { type: "done" },
    ]);
  });

  // Red when the non-2xx branch is removed: the box would try to parse an error page as SSE
  // and render nothing at all, instead of falling back to the local index.
  it("raises StreamUnavailableError on a non-2xx", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("nope", { status: 502 }));
    await expect(collect(streamAssistantTurn({ ...args, fetchFn }))).rejects.toBeInstanceOf(
      StreamUnavailableError,
    );
  });

  // Red when the throwing fetch is not caught: offline, this is the actual failure, and it
  // must be the same class the screen already knows how to fall back from.
  it("raises StreamUnavailableError when the request cannot be made at all", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Network request failed"));
    await expect(collect(streamAssistantTurn({ ...args, fetchFn }))).rejects.toBeInstanceOf(
      StreamUnavailableError,
    );
  });

  it("raises StreamUnavailableError when the response carries no body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(collect(streamAssistantTurn({ ...args, fetchFn }))).rejects.toBeInstanceOf(
      StreamUnavailableError,
    );
  });

  // Red if unknown event names are passed through: a server that grows an event this build
  // does not know must not render as a blank line in the answer.
  it("ignores an event type it does not know", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse('event: futurething\ndata: {"x":1}\n\nevent: done\ndata: {}\n\n'),
    );
    expect(await collect(streamAssistantTurn({ ...args, fetchFn }))).toEqual([{ type: "done" }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/mobile --force`
Expected: FAIL — `Cannot find module './stream.js'`.

- [ ] **Step 3: Write the implementation**

`apps/mobile/src/lib/assistant/stream.ts`:

```ts
import { readEvents, type Citation } from "@cortex/shared";

/**
 * The turn could not be had. Distinct from a turn that ran and declined (`declined`) or one
 * that errored server-side (`error`) -- only this one means "fall back to the local index",
 * and conflating them is how an offline user gets told their notes are missing.
 */
export class StreamUnavailableError extends Error {
  override name = "StreamUnavailableError";
}

export type BoxEvent =
  | { type: "attached"; domain: string | null; domainMeta: Record<string, unknown>;
      tags: string[]; degraded?: boolean }
  | { type: "citations"; citations: Citation[] }
  | { type: "token"; text: string }
  | { type: "mood"; checkinId: string; mood: number }
  | { type: "declined" }
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * One turn against POST /assistant, as typed events.
 *
 * `fetchFn` is injected for the same reason capture.ts exists: the test needs no network and no
 * React Native mock. The screen passes `expo/fetch`'s implementation, which is the one that
 * streams -- React Native's global fetch buffers the whole body (see Task 1's spike).
 *
 * `content` and `createdAt` ride along on every request, not just the first. The server ignores
 * them once the row exists, and the alternative -- tracking on-device whether this note has
 * been uploaded yet -- is a second source of truth about something PowerSync already owns.
 */
export async function* streamAssistantTurn(args: {
  noteId: string;
  content: string;
  createdAt: string;
  token: string;
  apiUrl: string;
  fetchFn?: typeof fetch;
}): AsyncGenerator<BoxEvent> {
  const doFetch = args.fetchFn ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${args.apiUrl}/assistant`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${args.token}` },
      body: JSON.stringify({
        noteId: args.noteId, content: args.content, createdAt: args.createdAt,
      }),
    });
  } catch {
    throw new StreamUnavailableError("the assistant could not be reached");
  }
  if (!res.ok || !res.body) {
    throw new StreamUnavailableError(`the assistant answered ${res.status}`);
  }

  for await (const ev of readEvents(res.body)) {
    const d = ev.data;
    switch (ev.type) {
      case "attached":
        yield {
          type: "attached",
          domain: (d.domain as string | null) ?? null,
          domainMeta: (d.domainMeta as Record<string, unknown>) ?? {},
          tags: (d.tags as string[]) ?? [],
          ...(d.degraded === true ? { degraded: true } : {}),
        };
        break;
      case "citations":
        yield { type: "citations", citations: (d.citations as Citation[]) ?? [] };
        break;
      case "token":
        yield { type: "token", text: String(d.text ?? "") };
        break;
      case "mood":
        yield { type: "mood", checkinId: String(d.checkinId), mood: Number(d.mood) };
        break;
      case "declined":
        yield { type: "declined" };
        break;
      case "done":
        yield { type: "done" };
        break;
      case "error":
        yield { type: "error", message: String(d.message ?? "") };
        break;
      // An event name this build does not know is DROPPED, not rendered. The server is
      // deployed independently of the APK, so it will grow events this client predates.
      default:
        break;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/mobile --force`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the screen**

`apps/mobile/src/screens/assistant-box.tsx`. Rendering only — every decision above is already tested.

```tsx
import { usePowerSync } from "@powersync/react-native";
import { randomUUID } from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { captureNote } from "../lib/capture";
import { createInFlightGuard } from "../lib/in-flight";
import { offlineAnswer, type OfflineMatch } from "../lib/assistant/offline-answer";
import { streamAssistantTurn, StreamUnavailableError, type BoxEvent } from "../lib/assistant/stream";
import { supabase } from "../lib/supabase";

/**
 * One box. It replaces quick capture, and in Tasks 7 and 8 the check-in widget and the media
 * log form (spec §1).
 *
 * The order is the whole design: the local INSERT is the deliverable and everything after it is
 * a bonus, so the note is durable before any network exists. A failed local write is the ONLY
 * case where text can be lost, and the only one that keeps the box's contents.
 */
export function AssistantBox() {
  const db = usePowerSync();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [attached, setAttached] = useState<Extract<BoxEvent, { type: "attached" }> | null>(null);
  const [answer, setAnswer] = useState("");
  const [matches, setMatches] = useState<OfflineMatch[]>([]);
  const run = useRef(createInFlightGuard()).current;

  async function submit() {
    await run(async () => {
      setBusy(true);
      setSaveFailed(false);
      setStatus(null);
      setAttached(null);
      setAnswer("");
      setMatches([]);

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      try {
        const wrote = await captureNote(db, { content: text, domain: null }, id);
        if (!wrote) return;
      } catch {
        // The one genuine loss. Keep the text and say so -- same copy quick capture used.
        setSaveFailed(true);
        return;
      }
      // Cleared here, before any network. Web clears only after POST /notes resolves; this is
      // both faster and strictly safer.
      const asked = text;
      setText("");

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new StreamUnavailableError("not signed in");
        for await (const ev of streamAssistantTurn({
          noteId: id, content: asked, createdAt,
          token: session.access_token,
          apiUrl: process.env.EXPO_PUBLIC_API_URL!,
          fetchFn: expoFetch as unknown as typeof fetch,
        })) {
          if (ev.type === "attached") setAttached(ev);
          else if (ev.type === "token") setAnswer((a) => a + ev.text);
          else if (ev.type === "declined") setStatus("Đã lưu. Chưa trả lời được (đã chạm giới hạn chi tiêu).");
          else if (ev.type === "error") setStatus("Đã lưu. Chưa trả lời được.");
        }
      } catch {
        // Offline, a dead stream, a 502 -- all the same from here, and all better answered
        // from the local index than with an error message.
        const hits = await offlineAnswer(db, asked).catch(() => []);
        setMatches(hits);
        setStatus(
          hits.length > 0
            ? `Không có mạng — ${hits.length} ghi chú của bạn khớp với câu này.`
            : "Đã lưu.",
        );
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <View style={{ gap: 12, padding: 16 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Bạn đang nghĩ gì?"
        multiline
        accessibilityLabel="Bạn đang nghĩ gì?"
        // testID, not the label: it becomes the Android resource-id, which is unique and
        // stable. This screen has a second TextInput (the note-list search box) whose
        // contentDescription is close enough to collide with a text matcher.
        testID="box-input"
        style={{ minHeight: 96, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 }}
      />
      {saveFailed ? (
        <Text style={{ color: "crimson" }}>
          Không lưu được vào máy. Chữ của bạn vẫn còn đây — thử lại nhé.
        </Text>
      ) : null}
      <Pressable
        onPress={() => void submit()}
        accessibilityRole="button"
        disabled={busy}
        testID="box-send"
        style={{ padding: 14, borderRadius: 8, backgroundColor: "#222", alignItems: "center",
                 opacity: busy ? 0.6 : 1 }}
      >
        <Text style={{ color: "white" }}>Gửi</Text>
      </Pressable>

      {busy ? <ActivityIndicator /> : null}

      {attached ? (
        <Text testID="box-attached">
          {attached.domain ? `Đã xếp vào: ${attached.domain}` : "Chưa xếp vào nhóm nào"}
          {attached.tags.length > 0 ? ` — thẻ ${attached.tags.join(", ")}` : ""}
        </Text>
      ) : null}

      {answer ? <Text testID="box-answer">{answer}</Text> : null}

      {matches.map((m) => (
        <Text key={m.id} testID="box-offline-match">{m.snippet}</Text>
      ))}

      {status ? <Text testID="box-status">{status}</Text> : null}
    </View>
  );
}
```

- [ ] **Step 6: Swap it into the home screen and delete quick capture**

`apps/mobile/app/index.tsx` — replace the `QuickCapture` import and its use:

```tsx
import { AssistantBox } from "@/screens/assistant-box";
```

```tsx
            header={
              <>
                <AssistantBox />
                <CheckinWidget />
                <MediaLogForm />
              </>
            }
```

```bash
git rm apps/mobile/src/screens/quick-capture.tsx
```

- [ ] **Step 7: Verify the package builds, typechecks and bundles**

Run: `pnpm turbo run test typecheck lint --filter=@cortex/mobile --force && pnpm turbo run bundle --filter=@cortex/mobile --force`
Expected: PASS. The bundle step is what catches an import that only resolves under node.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/lib/assistant/stream.ts apps/mobile/src/lib/assistant/stream.test.ts apps/mobile/src/screens/assistant-box.tsx apps/mobile/app/index.tsx apps/mobile/src/screens/quick-capture.tsx
git commit -F - <<'EOF'
feat(mobile): the assistant box, replacing quick capture

The local INSERT comes first and the box clears on it, so the note is durable
before any network exists -- web clears only after POST /notes returns, which is
slower and strictly less safe. Every failure after that point (offline, 502,
a stream that dies, not signed in) falls back to the local FTS5 index rather
than to an error message, because the index is there either way.

The only case that keeps the user's text in the box is a failed local write,
which is the only case where the text is genuinely gone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 7: The AI writes the mood, and Undo takes it back

**Files:**
- Modify: `packages/core/src/enrich/extract.ts` (schema, prompt, return)
- Modify: `packages/core/src/enrich/extract.test.ts`
- Modify: `packages/core/src/assistant/turn.ts` (write the check-in, emit the event)
- Modify: `apps/mobile/src/lib/checkins.ts` (`logCheckinWithId`)
- Modify: `apps/mobile/src/lib/checkins.test.ts`
- Modify: `apps/mobile/src/screens/assistant-box.tsx` (mirror the row, render Undo)
- Modify: `apps/mobile/app/index.tsx` (drop `CheckinWidget`)
- Delete: `apps/mobile/src/screens/checkin-widget.tsx`

**Interfaces:**
- Consumes: `CheckinService.createWithId(id, { mood, createdAt })` from `@cortex/core`; `noteCreatedAt` bound in Task 5.
- Produces:
  - `extractNote` returning `mood: number | null` alongside `domainMeta`.
  - the `mood` SSE event `{ checkinId: string; mood: number }`.
  - `logCheckinWithId(db: CheckinTarget, id: string, mood: number): Promise<void>`.

- [ ] **Step 1: Write the failing core test**

Add to `packages/core/src/enrich/extract.test.ts`, using the `seedNote` / `aiReturning` helpers the file already defines (`aiReturning(value)` scripts `generateJson`; `seedNote(text)` inserts a note and returns the `EnrichTarget`):

```ts
  it("returns the mood the model reported", async () => {
    const note = await seedNote("hôm nay mệt quá");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [], mood: 2 });

    // Red the moment `mood` is dropped from the returned object while the schema still asks
    // for it: the model is paid for the token and nothing ever writes the check-in.
    expect((await extractNote({ db, ai }, note)).mood).toBe(2);
  });

  it("returns null when the model reports no mood", async () => {
    const note = await seedNote("giá vé máy bay tháng sau");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [], mood: null });

    expect((await extractNote({ db, ai }, note)).mood).toBeNull();
  });

  /**
   * checkins_mood_or_energy (00013) constrains mood to 1..5. A responseSchema is a request,
   * not a guarantee -- the same reason intent and complexity are defaulted -- and a mood of 0
   * would be rejected by the CHECK, failing an extraction that was otherwise fine. Red when
   * the clamp is removed.
   */
  it("drops a mood outside 1..5 rather than passing it on", async () => {
    for (const bad of [0, 6, 4.5, "good", null]) {
      const note = await seedNote(`body ${String(bad)}`);
      const ai = aiReturning({ domain: null, domain_meta: {}, tags: [], mood: bad });
      expect((await extractNote({ db, ai }, note)).mood).toBeNull();
    }
  });

  /**
   * The prompt is the only thing that makes mood appear at all, and a prompt regression is
   * otherwise invisible until a user notices their moods stopped being recorded.
   * `aiCapturingPrompt` hands back what the model was actually shown.
   */
  it("tells the model when it may fill mood", async () => {
    const note = await seedNote("body");
    const { seen, ai } = aiCapturingPrompt({ domain: null, domain_meta: {}, tags: [], mood: null });
    await extractNote({ db, ai }, note);

    expect(seen[0]).toContain("mood is 1 to 5");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core --force`
Expected: FAIL — `result.mood` is `undefined`.

- [ ] **Step 3: Teach extract about mood**

In `packages/core/src/enrich/extract.ts`, add to the `Extraction` interface:

```ts
  mood?: unknown;
```

to `RESPONSE_SCHEMA.properties`:

```ts
    // 1..5, matching the checkins_mood_or_energy CHECK (00013). Nullable and usually null:
    // the prompt below only allows it when the text SAYS how the person feels.
    mood: { type: "integer", nullable: true },
```

and to `required`:

```ts
  required: ["intent", "complexity", "domain", "domain_meta", "tags", "mood"],
```

Add the rule to `buildPrompt`'s rules block, immediately after the `domain_meta` rule:

```ts
    "- mood is 1 to 5, and ONLY when the note says how the writer feels — \"mệt\", \"vui\",",
    "  \"chán\". A note about a difficult topic is not a bad mood. Return null if you are",
    "  inferring rather than reading.",
```

and the clamp plus the return:

```ts
  // The schema is a REQUEST, not a guarantee -- the same reason intent and complexity are
  // defaulted below. A mood outside 1..5 would be rejected by the checkins CHECK constraint
  // and fail an extraction that was otherwise fine, so it is dropped here instead.
  const rawMood = value.mood;
  const mood =
    typeof rawMood === "number" && Number.isInteger(rawMood) && rawMood >= 1 && rawMood <= 5
      ? rawMood
      : null;

  return {
    tags: accepted.length,
    tagNames: accepted,
    domain,
    domainMeta: meta,
    mood,
    intent: value.intent === "question" ? "question" : "statement",
    complexity: value.complexity === "complex" ? "complex" : "simple",
  };
```

Widen the declared return type to include `mood: number | null`.

- [ ] **Step 4: Run the core test to verify it passes**

Run: `pnpm turbo run test --filter=@cortex/core --force`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the check-in write**

In `packages/core/src/assistant/turn.test.ts`, not in the API e2e suite: that suite bootstraps
one app with a fixed `generateJson` script shared by every test, so it cannot vary the
classification per case. The double in `turn.test.ts` records every insert, which is exactly
what needs asserting.

```ts
  /**
   * Red when turn.ts reads the mood but never calls createWithId: the model has already been
   * paid for the token and nothing is written.
   */
  it("writes a check-in when the extraction reports a mood", async () => {
    const { client, inserted } = dbs();
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: ai({ mood: 4 }) },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));

    expect(inserted.checkins?.[0]).toMatchObject({ user_id: "u1", mood: 4 });
    const mood = events.find((e) => e.type === "mood");
    expect(mood).toMatchObject({ mood: 4 });
    // The id the client will mirror the row under. Without it, undo has nothing to name.
    expect((mood as { checkinId: string }).checkinId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("writes no check-in and emits no mood event when the extraction reports none", async () => {
    const { client, inserted } = dbs();
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: ai({ mood: null }) },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));

    expect(inserted.checkins).toBeUndefined();
    expect(events.map((e) => e.type)).not.toContain("mood");
  });

  /**
   * The check-in belongs to the moment the thought was captured, which offline can be hours
   * before the turn runs. Red when createdAt is omitted and the row lands at now().
   */
  it("dates the check-in from the note, not from the turn", async () => {
    const { client, inserted } = dbs();
    await collect(runTurn(
      { userDb: client, serviceDb: client, ai: ai({ mood: 3 }) },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));

    // NOTE.created_at, set in Task 5's fixture.
    expect(inserted.checkins?.[0]).toMatchObject({ created_at: "2026-08-14T01:02:03.000Z" });
  });

  /**
   * A failed check-in must not cost the user their answer. Red if the try/catch is removed:
   * the generator throws and the token stream never arrives.
   */
  it("still answers when the check-in write fails", async () => {
    const { client } = dbs({ failInsertOn: "checkins" });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: ai({ mood: 4 }) },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));

    expect(events.map((e) => e.type)).toContain("token");
  });
```

`dbs()` needs one more option for the last test — in `insertChain`, resolve to an error when the table matches:

```ts
  const insertChain = (name: string, row: Record<string, unknown>) => {
    (inserted[name] ??= []).push(row);
    return chain(() =>
      opts.failInsertOn === name
        ? { data: null, error: { code: "23514", message: "check constraint" } }
        : { data: { id: `${name}-1` }, error: null },
    );
  };
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/core --force`
Expected: FAIL — `inserted.checkins` is undefined and no `mood` event is emitted.

- [ ] **Step 7: Write the check-in from the turn**

In `packages/core/src/assistant/turn.ts`, after the `attached` yield and before the citations block:

```ts
  // Written by the TURN, not by extractNote, and the distinction matters: the 60-second sweep
  // runs extractNote too, and a sweep that wrote check-ins would manufacture mood history for
  // old notes at arbitrary times, with no screen to undo it on.
  if (extracted?.mood != null) {
    const checkinId = randomUUID();
    try {
      await new CheckinService(userDb, args.userId).createWithId(checkinId, {
        mood: extracted.mood,
        // The note's timestamp, not now(): offline, the thought can be hours older than
        // the turn that finally reached the server.
        createdAt: noteCreatedAt,
      });
      yield { type: "mood", checkinId, mood: extracted.mood };
    } catch (err) {
      // A failed check-in must not cost the user their answer. Logged, not raised.
      console.error(`[assistant] check-in write failed (request ${requestId}): ${errorMessage(err)}`);
    }
  }
```

Add to `AssistantEvent`:

```ts
  | { type: "mood"; checkinId: string; mood: number }
```

and the import:

```ts
import { CheckinService } from "../checkins/service.js";
```

- [ ] **Step 8: Run the core tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core --force`
Expected: PASS.

- [ ] **Step 9: Write the failing mobile test for the local mirror**

Add to `apps/mobile/src/lib/checkins.test.ts`:

```ts
  it("writes a check-in under an id the server chose", async () => {
    const id = randomUUID();
    await logCheckinWithId(target(db), id, 4);

    const [row] = db.prepare("SELECT * FROM checkins").all() as Record<string, unknown>[];
    expect(row.id).toBe(id);
    expect(row.mood).toBe(4);
  });

  /**
   * The whole reason the mirror exists. The server created the row and replication is a beat
   * slower than a thumb; undo against a local database that has not received it yet matches
   * nothing, PowerSync queues no operation, and the check-in the user just undid reappears.
   *
   * Red if logCheckinWithId writes a fresh uuid instead of the one it was given.
   */
  it("makes undo effective for a row the server created", async () => {
    const serverId = randomUUID();
    await logCheckinWithId(target(db), serverId, 2);
    await undoCheckin(target(db), serverId);

    expect(db.prepare("SELECT * FROM checkins").all()).toHaveLength(0);
  });
```

- [ ] **Step 10: Run it to verify it fails, then implement**

Run: `pnpm turbo run test --filter=@cortex/mobile --force`
Expected: FAIL — `logCheckinWithId is not a function`.

In `apps/mobile/src/lib/checkins.ts`:

```ts
/**
 * The local mirror of a check-in the SERVER created, under the server's id.
 *
 * The assistant writes the row when it reads a mood out of the note, and replication is a beat
 * slower than a thumb: undo against a database that has not received the row yet matches
 * nothing, PowerSync queues no op, and the check-in the user undid reappears moments later.
 * Writing it locally under the same id makes undo work immediately; the PUT that follows lands
 * in CheckinService.createWithId's 23505 branch and is a no-op, so the two writers converge on
 * one row by construction.
 */
export async function logCheckinWithId(
  db: CheckinTarget,
  id: string,
  mood: number,
): Promise<void> {
  await db.execute(LOG_CHECKIN_SQL, [id, mood]);
}
```

and refactor `logCheckin` to use it, so there is one statement and one call site:

```ts
export async function logCheckin(db: CheckinTarget, mood: number): Promise<string> {
  const id = randomUUID();
  await logCheckinWithId(db, id, mood);
  return id;
}
```

- [ ] **Step 11: Run the mobile tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/mobile --force`
Expected: PASS.

- [ ] **Step 12: Render the mood line and Undo in the box**

In `apps/mobile/src/screens/assistant-box.tsx`, add the imports and state:

```tsx
import { logCheckinWithId, undoCheckin } from "../lib/checkins";
```

```tsx
  const [mood, setMood] = useState<{ checkinId: string; mood: number } | null>(null);
```

reset it in `submit()` alongside the others (`setMood(null)`), handle the event inside the event loop:

```tsx
          else if (ev.type === "mood") {
            // Mirrored locally under the server's id so undo has a row to delete before
            // replication catches up. See lib/checkins.ts.
            await logCheckinWithId(db, ev.checkinId, ev.mood).catch(() => {});
            setMood({ checkinId: ev.checkinId, mood: ev.mood });
          }
```

and render it:

```tsx
      {mood ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text testID="box-mood">{`Đã ghi tâm trạng ${mood.mood}/5`}</Text>
          <Pressable
            testID="box-mood-undo"
            accessibilityRole="button"
            onPress={() => {
              const id = mood.checkinId;
              setMood(null);
              void undoCheckin(db, id);
            }}
          >
            <Text style={{ textDecorationLine: "underline" }}>Hoàn tác</Text>
          </Pressable>
        </View>
      ) : null}
```

- [ ] **Step 13: Remove the check-in widget**

`apps/mobile/app/index.tsx` — delete the `CheckinWidget` import and its element from the header.

```bash
git rm apps/mobile/src/screens/checkin-widget.tsx
```

If `checkin-widget.tsx` was the only consumer of anything in `lib/checkins.ts`, keep the lib — the box now consumes it.

- [ ] **Step 14: Verify everything**

Run: `pnpm turbo run test typecheck lint --filter=@cortex/core --filter=@cortex/api --filter=@cortex/mobile --force && pnpm turbo run bundle --filter=@cortex/mobile --force`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add packages/core/src/enrich/extract.ts packages/core/src/enrich/extract.test.ts packages/core/src/assistant/turn.ts packages/core/src/assistant/turn.test.ts apps/mobile/src/lib/checkins.ts apps/mobile/src/lib/checkins.test.ts apps/mobile/src/screens/assistant-box.tsx apps/mobile/app/index.tsx apps/mobile/src/screens/checkin-widget.tsx
git commit -F - <<'EOF'
feat: the AI writes the mood check-in, and Undo takes it back

extract gains a mood field, clamped to the 1..5 the checkins CHECK constraint
allows -- a responseSchema is a request, not a guarantee, and a mood of 0 would
fail an extraction that was otherwise fine. The prompt only allows it when the
text SAYS how the writer feels; a note about a hard topic is not a bad mood.

turn.ts writes the row, not extractNote, because the sweep runs extractNote too
and would manufacture mood history for old notes with no screen to undo it on.
The row is dated from the note, not from the turn: offline, the thought can be
hours older than the request that finally reached the server.

The client mirrors the row locally under the server's id. Without that, undo
runs against a database replication has not reached yet, matches nothing, queues
no op, and the check-in the user undid reappears moments later. The PUT that
follows hits createWithId's 23505 branch, so the two writers converge on one row.

The check-in widget is retired.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 8: The AI names the media item, and the box says which one

`resolveNoteMediaLink` returns `null` unless `domain_meta.pending_item` is present, and `pending_item` is device scaffolding the model knows nothing about. Left alone, an AI-classified media note gets `{rating, status}` and never links.

**Files:**
- Modify: `packages/core/src/enrich/extract.ts` (prompt only — `domainMetaSchemas.media` already accepts the field)
- Modify: `packages/core/src/assistant/turn.ts` (call the resolver, name the item on `attached`)
- Modify: `apps/api/src/enrich/enrich.service.ts` (the sweep's call site)
- Modify: `packages/core/src/media/service.test.ts`
- Modify: `apps/api/test/assistant.e2e.test.ts`
- Modify: `apps/mobile/src/screens/assistant-box.tsx` (render the item name)
- Modify: `apps/mobile/app/index.tsx` (drop `MediaLogForm`)
- Delete: `apps/mobile/src/screens/media-log-form.tsx`

**Interfaces:**
- Consumes: `MediaService.resolveNoteMediaLink(noteId, meta): Promise<MediaItem | null>`.
- Produces: the `attached` event gaining `mediaTitle?: string`.

- [ ] **Step 1: Teach the prompt to fill `pending_item`**

In `buildPrompt` in `packages/core/src/enrich/extract.ts`, after the `domain_meta` rule:

```ts
    "- when domain is \"media\", domain_meta.pending_item is REQUIRED and looks like",
    "  {\"kind\": \"movie\"|\"book\"|\"show\"|\"game\"|\"album\", \"title\": \"...\", \"year\": 2010}.",
    "  Use the work's own title as the person wrote it. Omit year when the text does not say.",
```

No schema change: `domainMetaSchemas.media` already declares `pending_item`, which is why
`NoteService.createWithId` was written not to strip it.

- [ ] **Step 2: Write the failing tests**

The prompt half, in `packages/core/src/enrich/extract.test.ts`:

```ts
  /**
   * The prompt is the ONLY thing that makes pending_item appear. Without it the model returns
   * {rating, status}, resolveNoteMediaLink sees no pending_item and returns null, and the
   * library never learns the film exists -- silently.
   */
  it("tells the model to name the work when the domain is media", async () => {
    const note = await seedNote("vừa xem xong Inception, 8.5/10");
    const { seen, ai } = aiCapturingPrompt({ domain: null, domain_meta: {}, tags: [], mood: null });
    await extractNote({ db, ai }, note);

    expect(seen[0]).toContain("pending_item");
  });

  /**
   * domainMetaSchemas.media accepts pending_item, so a model that fills it must have it
   * STORED rather than dropped by the meta validation -- it is the only thing a resolver or a
   * retry can work from. Red if the meta parse is ever narrowed to strip it.
   */
  it("stores a pending_item the model supplied", async () => {
    const note = await seedNote("vừa xem xong Inception");
    const ai = aiReturning({
      domain: "media", tags: [], mood: null,
      domain_meta: { rating: 8.5, pending_item: { kind: "movie", title: "Inception", year: 2010 } },
    });
    const out = await extractNote({ db, ai }, note);

    expect((out.domainMeta as Record<string, unknown>).pending_item)
      .toMatchObject({ title: "Inception" });
  });
```

The call-site half, in `packages/core/src/assistant/turn.test.ts`. Route the `media_items`
table in `dbs()` to a fixture row so `findOrCreate` resolves:

```ts
  /**
   * Red when the resolver call site is removed from the turn: the note is filed under "media"
   * with a rating and no media_item_id, and the box has nothing to name.
   */
  it("links a media note and names the item on the attached event", async () => {
    const { client } = dbs({ mediaItem: { id: "mi1", title: "Inception", kind: "movie" } });
    const scripted = ai({
      domain: "media",
      domain_meta: { rating: 8.5, pending_item: { kind: "movie", title: "Inception", year: 2010 } },
    });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: scripted },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));

    expect(events.find((e) => e.type === "attached")).toMatchObject({ mediaTitle: "Inception" });
  });

  /**
   * A failed link must not cost the answer -- the note and its tags are already the
   * deliverable. Red if the try/catch around the resolver is removed.
   */
  it("still answers when the media link fails", async () => {
    const { client } = dbs({ failInsertOn: "media_items" });
    const scripted = ai({
      domain: "media",
      domain_meta: { pending_item: { kind: "movie", title: "Unknown", year: 1 } },
    });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: scripted },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));

    expect(events.map((e) => e.type)).toContain("token");
  });
```

Add the `mediaItem` option to `dbs()` beside `note`, resolving the `media_items` select to it
(and to `{ data: null, error: null }` when absent, which is what drives `findOrCreate` into its
insert branch).

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core --force`
Expected: FAIL — the prompt contains no `pending_item` and `attached` carries no `mediaTitle`.

- [ ] **Step 4: Call the resolver from the turn**

In `packages/core/src/assistant/turn.ts`, replace the `attached` yield with a version that resolves media first:

```ts
  // Resolution runs AFTER extractNote returns, deliberately NOT inside it: in this file that
  // call is wrapped in withDeadline(..., EXTRACT_DEADLINE_MS), and a slow findOrCreate would
  // turn into `attached: degraded` -- trading the classification for a link.
  //
  // A throw is logged and swallowed. The note and its tags are already the deliverable, and
  // media_unresolved exists for the sync path, not for this one.
  let mediaTitle: string | undefined;
  if (extracted?.domain === "media") {
    try {
      const item = await new MediaService(userDb, args.userId)
        .resolveNoteMediaLink(args.noteId, extracted.domainMeta);
      if (item) mediaTitle = item.title;
    } catch (err) {
      console.error(`[assistant] media link failed (request ${requestId}): ${errorMessage(err)}`);
    }
  }

  yield extracted
    ? { type: "attached", domain: extracted.domain, domainMeta: extracted.domainMeta,
        tags: extracted.tagNames, ...(mediaTitle !== undefined ? { mediaTitle } : {}) }
    : { type: "attached", domain: null, domainMeta: {}, tags: [], degraded: true };
```

Add `mediaTitle?: string` to the `attached` member of `AssistantEvent`, and the import:

```ts
import { MediaService } from "../media/service.js";
```

- [ ] **Step 5: Call the resolver from the sweep**

In `apps/api/src/enrich/enrich.service.ts`, inside the `try` after `extractNote`:

```ts
        const extracted = await extractNote({ db, ai }, note);
        // The sweep's half of the same call site (spec §6.3). A note captured on web, or one
        // whose assistant turn died before this point, still needs its media identity resolved
        // -- and this is the only path that will ever run for it.
        if (extracted.domain === "media") {
          try {
            await new MediaService(db, row.user_id)
              .resolveNoteMediaLink(row.note_id, extracted.domainMeta);
          } catch (err) {
            // Never fails the enrichment: the note and its tags are already committed, and a
            // raise here would burn one of the note's five attempts on a link.
            console.error(`[enrich] note ${row.note_id} media link failed: ${errorMessage(err).slice(0, 500)}`);
          }
        }
```

(`embedNote` and `extractNote` are already awaited here in sequence — keep that order.) Add `MediaService` to the `@cortex/core` import at the top of the file.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core --filter=@cortex/api --force`
Expected: PASS.

- [ ] **Step 7: Render the item name and retire the media form**

In `apps/mobile/src/screens/assistant-box.tsx`, extend the `attached` line:

```tsx
      {attached ? (
        <Text testID="box-attached">
          {attached.mediaTitle
            ? `Đã ghi vào thư viện: ${attached.mediaTitle}`
            : attached.domain
              ? `Đã xếp vào: ${attached.domain}`
              : "Chưa xếp vào nhóm nào"}
          {attached.tags.length > 0 ? ` — thẻ ${attached.tags.join(", ")}` : ""}
        </Text>
      ) : null}
```

Add `mediaTitle?: string` to the `attached` member of `BoxEvent` in `apps/mobile/src/lib/assistant/stream.ts` and pass it through in the mapper:

```ts
          ...(typeof d.mediaTitle === "string" ? { mediaTitle: d.mediaTitle } : {}),
```

`apps/mobile/app/index.tsx` — delete the `MediaLogForm` import and its element. The header is now `<AssistantBox />` alone.

```bash
git rm apps/mobile/src/screens/media-log-form.tsx
```

`apps/mobile/src/lib/media-log.ts` keeps its tests and stays: it is the shape of `pending_item`, which the server still parses.

- [ ] **Step 8: Verify everything**

Run: `pnpm turbo run test typecheck lint --filter=@cortex/core --filter=@cortex/api --filter=@cortex/mobile --force && pnpm turbo run bundle --filter=@cortex/mobile --force`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/enrich/extract.ts packages/core/src/enrich/extract.test.ts packages/core/src/assistant/turn.ts packages/core/src/assistant/turn.test.ts apps/api/src/enrich/enrich.service.ts apps/mobile/src/lib/assistant/stream.ts apps/mobile/src/screens/assistant-box.tsx apps/mobile/app/index.tsx apps/mobile/src/screens/media-log-form.tsx
git commit -F - <<'EOF'
feat: the AI names the media item, and the box says which one it linked

resolveNoteMediaLink returns null unless domain_meta.pending_item is present,
and pending_item was device scaffolding the model knew nothing about -- so an
AI-classified media note got {rating, status} and never linked. The extract
prompt now fills it; domainMetaSchemas.media already accepted the field, which
is why createWithId was written not to strip it.

Two call sites, both AFTER extractNote returns rather than inside it: in the
turn that call is wrapped in a 4s deadline, and a slow findOrCreate would become
`attached: degraded` -- trading the classification for a link.

media_items identity is (user_id, kind, lower(title)) and there is no delete
surface, so a mistyped title is a permanent library row. The attached line names
the item it linked, which is the cheapest thing that makes that visible rather
than silent. Correcting it is stage D.

The media log form is retired; the box is now the only input on the screen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 9: The two budgets stop reading one total

`usage_month_to_date_usd` sums every `kind` and every `source`, so `ENRICH_MONTHLY_BUDGET_USD` and `ASSISTANT_MONTHLY_BUDGET_USD` are two thresholds on one number. C2 is what multiplies the traffic through it: capture on mobile costs nothing today and will pay a classification plus a retrieval embedding per submission.

**Files:**
- Create: `supabase/migrations/00028_usage_by_source.sql`
- Modify: `packages/core/src/enrich/budget.ts`
- Modify: `packages/core/src/enrich/budget.test.ts`
- Modify: `packages/core/src/assistant/turn.ts:148` (pass `"assistant"`)
- Modify: `apps/api/src/enrich/enrich.service.ts` (pass `"sweep"`)

**Interfaces:**
- Produces: `monthToDateUsd(db, userId, source?)` and `isOverBudget(db, userId, limitUsd, source?)`. Omitting `source` keeps the whole-total behaviour.

- [ ] **Step 1: Write the migration**

`supabase/migrations/00028_usage_by_source.sql`:

```sql
-- 00021 sums cost_usd across every kind and every source, so ENRICH_MONTHLY_BUDGET_USD and
-- ASSISTANT_MONTHLY_BUDGET_USD have always been two thresholds read off ONE total. 00027 added
-- usage_ledger.source to make the distinction possible; this is the half that uses it.
--
-- The visible failure without it: the assistant answers `declined: budget` while the enrichment
-- sweep is what spent the money, which on screen is indistinguishable from the assistant being
-- broken. Stage C2 is what makes that likely rather than theoretical -- it puts a classification
-- and a retrieval embedding behind every capture on the device where capture actually happens.
--
-- p_source is NULLABLE and defaults to null, which preserves 00021's exact behaviour for any
-- caller that wants the whole total. A new argument with a default, not a new function: two
-- functions would mean two places to keep the UTC month boundary correct.
--
-- security definer / set search_path / revoke-then-grant-service_role is unchanged from 00021:
-- usage_ledger is server-only and authenticated has no grant on it at all.
create or replace function public.usage_month_to_date_usd(p_user_id uuid, p_source text default null)
returns numeric
language sql
security definer
set search_path = public
as $$
  select coalesce(sum(cost_usd), 0)
  from public.usage_ledger
  where user_id = p_user_id
    and created_at >= (date_trunc('month', timezone('utc', now())) at time zone 'utc')
    and (p_source is null or source = p_source);
$$;

-- The one-argument signature from 00021 still exists as a separate overload after a
-- `create or replace` with a new defaulted parameter, and an overload PostgREST can resolve two
-- ways answers PGRST203 rather than picking one. Dropped explicitly so there is exactly one.
drop function if exists public.usage_month_to_date_usd(uuid);

revoke execute on function public.usage_month_to_date_usd(uuid, text) from public;
grant execute on function public.usage_month_to_date_usd(uuid, text) to service_role;
```

- [ ] **Step 2: Write the failing test**

Add to `packages/core/src/enrich/budget.test.ts`, inside the existing `describe("usage and budget")` block. That file's `beforeEach` creates a fresh `userId` and `db` is a service client — use those, and the literal model ids the file already uses rather than importing constants it does not.

```ts
  /**
   * Red the moment the source filter is dropped from the RPC or from isOverBudget's call:
   * enrichment spend declines an assistant turn, and the user is told the assistant hit a
   * limit it never approached.
   */
  it("counts only the named source", async () => {
    await recordUsage(db, { userId, kind: "tag", model: "gemini-3.5-flash-lite",
      inputTokens: 1_000_000, outputTokens: 0, source: "sweep" });
    await recordUsage(db, { userId, kind: "chat", model: "gemini-3.1-pro-preview",
      inputTokens: 1000, outputTokens: 0, source: "assistant" });

    const sweep = await monthToDateUsd(db, userId, "sweep");
    const assistant = await monthToDateUsd(db, userId, "assistant");
    const total = await monthToDateUsd(db, userId);

    expect(sweep).toBeGreaterThan(0);
    expect(assistant).toBeGreaterThan(0);
    expect(assistant).not.toBeCloseTo(sweep, 10);
    // Omitting the source still means "everything", which is 00021's behaviour unchanged.
    expect(total).toBeCloseTo(sweep + assistant, 10);
  });

  it("does not decline the assistant for money the sweep spent", async () => {
    await recordUsage(db, { userId, kind: "tag", model: "gemini-3.5-flash-lite",
      inputTokens: 100_000_000, outputTokens: 0, source: "sweep" });

    expect(await isOverBudget(db, userId, 1, "assistant")).toBe(false);
    expect(await isOverBudget(db, userId, 1, "sweep")).toBe(true);
  });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm supabase db push` (or `pnpm supabase migration up` against the local stack), then
`pnpm turbo run test --filter=@cortex/core --force`
Expected: FAIL — `monthToDateUsd` takes two arguments.

- [ ] **Step 4: Thread the source through budget.ts**

```ts
export async function monthToDateUsd(
  db: SupabaseClient,
  userId: string,
  source?: UsageSource,
): Promise<number> {
  const { data, error } = await db.rpc("usage_month_to_date_usd", {
    p_user_id: userId,
    // Explicit null rather than an omitted key: PostgREST resolves an overload by the argument
    // NAMES it is given, and omitting this would look for a one-argument function that 00028
    // drops.
    p_source: source ?? null,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function isOverBudget(
  db: SupabaseClient,
  userId: string,
  limitUsd: number,
  source?: UsageSource,
): Promise<boolean> {
  return (await monthToDateUsd(db, userId, source)) > limitUsd;
}
```

- [ ] **Step 5: Pass the source at both call sites**

`packages/core/src/assistant/turn.ts`:

```ts
  if (await isOverBudget(serviceDb, args.userId, args.budgetUsd, "assistant")) {
```

`apps/api/src/enrich/enrich.service.ts`:

```ts
        over = await isOverBudget(db, row.user_id, budgetUsd, "sweep");
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core --filter=@cortex/api --filter=@cortex/db --force`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/00028_usage_by_source.sql packages/core/src/enrich/budget.ts packages/core/src/enrich/budget.test.ts packages/core/src/assistant/turn.ts apps/api/src/enrich/enrich.service.ts
git commit -F - <<'EOF'
fix: the enrich and assistant budgets stop reading one shared total

00021 sums cost_usd across every kind and every source, so the two
MONTHLY_BUDGET_USD settings have always been two thresholds on one number.
00027 added usage_ledger.source to make the distinction possible and nothing
used it.

C2 is what makes it bite: capture on mobile costs nothing in the moment today,
and after this stage every submission pays a classification and a retrieval
embedding. The failure it produces is `declined: budget` on the assistant while
the sweep is what spent the money -- on screen, indistinguishable from the
assistant being broken.

p_source defaults to null, which is 00021's exact behaviour, so any caller that
wants the whole total still gets it. The one-argument overload is dropped
explicitly: an overload PostgREST can resolve two ways answers PGRST203.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 10: Rewrite the Maestro flows the widgets took with them

`02-online-basics.yaml` and `04a-offline-actions.yaml` tap `capture-input` / `capture-save` and assert on the mood widget's `"Mood 4 of 5 — good"` label; `scripts/assert-offline-results.js` checks the double-tapped Save and the mood undo against the database. Those two database assertions survive unchanged — only the taps that produce them move.

`e2e-mobile.yml` is `workflow_call`-only, invoked from `post-merge.yml`, so **it cannot fail this PR**. A stale flow costs nothing until it costs it on `main`, which is exactly why this task is inside the stage rather than after it.

**Files:**
- Modify: `.maestro/02-online-basics.yaml`
- Modify: `.maestro/04a-offline-actions.yaml`
- Modify: `.maestro/scripts/assert-offline-results.js` (comments only — the assertions hold)

**Interfaces:**
- Consumes: the testIDs Task 6 and 7 introduced — `box-input`, `box-send`, `box-answer`, `box-offline-match`, `box-status`, `box-mood`, `box-mood-undo`.

- [ ] **Step 1: Replace the capture taps in `02-online-basics.yaml`**

Every `capture-input` / `capture-save` pair becomes:

```yaml
- tapOn:
    id: "box-input"
- inputText: "${CAPTURE_TEXT}"
- tapOn:
    id: "box-send"
# The box clears on the LOCAL insert, before any network -- so the cleared field is the
# capture confirmation, exactly as it was for quick capture. Not `assertVisible` on a badge:
# there is no 1500ms "Saved ✓" label any more.
- assertVisible:
    id: "box-input"
    text: ""
# The online half of the turn: an answer actually streams back. This is the assertion the
# whole SSE path exists for, and no vitest suite can make it -- they all inject a fake fetch.
- extendedWaitUntil:
    visible:
      id: "box-answer"
    timeout: 30000
```

The mood section (line 132 onward) drops its widget taps and asserts on the box instead:

```yaml
# ---- mood, written by the assistant from the sentence ----
- tapOn:
    id: "box-input"
- inputText: "hôm nay mình thấy vui"
- tapOn:
    id: "box-send"
# Online only, and it is a model call, so it needs a real timeout rather than the default.
- extendedWaitUntil:
    visible:
      id: "box-mood"
    timeout: 30000
```

- [ ] **Step 2: Replace the capture taps in `04a-offline-actions.yaml`**

Section 5's double-tap keeps its point exactly — the in-flight guard is still what stops two notes:

```yaml
# ---- 5. double-tap Send ----
- tapOn:
    id: "box-input"
- inputText: "${DOUBLE_TAP_TEXT}"
- tapOn:
    id: "box-send"
- tapOn:
    id: "box-send"
```

Section 8's mood check-in becomes an offline-then-undo flow. **Note the change in what is being tested:** offline there is no assistant, so no mood is written — the check-in undo path is now only exercisable online. Move it to `02-online-basics.yaml` after the mood assertion added in Step 1:

```yaml
- tapOn:
    id: "box-mood-undo"
- assertNotVisible:
    id: "box-mood"
```

and add the offline answer assertion in its place in `04a`:

```yaml
# ---- 8. offline, the box answers from the local index ----
- tapOn:
    id: "box-input"
- inputText: "định giá"
- tapOn:
    id: "box-send"
# No network, so this must resolve from local SQLite alone and quickly. A timeout here means
# the offline branch is reaching for the network.
- extendedWaitUntil:
    visible:
      id: "box-status"
    timeout: 5000
```

- [ ] **Step 3: Update the assertion script's comments**

In `.maestro/scripts/assert-offline-results.js`, the two checks stand; only their provenance changed. Update the comment at line ~102:

```js
// 02 logged a mood through the assistant box and undid it. A check-in surviving here means undo
// produced no local delete, or produced one PowerSync never uploaded -- the failure the local
// mirror in lib/checkins.ts exists to prevent.
```

and at line ~43:

```js
/* ---- 5. the double-tapped Send produced ONE note ---- */
```

- [ ] **Step 4: Run the flows**

Run: `maestro test .maestro/02-online-basics.yaml` and `maestro test .maestro/04a-offline-actions.yaml` against a device with the Task 8 build installed.
Expected: PASS. Each fix round costs an APK build, so do not start here — every logic assertion in this stage is already green under vitest.

If an assertion cannot see something, read the artifacts before blaming sync: a header taller than the viewport, the keyboard covering the rows, and whole-text regex selectors have each cost a day already.

- [ ] **Step 5: Commit**

```bash
git add .maestro/02-online-basics.yaml .maestro/04a-offline-actions.yaml .maestro/scripts/assert-offline-results.js
git commit -F - <<'EOF'
test(mobile): point the Maestro flows at the box

The flows tapped capture-input/capture-save and asserted on the mood widget's
label, all three of which this stage deleted -- they broke by construction, so
rewriting them is work inside the stage, not fallout from it.

The two database assertions in assert-offline-results.js survive unchanged: one
note from a double tap, and no surviving check-in after an undo. Only the taps
that produce them moved.

One real change in coverage: the mood undo path moves from 04a to 02, because
offline there is no assistant and therefore no mood to undo. 04a gains the
offline answer assertion in its place.

e2e-mobile.yml is workflow_call-only and cannot fail this PR, which is exactly
why this lands before the merge rather than after the first red run on main.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Closing checks before the PR

- [ ] `pnpm turbo run build typecheck lint test --force` across the workspace, with the local Supabase stack up. Read the `Cached:` line.
- [ ] `pnpm turbo run bundle --filter=@cortex/mobile --force` — the step that catches an import resolving only under node.
- [ ] The home screen's header is `<AssistantBox />` alone; `quick-capture.tsx`, `checkin-widget.tsx` and `media-log-form.tsx` are gone from `apps/mobile/src/screens/`.
- [ ] Update `docs/superpowers/specs/2026-08-15-stage-c2-mobile-box-design.md` §10 with anything discovered that was left undone, and note the spike's outcome in §8.
- [ ] `docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md` §5.2's mermaid describes this stage in the future tense ("This is the stage C2 design; until it ships…"). Once merged, drop that sentence.
