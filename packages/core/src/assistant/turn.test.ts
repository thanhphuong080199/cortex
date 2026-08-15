import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeAi } from "../ai/fake.js";
import { runTurn, type AssistantEvent } from "./turn.js";

const NOTE = { id: "n1", user_id: "u1", content_text: "hôm nay tôi chạy bộ ở công viên" };

interface HistoryRow {
  role: string;
  content: string;
  created_at: string;
  retrieval_meta: { incomplete?: boolean } | null;
}

/**
 * A Supabase double covering only what runTurn (and, through it, extractNote and retrieve)
 * touches -- but built as a real chainable query-builder rather than a fixed-shape object, so
 * that `.eq().is().order().limit()` (tags' vocabulary read), `.eq().single()` (the domain
 * lookup), `.eq()` awaited bare (note_tags' link read), and `.eq().order().limit()` (the two
 * chat_messages reads) can all be satisfied by ONE implementation instead of five near-copies
 * that drift apart.
 *
 * Each chain is thenable at every step (mirroring supabase-js's own PostgrestFilterBuilder),
 * so a caller may terminate it with `.single()`, `.maybeSingle()`, or by awaiting the builder
 * directly -- all three resolve to the same fixture.
 *
 * `select()` routes on the COLUMNS STRING, because that is the only thing that tells apart two
 * different reads of the same table: chat_messages' "last message" probe and its full-history
 * read both do `.eq().order().limit()`, and only their `select()` argument differs. Routing on
 * anything looser (e.g. table name alone) would let a fixture written for one chain silently
 * satisfy the other -- exactly the failure mode this double exists to avoid.
 */
function dbs(opts: { over?: boolean; history?: HistoryRow[] } = {}) {
  const inserted: Record<string, Record<string, unknown>[]> = {};

  function chain(resolve: () => { data: unknown; error: unknown }) {
    const self: Record<string, unknown> = {
      eq: () => self,
      is: () => self,
      ilike: () => self,
      order: () => self,
      limit: () => self,
      select: () => self,
      single: async () => resolve(),
      maybeSingle: async () => resolve(),
      then: (
        onFulfilled: (r: { data: unknown; error: unknown }) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return self;
  }

  const insertChain = (name: string, row: Record<string, unknown>) => {
    (inserted[name] ??= []).push(row);
    return chain(() => ({ data: { id: `${name}-1` }, error: null }));
  };

  const table = (name: string) => ({
    select: (cols?: string) => {
      if (name === "notes" && cols === "id, content_text") {
        return chain(() => ({ data: NOTE, error: null }));
      }
      if (name === "notes" && cols === "domain") {
        return chain(() => ({ data: { domain: null }, error: null }));
      }
      // The "last message" probe (session resolution): always empty, so every turn in this
      // suite starts a fresh session -- none of these tests need cross-turn session reuse.
      if (name === "chat_messages" && cols?.includes("session_id")) {
        return chain(() => ({ data: [], error: null }));
      }
      // The full-history read. This is the ONLY chain `opts.history` threads into.
      if (name === "chat_messages" && cols?.includes("retrieval_meta")) {
        return chain(() => ({ data: opts.history ?? [], error: null }));
      }
      if (name === "tags" && cols?.includes("id, name")) {
        return chain(() => ({ data: [], error: null }));
      }
      if (name === "note_tags" && cols === "tag_id") {
        return chain(() => ({ data: [], error: null }));
      }
      throw new Error(`dbs() double: unhandled select on "${name}" (cols: ${String(cols)})`);
    },
    insert: (row: Record<string, unknown>) => insertChain(name, row),
    update: () => chain(() => ({ data: null, error: null })),
    upsert: () => chain(() => ({ data: null, error: null })),
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

  // This scripts `usage()` returning a value AFTER the chunk iterator throws -- something the
  // real Gemini client (packages/core/src/ai/gemini.ts's openStream) cannot do: usageMetadata
  // only ever arrives on the FINAL SSE event, so a socket death before that event means `usage`
  // (the closure variable) was never assigned and `stream.usage()` returns null, not a value.
  // What this test actually pins is runTurn's OWN branch -- "bill whenever `streamUsage` is
  // truthy, independent of whether the stream finished" -- using a value the fake CAN produce
  // but the real client never will. It documents that code path, not a guarantee that a real
  // failed stream is ever billed; the next test (with `usage: () => null`, the shape the real
  // client actually produces on a mid-stream death) pins the far more common case.
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
});
