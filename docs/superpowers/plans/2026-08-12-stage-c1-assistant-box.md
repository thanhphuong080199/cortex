# Stage C1 — the assistant box — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One input box on web that saves every thought instantly and answers when you ask, with citations — and a `usage_ledger` that can say where every cent went.

**Architecture:** The client writes the note through `POST /notes` **before** opening a stream, so the note's existence never depends on the AI path. `POST /assistant` is Server-Sent Events: it classifies and retrieves **concurrently**, then streams an answer. Logic lives in `packages/core/src/assistant/`, wiring in `apps/api`.

**Tech Stack:** TypeScript, NestJS 11, `@supabase/supabase-js`, Postgres 15 + pgvector, Gemini API, Next.js 15 (App Router), vitest, Playwright, turbo, pnpm.

Spec: `docs/superpowers/specs/2026-08-12-stage-c1-assistant-box-design.md`.

## Global Constraints

- **Always `pnpm turbo run test --filter=<pkg>`, never `pnpm --filter <pkg> test`.** `@cortex/shared` and `@cortex/core` are consumed as compiled `dist/`, and only turbo's `test` → `^build` edge rebuilds them first.
- **Read the `Cached:` line.** A gate is evidence only when it says `0 cached`. Use `--force` for the final gate of a task.
- **Docker Desktop must be up** for `@cortex/db`, `@cortex/api` and `@cortex/core` suites. When it is down those are turbo cache replays, not runs, and must never be reported as runs.
- **After `supabase db reset --local`, restart Kong** (`docker restart supabase_kong_phase-0-foundations`) or every auth call fails with `AuthRetryableFetchError`.
- **New env vars must be added in FOUR places**: `turbo.json`'s `test.env`, `.github/workflows/ci.yml`, `.github/workflows/e2e-web.yml`, `.github/workflows/e2e-mobile.yml`. Three of the four have been missed before (issue-log A1, G1). Grep `.github/` for an existing var name and expect three hits.
- **Migrations must schema-qualify extension types**: `extensions.vector(...)`. Unqualified works locally and fails only against the hosted project.
- **Never call the real Gemini API from a test.** Every suite uses `createFakeAi`.
- **No ASCII-range character classes** in any text handling. Cortex's users write Vietnamese; `[A-Z]` and `to_tsvector('english')` were both this mistake (PR #12, #13).
- **Never log note text or query text** (parent spec §15.6 rule 1). Log ids and `errorMessage(err)` only.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/00027_assistant_ledger.sql` | ledger attribution columns, `last_error_status`, chat index |
| `packages/core/src/enrich/budget.ts` | `recordUsage` widened to carry attribution |
| `packages/core/src/ai/client.ts` | `AiClient` gains `generateStream` |
| `packages/core/src/ai/fake.ts` | scripted `generateStream` for tests |
| `packages/core/src/ai/gemini.ts` | real streaming, and `usageMetadata` off the final chunk |
| `packages/core/src/enrich/extract.ts` | `intent` + `complexity` + the language rule |
| `packages/core/src/assistant/context.ts` | session selection, the 4-hour reset, the rolling window |
| `packages/core/src/assistant/retrieve.ts` | one call into `search_notes` for both branches |
| `packages/core/src/assistant/prompts.ts` | the two system prompts |
| `packages/core/src/assistant/turn.ts` | orchestration; yields the event stream |
| `packages/shared/src/dto/assistant.ts` | `assistantInput` and the SSE event union |
| `apps/api/src/assistant.controller.ts` | SSE framing, auth, abort |
| `apps/web/src/app/assistant-box.tsx` | the box; replaces `quick-capture.tsx` |

---

## Task 1: `00027` — a ledger that can be asked where the money went

**Files:**
- Create: `supabase/migrations/00027_assistant_ledger.sql`
- Test: `packages/db/src/test/usage-ledger-attribution.test.ts`

**Interfaces:**
- Produces: `usage_ledger` columns `note_id uuid`, `source text`, `request_id uuid`, `attempt int`, `latency_ms int`, `content_chars int`; `note_enrichment.last_error_status int`; index `chat_messages_user_idx`.

**Context.** `usage_ledger` (`00007`) answers two of the nine cost questions the project needs. It cannot separate a search from a note embedding — `search.controller.ts:74` and `embed.ts:84` both write `kind='embed'` — and it cannot attribute spend to a note, a turn, or a retry. `kind`'s CHECK constraint is **not** touched: `packages/shared/src/enums.ts:76` mirrors it and `enum-parity.test.ts` fails if the two drift.

`chat_messages` has `(session_id, created_at)`; the 4-hour reset needs the user's most recent message across sessions, so it needs `(user_id, created_at desc)`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/test/usage-ledger-attribution.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

describe("usage_ledger attribution (00027)", () => {
  let user: string;
  beforeAll(async () => {
    ({ id: user } = await makeUser("ledger-attrib@example.com"));
  });

  it("stores every attribution column a cost question needs", async () => {
    const { data: note } = await admin.from("notes")
      .insert({ user_id: user, content: "a note to attribute spend to" })
      .select("id").single();
    const requestId = crypto.randomUUID();

    const { error } = await admin.from("usage_ledger").insert({
      user_id: user, kind: "chat", model: "test-model",
      input_tokens: 10, output_tokens: 5, cost_usd: 0.001,
      note_id: note!.id, source: "assistant", request_id: requestId,
      attempt: 2, latency_ms: 1234, content_chars: 40,
    });
    expect(error).toBeNull();

    const { data } = await admin.from("usage_ledger")
      .select("note_id, source, request_id, attempt, latency_ms, content_chars")
      .eq("request_id", requestId).single();
    expect(data).toMatchObject({
      note_id: note!.id, source: "assistant", request_id: requestId,
      attempt: 2, latency_ms: 1234, content_chars: 40,
    });
  });

  // The whole point of `source`: 'embed' is written by BOTH the sweep and a search, so
  // without it "cost per search" is unanswerable.
  it("separates a search embedding from a note embedding", async () => {
    const tag = crypto.randomUUID();
    await admin.from("usage_ledger").insert([
      { user_id: user, kind: "embed", model: tag, source: "sweep", cost_usd: 0.02 },
      { user_id: user, kind: "embed", model: tag, source: "search", cost_usd: 0.01 },
    ]);
    const { data } = await admin.from("usage_ledger")
      .select("source, cost_usd").eq("model", tag);
    const bySource = Object.fromEntries((data ?? []).map((r) => [r.source, Number(r.cost_usd)]));
    expect(bySource).toEqual({ sweep: 0.02, search: 0.01 });
  });

  it("rejects a source outside the vocabulary", async () => {
    const { error } = await admin.from("usage_ledger")
      .insert({ user_id: user, kind: "embed", source: "nonsense" });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514"); // check_violation
  });

  it("records the HTTP status a note's last enrichment failure carried", async () => {
    const { data: note } = await admin.from("notes")
      .insert({ user_id: user, content: "a note that failed enrichment" })
      .select("id").single();
    const { error } = await admin.from("note_enrichment").insert({
      note_id: note!.id, user_id: user, attempts: 1, last_error_status: 429,
    });
    expect(error).toBeNull();
  });

  // The 4-hour reset reads the user's newest message ACROSS sessions, so it needs
  // (user_id, created_at) -- chat_messages_session_idx leads on session_id and cannot serve
  // it. PostgREST does not expose pg_indexes, so this asserts the QUERY the reset issues,
  // which is what actually has to work.
  it("supports the newest-message-per-user query the 4-hour reset issues", async () => {
    const { data: session } = await admin.from("chat_sessions")
      .insert({ user_id: user }).select("id").single();
    await admin.from("chat_messages").insert([
      { user_id: user, session_id: session!.id, role: "user", content: "cũ" },
      { user_id: user, session_id: session!.id, role: "user", content: "mới" },
    ]);

    const { data, error } = await admin.from("chat_messages")
      .select("content, created_at").eq("user_id", user)
      .order("created_at", { ascending: false }).limit(1);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/db --force
```

Expected: the first four tests fail with PostgREST `PGRST204` ("column ... does not exist") or `42703`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00027_assistant_ledger.sql`:

```sql
-- usage_ledger answered two of the nine cost questions this project needs. The gap that
-- matters most: 'embed' is written by BOTH the enrichment sweep (embed.ts) and by every
-- search (search.controller.ts), so "cost per search" was unanswerable, and stage C is about
-- to add a third writer that costs ~6x the whole pipeline.
--
-- `kind` is deliberately NOT touched. packages/shared/src/enums.ts mirrors its CHECK
-- constraint and packages/db's enum-parity test fails if the two drift; 'chat' is already in
-- the vocabulary, which is what the assistant writes.
--
-- Every column is nullable. Existing rows predate stage C and must stay valid, and a ledger
-- write must never be the thing that fails a working request.
alter table public.usage_ledger
  add column note_id uuid references public.notes(id) on delete set null,
  -- `set null`, not `cascade`: deleting a note must not erase the record that money was
  -- spent on it. The spend happened whatever became of the note.
  add column source text,
  add column request_id uuid,
  add column attempt int,
  add column latency_ms int,
  -- Not a cost column. The token counts for `kind='embed'` are a chars/4 ESTIMATE, and that
  -- ratio is an English one -- Vietnamese runs nearer 2-3 chars per token, so embedding spend
  -- is under-reported by roughly 40-60% for the primary corpus language. Storing the character
  -- count makes the ratio recalibratable later from data, which beats replacing a known-wrong
  -- divisor with an unknown-wrong one.
  add column content_chars int;

alter table public.usage_ledger
  add constraint usage_ledger_source_check
  check (source is null or source in ('sweep', 'assistant', 'search'));

-- Grouping: "cost per answered question" sums the classify row and the answer row of one turn.
create index usage_ledger_request_idx on public.usage_ledger (request_id)
  where request_id is not null;
create index usage_ledger_note_idx on public.usage_ledger (note_id)
  where note_id is not null;

-- gemini.ts attaches `status` to its errors specifically so a caller can tell a 429 from a
-- 400. No caller does yet. Recording it costs nothing and makes the retry mix measurable
-- without parsing error strings.
alter table public.note_enrichment add column last_error_status int;

-- The 4-hour context reset reads the user's most recent chat message ACROSS sessions.
-- chat_messages_session_idx is (session_id, created_at) -- wrong leading column for that.
create index chat_messages_user_idx on public.chat_messages (user_id, created_at desc);

-- usage_ledger and note_enrichment stay server-only: no grant to authenticated, here or
-- anywhere. 00007 and 00018 established that and nothing in stage C changes it.
```

- [ ] **Step 4: Apply and run**

```bash
npx supabase db reset --local
docker restart supabase_kong_phase-0-foundations
pnpm turbo run test --filter=@cortex/db --force
```

Expected: all pass, `0 cached`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00027_assistant_ledger.sql packages/db/src/test/usage-ledger-attribution.test.ts
git commit -m "feat(db): a ledger that can be asked where the money went

usage_ledger answered two of the nine cost questions this project needs. The
gap that mattered most: 'embed' is written by both the sweep and every search,
so cost-per-search was unanswerable -- and stage C adds a third writer that
costs roughly six times the whole enrichment pipeline.

content_chars is not a cost column. The chars/4 token estimate is an English
ratio and Vietnamese runs nearer 2-3, so embedding spend is under-reported by
40-60% for the primary corpus language. Storing the character count makes the
ratio recalibratable from data later rather than lost.

note_id is ON DELETE SET NULL: deleting a note must not erase the record that
money was spent on it.

kind's CHECK is untouched -- enums.ts mirrors it and enum-parity would fail.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: `recordUsage` carries the attribution

**Files:**
- Modify: `packages/core/src/enrich/budget.ts:26-39`
- Modify: `packages/core/src/enrich/embed.ts:84`, `packages/core/src/enrich/extract.ts:111`
- Modify: `apps/api/src/search.controller.ts:72-78`
- Test: `packages/core/src/enrich/budget.test.ts`

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces:
  ```ts
  export type UsageSource = "sweep" | "assistant" | "search";
  export async function recordUsage(
    db: SupabaseClient,
    u: {
      userId: string;
      kind: "embed" | "tag" | "chat";
      model: string;
      inputTokens: number;
      outputTokens: number;
      source: UsageSource;
      noteId?: string;
      requestId?: string;
      attempt?: number;
      latencyMs?: number;
      contentChars?: number;
    },
  ): Promise<void>;
  ```
  `source` is **required** — an optional one would silently reproduce the gap Task 1 exists to close.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/enrich/budget.test.ts`:

```ts
describe("recordUsage attribution", () => {
  it("writes every attribution field through to the row", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = {
      from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }),
    } as unknown as SupabaseClient;

    await recordUsage(db, {
      userId: "u1", kind: "chat", model: "m", inputTokens: 10, outputTokens: 5,
      source: "assistant", noteId: "n1", requestId: "r1", attempt: 2,
      latencyMs: 900, contentChars: 40,
    });

    expect(rows[0]).toMatchObject({
      user_id: "u1", kind: "chat", source: "assistant", note_id: "n1",
      request_id: "r1", attempt: 2, latency_ms: 900, content_chars: 40,
    });
  });

  it("omits absent optional fields rather than writing nulls", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = {
      from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }),
    } as unknown as SupabaseClient;

    await recordUsage(db, {
      userId: "u1", kind: "embed", model: "m", inputTokens: 1, outputTokens: 0, source: "sweep",
    });

    expect(rows[0]).not.toHaveProperty("note_id");
    expect(rows[0]).not.toHaveProperty("request_id");
    expect(rows[0]!.source).toBe("sweep");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

Expected: TypeScript rejects `source` as an unknown property, or the assertion on `source` fails.

- [ ] **Step 3: Implement**

Replace `recordUsage` in `packages/core/src/enrich/budget.ts`:

```ts
/** Which part of the system spent this. See 00027 -- 'embed' alone cannot answer that. */
export type UsageSource = "sweep" | "assistant" | "search";

export async function recordUsage(
  db: SupabaseClient,
  u: {
    userId: string;
    kind: "embed" | "tag" | "chat";
    model: string;
    inputTokens: number;
    outputTokens: number;
    source: UsageSource;
    noteId?: string;
    requestId?: string;
    attempt?: number;
    latencyMs?: number;
    contentChars?: number;
  },
): Promise<void> {
  // `source` is REQUIRED, not optional with a default. A default would put every new call
  // site into whichever bucket the default names, which is exactly the ambiguity 00027
  // exists to remove -- and it would do it silently.
  //
  // Optional fields are OMITTED rather than written as null so a row's shape says which
  // facts were actually known. `undefined` would be serialised away by PostgREST anyway;
  // spelling it out means a reader of this function does not have to know that.
  const row: Record<string, unknown> = {
    user_id: u.userId,
    kind: u.kind,
    model: u.model,
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cost_usd: priceUsd(u.model, u.inputTokens, u.outputTokens),
    source: u.source,
  };
  if (u.noteId !== undefined) row.note_id = u.noteId;
  if (u.requestId !== undefined) row.request_id = u.requestId;
  if (u.attempt !== undefined) row.attempt = u.attempt;
  if (u.latencyMs !== undefined) row.latency_ms = u.latencyMs;
  if (u.contentChars !== undefined) row.content_chars = u.contentChars;

  const { error } = await db.from("usage_ledger").insert(row);
  if (error) throw error;
}
```

- [ ] **Step 4: Update the three existing call sites**

`packages/core/src/enrich/embed.ts:84` — add `source`, `noteId`, and the character count that makes the estimate recalibratable:

```ts
    await recordUsage(db, {
      userId: note.userId, kind: "embed", model, inputTokens, outputTokens: 0,
      source: "sweep", noteId: note.noteId,
      contentChars: stale.reduce((n, c) => n + c.content.length, 0),
    });
```

`packages/core/src/enrich/extract.ts:111`:

```ts
  await recordUsage(db, {
    userId: note.userId, kind: "tag", model, inputTokens, outputTokens,
    source: "sweep", noteId: note.noteId, contentChars: note.contentText.length,
  });
```

`apps/api/src/search.controller.ts:72` — inside the existing try/catch, unchanged in every other respect:

```ts
      await recordUsage(this.db, {
        userId: user.id, kind: "embed", model, inputTokens, outputTokens: 0,
        source: "search", contentChars: body.q.length,
      });
```

- [ ] **Step 5: Run every suite that touches it**

```bash
pnpm turbo run test --filter=@cortex/core --filter=@cortex/api --force
```

Expected: all pass, `0 cached`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/enrich packages/core/src/ai apps/api/src/search.controller.ts
git commit -m "feat(core): every ledger row now says which part of the system spent it

source is required rather than optional-with-a-default. A default would put
every future call site into whichever bucket the default names -- silently --
which is the ambiguity 00027 exists to remove.

Optional fields are omitted rather than written as null, so a row's shape says
which facts were actually known.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: `generateStream`, and the token count that only arrives at the end

**Files:**
- Modify: `packages/core/src/ai/client.ts`
- Modify: `packages/core/src/ai/fake.ts:22-28`
- Modify: `packages/core/src/ai/gemini.ts`
- Test: `packages/core/src/ai/fake.test.ts`, `packages/core/src/ai/gemini.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StreamChunk { text: string }
  export interface StreamUsage { inputTokens: number; outputTokens: number; model: string }
  export interface StreamResult {
    chunks: AsyncIterable<StreamChunk>;
    /** Resolves when the stream ends -- successfully or not. */
    usage: () => StreamUsage | null;
  }
  // on AiClient:
  generateStream(args: {
    prompt: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<StreamResult>;
  ```

**Context the implementer needs.** Streaming APIs report token counts in the **final** chunk. Answer generation is ~75% of this system's spend; if `usageMetadata` is dropped on the floor, the largest line item has no row in `usage_ledger` at all and §7 of the spec is defeated. `usage()` is a function rather than a promise so a caller that abandons the stream can still read whatever was counted.

- [ ] **Step 1: Write the failing test for the fake**

Append to `packages/core/src/ai/fake.test.ts`:

```ts
describe("createFakeAi.generateStream", () => {
  it("yields the scripted chunks and then reports usage", async () => {
    const ai = createFakeAi({
      generateStream: async () => ({
        chunks: (async function* () { yield { text: "hel" }; yield { text: "lo" }; })(),
        usage: () => ({ inputTokens: 7, outputTokens: 2, model: "fake-stream" }),
      }),
    });

    const res = await ai.generateStream({ prompt: "p", model: "fake-stream" });
    let out = "";
    for await (const c of res.chunks) out += c.text;

    expect(out).toBe("hello");
    expect(res.usage()).toEqual({ inputTokens: 7, outputTokens: 2, model: "fake-stream" });
  });

  it("throws a named error when a test calls it without scripting it", async () => {
    const ai = createFakeAi();
    await expect(ai.generateStream({ prompt: "p", model: "m" }))
      .rejects.toThrow(/generateStream was called but not scripted/);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

Expected: `ai.generateStream is not a function`.

- [ ] **Step 3: Extend the interface and the fake**

In `packages/core/src/ai/client.ts`, append:

```ts
export interface StreamChunk {
  text: string;
}

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface StreamResult {
  chunks: AsyncIterable<StreamChunk>;
  /**
   * The token counts, or null if the stream never reported them.
   *
   * A FUNCTION, not a promise, and readable at any time. Streaming APIs report usage in the
   * FINAL chunk, so a caller that aborts mid-stream would never see a promise resolve -- and
   * an aborted answer is still money spent. Reading whatever was counted is the point.
   */
  usage: () => StreamUsage | null;
}
```

and add to `AiClient`:

```ts
  generateStream(args: { prompt: string; model: string; signal?: AbortSignal }): Promise<StreamResult>;
```

In `packages/core/src/ai/fake.ts`, add to `FakeAiScript`:

```ts
  generateStream?: AiClient["generateStream"];
```

and to the returned object in `createFakeAi`:

```ts
    generateStream:
      script.generateStream ??
      (async () => {
        throw new Error("createFakeAi: generateStream was called but not scripted for this test");
      }),
```

- [ ] **Step 4: Run and watch the fake tests pass**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

- [ ] **Step 5: Write the failing test for the Gemini client**

Append to `packages/core/src/ai/gemini.test.ts`. The existing suite stubs `fetch`; follow that pattern.

```ts
describe("createGeminiAi.generateStream", () => {
  const sseBody = (parts: string[], usage: Record<string, number> | null) => {
    const lines = parts.map((t) =>
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`);
    if (usage) {
      lines.push(`data: ${JSON.stringify({
        candidates: [{ content: { parts: [] } }],
        usageMetadata: usage,
      })}\n\n`);
    }
    return lines.join("");
  };

  it("yields text chunks and captures usage from the final chunk", async () => {
    globalThis.fetch = (async () => new Response(
      sseBody(["Xin ", "chào"], { promptTokenCount: 12, candidatesTokenCount: 4 }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;

    const ai = createGeminiAi("key");
    const res = await ai.generateStream({ prompt: "p", model: "m" });
    let out = "";
    for await (const c of res.chunks) out += c.text;

    expect(out).toBe("Xin chào");
    expect(res.usage()).toEqual({ inputTokens: 12, outputTokens: 4, model: "m" });
  });

  // An abandoned answer is still billed, so whatever was counted must remain readable.
  it("reports null usage when the stream ends without usageMetadata", async () => {
    globalThis.fetch = (async () => new Response(
      sseBody(["partial"], null),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;

    const ai = createGeminiAi("key");
    const res = await ai.generateStream({ prompt: "p", model: "m" });
    for await (const _ of res.chunks) { /* drain */ }
    expect(res.usage()).toBeNull();
  });

  it("attaches the HTTP status so a caller can tell a 429 from a 400", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 429 })) as typeof fetch;
    const ai = createGeminiAi("key");
    await expect(ai.generateStream({ prompt: "p", model: "m" }))
      .rejects.toMatchObject({ status: 429 });
  });
});
```

- [ ] **Step 6: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

- [ ] **Step 7: Implement the real streaming client**

Add to `packages/core/src/ai/gemini.ts`, reusing the file's existing `post`/base-URL helpers for the key and error shape:

```ts
/**
 * `streamGenerateContent?alt=sse` returns Server-Sent Events. Each `data:` line is a full
 * GenerateContentResponse; text arrives incrementally and `usageMetadata` arrives on the LAST
 * one. Answer generation is the largest line item in this system's spend, so dropping that
 * final object means the ledger cannot see ~75% of the money -- see 00027's header.
 */
async function openStream(
  apiKey: string,
  args: { prompt: string; model: string; signal?: AbortSignal },
): Promise<StreamResult> {
  const res = await fetch(
    `${BASE_URL}/models/${args.model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: args.prompt }] }] }),
      signal: args.signal,
    },
  );
  if (!res.ok || !res.body) {
    // Same shape as the non-streaming path: status in the message for logs, and attached as a
    // property so a caller can branch on 429/5xx (retry) vs 400 (a bug in our request).
    throw Object.assign(new Error(`gemini ${res.status}`), { status: res.status });
  }

  let usage: StreamUsage | null = null;

  async function* iterate(): AsyncIterable<StreamChunk> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // One parser, used by both the loop and the final flush. Duplicating it is how the two
    // paths drift.
    function handleEvent(event: string): string {
      const payload = event
        .split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (payload === "" || payload === "[DONE]") return "";
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // Never quote the payload: it is model output, and §15.6 rule 1 forbids user content
        // reaching a log. Length is enough to diagnose a truncation.
        throw new Error(`gemini: stream chunk was not valid JSON (${payload.length} chars)`);
      }
      const meta = obj.usageMetadata as Record<string, number> | undefined;
      if (meta) {
        usage = {
          inputTokens: meta.promptTokenCount ?? 0,
          outputTokens: meta.candidatesTokenCount ?? 0,
          model: args.model,
        };
      }
      const candidates = obj.candidates as
        | { content?: { parts?: { text?: string }[] } }[]
        | undefined;
      return candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    }

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // CRLF is normalised before splitting. If the endpoint ever emits \r\n\r\n, a
        // "\n\n"-only split matches nothing, the buffer grows for the whole response, and the
        // stream silently yields zero chunks and null usage.
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
        // SSE events are separated by a blank line. Hold the tail: a chunk boundary can land
        // mid-event, and parsing half a JSON object throws.
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const text = handleEvent(event);
          if (text !== "") yield { text };
        }
      }

      // THE TAIL MUST BE FLUSHED, and this is the whole point of the task. A final event that
      // is not terminated by a blank line sits in `buffer` when the loop exits -- and it is the
      // one carrying usageMetadata. Dropping it means usage() returns null, no ledger row is
      // written, and the largest line item in this system's spend disappears silently.
      //
      // decoder.decode() with no argument flushes bytes held back for an incomplete multi-byte
      // sequence. Vietnamese is multi-byte throughout, so this is not hypothetical.
      buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
      for (const event of buffer.split("\n\n")) {
        const text = handleEvent(event);
        if (text !== "") yield { text };
      }
    } finally {
      // cancel(), not releaseLock(). releaseLock merely detaches the reader and leaves the body
      // unconsumed and un-errored, so a caller that breaks out of the for-await without an
      // AbortSignal leaves the connection open rather than returning it to the pool. cancel()
      // tears it down and releases the lock as a side effect.
      await reader.cancel().catch(() => {});
    }
  }

  return { chunks: iterate(), usage: () => usage };
}
```

Wire it into the returned client:

```ts
    generateStream: (args) => openStream(apiKey, args),
```

- [ ] **Step 8: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

Expected: all pass, `0 cached`.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/ai
git commit -m "feat(ai): stream answers, and keep the token count that only arrives last

Streaming APIs report usageMetadata in the final chunk. Answer generation is
about 75% of this system's spend, so dropping it means the ledger cannot see
the largest line item at all.

usage() is a function rather than a promise, readable at any time: a caller
that aborts mid-stream would never see a promise resolve, and an abandoned
answer is still money spent.

The SSE reader holds its tail buffer because a network chunk boundary can land
mid-event, and parsing half a JSON object throws. A malformed payload is
reported by LENGTH, never quoted -- it is model output.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: one classification call, now carrying `intent`, `complexity` and a language rule

**Files:**
- Modify: `packages/core/src/enrich/extract.ts:7-28` and its prompt builder
- Test: `packages/core/src/enrich/extract.test.ts`

**Interfaces:**
- Produces: `extractNote` returns `{ tags: number; tagNames: string[]; domain: string | null; intent: "question" | "statement"; complexity: "simple" | "complex" }`.

  **`tagNames` is new and load-bearing.** `extractNote` returns `tags` as a *count*, which is all the sweep ever needed. The box's `attached` event has to name the tags on screen, and re-reading them back out of `note_tags` would be a second round trip for data the function already had in hand.

**Context.** The box needs intent, and the sweep already makes exactly the call that could return it. Two prompts would drift — the same failure `filters-equivalence.test.ts` and the hoisted server-only table list exist to prevent. The sweep gets a field it ignores, costing a few output tokens.

`complexity` is recorded and **not acted on**. It produces the dataset a future routing decision needs; recording is not the same as routing.

**The language rule.** No prompt in this pipeline says anything about language, and Cortex's users write Vietnamese. Tags coming back sometimes in English and sometimes in Vietnamese fragment exactly the vocabulary `TAG_VOCABULARY_LIMIT` exists to keep stable.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/enrich/extract.test.ts`:

```ts
describe("extractNote — intent, complexity and language", () => {
  it("returns the intent the model classified", async () => {
    const ai = createFakeAi({
      generateJson: async () => ({
        value: { intent: "question", complexity: "simple", domain: null, domain_meta: {}, tags: [] },
        inputTokens: 1, outputTokens: 1, model: "fake",
      }),
    });
    const out = await extractNote({ db: fakeDb(), ai }, note("bao giờ tôi viết về chuyện này?"));
    expect(out.intent).toBe("question");
    expect(out.complexity).toBe("simple");
  });

  it("asks for one JSON object carrying all four decisions, not four calls", async () => {
    const schemas: Record<string, unknown>[] = [];
    const ai = createFakeAi({
      generateJson: async (args) => {
        schemas.push(args.schema);
        return {
          value: { intent: "statement", complexity: "simple", domain: null, domain_meta: {}, tags: [] },
          inputTokens: 1, outputTokens: 1, model: "fake",
        };
      },
    });
    await extractNote({ db: fakeDb(), ai }, note("hôm nay tôi chạy bộ"));
    expect(schemas).toHaveLength(1);
    const props = (schemas[0]!.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props).sort())
      .toEqual(["complexity", "domain", "domain_meta", "intent", "tags"]);
  });

  // Cortex's users write Vietnamese. A prompt that says nothing about language gets tags back
  // in whichever language the model felt like, which fragments the vocabulary that
  // TAG_VOCABULARY_LIMIT exists to keep stable.
  it("instructs the model to work in the language the note was written in", async () => {
    let seen = "";
    const ai = createFakeAi({
      generateJson: async (args) => {
        seen = args.prompt;
        return {
          value: { intent: "statement", complexity: "simple", domain: null, domain_meta: {}, tags: [] },
          inputTokens: 1, outputTokens: 1, model: "fake",
        };
      },
    });
    await extractNote({ db: fakeDb(), ai }, note("tôi ngủ không đủ giấc"));
    expect(seen).toMatch(/same language/i);
  });

  it("defaults to statement when the model omits intent, rather than throwing", async () => {
    const ai = createFakeAi({
      generateJson: async () => ({
        value: { domain: null, domain_meta: {}, tags: [] },
        inputTokens: 1, outputTokens: 1, model: "fake",
      }),
    });
    const out = await extractNote({ db: fakeDb(), ai }, note("ghi chú"));
    expect(out.intent).toBe("statement");
  });
});
```

Reuse the file's existing `fakeDb()` and `note()` helpers; if they are inline in other tests, hoist them to the top of the file unchanged.

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

- [ ] **Step 3: Implement**

In `packages/core/src/enrich/extract.ts`, widen the interface and schema:

```ts
interface Extraction {
  intent?: "question" | "statement";
  complexity?: "simple" | "complex";
  domain: string | null;
  domain_meta: Record<string, unknown>;
  tags: { name: string; confidence: number }[];
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    // The box branches on this. The sweep ignores it -- a few output tokens, against two
    // prompts that would have to be kept in step by discipline alone.
    intent: { type: "string", enum: ["question", "statement"] },
    // RECORDED, NOT ACTED ON. It costs a couple of output tokens and produces the dataset a
    // future model-routing decision needs: complexity x real cost x model. Nothing reads it.
    complexity: { type: "string", enum: ["simple", "complex"] },
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
  required: ["intent", "complexity", "domain", "domain_meta", "tags"],
};
```

In the prompt builder, add the language rule as its own paragraph:

```
Write tags in the SAME LANGUAGE the note is written in. Do not translate: a note in
Vietnamese gets Vietnamese tags. Tag vocabularies that mix languages split one idea across two
tags and stop being reusable. The `domain` value is the exception -- it is a fixed English
identifier stored in the database, so return it exactly as listed above whatever the note's
language.
```

At the end of `extractNote`, return the two new fields:

```ts
  // Defaulted rather than trusted. `required` in a responseSchema is a request, not a
  // guarantee, and an absent intent must not throw away an otherwise good extraction:
  // "statement" is the safe branch, because it never spends the reasoning model.
  return {
    tags: linked,
    // The names, not just the count: the box shows them, and reading them back out of
    // note_tags would be a second round trip for data this function already holds.
    tagNames: accepted.map((t) => t.name),
    domain: value.domain ?? null,
    intent: value.intent === "question" ? "question" : "statement",
    complexity: value.complexity === "complex" ? "complex" : "simple",
  };
```

where `accepted` is the existing local holding the tags this call actually linked. If the
current code does not keep one, hoist it out of the loop that writes `note_tags` — do not
recompute it.
```

- [ ] **Step 4: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

- [ ] **Step 5: Mutation-check the default**

Change `value.intent === "question" ? "question" : "statement"` to `value.intent as "question"`. The "defaults to statement" test must go red. Restore it.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/enrich/extract.ts packages/core/src/enrich/extract.test.ts
git commit -m "feat(enrich): one classification call, now carrying intent and language

The box needs intent and the sweep already makes exactly the call that could
return it. Two prompts would drift -- the failure filters-equivalence and the
hoisted server-only table list both exist to prevent. The sweep pays a few
output tokens for a field it ignores.

complexity is recorded and deliberately not acted on: it produces the dataset a
future routing decision needs, and recording is not routing.

No prompt in this pipeline said anything about language, and the users write
Vietnamese. Tags coming back sometimes in English fragment the vocabulary that
TAG_VOCABULARY_LIMIT exists to keep stable. domain stays English -- it is a
stored CHECK value, not model output.

intent is defaulted rather than trusted: required in a responseSchema is a
request, not a guarantee, and statement is the safe branch because it never
spends the reasoning model.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: the rolling context and the 4-hour reset

**Files:**
- Create: `packages/core/src/assistant/context.ts`, `packages/core/src/assistant/context.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Produces:
  ```ts
  export const CONTEXT_TOKEN_BUDGET = 2000;
  export const SESSION_IDLE_RESET_MS = 4 * 60 * 60 * 1000;
  export interface ThreadTurn { role: "user" | "assistant"; content: string; createdAt: string }
  export function selectContext(turns: ThreadTurn[], budget?: number): ThreadTurn[];
  export function isStale(lastMessageAt: string | null, now: Date): boolean;
  ```

**Context.** `selectContext` and `isStale` are pure so they can be tested without Docker. Session resolution against the database lives in Task 7, which is where the client is.

Estimating tokens as `chars/4` here is the same English-biased estimate `00027`'s header records — and here it is **safe**, because under-counting Vietnamese means the window holds fewer real tokens than budgeted, never more. Erring small is the harmless direction for a prompt budget.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/assistant/context.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CONTEXT_TOKEN_BUDGET, isStale, selectContext, type ThreadTurn } from "./context.js";

const turn = (role: "user" | "assistant", content: string, minutesAgo: number): ThreadTurn => ({
  role, content,
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

describe("selectContext", () => {
  it("keeps the newest turns and returns them oldest-first for the prompt", () => {
    const turns = [turn("user", "oldest", 30), turn("assistant", "middle", 20), turn("user", "newest", 10)];
    expect(selectContext(turns).map((t) => t.content)).toEqual(["oldest", "middle", "newest"]);
  });

  it("drops the oldest turns once the budget is exceeded", () => {
    const big = "x".repeat(4 * 1200); // ~1200 tokens at chars/4
    const turns = [turn("user", `OLD${big}`, 30), turn("assistant", `MID${big}`, 20), turn("user", "tiny", 10)];
    const kept = selectContext(turns);
    expect(kept.some((t) => t.content.startsWith("OLD"))).toBe(false);
    expect(kept.some((t) => t.content.startsWith("MID"))).toBe(true);
    expect(kept.some((t) => t.content === "tiny")).toBe(true);
  });

  // Whole turns only: half an exchange is worse context than none, because the model reads a
  // truncated question as the whole question.
  it("never includes a partial turn", () => {
    const huge = "y".repeat(4 * (CONTEXT_TOKEN_BUDGET + 500));
    const kept = selectContext([turn("user", huge, 5)]);
    expect(kept).toEqual([]);
  });
});

describe("isStale", () => {
  const now = new Date("2026-08-12T12:00:00Z");
  it("is stale after four hours of silence", () => {
    expect(isStale("2026-08-12T07:59:00Z", now)).toBe(true);
  });
  it("is not stale inside the window", () => {
    expect(isStale("2026-08-12T08:30:00Z", now)).toBe(false);
  });
  // A user with no history starts a session rather than joining one that does not exist.
  it("treats no history as stale", () => {
    expect(isStale(null, now)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

Expected: `Cannot find module './context.js'`.

- [ ] **Step 3: Implement**

Create `packages/core/src/assistant/context.ts`:

```ts
/**
 * A token BUDGET, not a turn count: one turn may be a word and the next a pasted page
 * (parent spec §9).
 */
export const CONTEXT_TOKEN_BUDGET = 2000;

/**
 * An idle gap rather than a calendar boundary, so someone writing at 1am is not cut
 * mid-thought.
 */
export const SESSION_IDLE_RESET_MS = 4 * 60 * 60 * 1000;

export interface ThreadTurn {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

// chars/4 -- the same English-biased estimate 00027's header records, and SAFE here in a way
// it is not in the ledger: under-counting Vietnamese means the window holds fewer real tokens
// than budgeted, never more. Erring small is the harmless direction for a prompt budget.
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Newest-first while filling the budget, then reversed: the prompt reads oldest-first, which
 * is chronological order, while the thing being protected is the NEWEST context.
 *
 * Whole turns only. Half an exchange is worse than none, because the model reads a truncated
 * question as the whole question -- so a single turn larger than the entire budget yields
 * nothing rather than a fragment.
 */
export function selectContext(turns: ThreadTurn[], budget = CONTEXT_TOKEN_BUDGET): ThreadTurn[] {
  const kept: ThreadTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const cost = estimateTokens(t.content);
    if (used + cost > budget) break;
    used += cost;
    kept.push(t);
  }
  return kept.reverse();
}

/** No history is stale: a first message starts a session rather than joining one. */
export function isStale(lastMessageAt: string | null, now: Date): boolean {
  if (lastMessageAt === null) return true;
  return now.getTime() - new Date(lastMessageAt).getTime() >= SESSION_IDLE_RESET_MS;
}
```

Export from `packages/core/src/index.ts`:

```ts
export * from "./assistant/context.js";
```

- [ ] **Step 4: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/assistant packages/core/src/index.ts
git commit -m "feat(assistant): a rolling context window and a four-hour reset

A token budget rather than a turn count, because one turn may be a word and the
next a pasted page. Whole turns only: half an exchange is worse context than
none, since the model reads a truncated question as the whole question.

Filled newest-first and then reversed, so the budget protects recent context
while the prompt still reads chronologically.

chars/4 is the same English-biased estimate the ledger records as wrong, and it
is safe here for the opposite reason: under-counting Vietnamese means the window
holds fewer real tokens than budgeted, never more.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: retrieval and the two prompts

**Files:**
- Create: `packages/core/src/assistant/retrieve.ts`, `packages/core/src/assistant/retrieve.test.ts`
- Create: `packages/core/src/assistant/prompts.ts`, `packages/core/src/assistant/prompts.test.ts`

**Interfaces:**
- Consumes: `AiClient.embed`, `recordUsage` from Task 2.
- Produces:
  ```ts
  export interface Citation {
    noteId: string; title: string | null; snippet: string; score: number; matchedBy: string;
  }
  export async function retrieve(
    deps: { db: SupabaseClient; ai: AiClient },
    args: { userId: string; text: string; requestId: string; limit?: number },
  ): Promise<Citation[]>;

  export function buildAnswerPrompt(a: {
    question: string; citations: Citation[]; history: ThreadTurn[];
  }): string;
  export function buildAcknowledgePrompt(a: {
    note: string; domain: string | null; tags: string[]; related: Citation[]; history: ThreadTurn[];
  }): string;
  ```

**Context.** `retrieve` takes the **service-role** client, because `search_notes` is `SECURITY DEFINER` over `note_chunks`. `userId` must come from the verified JWT and never from a request body — it is the only thing separating two users' corpora once RLS is out of the picture.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/assistant/retrieve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeAi } from "../ai/fake.js";
import { retrieve } from "./retrieve.js";

const rpcDb = (rows: unknown[], captured: Record<string, unknown>[] = []) =>
  ({
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      captured.push(args);
      return { data: rows, error: null };
    },
    from: () => ({ insert: async () => ({ error: null }) }),
  }) as unknown as SupabaseClient;

describe("retrieve", () => {
  it("maps search_notes rows into camelCase citations", async () => {
    const db = rpcDb([
      { note_id: "n1", title: "t", snippet: "s", score: 0.5, matched_by: "both" },
    ]);
    const out = await retrieve({ db, ai: createFakeAi() }, {
      userId: "u1", text: "tôi ngủ mấy tiếng?", requestId: "r1",
    });
    expect(out).toEqual([
      { noteId: "n1", title: "t", snippet: "s", score: 0.5, matchedBy: "both" },
    ]);
  });

  it("passes the caller's user id to the RPC, never anything from the text", async () => {
    const captured: Record<string, unknown>[] = [];
    const db = rpcDb([], captured);
    await retrieve({ db, ai: createFakeAi() }, {
      userId: "u1", text: "p_user_id=someone-else", requestId: "r1",
    });
    expect(captured[0]!.p_user_id).toBe("u1");
  });

  it("meters the query embedding against the assistant, not the search box", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = {
      rpc: async () => ({ data: [], error: null }),
      from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }),
    } as unknown as SupabaseClient;
    await retrieve({ db, ai: createFakeAi() }, { userId: "u1", text: "hỏi gì đó", requestId: "r1" });
    expect(rows[0]).toMatchObject({ kind: "embed", source: "assistant", request_id: "r1" });
  });

  it("does not fail the turn when the ledger write fails", async () => {
    const db = {
      rpc: async () => ({ data: [], error: null }),
      from: () => ({ insert: async () => ({ error: { message: "ledger down" } }) }),
    } as unknown as SupabaseClient;
    await expect(retrieve({ db, ai: createFakeAi() }, {
      userId: "u1", text: "x", requestId: "r1",
    })).resolves.toEqual([]);
  });
});
```

Create `packages/core/src/assistant/prompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAcknowledgePrompt, buildAnswerPrompt } from "./prompts.js";

describe("buildAnswerPrompt", () => {
  it("tells the model to answer in the user's language", () => {
    expect(buildAnswerPrompt({ question: "tôi ngủ mấy tiếng?", citations: [], history: [] }))
      .toMatch(/same language/i);
  });

  it("numbers the citations so the answer can refer to them", () => {
    const p = buildAnswerPrompt({
      question: "q",
      citations: [
        { noteId: "a", title: null, snippet: "first", score: 1, matchedBy: "fts" },
        { noteId: "b", title: null, snippet: "second", score: 1, matchedBy: "fts" },
      ],
      history: [],
    });
    expect(p).toContain("[1]");
    expect(p).toContain("[2]");
  });

  it("says plainly what to do when there is nothing to answer from", () => {
    expect(buildAnswerPrompt({ question: "q", citations: [], history: [] }))
      .toMatch(/say so/i);
  });
});

describe("buildAcknowledgePrompt", () => {
  it("carries what was attached, so the reply can name it", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay tôi chạy bộ", domain: "health", tags: ["thể dục"], related: [], history: [],
    });
    expect(p).toContain("health");
    expect(p).toContain("thể dục");
  });

  it("forbids inventing a question that was not asked", () => {
    expect(buildAcknowledgePrompt({ note: "n", domain: null, tags: [], related: [], history: [] }))
      .toMatch(/did not ask/i);
  });
});
```

- [ ] **Step 2: Run and watch both fail**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

- [ ] **Step 3: Implement `retrieve.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiClient } from "../ai/client.js";
import { recordUsage } from "../enrich/budget.js";
import { errorMessage } from "../errors.js";

export interface Citation {
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  matchedBy: string;
}

interface SearchRow {
  note_id: string;
  title: string | null;
  snippet: string;
  score: number;
  matched_by: string;
}

/**
 * One retrieval path for both branches of a turn -- a question's citations and a statement's
 * "you wrote about this before" are the same query with the same ranking.
 *
 * `db` MUST be the service-role client: search_notes is SECURITY DEFINER over note_chunks,
 * which has RLS enabled with no policies and is invisible to `authenticated` by design.
 * `userId` therefore comes from the verified JWT and never from anything the caller typed --
 * with RLS out of the picture it is the only thing separating two users' corpora.
 */
export async function retrieve(
  deps: { db: SupabaseClient; ai: AiClient },
  args: { userId: string; text: string; requestId: string; limit?: number },
): Promise<Citation[]> {
  const { db, ai } = deps;
  const { vectors, inputTokens, model } = await ai.embed([args.text]);
  const embedding = vectors[0];
  if (!embedding) throw new Error("assistant: embed() returned no vector for the query");

  // Metered, never fatal -- the same trade search.controller.ts documents. A ledger outage
  // must not turn a working turn into a failed one; a silent under-count is the accepted cost.
  // errorMessage, not String(err): PostgREST errors are plain objects and stringify to
  // "[object Object]". Never log args.text -- it is note content (§15.6 rule 1).
  try {
    await recordUsage(db, {
      userId: args.userId, kind: "embed", model, inputTokens, outputTokens: 0,
      source: "assistant", requestId: args.requestId, contentChars: args.text.length,
    });
  } catch (err) {
    console.error(`[assistant] usage_ledger write failed: ${errorMessage(err)}`);
  }

  const { data, error } = await db.rpc("search_notes", {
    p_user_id: args.userId,
    p_query: args.text,
    p_embedding: embedding,
    p_limit: args.limit ?? 5,
  });
  if (error) throw error;

  return ((data ?? []) as SearchRow[]).map((r) => ({
    noteId: r.note_id,
    title: r.title,
    snippet: r.snippet,
    score: r.score,
    matchedBy: r.matched_by,
  }));
}
```

- [ ] **Step 4: Implement `prompts.ts`**

```ts
import type { ThreadTurn } from "./context.js";
import type { Citation } from "./retrieve.js";

const LANGUAGE_RULE =
  "Reply in the same language the user wrote in. Do not translate their words, their tags, " +
  "or their notes into another language.";

const renderHistory = (history: ThreadTurn[]) =>
  history.length === 0
    ? ""
    : `\n\nEarlier in this conversation:\n${history
        .map((t) => `${t.role === "user" ? "User" : "You"}: ${t.content}`)
        .join("\n")}`;

const renderCitations = (citations: Citation[]) =>
  citations.length === 0
    ? "\n\nThe user has no notes matching this."
    : `\n\nThe user's own notes:\n${citations
        .map((c, i) => `[${i + 1}] ${c.title ? `${c.title}: ` : ""}${c.snippet}`)
        .join("\n")}`;

/**
 * Answering never invents (life-domains spec §6.1): answer from the user's notes first, say so
 * when the notes cannot answer, and never present outside content as the user's own thinking.
 */
export function buildAnswerPrompt(a: {
  question: string;
  citations: Citation[];
  history: ThreadTurn[];
}): string {
  return [
    "You are the user's second brain. Answer their question using their own notes.",
    LANGUAGE_RULE,
    "Cite the notes you used by their bracketed number, like [1].",
    "If their notes do not answer the question, say so plainly and briefly. Do not fill the " +
      "gap with general knowledge presented as if it came from them.",
    renderCitations(a.citations),
    renderHistory(a.history),
    `\n\nTheir question: ${a.question}`,
  ].join("\n");
}

/**
 * The statement branch. It exists because an acknowledgement built from a template reads like
 * a UI rather than something talking back -- and that acknowledgement is what makes this feel
 * like an assistant rather than an inbox (parent spec §6, obligation 3).
 */
export function buildAcknowledgePrompt(a: {
  note: string;
  domain: string | null;
  tags: string[];
  related: Citation[];
  history: ThreadTurn[];
}): string {
  return [
    "The user just saved a note. Acknowledge it in one or two sentences.",
    LANGUAGE_RULE,
    `You filed it under: ${a.domain ?? "no domain"}. You tagged it: ${
      a.tags.length > 0 ? a.tags.join(", ") : "nothing"
    }.`,
    "Mention what you attached, briefly. If any of their earlier notes below are genuinely " +
      "related, say so and cite them like [1].",
    "The user did not ask a question. Do not answer one, and do not invent one to answer.",
    renderCitations(a.related),
    renderHistory(a.history),
    `\n\nTheir note: ${a.note}`,
  ].join("\n");
}
```

- [ ] **Step 5: Run and watch both pass**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/assistant
git commit -m "feat(assistant): one retrieval path, and the two prompts

A question's citations and a statement's 'you wrote about this before' are the
same query with the same ranking, so they are one function.

retrieve takes the service-role client because search_notes is SECURITY DEFINER
over note_chunks -- which means p_user_id comes from the verified JWT and never
from anything the caller typed, since with RLS out of the picture it is the only
thing separating two corpora.

The query embedding is metered against source='assistant' and never fatal: a
ledger outage must not turn a working turn into a failed one.

Both prompts carry the language rule. The acknowledgement prompt is forbidden
from answering a question that was not asked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: the turn — pin the model, then orchestrate

**Files:**
- Modify: `packages/shared/src/enums.ts` (the answering model constant)
- Create: `packages/core/src/assistant/turn.ts`, `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces:
  ```ts
  export type AssistantEvent =
    | { type: "attached"; domain: string | null; domainMeta: Record<string, unknown>;
        tags: string[]; degraded?: boolean }
    | { type: "citations"; citations: Citation[]; degraded?: boolean }
    | { type: "token"; text: string }
    | { type: "declined"; reason: "budget" }
    | { type: "done"; messageId: string; sessionId: string }
    | { type: "error"; message: string };

  export const EXTRACT_DEADLINE_MS = 4000;

  export async function* runTurn(
    deps: { userDb: SupabaseClient; serviceDb: SupabaseClient; ai: AiClient },
    args: { userId: string; noteId: string; sessionId?: string;
            budgetUsd: number; signal?: AbortSignal },
  ): AsyncGenerator<AssistantEvent>;
  ```

- [ ] **Step 1: Pin the answering model against current documentation**

This is a research step, not a code step, and it must not be skipped or guessed. `CLASSIFY_MODEL` was pinned this way on 2026-08-10 and the header records that the brief's drafted prices were stale.

Open `https://ai.google.dev/gemini-api/docs/models` and `https://ai.google.dev/gemini-api/docs/pricing`. Find the current reasoning-tier model id and its input/output price per million tokens. Then add to `packages/shared/src/enums.ts`, beside `CLASSIFY_MODEL`:

```ts
// Reasoning: answering a question from the user's notes. Life-domains spec §1 says "Gemini 3
// Pro", which is a model FAMILY, not an API id -- verified against
// ai.google.dev/gemini-api/docs/models on <DATE YOU CHECKED>.
export const ANSWER_MODEL = "<the id you read>";
```

and its prices into `MODEL_PRICES_USD_PER_MTOK`. If the id you read differs from what any older document in this repo assumes, the document is wrong and the docs are right — say so in the commit message.

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/assistant/turn.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeAi } from "../ai/fake.js";
import { runTurn, type AssistantEvent } from "./turn.js";

const NOTE = { id: "n1", user_id: "u1", content_text: "hôm nay tôi chạy bộ ở công viên" };

/** A Supabase double covering only what runTurn touches. */
function dbs(opts: { over?: boolean } = {}) {
  const inserted: Record<string, Record<string, unknown>[]> = {};
  const table = (name: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: NOTE, error: null }) }),
        order: () => ({ limit: async () => ({ data: [], error: null }) }),
        maybeSingle: async () => ({ data: NOTE, error: null }),
      }),
    }),
    insert: (r: Record<string, unknown>) => {
      (inserted[name] ??= []).push(r);
      return { select: () => ({ single: async () => ({ data: { id: `${name}-1` }, error: null }) }) };
    },
    update: () => ({ eq: async () => ({ error: null }) }),
  });
  const client = {
    from: (n: string) => table(n),
    rpc: async (fn: string) =>
      fn === "usage_month_to_date_usd"
        ? { data: opts.over ? 999 : 0, error: null }
        : { data: [], error: null },
  } as unknown as SupabaseClient;
  return { client, inserted };
}

const collect = async (gen: AsyncGenerator<AssistantEvent>) => {
  const out: AssistantEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

const ai = () =>
  createFakeAi({
    generateJson: async () => ({
      value: { intent: "statement", complexity: "simple", domain: "health", domain_meta: {}, tags: [] },
      inputTokens: 5, outputTokens: 2, model: "fake-classify",
    }),
    generateStream: async () => ({
      chunks: (async function* () { yield { text: "Đã " }; yield { text: "lưu." }; })(),
      usage: () => ({ inputTokens: 20, outputTokens: 4, model: "fake-answer" }),
    }),
  });

describe("runTurn", () => {
  it("emits attached, citations, tokens and done", async () => {
    const { client } = dbs();
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: ai() },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));
    const types = events.map((e) => e.type);
    expect(types).toContain("attached");
    expect(types).toContain("citations");
    expect(types.filter((t) => t === "token").length).toBeGreaterThan(0);
    expect(types.at(-1)).toBe("done");
  });

  // The circuit breaker bounds a runaway; it must never cost the user their note or the
  // context around it.
  it("declines the answer when over budget, after still attaching and retrieving", async () => {
    const { client } = dbs({ over: true });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: ai() },
      { userId: "u1", noteId: "n1", budgetUsd: 1 },
    ));
    const types = events.map((e) => e.type);
    expect(types).toContain("attached");
    expect(types).toContain("citations");
    expect(types).toContain("declined");
    expect(types).not.toContain("token");
  });

  it("still answers when classification fails, marking attached as degraded", async () => {
    const { client } = dbs();
    const brokenAi = createFakeAi({
      generateJson: async () => { throw new Error("classify exploded"); },
      generateStream: async () => ({
        chunks: (async function* () { yield { text: "ok" }; })(),
        usage: () => null,
      }),
    });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: brokenAi },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));
    const attached = events.find((e) => e.type === "attached");
    expect(attached).toMatchObject({ degraded: true });
    expect(events.map((e) => e.type)).toContain("token");
  });

  it("records the answer's usage even when the stream fails part-way", async () => {
    const { client, inserted } = dbs();
    const failing = createFakeAi({
      generateJson: async () => ({
        value: { intent: "question", complexity: "simple", domain: null, domain_meta: {}, tags: [] },
        inputTokens: 5, outputTokens: 2, model: "fake-classify",
      }),
      generateStream: async () => ({
        chunks: (async function* () { yield { text: "half" }; throw new Error("socket died"); })(),
        usage: () => ({ inputTokens: 30, outputTokens: 3, model: "fake-answer" }),
      }),
    });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: failing },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));
    expect(events.map((e) => e.type)).toContain("error");
    const chatRows = inserted.usage_ledger ?? [];
    expect(chatRows.some((r) => r.kind === "chat")).toBe(true);
  });

  it("marks an interrupted assistant message incomplete, so it is excluded from context", async () => {
    const { client, inserted } = dbs();
    const failing = createFakeAi({
      generateJson: async () => ({
        value: { intent: "question", complexity: "simple", domain: null, domain_meta: {}, tags: [] },
        inputTokens: 1, outputTokens: 1, model: "fake-classify",
      }),
      generateStream: async () => ({
        chunks: (async function* () { yield { text: "half" }; throw new Error("socket died"); })(),
        usage: () => null,
      }),
    });
    await collect(runTurn(
      { userDb: client, serviceDb: client, ai: failing },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));
    const messages = inserted.chat_messages ?? [];
    const assistantRow = messages.find((m) => m.role === "assistant");
    expect((assistantRow?.retrieval_meta as { incomplete?: boolean })?.incomplete).toBe(true);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

- [ ] **Step 4: Implement `turn.ts`**

```ts
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ANSWER_MODEL, CLASSIFY_MODEL } from "@cortex/shared";
import type { AiClient } from "../ai/client.js";
import { isOverBudget, recordUsage } from "../enrich/budget.js";
import { extractNote } from "../enrich/extract.js";
import { errorMessage } from "../errors.js";
import { isStale, selectContext, type ThreadTurn } from "./context.js";
import { buildAcknowledgePrompt, buildAnswerPrompt } from "./prompts.js";
import { retrieve, type Citation } from "./retrieve.js";

export type AssistantEvent =
  | { type: "attached"; domain: string | null; domainMeta: Record<string, unknown>;
      tags: string[]; degraded?: boolean }
  | { type: "citations"; citations: Citation[]; degraded?: boolean }
  | { type: "token"; text: string }
  | { type: "declined"; reason: "budget" }
  | { type: "done"; messageId: string; sessionId: string }
  | { type: "error"; message: string };

/**
 * Keeping extraction synchronous is right -- its result is on screen. Without a deadline a
 * hung Flash call holds the SSE connection open indefinitely, so the turn gives up on it and
 * proceeds degraded; the 60-second sweep enriches the note later through the path that always
 * existed.
 */
export const EXTRACT_DEADLINE_MS = 4000;

const withDeadline = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

export async function* runTurn(
  deps: { userDb: SupabaseClient; serviceDb: SupabaseClient; ai: AiClient },
  args: { userId: string; noteId: string; sessionId?: string; budgetUsd: number; signal?: AbortSignal },
): AsyncGenerator<AssistantEvent> {
  const { userDb, serviceDb, ai } = deps;
  const requestId = crypto.randomUUID();

  // The user's client, so RLS is what proves ownership -- and the note's text comes from the
  // database, never from the caller's copy of it.
  const { data: note, error: noteErr } = await userDb
    .from("notes").select("id, content_text").eq("id", args.noteId).maybeSingle();
  if (noteErr || !note) {
    yield { type: "error", message: "note not found" };
    return;
  }
  const text = (note as { content_text: string }).content_text;

  // Session resolution, then the user's turn is written BEFORE any generation: a failure
  // later still leaves a coherent thread.
  const { data: last } = await userDb
    .from("chat_messages").select("session_id, created_at")
    .eq("user_id", args.userId).order("created_at", { ascending: false }).limit(1);
  const lastRow = (last ?? [])[0] as { session_id: string; created_at: string } | undefined;
  let sessionId = args.sessionId ?? lastRow?.session_id;
  if (!sessionId || isStale(lastRow?.created_at ?? null, new Date())) {
    const { data: created } = await userDb
      .from("chat_sessions").insert({ user_id: args.userId }).select("id").single();
    sessionId = (created as { id: string } | null)?.id ?? sessionId ?? crypto.randomUUID();
  }
  await userDb.from("chat_messages")
    .insert({ user_id: args.userId, session_id: sessionId, role: "user", content: text });

  const { data: historyRows } = await userDb
    .from("chat_messages").select("role, content, created_at, retrieval_meta")
    .eq("session_id", sessionId).order("created_at", { ascending: false }).limit(40);
  const history = selectContext(
    ((historyRows ?? []) as { role: string; content: string; created_at: string;
      retrieval_meta: { incomplete?: boolean } | null }[])
      // An interrupted answer stays visible in the thread and is kept OUT of the prompt: the
      // model reads a truncated answer as a complete one.
      .filter((r) => r.retrieval_meta?.incomplete !== true)
      .map((r) => ({ role: r.role as ThreadTurn["role"], content: r.content, createdAt: r.created_at }))
      .reverse(),
  );

  // CONCURRENT, and this is the latency win: retrieval needs only the note text, not the
  // classification. `attached` and `citations` may therefore be emitted in either order, which
  // is why the SSE contract says so.
  const classifyStarted = Date.now();
  // The REAL content hash, not a placeholder. extractNote stamps note_enrichment.extracted_hash
  // with whatever it is given; an empty string would never equal md5(content_text), so the
  // sweep would re-extract this note 60 seconds later and pay for the same call twice. This is
  // the two-hash design working (spec §4.2) only if the hash is honest.
  const contentHash = createHash("md5").update(text, "utf8").digest("hex");
  const [extraction, citationsResult] = await Promise.allSettled([
    withDeadline(
      extractNote({ db: serviceDb, ai }, {
        noteId: args.noteId, userId: args.userId, contentText: text, contentHash,
      }),
      EXTRACT_DEADLINE_MS,
    ),
    retrieve({ db: serviceDb, ai }, { userId: args.userId, text, requestId }),
  ]);

  // `withDeadline` resolves to null on timeout, so a fulfilled-but-null result is a timeout
  // and must be treated exactly like a thrown one.
  const extracted = extraction.status === "fulfilled" ? extraction.value : null;
  yield extracted
    ? { type: "attached", domain: extracted.domain, domainMeta: {}, tags: extracted.tagNames }
    : { type: "attached", domain: null, domainMeta: {}, tags: [], degraded: true };

  const citations = citationsResult.status === "fulfilled" ? citationsResult.value : [];
  yield citationsResult.status === "fulfilled"
    ? { type: "citations", citations }
    : { type: "citations", citations: [], degraded: true };

  // A circuit breaker, not a budget: it bounds a runaway, and it never costs the user the
  // note or the context around it -- both are already emitted above.
  if (await isOverBudget(serviceDb, args.userId, args.budgetUsd)) {
    yield { type: "declined", reason: "budget" };
    return;
  }

  const isQuestion = extracted?.intent === "question";
  if (isQuestion) {
    await userDb.from("notes").update({ source_type: "chat" }).eq("id", args.noteId);
  }
  const prompt = isQuestion
    ? buildAnswerPrompt({ question: text, citations, history })
    : buildAcknowledgePrompt({
        note: text, domain: extracted?.domain ?? null, tags: extracted?.tagNames ?? [],
        related: citations, history,
      });
  const model = isQuestion ? ANSWER_MODEL : CLASSIFY_MODEL;

  let answer = "";
  let incomplete = false;
  let streamUsage: { inputTokens: number; outputTokens: number; model: string } | null = null;
  try {
    const stream = await ai.generateStream({ prompt, model, signal: args.signal });
    try {
      for await (const chunk of stream.chunks) {
        answer += chunk.text;
        yield { type: "token", text: chunk.text };
      }
    } finally {
      streamUsage = stream.usage();
    }
  } catch (err) {
    incomplete = true;
    yield { type: "error", message: errorMessage(err).slice(0, 200) };
  }

  // Billed whether or not it finished. An abandoned answer is still money spent, and this is
  // the largest line item in the system.
  if (streamUsage) {
    try {
      await recordUsage(serviceDb, {
        userId: args.userId, kind: "chat", model: streamUsage.model,
        inputTokens: streamUsage.inputTokens, outputTokens: streamUsage.outputTokens,
        source: "assistant", noteId: args.noteId, requestId,
        latencyMs: Date.now() - classifyStarted, contentChars: text.length,
      });
    } catch (err) {
      console.error(`[assistant] usage_ledger write failed: ${errorMessage(err)}`);
    }
  }

  const { data: message } = await userDb.from("chat_messages").insert({
    user_id: args.userId, session_id: sessionId, role: "assistant", content: answer,
    citations, retrieval_meta: { requestId, incomplete },
  }).select("id").single();

  if (!incomplete) {
    yield { type: "done", messageId: (message as { id: string } | null)?.id ?? "", sessionId };
  }
}
```

- [ ] **Step 5: Run and watch it pass**

```bash
pnpm turbo run test --filter=@cortex/core --force
```

- [ ] **Step 6: Add the test that pins context exclusion, then mutation-check both rules**

The tests in Step 2 do not yet cover the `incomplete` filter on the way *in*. Add one — return a history containing an incomplete assistant row from the double, script `generateStream` to capture the prompt it is handed, and assert that prompt does not contain the incomplete row's text:

```ts
it("keeps an interrupted earlier answer out of the prompt", async () => {
  const { client } = dbs({ history: [
    { role: "assistant", content: "TRUNCATED-EARLIER-ANSWER",
      created_at: new Date().toISOString(), retrieval_meta: { incomplete: true } },
  ] });
  let seen = "";
  const capturing = createFakeAi({
    generateJson: async () => ({
      value: { intent: "question", complexity: "simple", domain: null, domain_meta: {}, tags: [] },
      inputTokens: 1, outputTokens: 1, model: "fake-classify",
    }),
    generateStream: async ({ prompt }) => {
      seen = prompt;
      return { chunks: (async function* () { yield { text: "ok" }; })(), usage: () => null };
    },
  });
  await collect(runTurn({ userDb: client, serviceDb: client, ai: capturing },
    { userId: "u1", noteId: "n1", budgetUsd: 100 }));
  expect(seen).not.toContain("TRUNCATED-EARLIER-ANSWER");
});
```

Extend `dbs()` to accept `{ history }` and return it from the `chat_messages` select.

Then mutate, one at a time, and confirm each turns exactly one test red:

1. Remove `.filter((r) => r.retrieval_meta?.incomplete !== true)` → the test above goes red.
2. Wrap the `recordUsage` call in `if (!incomplete)` → "records the answer's usage even when the stream fails part-way" goes red.

Restore both.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/enums.ts packages/core/src/assistant
git commit -m "feat(assistant): one turn -- classify and retrieve at once, then stream

Classification and retrieval run concurrently because retrieval needs only the
note text. That makes attached and citations arrive in either order, which the
SSE contract states rather than leaving clients to discover.

The extract deadline exists because keeping extraction synchronous is right --
its result is on screen -- but a hung call would otherwise hold the connection
open forever. On timeout the turn proceeds degraded and the sweep enriches later
through the path that always existed.

The budget check is a circuit breaker, not a budget: it never costs the user the
note or the citations, both already emitted by the time it runs.

Usage is recorded whether or not the stream finished. An abandoned answer is
still money spent, and it is the largest line item in the system.

An interrupted answer is stored with incomplete=true: visible in the thread,
excluded from the prompt, because the model reads a truncated answer as a
complete one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: `POST /assistant` — SSE, auth, abort, and the fourth env var

**Files:**
- Create: `packages/shared/src/dto/assistant.ts`, `packages/shared/src/dto/assistant.test.ts`
- Create: `apps/api/src/assistant.controller.ts`, `apps/api/test/assistant.e2e.test.ts`
- Modify: `apps/api/src/env.ts`, `apps/api/src/root.module.ts`
- Modify: `turbo.json`, `.github/workflows/ci.yml`, `.github/workflows/e2e-web.yml`, `.github/workflows/e2e-mobile.yml`

**Interfaces:**
- Produces: `assistantInput` = `z.object({ noteId: z.string().uuid(), sessionId: z.string().uuid().optional() }).strict()`, and `ASSISTANT_MONTHLY_BUDGET_USD` in `ApiEnv`.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/dto/assistant.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assistantInput } from "./assistant.js";

describe("assistantInput", () => {
  it("accepts a note id alone", () => {
    expect(assistantInput.safeParse({ noteId: crypto.randomUUID() }).success).toBe(true);
  });

  // .strict() so a body carrying userId is a 400, not a value that gets quietly dropped --
  // the same rule searchInput follows, for the same reason.
  it("rejects an unexpected field rather than ignoring it", () => {
    const r = assistantInput.safeParse({ noteId: crypto.randomUUID(), userId: "someone-else" });
    expect(r.success).toBe(false);
  });

  it("rejects a non-uuid note id", () => {
    expect(assistantInput.safeParse({ noteId: "../../etc/passwd" }).success).toBe(false);
  });
});
```

Create `apps/api/test/assistant.e2e.test.ts` following the shape of `apps/api/test/search.e2e.test.ts`:

```ts
it("rejects an unauthenticated request", async () => {
  const res = await request(app.getHttpServer()).post("/assistant").send({ noteId: crypto.randomUUID() });
  expect(res.status).toBe(401);
});

it("rejects a body carrying an extra field", async () => {
  const res = await request(app.getHttpServer())
    .post("/assistant").set("Authorization", `Bearer ${token}`)
    .send({ noteId: crypto.randomUUID(), userId: "someone-else" });
  expect(res.status).toBe(400);
});

it("answers as an event stream", async () => {
  const res = await request(app.getHttpServer())
    .post("/assistant").set("Authorization", `Bearer ${token}`)
    .send({ noteId });
  expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
  expect(res.text).toMatch(/event: attached/);
  expect(res.text).toMatch(/event: citations/);
  expect(res.text).toMatch(/event: done/);
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm turbo run test --filter=@cortex/shared --filter=@cortex/api --force
```

- [ ] **Step 3: Add the DTO**

Create `packages/shared/src/dto/assistant.ts`:

```ts
import { z } from "zod";

/**
 * `.strict()`, matching searchInput: a body carrying a userId must be a 400, not a value the
 * server quietly drops. The user id comes from the verified JWT and nowhere else.
 */
export const assistantInput = z.object({
  noteId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
}).strict();

export type AssistantInput = z.infer<typeof assistantInput>;
```

Export it from `packages/shared/src/index.ts` beside the other DTOs.

- [ ] **Step 4: Add the env var in all four places**

`apps/api/src/env.ts` — beside `ENRICH_MONTHLY_BUDGET_USD`:

```ts
  // A circuit breaker, not a budget. It bounds a runaway loop or a pathological output; it is
  // set generously, because refusing to answer is a UX failure and this product has two users.
  ASSISTANT_MONTHLY_BUDGET_USD: z.coerce.number().positive(),
```

`turbo.json` — add `"ASSISTANT_MONTHLY_BUDGET_USD"` to the `test.env` array.

`.github/workflows/ci.yml`, `.github/workflows/e2e-web.yml`, `.github/workflows/e2e-mobile.yml` — add `ASSISTANT_MONTHLY_BUDGET_USD=5` next to the existing `ENRICH_MONTHLY_BUDGET_USD` export in each. Verify with:

```bash
grep -rn "ASSISTANT_MONTHLY_BUDGET_USD" .github/ turbo.json
```

Expected: **four** hits. Three is the bug this repo has shipped twice (issue-log A1, G1).

- [ ] **Step 5: Implement the controller**

Create `apps/api/src/assistant.controller.ts`:

```ts
import { Body, Controller, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import type { AiClient } from "@cortex/core";
import { createServiceClient, createUserClient, errorMessage, runTurn } from "@cortex/core";
import { assistantInput, type AssistantInput } from "@cortex/shared";
import { AI_CLIENT } from "./ai-client.provider";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { parseApiEnv } from "./env";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("assistant")
@UseGuards(SupabaseAuthGuard)
export class AssistantController {
  // Service-role, singleton, for search_notes and the ledger only. Every user-facing read and
  // write in the turn goes through createUserClient with the caller's JWT -- RLS is the
  // enforcement, per spec §11.
  private readonly serviceDb = createServiceClient();
  private readonly env = parseApiEnv(process.env);

  constructor(@Inject(AI_CLIENT) private readonly ai: AiClient) {}

  @Post()
  async assist(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(assistantInput)) body: AssistantInput,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();

    // Closing the tab must actually stop the work. Without this the answer streams to
    // completion into a socket nobody is reading, and we pay for all of it.
    const abort = new AbortController();
    req.on("close", () => abort.abort());

    try {
      for await (const event of runTurn(
        { userDb: createUserClient(user.accessToken), serviceDb: this.serviceDb, ai: this.ai },
        {
          userId: user.id,
          noteId: body.noteId,
          sessionId: body.sessionId,
          budgetUsd: this.env.ASSISTANT_MONTHLY_BUDGET_USD,
          signal: abort.signal,
        },
      )) {
        if (res.writableEnded) break;
        const { type, ...data } = event;
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    } catch (err) {
      // Headers are already sent, so there is no status code left to set -- the only way to
      // report a failure is inside the stream. Never the raw error: it can carry model output.
      console.error(`[assistant] turn failed: ${errorMessage(err)}`);
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: "the turn failed" })}\n\n`);
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }
}
```

Register it in `apps/api/src/root.module.ts` beside `SearchController`.

- [ ] **Step 6: Run and watch them pass**

```bash
pnpm turbo run test --filter=@cortex/shared --filter=@cortex/api --force
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/dto apps/api/src apps/api/test turbo.json .github/workflows
git commit -m "feat(api): POST /assistant, as an event stream

The body is .strict() for the same reason searchInput is: a body carrying a
userId must be a 400, not a value the server quietly drops. The user id comes
from the verified JWT and nowhere else.

req.on('close') aborts the turn. Without it, closing a tab still streams the
answer to completion into a socket nobody is reading, and we pay for all of it.

Once headers are sent there is no status code left to set, so a failure can only
be reported inside the stream -- and never as the raw error, which can carry
model output.

ASSISTANT_MONTHLY_BUDGET_USD is declared in all four places. Three is the bug
this repo has shipped twice; grep .github/ and turbo.json and expect four hits.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: the box replaces quick capture

**Files:**
- Create: `apps/web/src/app/assistant-box.tsx`, `apps/web/src/app/assistant-box.test.tsx`
- Modify: `apps/web/src/app/page.tsx:71`
- Delete: `apps/web/src/app/quick-capture.tsx`

**Interfaces:**
- Consumes: `POST /notes` (existing `api.createNote`), `POST /assistant` SSE.

**Context.** The box is a strict superset of `QuickCapture`: it uses the same save path and then adds an answer. Keeping both would leave two capture paths side by side — the smell this project has been bitten by three times. `QuickCapture` disables itself offline; the box keeps that behaviour, because web has no local store and inventing one is out of scope (spec §1).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/app/assistant-box.test.tsx`, following `search-form.test.tsx` for setup:

```tsx
const sse = (events: [string, unknown][]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const [type, data] of events) {
          c.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        }
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

it("saves the note before it opens the stream", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return String(url).endsWith("/notes")
      ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
      : sse([["done", { messageId: "m1", sessionId: "s1" }]]);
  }) as typeof fetch;

  render(<AssistantBox token="t" />);
  await userEvent.type(screen.getByLabelText(/what are you thinking/i), "hôm nay tôi chạy bộ");
  await userEvent.click(screen.getByRole("button", { name: /send/i }));

  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[0]).toMatch(/\/notes$/);
  expect(calls[1]).toMatch(/\/assistant$/);
});

it("renders attached and citations whichever order they arrive in", async () => {
  globalThis.fetch = (async (url: string) =>
    String(url).endsWith("/notes")
      ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
      : sse([
          ["citations", { citations: [{ noteId: "x", title: "Older note", snippet: "s", score: 1, matchedBy: "fts" }] }],
          ["attached", { domain: "health", domainMeta: {}, tags: ["thể dục"] }],
          ["token", { text: "Đã lưu." }],
          ["done", { messageId: "m1", sessionId: "s1" }],
        ])) as typeof fetch;

  render(<AssistantBox token="t" />);
  await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
  await userEvent.click(screen.getByRole("button", { name: /send/i }));

  expect(await screen.findByText(/health/)).toBeInTheDocument();
  expect(await screen.findByText(/Older note/)).toBeInTheDocument();
  expect(await screen.findByText(/Đã lưu\./)).toBeInTheDocument();
});

// The guarantee that matters most: a dead assistant must never cost a capture.
it("keeps the note and says so when the stream fails", async () => {
  globalThis.fetch = (async (url: string) =>
    String(url).endsWith("/notes")
      ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
      : new Response("boom", { status: 500 })) as typeof fetch;

  render(<AssistantBox token="t" />);
  await userEvent.type(screen.getByLabelText(/what are you thinking/i), "ghi chú");
  await userEvent.click(screen.getByRole("button", { name: /send/i }));

  expect(await screen.findByText(/saved/i)).toBeInTheDocument();
});

it("says plainly that there is no answer when the budget declines", async () => {
  globalThis.fetch = (async (url: string) =>
    String(url).endsWith("/notes")
      ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
      : sse([["declined", { reason: "budget" }]])) as typeof fetch;

  render(<AssistantBox token="t" />);
  await userEvent.type(screen.getByLabelText(/what are you thinking/i), "ghi chú");
  await userEvent.click(screen.getByRole("button", { name: /send/i }));

  expect(await screen.findByText(/no answer/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm turbo run test --filter=@cortex/web --force
```

- [ ] **Step 3: Implement the box**

Create `apps/web/src/app/assistant-box.tsx` as a client component (`"use client"`).

The SSE reader is the part worth writing out, because the tail-buffer rule is the one people get wrong:

```tsx
/**
 * Reads an SSE body. Holds the tail: a network chunk can end mid-event, and parsing half a
 * JSON object throws. Same rule the server-side reader in gemini.ts follows.
 */
async function* readEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parse = (raw: string) => {
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

and the submit handler, whose ORDER is the whole design:

```tsx
async function submit() {
  if (!text.trim() || busy) return;
  setBusy(true);
  setStatus(null);
  try {
    // FIRST, and awaited. The note is the deliverable; the answer is a bonus. Clearing the
    // textarea only after this resolves is why a capture box never loses a thought.
    const note = await api.createNote(token, { content: text });
    setText("");

    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/assistant`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ noteId: note.id }),
    });
    if (!res.ok || !res.body) {
      setStatus("Saved. No answer right now.");
      return;
    }
    for await (const ev of readEvents(res.body)) {
      if (ev.type === "attached") setAttached(ev.data as Attached);
      else if (ev.type === "citations") setCitations(ev.data.citations as Citation[]);
      else if (ev.type === "token") setAnswer((a) => a + String(ev.data.text ?? ""));
      else if (ev.type === "declined") setStatus("Saved. No answer right now (spending limit).");
      else if (ev.type === "error") setStatus("Saved. No answer right now.");
    }
  } catch {
    // The note may well have been created before this threw. Never say it was lost.
    setStatus("Saved. No answer right now.");
  } finally {
    setBusy(false);
  }
}
```

The rest is presentation, and three details the tests pin:

1. `attached` and `citations` are **separate** pieces of state — the server emits them concurrently and either can arrive first.
2. Keep `QuickCapture`'s offline banner verbatim: `navigator.onLine` plus the `online`/`offline` listeners, and the same copy. Web has no local store; inventing one is out of scope (spec §1).
3. Label the textarea `What are you thinking?` and the submit button `Send`, matching the test queries.

- [ ] **Step 4: Swap it into the page and delete the old one**

In `apps/web/src/app/page.tsx`, replace the `QuickCapture` import and its usage at line 71 with `AssistantBox`, then delete `apps/web/src/app/quick-capture.tsx`. Grep for stragglers:

```bash
grep -rn "QuickCapture\|quick-capture" apps/web/src apps/web/e2e
```

Expected: no hits.

- [ ] **Step 5: Run and watch them pass**

```bash
pnpm turbo run test --filter=@cortex/web --force
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app
git commit -m "feat(web): one box -- it saves first, then answers

The box is a strict superset of QuickCapture: same save path, plus an answer.
Keeping both would leave two capture paths side by side, which is the smell this
project has been bitten by three times.

POST /notes completes before the stream opens, so a dead assistant costs an
answer and never a capture. The textarea clears only after the save resolves.

attached and citations are separate pieces of state because the server emits
them concurrently and either can arrive first.

The SSE reader holds its tail buffer: a network chunk can land mid-event.

Offline behaviour is QuickCapture's, unchanged -- web has no local store and
inventing one is out of scope.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: prove capture survives a dead assistant, end to end

**Files:**
- Create: `apps/web/e2e/assistant-box.spec.ts`
- Modify: `docs/deploy.md` (the Vercel build command)

**Context.** `e2e-web.yml` runs with a dummy Gemini key and states in capitals that **no E2E run may reach the real API**, so there is no real answer to assert. The property most worth protecting is testable inside that constraint anyway, and it is the one this whole design is built around.

- [ ] **Step 1: Write the E2E spec**

Create `apps/web/e2e/assistant-box.spec.ts`, following the existing specs for auth setup:

```ts
import { expect, test } from "@playwright/test";

test("a thought is saved even though the assistant cannot answer", async ({ page }) => {
  await page.goto("/");
  const text = `e2e capture ${Date.now()}`;

  await page.getByLabel(/what are you thinking/i).fill(text);
  await page.getByRole("button", { name: /send/i }).click();

  // The note is the deliverable. The API boots with a dummy Gemini key, so the turn fails --
  // and that is precisely the case worth pinning: capture must not depend on the AI path.
  await expect(page.getByText(text)).toBeVisible();
  await expect(page.getByText(/no answer right now/i)).toBeVisible();
});
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter @cortex/web test:e2e -- assistant-box.spec.ts
```

Expected: PASS. If the note does not appear, check CORS before anything else (`docs/deploy.md` §4).

- [ ] **Step 3: Pin the Vercel build command**

In the Vercel dashboard, set the project's Build Command to:

```
cd ../.. && pnpm turbo run build --filter=@cortex/web
```

It currently runs on the default and works, because Vercel's Turborepo detection builds the workspace — but a bare `next build` fails without `packages/shared/dist` and nothing in the repo produces that. Naming the command removes the inference. Update the "already true" table in `docs/deploy.md` § "Web — Vercel deploy checklist" to record that it is now set.

- [ ] **Step 4: Run the full gate**

```bash
pnpm turbo run typecheck lint test --force
```

Expected: every task successful, `Cached: 0 cached`, Docker up.

- [ ] **Step 5: Commit and open the PR**

```bash
git add apps/web/e2e docs/deploy.md
git commit -m "test(web): capture survives a dead assistant, proven end to end

E2E runs with a dummy Gemini key and may never reach the real API, so there is
no real answer to assert. The property most worth protecting is testable inside
that constraint anyway, and it is the one the whole design is built around: the
note appears, and the answer area says plainly that there is none.

Also pins the Vercel build command. It works today on the default because
Vercel's Turborepo detection builds the workspace, but a bare next build fails
without packages/shared/dist and nothing in the repo produces it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the merge

- [ ] `supabase db push` to apply `00027` to the hosted project, then confirm `migration list` shows local == remote.
- [ ] Set `ASSISTANT_MONTHLY_BUDGET_USD` on Railway and redeploy the API. Verify by piping `railway variables --json` through the compiled `parseApiEnv`, as phase 2 did — a missing var makes `main.ts` `exit(1)` and Railway shows a crash loop, not a bad config.
- [ ] Redeploy web, then walk `docs/deploy.md`'s verification table in order.
- [ ] Confirm the first real turn wrote a `usage_ledger` row with `kind='chat'`, `source='assistant'` and a non-null `request_id`. **If `input_tokens` is 0, `usageMetadata` is being dropped** — that is the failure Task 3 exists to prevent, and it is invisible from the UI.
