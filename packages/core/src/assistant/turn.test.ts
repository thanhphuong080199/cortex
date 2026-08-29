import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ANSWER_MODEL, formatToday, GROUNDING_USD_PER_QUERY, SESSION_IDLE_RESET_MS,
} from "@cortex/shared";
import type { GroundingResult } from "../ai/client.js";
import { createFakeAi } from "../ai/fake.js";
import { EXTRACT_DEADLINE_MS, runTurn, type AssistantEvent } from "./turn.js";

const NOTE = {
  id: "n1", user_id: "u1",
  content_text: "hôm nay tôi chạy bộ ở công viên",
  created_at: "2026-08-14T01:02:03.000Z",
};

interface HistoryRow {
  role: string;
  content: string;
  created_at: string;
  retrieval_meta: {
    incomplete?: boolean;
    asked?: { noteId: string; field: string };
  } | null;
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
function dbs(
  opts: {
    over?: boolean; history?: HistoryRow[]; note?: typeof NOTE | null;
    failInsertOn?: string;
    mediaItem?: { id: string; title: string; kind: string };
    lastMessage?: { session_id: string; created_at: string };
    /** Simulates the backfill's own `.is()` filters legitimately matching zero rows. */
    backfillRejected?: boolean;
  } = {},
) {
  const inserted: Record<string, Record<string, unknown>[]> = {};
  const updated: Record<string, Record<string, unknown>[]> = {};

  function chain(
    resolve: () => { data: unknown; error: unknown },
    onFilter?: (column: string, value: unknown) => void,
  ) {
    const self: Record<string, unknown> = {
      eq: (column: string, value: unknown) => { onFilter?.(column, value); return self; },
      is: (column: string, value: unknown) => { onFilter?.(column, value); return self; },
      ilike: () => self,
      filter: () => self,
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
    // Spread the row back, not just a placeholder id: NoteService.createWithId reads
    // `.content`/`.created_at` off what insert().select().single() resolves to, and a
    // bare `{ id }` would leave those undefined, crashing the md5 hash a few lines later
    // in runTurn instead of failing the assertion the test actually wrote.
    return chain(() =>
      opts.failInsertOn === name
        ? { data: null, error: { code: "23514", message: "check constraint" } }
        : { data: { id: `${name}-1`, ...row }, error: null },
    );
  };

  const table = (name: string) => ({
    select: (cols?: string) => {
      if (name === "notes" && cols === "id, content_text, created_at") {
        return chain(() => ({ data: opts.note === undefined ? NOTE : opts.note, error: null }));
      }
      if (name === "notes" && cols === "domain") {
        return chain(() => ({ data: { domain: null }, error: null }));
      }
      // The client-supplied sessionId ownership check (runTurn, before session resolution).
      // Always "not found": this double's `eq()` does not record its arguments, so it cannot
      // tell a genuinely-owned id from a guessed one. Returning null here is safe because it
      // only pushes resolution onto the "last message" probe below, which is what every test
      // that cares about which session a turn lands in already supplies via `opts.lastMessage`.
      if (name === "chat_sessions" && cols === "id") {
        return chain(() => ({ data: null, error: null }));
      }
      // The "last message" probe (session resolution). Empty by default, so a turn with no
      // `lastMessage` starts a fresh session -- which is what every test written before C4
      // assumed. `lastMessage` is what lets a test say "this user was mid-conversation".
      if (name === "chat_messages" && cols?.includes("session_id")) {
        return chain(() => ({ data: opts.lastMessage ? [opts.lastMessage] : [], error: null }));
      }
      // The full-history read. `opts.history` supplies genuine PRIOR turns; rows already
      // pushed onto `inserted.chat_messages` by this same runTurn call (read lazily, at
      // resolve time, so this reflects whichever insert has actually run by then) are merged
      // in too. That merge is what lets this double catch the current-turn-duplicated-into-
      // its-own-history bug: read-then-insert (the fix) sees none of its own row, while
      // insert-then-read (the bug) would see it.
      if (name === "chat_messages" && cols?.includes("retrieval_meta")) {
        return chain(() => {
          const already = (inserted.chat_messages ?? []).map((r) => ({
            role: r.role as string,
            content: r.content as string,
            created_at: new Date().toISOString(),
            retrieval_meta: (r.retrieval_meta as HistoryRow["retrieval_meta"]) ?? null,
          }));
          // Newest first, matching the real query's `order("created_at", { ascending: false })`.
          // runTurn now reads history[0] as "the message immediately before this turn", so a
          // double that answered in insertion order would silently invert that.
          return {
            data: [...(opts.history ?? []), ...already]
              .sort((a, b) => b.created_at.localeCompare(a.created_at)),
            error: null,
          };
        });
      }
      if (name === "tags" && cols?.includes("id, name")) {
        return chain(() => ({ data: [], error: null }));
      }
      if (name === "note_tags" && cols === "tag_id") {
        return chain(() => ({ data: [], error: null }));
      }
      // MediaService.findLiveByTitle: awaited bare (no .single()), so the shape is always an
      // array -- empty drives findOrCreate into its insert branch, one entry is a "found" hit.
      if (name === "media_items") {
        return chain(() => ({
          data: opts.mediaItem ? [mediaItemRow()] : [],
          error: null,
        }));
      }
      throw new Error(`dbs() double: unhandled select on "${name}" (cols: ${String(cols)})`);
    },
    insert: (row: Record<string, unknown>) => insertChain(name, row),
    update: (row: Record<string, unknown> = {}) => {
      // `__where` captures the .eq()/.is() chain that scoped this update. Without it a test can
      // see that SOME note was linked but not WHICH -- and S2's backfill is defined entirely by
      // which note it targets.
      const where: Record<string, unknown> = {};
      (updated[name] ??= []).push({ ...row, __where: where });
      const sink = (column: string, value: unknown) => { where[column] = value; };
      // MediaService.reconcileYear's backfill (`.update({ year }).eq().eq().select().single()`)
      // when the fixture item is missing the year `pending_item` supplies. Spread the row back,
      // same trick insertChain uses above -- the caller reads the UPDATED item off this, not a
      // placeholder.
      if (name === "media_items") {
        return chain(() => (
          opts.mediaItem ? { data: { ...mediaItemRow(), ...row }, error: null } : { data: null, error: null }
        ), sink);
      }
      // resolveNoteMediaLink's link write (`.update({ media_item_id, domain_meta })...
      // .select("id").maybeSingle()`). A null noteId row (this suite's "note not found" fixtures
      // never carry domain: "media", so this branch is otherwise unreached) falls through to the
      // generic case below rather than crashing on `.id`.
      if (name === "notes" && "media_item_id" in row) {
        // Task 6's backfill write carries `media_item_id` ALONE; resolveNoteMediaLink's write
        // carries `domain_meta` too. That key is the only signal this double has for telling
        // the two calls apart, since both target "notes" with an update() naming
        // `media_item_id` -- and it's what lets `opts.backfillRejected` simulate the backfill's
        // own filters (.is("deleted_at", null), .is("media_item_id", null)) legitimately
        // matching zero rows, independently of whether the CURRENT note's own link write
        // (resolveNoteMediaLink) succeeds.
        const isBackfill = !("domain_meta" in row);
        if (isBackfill && opts.backfillRejected) {
          return chain(() => ({ data: null, error: null }), sink);
        }
        const noteRow = opts.note === undefined ? NOTE : opts.note;
        return chain(() => (
          noteRow ? { data: { id: noteRow.id }, error: null } : { data: null, error: null }
        ), sink);
      }
      return chain(() => ({ data: null, error: null }), sink);
    },
    upsert: () => chain(() => ({ data: null, error: null })),
  });

  // A full MediaItem row (packages/core/src/media/service.ts's interface), defaulted the way a
  // real media_items row would be, merged with the fixture's `id`/`title`/`kind`. `year: null`
  // rather than omitted -- reconcileYear branches on `item.year !== null`, and `undefined !==
  // null` would wrongly take the "year already set, and it conflicts" throw instead of the
  // "backfill it" update this fixture is built to exercise.
  function mediaItemRow(): Record<string, unknown> {
    return {
      user_id: "u1", year: null, creator: null, external_meta: {},
      created_at: "2020-01-01T00:00:00.000Z", deleted_at: null,
      ...opts.mediaItem,
    };
  }

  const client = {
    from: (n: string) => table(n),
    rpc: async (fn: string) =>
      fn === "usage_month_to_date_usd"
        ? { data: opts.over ? 999 : 0, error: null }
        : { data: [], error: null },
  } as unknown as SupabaseClient;

  return { client, inserted, updated };
}

const collect = async (gen: AsyncGenerator<AssistantEvent>) => {
  const out: AssistantEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

const ai = (value: Record<string, unknown> = {}) =>
  createFakeAi({
    generateJson: async () => ({
      value: { intent: "statement", complexity: "simple", domain: null,
               domain_meta: {}, tags: [], mood: null, ...value },
      inputTokens: 10, outputTokens: 5, model: "fake-classify",
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
    // Spec §9: "One event, one meaning". `attached` is emitted from two call sites (mid-stream
    // via the token loop, or after the stream via annotationEvents) and `sentAttached` is what
    // keeps them mutually exclusive -- a count, not just presence, is what catches a regression
    // that emits both.
    expect(types.filter((t) => t === "attached")).toHaveLength(1);
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

  // Finding 1 (Stage C1 review round 1): a rejected retrieval used to become `[]` with no log
  // line anywhere, and the prompt then rendered "The user has no notes matching this." -- a
  // false claim, since the search failed rather than genuinely finding nothing.
  it("logs a rejected retrieval and tells the model the search failed, not that there are none", async () => {
    const { client } = dbs();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let seen = "";
    const broken = createFakeAi({
      generateJson: async () => ({
        value: { intent: "statement", complexity: "simple", domain: "health", domain_meta: {}, tags: [] },
        inputTokens: 1, outputTokens: 1, model: "fake-classify",
      }),
      embed: async () => { throw new Error("embed exploded"); },
      generateStream: async ({ prompt }) => {
        seen = prompt;
        return { chunks: (async function* () { yield { text: "ok" }; })(), usage: () => null };
      },
    });
    try {
      const events = await collect(runTurn({ userDb: client, serviceDb: client, ai: broken },
        { userId: "u1", noteId: "n1", budgetUsd: 100 }));
      // The wire event is untouched by this fix -- still `[]` + degraded: true.
      const citationsEvent = events.find((e) => e.type === "citations");
      expect(citationsEvent).toMatchObject({ citations: [], degraded: true });
      // But the PROMPT must say something true, not "no notes matching".
      expect(seen).toMatch(/could not be searched/i);
      expect(seen).not.toMatch(/no notes matching/i);
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("[assistant] retrieval failed");
      expect(logged).toContain("embed exploded");
    } finally {
      spy.mockRestore();
    }
  });

  // The other half of Finding 1: a thrown extraction was equally silent, and indistinguishable
  // in the logs from a `withDeadline` timeout (there were no logs for either).
  it("logs a rejected extraction instead of staying silent", async () => {
    const { client } = dbs();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const brokenAi = createFakeAi({
      generateJson: async () => { throw new Error("classify exploded"); },
      generateStream: async () => ({
        chunks: (async function* () { yield { text: "ok" }; })(),
        usage: () => null,
      }),
    });
    try {
      await collect(runTurn({ userDb: client, serviceDb: client, ai: brokenAi },
        { userId: "u1", noteId: "n1", budgetUsd: 100 }));
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("[assistant] extraction failed");
      expect(logged).toContain("classify exploded");
    } finally {
      spy.mockRestore();
    }
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

  // Reported 2026-08-24: "Cung điện ký ức là gì?" got back an acknowledgement of a filed note
  // instead of an answer -- `extracted` was null (the classifier call failed or missed
  // EXTRACT_DEADLINE_MS) and `wantsAnswer` had no branch for that case, so an unmistakable
  // question fell into buildAcknowledgePrompt. `looksLikeQuestion`'s keyword fallback patched
  // that one case, and then itself misrouted a second question on 2026-08-29 ("Bơi lội có giúp
  // phát triển cơ bắp không"), because a fallback is still a branch a message can fall on the
  // wrong side of. Removing the gate on 2026-08-29 fixes it structurally instead: there is no
  // wrong branch left for a degraded extraction to fall into, so no fallback is needed at all.
  it("still answers an unmistakable question when classification fails entirely", async () => {
    const { client } = dbs({ note: { ...NOTE, content_text: "Cung điện ký ức là gì?" } });
    let seen = "";
    const brokenAi = createFakeAi({
      generateJson: async () => { throw new Error("classify exploded"); },
      generateStream: async ({ prompt }) => {
        seen = prompt;
        return {
          chunks: (async function* () { yield { text: "ok" }; })(),
          usage: () => null,
        };
      },
    });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: brokenAi },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));
    // buildTurnPrompt's own signature line -- there is no separate "Their question:" branch left
    // to check for, and none of the old acknowledge prompt's refusal language survives either.
    expect(seen).toMatch(/Their message:/);
    expect(seen).not.toMatch(/Their question:/);
    expect(seen).not.toMatch(/The user did not ask a question/);
    expect(events.map((e) => e.type)).toContain("token");
  });

  // Was "still acknowledges an ordinary statement when classification fails" until 2026-08-29.
  // `looksLikeQuestion`'s job was telling this note apart from the question above it, so a
  // degraded extraction would not start answering everything -- a narrow "?" / interrogative-
  // phrase check, not a guess. With the gate gone there is nothing left to tell apart: a degraded
  // extraction reaches the exact same prompt and model as a live one, whatever the note says.
  it("still answers on the answer model when classification fails, for a plain statement too", async () => {
    const { client } = dbs({ note: { ...NOTE, content_text: "hôm nay tôi chạy bộ ở công viên" } });
    let seen = "";
    const brokenAi = createFakeAi({
      generateJson: async () => { throw new Error("classify exploded"); },
      generateStream: async ({ prompt }) => {
        seen = prompt;
        return {
          chunks: (async function* () { yield { text: "ok" }; })(),
          usage: () => null,
        };
      },
    });
    await collect(runTurn(
      { userDb: client, serviceDb: client, ai: brokenAi },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));
    expect(seen).toMatch(/Their message:/);
    expect(seen).not.toMatch(/The user did not ask a question/);
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

  // `incomplete` says a turn died; it never said WHY, and nothing else did either. The catch
  // around the model stream is the only place `incomplete` is set, and it yielded the reason as
  // an SSE event that both clients deliberately ignore, logged nothing (alone among this file's
  // failure branches), and persisted `{ requestId, incomplete }` with the message left out. So
  // the one user-visible failure in the system was the one nothing recorded -- which is why the
  // "Hello hello" report of 2026-08-23 could be reproduced only as far as "the stream threw".
  //
  // Asserted on the persisted row rather than the yielded event: the event existed already.
  it("records WHY a stream died on the row it writes", async () => {
    const { client, inserted } = dbs();
    const failing = createFakeAi({
      generateJson: async () => ({
        value: { intent: "question", complexity: "simple", domain: null, domain_meta: {}, tags: [] },
        inputTokens: 1, outputTokens: 1, model: "fake-classify",
      }),
      generateStream: async () => ({
        chunks: (async function* () {
          yield { text: "half" };
          throw new Error("gemini 429");
        })(),
        usage: () => null,
      }),
    });
    await collect(runTurn(
      { userDb: client, serviceDb: client, ai: failing },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));
    const assistantRow = (inserted.chat_messages ?? []).find((m) => m.role === "assistant");
    const meta = assistantRow?.retrieval_meta as { incomplete?: boolean; error?: string };
    expect(meta.incomplete).toBe(true);
    expect(meta.error).toContain("gemini 429");
  });

  // The other half, and the one an implementation that always stamps `error` would break: a
  // turn that finished must not carry a failure reason. A row with `error` on it is read by a
  // human as evidence something went wrong.
  it("leaves no error on a turn that completed", async () => {
    const { client, inserted } = dbs();
    await collect(runTurn(
      { userDb: client, serviceDb: client, ai: ai() },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));
    const assistantRow = (inserted.chat_messages ?? []).find((m) => m.role === "assistant");
    const meta = assistantRow?.retrieval_meta as { incomplete?: boolean; error?: string };
    expect(meta.incomplete).toBe(false);
    expect(meta.error).toBeUndefined();
  });

  // Finding 2 (Stage C1 review round 1): the user's turn is written before history is read, and
  // with no exclusion the just-inserted row IS the history -- renderHistory then shows the model
  // its own current note/question a second time, mislabeled as something that already happened.
  it("does not duplicate the current turn's own message into its history", async () => {
    // A note text of this test's OWN choosing, not the shared NOTE fixture's "hôm nay tôi chạy bộ
    // ở công viên" -- GROUNDING_RULE (prompts.ts) uses that exact sentence, verbatim, as its own
    // worked example of something not worth searching for, so counting NOTE.content_text's
    // occurrences in the rendered prompt started passing for the wrong reason (2/2, not 1/1) the
    // moment buildTurnPrompt's rules began rendering on every turn.
    const noteText = "buổi sáng nay mình chạy 5km ở công viên gần nhà";
    const { client } = dbs({ note: { ...NOTE, content_text: noteText } });
    let seen = "";
    const capturing = createFakeAi({
      generateJson: async () => ({
        value: { intent: "statement", complexity: "simple", domain: "health", domain_meta: {}, tags: [] },
        inputTokens: 1, outputTokens: 1, model: "fake-classify",
      }),
      generateStream: async ({ prompt }) => {
        seen = prompt;
        return { chunks: (async function* () { yield { text: "ok" }; })(), usage: () => null };
      },
    });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: capturing },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));
    // No real prior turns exist in this fixture (opts.history defaults to []), so a correct
    // history read is empty and renderHistory emits no section at all. The bug would have this
    // read back the note it just wrote and render one.
    //
    // The exact rendered heading, WITH its colon, and case-sensitive -- not the looser
    // case-insensitive phrase this asserted until 2026-08-29. buildTurnPrompt's CORRECTION_RULE
    // now renders unconditionally on every turn and happens to contain the same lowercase words
    // ("...never to something you yourself said earlier in this conversation."), which made the
    // looser regex a false positive the moment CORRECTION_RULE started rendering here too.
    expect(seen).not.toContain("Earlier in this conversation:");
    expect(seen.match(new RegExp(noteText, "g"))?.length ?? 0).toBe(1);
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

  // The wiring, end to end: what the turn reads out of chat_messages has to reach the classifier
  // prompt. Asserted on the prompt text itself, because a plumbing mistake here (passing nothing,
  // or passing it to the wrong call) is invisible in every other assertion -- the turn still
  // answers, just with the wrong branch.
  it("shows the classifier the conversation so far", async () => {
    const { client } = dbs({
      history: [
        { role: "user", content: "RAG là gì", created_at: "2026-08-16T10:00:00Z", retrieval_meta: null },
        { role: "assistant", content: "RAG là retrieval augmented generation.",
          created_at: "2026-08-16T10:00:05Z", retrieval_meta: null },
      ],
    });
    const prompts: string[] = [];
    const recordingAi = createFakeAi({
      generateJson: async (args) => {
        prompts.push(args.prompt);
        return {
          value: { intent: "question", complexity: "simple", domain: null,
                   domain_meta: {}, tags: [], mood: null },
          inputTokens: 10, outputTokens: 5, model: "fake-classify",
        };
      },
      generateStream: async () => ({
        chunks: (async function* () { yield { text: "ok" }; })(),
        usage: () => ({ inputTokens: 20, outputTokens: 4, model: "fake-answer" }),
      }),
    });

    await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(prompts[0], "the classifier prompt").toContain("RAG là gì");
  });

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
    // rating: 4, not 8.5 -- domainMetaSchemas.media (packages/shared/src/dto/domains.ts)
    // caps rating at an integer 1-5. A value outside that range would fail
    // validateDomainMeta's safeParse and get dropped to `{}` by extractNote, which would
    // make this test pass for the wrong reason (silently exercising the "invalid meta
    // dropped" branch instead of the "real meta carried through" one it is meant to pin).
    const scripted = ai({ domain: "media", domain_meta: { rating: 4 } });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: scripted },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));

    const attached = events.find((e) => e.type === "attached");
    expect(attached).toMatchObject({ domainMeta: { rating: 4 } });
  });

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

  /**
   * Red when the resolver call site is removed from the turn: the note is filed under "media"
   * with a rating and no media_item_id, and the box has nothing to name.
   */
  it("links a media note and names the item on the attached event", async () => {
    const { client } = dbs({ mediaItem: { id: "mi1", title: "Inception", kind: "movie" } });
    const scripted = ai({
      domain: "media",
      // rating: 4, not 8.5 -- domainMetaSchemas.media.rating is an integer 1-5. 8.5 would fail
      // extractNote's own meta parse and drop pending_item along with it, so the resolver would
      // never see it and this test would pass without exercising the link at all.
      domain_meta: { rating: 4, pending_item: { kind: "movie", title: "Inception", year: 2010 } },
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
      // year: 1900, not 1 -- pendingMediaItem.year is an integer 1000-2200 (packages/shared/
      // src/dto/media.ts). year: 1 fails that check, which fails domainMetaSchemas.media's
      // .strict() parse for the WHOLE object and drops pending_item too -- resolveNoteMediaLink
      // would then see no pending_item and return null without ever reaching the failing
      // insert this test means to exercise.
      domain_meta: { pending_item: { kind: "movie", title: "Unknown", year: 1900 } },
    });
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: scripted },
      { userId: "u1", noteId: "n1", budgetUsd: 100 },
    ));

    expect(events.map((e) => e.type)).toContain("token");
  });

  // A recorder ARRAY, not a nullable variable reassigned by the fake: `let seenArgs: {...} |
  // undefined` initialised to `undefined` gets narrowed by TS to exactly `undefined` at every
  // read site in this file, since the only assignment is inside a closure passed to
  // `createFakeAi` that TS cannot see runs before the read -- `seenArgs?.grounding` below then
  // becomes a property access on `never` (TS2339) once `strict` build-mode typechecking (not
  // vitest, which never typechecks) looks at this file. Pushing into an array sidesteps the
  // narrowing without weakening either assertion below: each test still reads the exact
  // `grounding` value `runTurn` passed to `generateStream`.
  const seenArgs: { grounding?: boolean }[] = [];

  // A scripted stream that reports grounding, for the tests below.
  const groundedAi = (g: GroundingResult | null, intent = "question") => createFakeAi({
    generateJson: async () => ({
      value: { intent, complexity: "simple", domain: null, domain_meta: {}, tags: [], mood: null },
      inputTokens: 5, outputTokens: 2, model: "fake-classify",
    }),
    generateStream: async (args) => {
      seenArgs.push(args);
      return {
        chunks: (async function* () { yield { text: "câu trả lời" }; })(),
        usage: () => ({ inputTokens: 30, outputTokens: 8, model: "fake-answer" }),
        grounding: () => g,
      };
    },
  });

  it("declares grounding on the answer path", async () => {
    const { client } = dbs();
    seenArgs.length = 0;
    await collect(runTurn({ userDb: client, serviceDb: client, ai: groundedAi(null) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(seenArgs[0]?.grounding).toBe(true);
  });

  // Was "does NOT declare grounding on the acknowledge path" until 2026-08-29. There is no
  // acknowledge branch to withhold grounding from any more: searching the web on "hôm nay mình
  // ngủ 5 tiếng" is now discouraged by GROUNDING_RULE, an instruction in the one shared prompt,
  // rather than prevented by a code branch. That is a real cost the stage spec accepts (§7) --
  // an instruction can be ignored where a branch could not -- in exchange for removing the gate
  // that misrouted real questions into this same branch.
  it("declares grounding on the statement path too, now that there is no acknowledge branch", async () => {
    const { client } = dbs();
    seenArgs.length = 0;
    await collect(runTurn({ userDb: client, serviceDb: client, ai: groundedAi(null, "statement") },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(seenArgs[0]?.grounding).toBe(true);
  });

  // The wire event carries WebCitation[] (with `type: "web"`), not the AI client's internal
  // WebSource[] (no `type` key) -- the same shape `chat_messages.citations` already gets below.
  // Both clients declare the `web` event's `sources` as `WebCitation[]` and reach it through an
  // unchecked cast; emitting `grounding.sources` as-is would make that declared type a lie.
  it("emits a web event carrying the sources and the queries", async () => {
    const { client } = dbs();
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: groundedAi({
          sources: [{ url: "https://a.example", title: "a" }],
          queries: ["Dune 3"], entryPoint: "<div>chips</div>",
        }) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 },
    ));
    expect(events.find((e) => e.type === "web")).toEqual({
      type: "web",
      sources: [{ type: "web", url: "https://a.example", title: "a" }],
      queries: ["Dune 3"],
      entryPoint: "<div>chips</div>",
    });
  });

  // "Did this turn search the web" is exactly "did a web event arrive", with no second flag to
  // keep in step. An unconditional yield destroys that property: a notes-only turn would emit
  // `sources: []` and every client would need to re-check the length.
  it("emits no web event at all when nothing was searched", async () => {
    const { client } = dbs();
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: groundedAi(null) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 },
    ));
    expect(events.some((e) => e.type === "web")).toBe(false);
  });

  // It cannot ride in `citations` (yielded at turn.ts:222, before generateStream at 249 -- the
  // metadata does not exist yet), and it must not arrive after `done`, which is the clients'
  // end-of-turn signal.
  it("emits web after the last token and before done", async () => {
    const { client } = dbs();
    const events = await collect(runTurn(
      { userDb: client, serviceDb: client, ai: groundedAi({
          sources: [{ url: "https://a.example", title: "a" }], queries: ["q"],
        }) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 },
    ));
    const types = events.map((e) => e.type);
    expect(types.lastIndexOf("token")).toBeLessThan(types.indexOf("web"));
    expect(types.indexOf("web")).toBeLessThan(types.indexOf("done"));
  });

  it("persists web sources alongside note citations", async () => {
    const { client, inserted } = dbs();
    await collect(runTurn(
      { userDb: client, serviceDb: client, ai: groundedAi({
          sources: [{ url: "https://a.example", title: "a" }], queries: ["q"],
        }) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 },
    ));
    const msg = (inserted.chat_messages ?? []).find((r) => r.role === "assistant");
    expect(msg!.citations).toContainEqual({ type: "web", url: "https://a.example", title: "a" });
  });

  it("bills a grounded turn against the assistant budget", async () => {
    const { client, inserted } = dbs();
    await collect(runTurn(
      { userDb: client, serviceDb: client, ai: groundedAi({
          sources: [{ url: "https://a.example", title: "a" }], queries: ["Dune 3"],
        }) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 },
    ));
    const row = (inserted.usage_ledger ?? []).find((r) => r.kind === "grounding");
    expect(row, "no grounding row was written").toBeDefined();
    expect(row!.cost_usd).toBeCloseTo(GROUNDING_USD_PER_QUERY, 6);
    // `source: 'assistant'` is what makes isOverBudget see it -- that function sums by SOURCE,
    // not by kind, so any other value here means grounding spend never declines a later turn.
    expect(row!.source).toBe("assistant");
  });

  // The model searched and every chunk came back unusable. Google still billed the query.
  it("bills a turn that searched and got no usable sources", async () => {
    const { client, inserted } = dbs();
    await collect(runTurn(
      { userDb: client, serviceDb: client, ai: groundedAi({ sources: [], queries: ["gì đó"] }) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 },
    ));
    expect((inserted.usage_ledger ?? []).some((r) => r.kind === "grounding")).toBe(true);
  });

  // extractGrounding degrades a non-array webSearchQueries to `[]` (gemini.test.ts), and
  // handleEvent's last-one-wins capture would produce this same shape if Gemini ever split
  // queries and sources across chunks: sources present, queries empty. That state still renders
  // a full "Từ web" block with live links and still persists web citations, so it must still be
  // billed -- sources are equally good evidence Google was queried. Red if `searched` goes back
  // to keying on `queries.length` alone.
  it("bills a turn that has sources but no queries", async () => {
    const { client, inserted } = dbs();
    await collect(runTurn(
      { userDb: client, serviceDb: client, ai: groundedAi({
          sources: [{ url: "https://a.example", title: "a" }], queries: [],
        }) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 },
    ));
    expect((inserted.usage_ledger ?? []).some((r) => r.kind === "grounding")).toBe(true);
  });

  it("writes no grounding row when the model did not search", async () => {
    const { client, inserted } = dbs();
    await collect(runTurn(
      { userDb: client, serviceDb: client, ai: groundedAi(null) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 },
    ));
    expect((inserted.usage_ledger ?? []).some((r) => r.kind === "grounding")).toBe(false);
  });

  // The turn's half of the shared decision. This asserts the OUTCOME (a new chat_sessions row,
  // or none) rather than that a particular function was called, which is the honest limit here:
  // it stays green against a correct copy of the logic and turns red against a wrong one. The
  // guard against a *correct* copy silently drifting later is that there is only one place to
  // change -- Step 6 removed the arithmetic from this file entirely.
  it("resumes the session the last message belongs to", async () => {
    const { client, inserted } = dbs({
      lastMessage: { session_id: "s-old", created_at: new Date(Date.now() - 60_000).toISOString() },
    });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: ai() },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(inserted.chat_sessions ?? []).toHaveLength(0);
    expect((inserted.chat_messages ?? []).every((r) => r.session_id === "s-old")).toBe(true);
  });

  it("opens a new session once the idle gap has passed", async () => {
    const { client, inserted } = dbs({
      lastMessage: {
        session_id: "s-old",
        created_at: new Date(Date.now() - SESSION_IDLE_RESET_MS - 1000).toISOString(),
      },
    });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: ai() },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(inserted.chat_sessions ?? []).toHaveLength(1);
    expect((inserted.chat_messages ?? []).some((r) => r.session_id === "s-old")).toBe(false);
  });

  it("stamps a chitchat turn's note as chitchat", async () => {
    const { client, updated } = dbs();
    await collect(runTurn({ userDb: client, serviceDb: client, ai: ai({ intent: "chitchat" }) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(updated.notes ?? []).toContainEqual(expect.objectContaining({ source_type: "chitchat" }));
  });

  it("stamps a question's note as chat, not chitchat", async () => {
    const { client, updated } = dbs();
    await collect(runTurn({ userDb: client, serviceDb: client, ai: ai({ intent: "question" }) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(updated.notes ?? []).toContainEqual(expect.objectContaining({ source_type: "chat" }));
  });

  // The three-way must stay three-way. A statement is the DEFAULT branch and is left alone at
  // 'quick': stamping it would relabel every ordinary capture as something it is not.
  it("leaves an ordinary statement's source_type alone", async () => {
    const { client, updated } = dbs();
    await collect(runTurn({ userDb: client, serviceDb: client, ai: ai({ intent: "statement" }) },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect((updated.notes ?? []).some((r) => "source_type" in r)).toBe(false);
  });

  // Was "does not spend the answer model on chitchat" until 2026-08-29. Small talk no longer
  // avoids the reasoning model: the classify-gate that kept it on the cheap path also misrouted
  // real questions into "note filed" whenever it timed out (2026-08-24 and 2026-08-29), and it is
  // gone. Whether to ground "haha ok" against Google is now controlled by GROUNDING_RULE in the
  // prompt instead of a code branch (prompts.ts) -- an instruction, not a guarantee, which is the
  // tradeoff the stage spec accepts in exchange for removing the gate that misrouted questions.
  //
  // A recorder ARRAY, not a nullable variable reassigned by the fake, for the reason spelled out
  // at turn.test.ts:548: an early return inside createFakeAi that TS cannot see would leave a
  // nullable `seen` undefined, and `seen?.model` then passes vacuously.
  it("answers chitchat on the answer model too, with grounding offered", async () => {
    const { client } = dbs();
    const seen: { model?: string; grounding?: boolean }[] = [];
    const recordingAi = createFakeAi({
      generateJson: async () => ({
        value: { intent: "chitchat", complexity: "simple", domain: null,
                 domain_meta: {}, tags: [], mood: null },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      }),
      generateStream: async (args) => {
        seen.push(args);
        return {
          chunks: (async function* () { yield { text: "hehe" }; })(),
          usage: () => ({ inputTokens: 5, outputTokens: 2, model: "fake-classify" }),
        };
      },
    });

    await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(seen[0]?.model).toBe(ANSWER_MODEL);
    expect(seen[0]?.grounding).toBe(true);
  });

  // THE TURN THIS WHOLE TASK EXISTS FOR: a note to file AND a question, in one sentence. From
  // the routing point on it must be indistinguishable from a pure question -- same prompt, same
  // model, same grounding. Assertions on all three and not one, because the old `isQuestion`
  // drove exactly these and a partial fix would leave the answer ungrounded or running on
  // flash-lite with nothing to show that it had.
  //
  // THE STAMP IS THE EXCEPTION, and it used to be asserted here as `source_type: "chat"`
  // (changed 2026-08-23). "Indistinguishable from a pure question" was right about the REPLY and
  // wrong about the filing: this turn is a note the user recorded -- "dạo này hơi mỏi mắt" is a
  // fact about them -- and 00039 makes 'chat' unrecallable. Stamping it would mean a sentence
  // that also ends in a question mark quietly never gets recalled again.
  it("answers a statement that also asks something", async () => {
    const { client, updated } = dbs();
    const seen: { prompt?: string; model?: string; grounding?: boolean }[] = [];
    const recordingAi = createFakeAi({
      generateJson: async () => ({
        value: { intent: "statement", alsoWantsAnswer: true, complexity: "simple",
                 domain: null, domain_meta: {}, tags: [], mood: null },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      }),
      generateStream: async (a) => {
        seen.push(a);
        return {
          chunks: (async function* () { yield { text: "Cá hồi và rau xanh." }; })(),
          usage: () => ({ inputTokens: 5, outputTokens: 4, model: ANSWER_MODEL }),
        };
      },
    });

    await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));

    expect(seen[0]?.model, "must reach the answer model").toBe(ANSWER_MODEL);
    expect(seen[0]?.grounding, "must be allowed to search the web").toBe(true);
    // Keeps the 'quick' it was created with -- no source_type write at all. See the note above.
    expect((updated.notes ?? []).some((r) => "source_type" in r)).toBe(false);
    // The acknowledge prompt's refusal is the sentence that swallowed the question. Its absence
    // is the only direct evidence the ANSWER prompt ran rather than a reworded acknowledge one.
    expect(seen[0]?.prompt).not.toMatch(/did not ask a question/i);
  });

  // Confirmed by the user: this branch must NOT announce a save. The property is bought by
  // buildTurnPrompt itself, which never mentions filing at all (prompts.ts §5.1 -- classification
  // hasn't settled when the prompt is built, so there is nothing to announce) -- so this asserts
  // the outcome, which stays green against a correct implementation and red against one that
  // "helpfully" adds a filing line back in.
  it("does not announce the filing when it answers a statement", async () => {
    const { client } = dbs();
    const seen: { prompt?: string }[] = [];
    const recordingAi = createFakeAi({
      generateJson: async () => ({
        value: { intent: "statement", alsoWantsAnswer: true, complexity: "simple",
                 domain: "health", domain_meta: {}, tags: [], mood: null },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      }),
      generateStream: async (a) => {
        seen.push(a);
        return {
          chunks: (async function* () { yield { text: "ok" }; })(),
          usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
        };
      },
    });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(seen[0]?.prompt).not.toMatch(/You filed it under/i);
    expect(seen[0]?.prompt).not.toMatch(/Mention what you attached/i);
  });

  // Was "leaves an ordinary statement on the cheap path" until 2026-08-29. The cheap path is
  // gone: it existed because a classifier told turn.ts which of three prompts to use, and that
  // gate misrouted real questions into "note filed" whenever it timed out (2026-08-24 and
  // 2026-08-29). An ordinary recorded note now reaches the same model and the same prompt as
  // everything else, and the cost of that is stated and accepted in the stage spec §11.2.
  //
  // What is still asserted is the half that was never about the model: a plain capture keeps the
  // 'quick' source_type it was created with. Stamp it 'chat' here and 00039 makes it unrecallable.
  it("answers an ordinary statement on the answer model and leaves its source_type alone", async () => {
    const { client, updated } = dbs();
    const seen: { model?: string; grounding?: boolean }[] = [];
    const recordingAi = createFakeAi({
      generateJson: async () => ({
        value: { intent: "statement", alsoWantsAnswer: false, complexity: "simple",
                 domain: null, domain_meta: {}, tags: [], mood: null },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      }),
      generateStream: async (a) => {
        seen.push(a);
        return {
          chunks: (async function* () { yield { text: "Đã lưu." }; })(),
          usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
        };
      },
    });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(seen[0]?.model).toBe(ANSWER_MODEL);
    expect(seen[0]?.grounding).toBe(true);
    expect((updated.notes ?? []).some((r) => "source_type" in r)).toBe(false);
  });

  // Was "never lets the flag promote chitchat" until 2026-08-29. There is no flag left to
  // promote anything, or a cheap path left to be promoted out of -- chitchat with a spurious
  // `alsoWantsAnswer` reaches the same model and the same prompt as every other turn, same as a
  // plain chitchat turn does. GROUNDING_RULE, not this flag, is what now discourages searching
  // Google for "haha ok".
  it("answers chitchat on the answer model too even when the flag is set", async () => {
    const { client } = dbs();
    const seen: { model?: string; grounding?: boolean }[] = [];
    const recordingAi = createFakeAi({
      generateJson: async () => ({
        value: { intent: "chitchat", alsoWantsAnswer: true, complexity: "simple",
                 domain: null, domain_meta: {}, tags: [], mood: null },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      }),
      generateStream: async (a) => {
        seen.push(a);
        return {
          chunks: (async function* () { yield { text: "hehe" }; })(),
          usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
        };
      },
    });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(seen[0]?.model).toBe(ANSWER_MODEL);
    expect(seen[0]?.grounding).toBe(true);
  });

  // THE POINT OF THE STAGE. All three intents reach the same model with grounding offered -- there
  // is no branch left for a classification to pick. Three cases rather than one: a single
  // statement case would still pass against an implementation that kept the question branch and
  // merely widened the statement one.
  //
  // Red when: any `intent`-conditional model or grounding choice is reintroduced in turn.ts.
  it.each(["question", "statement", "chitchat"] as const)(
    "answers a %s turn on the answer model with grounding offered",
    async (intent) => {
      const { client } = dbs();
      const seen: { model?: string; grounding?: boolean; prompt?: string }[] = [];
      const recordingAi = createFakeAi({
        generateJson: async () => ({
          value: { intent, alsoWantsAnswer: false, complexity: "simple",
                   domain: null, domain_meta: {}, tags: [], mood: null },
          inputTokens: 10, outputTokens: 5, model: "fake-classify",
        }),
        generateStream: async (a) => {
          seen.push(a);
          return {
            chunks: (async function* () { yield { text: "ok" }; })(),
            usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
          };
        },
      });
      await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
        { userId: "u1", noteId: "n1", budgetUsd: 5 }));
      expect(seen[0]?.model).toBe(ANSWER_MODEL);
      expect(seen[0]?.grounding).toBe(true);
      // One prompt, and the two sentences that identified the two branches it replaced are gone.
      expect(seen[0]?.prompt).toMatch(/Their message:/);
      expect(seen[0]?.prompt).not.toMatch(/did not ask a question/i);
      expect(seen[0]?.prompt).not.toMatch(/Their question:/);
    },
  );

  // The S2 ceiling, asserted on the PROMPT rather than on what got recorded. Asserting only that
  // `asked` was not re-recorded passes for the wrong reason -- the model would still be nagging,
  // and the recording would just be missing.
  //
  // Red when: `justAsked` stops being derived from pendingAsk in turn.ts.
  it("tells the model not to ask again when a question is outstanding", async () => {
    const { client } = dbs({
      history: [{
        role: "assistant", content: "Phim gì vậy bạn?", created_at: "2026-08-14T01:00:00.000Z",
        retrieval_meta: { asked: { noteId: "n0", field: "pending_item.title" } },
      }],
      lastMessage: { session_id: "s1", created_at: "2026-08-14T01:00:00.000Z" },
    });
    const seen: { prompt?: string }[] = [];
    const recordingAi = createFakeAi({
      generateJson: async () => ({
        value: { intent: "statement", complexity: "simple", domain: null,
                 domain_meta: {}, tags: [], mood: null },
        inputTokens: 1, outputTokens: 1, model: "fake-classify",
      }),
      generateStream: async (a) => {
        seen.push(a);
        return {
          chunks: (async function* () { yield { text: "ok" }; })(),
          usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
        };
      },
    });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(seen[0]?.prompt).toMatch(/Do not\s+ask another question this turn/i);
  });

  // Wiring, asserted on the prompt text: a zone accepted by the DTO and then dropped somewhere
  // between the controller and the builder is invisible in every other assertion -- the turn
  // still answers, just from the wrong day.
  it("formats the turn's dates in the caller's time zone", async () => {
    const { client } = dbs();
    const prompts: string[] = [];
    const recordingAi = createFakeAi({
      generateJson: async () => ({
        value: { intent: "statement", complexity: "simple", domain: null,
                 domain_meta: {}, tags: [], mood: null },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      }),
      generateStream: async (args) => {
        prompts.push(args.prompt);
        return {
          chunks: (async function* () { yield { text: "ok" }; })(),
          usage: () => ({ inputTokens: 5, outputTokens: 2, model: "fake-answer" }),
        };
      },
    });

    await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5, timeZone: "Pacific/Auckland" }));

    const today = formatToday(new Date(), "Pacific/Auckland");
    expect(prompts[0]).toContain(today);
  });

  // An invalid zone must cost accuracy, never the answer. Intl throws RangeError on an unknown
  // zone, and this whole value arrives from an HTTP body.
  it("still answers when the client sends a nonsense time zone", async () => {
    const { client } = dbs();
    const events = await collect(runTurn({ userDb: client, serviceDb: client, ai: ai() },
      { userId: "u1", noteId: "n1", budgetUsd: 5, timeZone: "Mars/Olympus_Mons" }));
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  // THE CEILING, and the assertion that keeps this from becoming a second model call on every
  // turn in the system. An ungrounded answer contributed nothing external, so proposeOffer must
  // not run at all -- asserted on the absence of the event AND on the classify-call count,
  // because an offer that ran and returned null is invisible in the event stream alone.
  it("makes no offer call on an ungrounded turn", async () => {
    const { client } = dbs();
    let jsonCalls = 0;
    const ai = createFakeAi({
      generateJson: async () => {
        jsonCalls += 1;
        return {
          value: { intent: "question", complexity: "simple", domain: null,
                   domain_meta: {}, tags: [], mood: null },
          inputTokens: 10, outputTokens: 5, model: "fake-classify",
        };
      },
      generateStream: async () => ({
        chunks: (async function* () { yield { text: "từ note của bạn thôi" }; })(),
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
        // No grounding() -- nothing was searched.
      }),
    });
    const events = await collect(runTurn({ userDb: client, serviceDb: client, ai },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(events.some((e) => e.type === "offer")).toBe(false);
    expect(jsonCalls, "classification only, no offer call").toBe(1);
  });

  // An interrupted answer must not produce an offer: the statement would be condensed out of a
  // reply that was cut off mid-sentence, so nobody -- including this process -- saw it whole.
  it("makes no offer when the answer was interrupted", async () => {
    const { client } = dbs();
    const ai = createFakeAi({
      generateJson: async () => ({
        value: { intent: "question", complexity: "simple", domain: null,
                 domain_meta: {}, tags: [], mood: null },
        inputTokens: 10, outputTokens: 5, model: "fake-classify",
      }),
      generateStream: async () => ({
        chunks: (async function* () { yield { text: "một nử" }; throw new Error("cut"); })(),
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
        grounding: () => ({ queries: ["omega 3"], sources: [{ url: "https://e.com/a", title: "A" }] }),
      }),
    });
    const events = await collect(runTurn({ userDb: client, serviceDb: client, ai },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(events.some((e) => e.type === "offer")).toBe(false);
  });

  // FINDING 3 (final whole-branch review): THE POSITIVE CASE. Every other offer test in this
  // file is negative -- until this one, deleting the entire `yield { type: "offer", ... }` block
  // out of turn.ts would leave the whole monorepo test suite green. `generateJson` is scripted
  // by CALL COUNT: the first call is extractNote's own classification, the second is
  // proposeOffer's condensation call -- the same two-calls-in-sequence shape "makes no offer
  // call on an ungrounded turn" above already pins the ABSENCE of.
  it("emits an offer event when a grounded, complete question turn produces one", async () => {
    const { client } = dbs();
    let jsonCalls = 0;
    const scripted = createFakeAi({
      generateJson: async () => {
        jsonCalls += 1;
        return jsonCalls === 1
          ? { // extractNote's classify call.
              value: { intent: "question", complexity: "simple", domain: null,
                       domain_meta: {}, tags: [], mood: null },
              inputTokens: 10, outputTokens: 5, model: "fake-classify",
            }
          : { // proposeOffer's own classify call, condensing the answer into one statement.
              value: { statement: "some fact" },
              inputTokens: 10, outputTokens: 5, model: "fake-classify",
            };
      },
      generateStream: async () => ({
        chunks: (async function* () { yield { text: "Cá hồi giàu omega-3." }; })(),
        usage: () => ({ inputTokens: 20, outputTokens: 4, model: ANSWER_MODEL }),
        grounding: () => ({
          queries: ["omega 3"],
          sources: [{ url: "https://e.com/a", title: "A" }],
        }),
      }),
    });
    const events = await collect(runTurn({ userDb: client, serviceDb: client, ai: scripted },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(events).toContainEqual({
      type: "offer", statement: "some fact", sourceUrl: "https://e.com/a",
    });
    expect(jsonCalls, "extraction, then proposeOffer's own classify call").toBe(2);
  });

  // FINDING 4 (final whole-branch review, predating this plan's classify-gate removal): a
  // CORRECTION-only turn (a doubtful claim that is NOT also a question -- CORRECTION_RULE fires,
  // not an answer) can still set `searched` if the model grounds while correcting it. `searched`
  // alone does not mean "this turn answered a question", which is why turn.ts gates
  // proposeOffer on `answersAQuestion` (`extracted.intent === "question" ||
  // extracted.alsoWantsAnswer === true`) rather than on `searched` alone -- a prompt hardcoded to
  // open with "The assistant just answered a question using knowledge that was NOT in the user's
  // own notes" would be false on this branch, since nothing answered a question.
  // `checkable_claim: true` and no `alsoWantsAnswer` makes `answersAQuestion` false here even
  // though the turn grounds, which is the exact collision Finding 4 describes.
  it("makes no offer on a correction-only turn that grounded, since it never answered a question", async () => {
    const { client } = dbs();
    let jsonCalls = 0;
    const scripted = createFakeAi({
      generateJson: async () => {
        jsonCalls += 1;
        return {
          value: { intent: "statement", complexity: "simple", domain: null,
                   domain_meta: {}, tags: [], mood: null, checkable_claim: true },
          inputTokens: 10, outputTokens: 5, model: "fake-classify",
        };
      },
      generateStream: async () => ({
        chunks: (async function* () { yield { text: "Không đúng, cá hồi giàu omega-3." }; })(),
        usage: () => ({ inputTokens: 20, outputTokens: 4, model: ANSWER_MODEL }),
        grounding: () => ({
          queries: ["omega 3 chữa cận thị"],
          sources: [{ url: "https://e.com/a", title: "A" }],
        }),
      }),
    });
    const events = await collect(runTurn({ userDb: client, serviceDb: client, ai: scripted },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(events.some((e) => e.type === "offer")).toBe(false);
    expect(jsonCalls, "extraction only -- proposeOffer's classify call must not run").toBe(1);
  });

  // Spec §10, the offer half: "A degraded extraction produces no offer." The `asked` half is
  // covered by "never asks when the extraction failed" below; this is `answersAQuestion`'s
  // `extracted !== null` guard (turn.ts). Everything else the offer gate checks is satisfied on
  // purpose -- the reply is question-shaped, complete, non-empty, and the turn grounds -- so the
  // only thing standing between this turn and an offer is the degraded (null) extraction itself.
  it("makes no offer when the extraction failed, even on a grounded, question-shaped reply", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { client } = dbs();
      let jsonCalls = 0;
      const broken = createFakeAi({
        generateJson: async () => {
          jsonCalls += 1;
          throw new Error("classify exploded");
        },
        generateStream: async () => ({
          chunks: (async function* () { yield { text: "Cá hồi giàu omega-3, bạn có muốn biết thêm không?" }; })(),
          usage: () => ({ inputTokens: 20, outputTokens: 4, model: ANSWER_MODEL }),
          grounding: () => ({
            queries: ["omega 3"],
            sources: [{ url: "https://e.com/a", title: "A" }],
          }),
        }),
      });
      const events = await collect(runTurn({ userDb: client, serviceDb: client, ai: broken },
        { userId: "u1", noteId: "n1", budgetUsd: 5 }));
      expect(events.some((e) => e.type === "offer")).toBe(false);
      expect(jsonCalls, "extraction's own failed attempt only -- proposeOffer must not run").toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  /** Like `ai()`, but the reply is a question and the prompt it was built from is captured. */
  const askingAi = (value: Record<string, unknown>, reply = "Phim gì vậy?") => {
    const seen: string[] = [];
    return {
      seen,
      client: createFakeAi({
        generateJson: async () => ({
          value: { intent: "statement", complexity: "simple", domain: null,
                   domain_meta: {}, tags: [], mood: null, ...value },
          inputTokens: 10, outputTokens: 5, model: "fake-classify",
        }),
        generateStream: async ({ prompt }) => {
          seen.push(prompt);
          return {
            chunks: (async function* () { yield { text: reply }; })(),
            usage: () => ({ inputTokens: 20, outputTokens: 4, model: "fake-answer" }),
          };
        },
      }),
    };
  };

  const assistantRow = (inserted: Record<string, Record<string, unknown>[]>) =>
    (inserted.chat_messages ?? []).find((r) => r.role === "assistant");

  const MEDIA_NO_TITLE = { domain: "media", domain_meta: {} };

  // Was checked against the exact instruction handed to the model ("which film, series or book
  // it was") until 2026-08-29. buildTurnPrompt never receives the gap at all now -- classification
  // has not settled when the prompt is built, and ENGAGE_RULE draws a follow-up out generically
  // instead of naming the field (follow-up.ts's header). What survives is the RECORD: `gap` still
  // names the field a media note with no title is missing, and askingAi's scripted reply still
  // ends in "?", so the turn still remembers what it would take to backfill if the next message
  // answers it.
  it("records what a media note with no title is missing, on a reply that asks", async () => {
    const { client, inserted } = dbs();
    const { client: fake } = askingAi(MEDIA_NO_TITLE);
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta)
      .toMatchObject({ asked: { noteId: "n1", field: "pending_item.title" } });
  });

  // We know we told the model to ask. We do not know that it did. Recording `asked` anyway would
  // leave the next turn hunting for an answer to a question nobody was given.
  it("records nothing when the reply contains no question at all", async () => {
    const { client, inserted } = dbs();
    const { client: fake } = askingAi(MEDIA_NO_TITLE, "Đã lưu.");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("asked");
  });

  // Was "never asks on a turn that is correcting a false claim" until 2026-08-29. `checkable_claim`
  // is RECORDED, NOT ACTED ON now (extract.ts) -- it no longer builds a `verifies` flag, and
  // `verifies` is what used to exclude this turn from the gap computation. A claim-correcting turn
  // on a media note with no title is now recorded exactly like any other: the three-way exclusion
  // (question / chitchat / verifies) lived in `gap`'s old derivation and went with it.
  it("still records what is missing on a claim-correcting turn", async () => {
    const { client, inserted } = dbs();
    const { client: fake } = askingAi({ ...MEDIA_NO_TITLE, checkable_claim: true });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta)
      .toMatchObject({ asked: { noteId: "n1", field: "pending_item.title" } });
  });

  // Was "never asks on a turn that answered a question" until 2026-08-29. `wantsAnswer` used to
  // exclude a pure question from the gap computation entirely; that exclusion went with
  // `wantsAnswer` itself. A question about a media note with no title is recorded on the same "?"
  // heuristic as everything else now.
  it("also records what is missing on a turn that answered a question", async () => {
    const { client, inserted } = dbs();
    const { client: fake } = askingAi({ ...MEDIA_NO_TITLE, intent: "question" });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta)
      .toMatchObject({ asked: { noteId: "n1", field: "pending_item.title" } });
  });

  // Was "never asks on small talk, even if the classifier called it media" until 2026-08-29.
  // `isChitchat` used to exclude this from the gap computation via the same three-way check that
  // guarded the question and verifies cases above; that exclusion is gone with the routing chain
  // it was part of. A media-tagged "chitchat" turn is recorded the same as any other -- an edge
  // case the classifier is unlikely to actually produce (chitchat rarely gets tagged `domain:
  // "media"`), and the `?` heuristic's own documented tolerance for a false `asked` (turn.ts) is
  // what makes recording it anyway harmless.
  it("also records what is missing on a chitchat-tagged turn", async () => {
    const { client, inserted } = dbs();
    const { client: fake } = askingAi({ ...MEDIA_NO_TITLE, intent: "chitchat" });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta)
      .toMatchObject({ asked: { noteId: "n1", field: "pending_item.title" } });
  });

  // A degraded extraction knows of no domain and therefore of no gap. Asking anyway would be the
  // assistant inventing curiosity about a note it failed to read.
  it("never asks when the extraction failed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { client, inserted } = dbs();
      const broken = createFakeAi({
        generateJson: async () => { throw new Error("classify exploded"); },
        generateStream: async () => ({
          chunks: (async function* () { yield { text: "Phim gì vậy?" }; })(),
          usage: () => null,
        }),
      });
      await collect(runTurn({ userDb: client, serviceDb: client, ai: broken },
        { userId: "u1", noteId: "n1", budgetUsd: 100 }));
      expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("asked");
    } finally {
      spy.mockRestore();
    }
  });

  // S2 §7. The whole ceiling, and there is no number in it: if the message immediately before
  // this turn asked something, this turn does not ask -- whether or not it was answered.
  it("does not ask again on the turn right after a question", async () => {
    const { client, inserted } = dbs({
      history: [{
        role: "assistant", content: "Phim gì vậy?", created_at: "2026-08-24T10:00:00.000Z",
        retrieval_meta: { asked: { noteId: "n0", field: "pending_item.title" } },
      }],
      lastMessage: { session_id: "s1", created_at: "2026-08-24T10:00:00.000Z" },
    });
    const { seen, client: fake } = askingAi(MEDIA_NO_TITLE);
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    expect(seen[0]).not.toContain("which film, series or book it was");
    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("asked");
  });

  // The other side of the same condition: an ordinary prior exchange does not suppress a question.
  // The prompt-content half of this assertion ("which film, series or book it was") went with
  // `askAbout` on 2026-08-29 -- buildTurnPrompt never receives the gap. What survives is the
  // RECORD, on the same "?" heuristic as every case above.
  it("still records what is missing when the previous turn asked nothing", async () => {
    const { client, inserted } = dbs({
      history: [{
        role: "assistant", content: "Đã lưu.", created_at: "2026-08-24T10:00:00.000Z",
        retrieval_meta: { incomplete: false },
      }],
      lastMessage: { session_id: "s1", created_at: "2026-08-24T10:00:00.000Z" },
    });
    const { client: fake } = askingAi(MEDIA_NO_TITLE);
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta).toHaveProperty("asked");
  });

  const MEDIA_WITH_TITLE = {
    domain: "media",
    domain_meta: { pending_item: { kind: "movie", title: "Interstellar" } },
  };

  const answeringHistory = () => ({
    history: [{
      role: "assistant", content: "Phim gì vậy?", created_at: "2026-08-24T10:00:00.000Z",
      retrieval_meta: { asked: { noteId: "n0", field: "pending_item.title" } },
    }],
    lastMessage: { session_id: "s1", created_at: "2026-08-24T10:00:00.000Z" },
  });

  /** Every notes update that carried a media link, as `{ noteId, itemId }`. */
  const links = (updated: Record<string, Record<string, unknown>[]>) =>
    (updated.notes ?? [])
      .filter((r) => "media_item_id" in r && r.media_item_id !== null)
      .map((r) => ({
        noteId: (r.__where as Record<string, unknown>).id,
        itemId: r.media_item_id,
        where: r.__where as Record<string, unknown>,
      }));

  // THE DELIVERABLE. Both notes must point at the SAME media_items row -- asserting only that
  // note n0 became non-null passes even when the backfill created a second, duplicate item,
  // which is the bug actually worth catching.
  it("links the answered note and the original note to one and the same media item", async () => {
    const { client, updated } = dbs(answeringHistory());
    const { client: fake } = askingAi(MEDIA_WITH_TITLE, "Hay đấy!");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    const linked = links(updated);
    expect(linked.map((l) => l.noteId).sort()).toEqual(["n0", "n1"]);
    expect(new Set(linked.map((l) => l.itemId)).size).toBe(1);
  });

  // The backfill writes the LINK and nothing else. Note n0 said nothing about a rating, and
  // writing one into it would be putting words in the user's mouth.
  it("backfills the link alone, never the original note's meta or text", async () => {
    const { client, updated } = dbs(answeringHistory());
    const { client: fake } = askingAi(MEDIA_WITH_TITLE, "Hay đấy!");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    const backfill = links(updated).find((l) => l.noteId === "n0")!;
    const row = (updated.notes ?? []).find((r) => r.__where === backfill.where)!;
    expect(Object.keys(row).filter((k) => k !== "__where")).toEqual(["media_item_id"]);
    // And it must refuse to touch a trashed note or overwrite an existing link.
    expect(backfill.where).toMatchObject({ deleted_at: null, media_item_id: null });
  });

  // §8: the measurement signal. One boolean is what makes "how often was a question answered"
  // a query rather than a guess.
  it("records that the question was answered", async () => {
    const { client, inserted } = dbs(answeringHistory());
    const { client: fake } = askingAi(MEDIA_WITH_TITLE, "Hay đấy!");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta).toMatchObject({ answeredAsk: true });
  });

  // The exact race the two `.is()` filters exist to protect: the write is legitimately
  // rejected (the note was trashed mid-conversation, or a concurrent request already linked
  // it) and PostgREST returns `error: null` regardless -- a zero-row match is not an error.
  // `answeredAsk` must track whether a row actually moved, not merely whether the call threw.
  it("does not record answeredAsk when the backfill write matches zero rows", async () => {
    const { client, inserted } = dbs({ ...answeringHistory(), backfillRejected: true });
    const { client: fake } = askingAi(MEDIA_WITH_TITLE, "Hay đấy!");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("answeredAsk");
  });

  // No question outstanding means no backfill, however media-ish the note is. Only n1 is linked.
  it("does not backfill anything when no question was pending", async () => {
    const { client, updated, inserted } = dbs();
    const { client: fake } = askingAi(MEDIA_WITH_TITLE, "Hay đấy!");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", budgetUsd: 100 }));

    expect(links(updated).map((l) => l.noteId)).toEqual(["n1"]);
    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("answeredAsk");
  });

  // The user was asked which film, and changed the subject. Nothing resolves, nothing backfills,
  // and the question lapses with no special case.
  it("backfills nothing when the answer turn produced no media item", async () => {
    const { client, updated, inserted } = dbs(answeringHistory());
    const { client: fake } = askingAi({ domain: "health", domain_meta: {} }, "Ừ.");
    await collect(runTurn({ userDb: client, serviceDb: client, ai: fake },
      { userId: "u1", noteId: "n1", sessionId: "s1", budgetUsd: 100 }));

    expect(links(updated)).toEqual([]);
    expect(assistantRow(inserted)?.retrieval_meta).not.toHaveProperty("answeredAsk");
  });

  // THE REGRESSION TEST FOR THE REPORTED BUG, and the most important assertion in this file. A
  // classification that never returns must cost the user their tags, and nothing else. Before
  // 2026-08-29 it cost them the answer: `extracted` was null, wantsAnswer fell through to a keyword
  // list, and "Bơi lội có giúp phát triển cơ bắp không" came back as an acknowledgement of a filed
  // note.
  //
  // Red when: the first token is delayed toward EXTRACT_DEADLINE_MS. That is what a regression
  // re-sequencing classification ahead of the prompt (`Promise.allSettled([withDeadline(extractNote,
  // ...), retrieve])` before `generateStream`, i.e. Task 3's shape) would do to this fixture --
  // `withDeadline` still bounds it, so it would still complete this test's answer, tag count and
  // `degraded: true` checks inside the 20s budget, JUST ~EXTRACT_DEADLINE_MS late. Those four
  // content checks alone do not time anything and would stay green under that regression; the
  // timing assertion below is what actually forces this test red on it. (An earlier version of
  // this test claimed those content checks alone were sufficient -- they are not, at the deadline
  // values this file ships. See turn.test.ts's git history / task-4 fix-round-1 for how this was
  // found.) Test B below ("opens the model stream before classification has settled") is the other,
  // independent discriminator, and is not weakened by any of this -- its gate lives inside the fake
  // `generateStream` itself, so a sequential-await implementation deadlocks on it until
  // `withDeadline`'s internal timer fires.
  it("answers in full while classification is still hanging", async () => {
    const { client } = dbs();
    const seen: { prompt?: string }[] = [];
    const hanging = createFakeAi({
      // Never resolves. Not a rejection and not a slow resolve -- the turn must not depend on this
      // promise settling at all before it answers.
      generateJson: () => new Promise(() => {}),
      generateStream: async (a) => {
        seen.push(a);
        return {
          chunks: (async function* () { yield { text: "Bơi lội " }; yield { text: "có." }; })(),
          usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
        };
      },
    });

    const startedAt = Date.now();
    let firstTokenMs: number | null = null;
    const events: AssistantEvent[] = [];
    for await (const e of runTurn({ userDb: client, serviceDb: client, ai: hanging },
      { userId: "u1", noteId: "n1", budgetUsd: 5 })) {
      if (e.type === "token" && firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
      events.push(e);
    }

    // THE discriminator: the first token must land almost immediately, not after classification's
    // own deadline has burned down. A regression that awaits classification before the prompt would
    // push this well past EXTRACT_DEADLINE_MS / 2 (it would land near EXTRACT_DEADLINE_MS itself);
    // a correct decoupled turn lands in low milliseconds, since nothing before the first token
    // depends on the hung `generateJson` call at all.
    expect(firstTokenMs, "a token must have arrived").not.toBeNull();
    expect(firstTokenMs, "the first token must not wait on classification")
      .toBeLessThan(EXTRACT_DEADLINE_MS / 2);

    const answer = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
    expect(answer).toBe("Bơi lội có.");
    expect(seen).toHaveLength(1);
    // The turn still completes, and still reports the classification honestly rather than silently.
    expect(events.find((e) => e.type === "attached")).toMatchObject({ degraded: true });
    expect(events.at(-1)?.type).toBe("done");
  }, 20_000);

  // The above passes against an implementation that awaits classification but happens to get a fast
  // fake. This one does not: the stream is only opened once the test has PROVEN the classification
  // is still outstanding.
  //
  // Red when: the classification is awaited before the prompt is built, however briefly.
  it("opens the model stream before classification has settled", async () => {
    const { client } = dbs();
    let classifySettled = false;
    let streamOpenedWhileClassifying = false;
    let releaseClassify: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseClassify = r; });

    const slow = createFakeAi({
      generateJson: async () => {
        await gate;
        classifySettled = true;
        return {
          // { name, confidence }[], the real Extraction.tags shape (extract.ts) -- a bare string
          // array here is silently filtered to nothing by extractNote's `typeof t.name ===
          // "string"` check, so this fixture must match production or "tags" always comes back [].
          value: { intent: "statement", complexity: "simple", domain: null,
                   domain_meta: {}, tags: [{ name: "chạy-bộ", confidence: 0.9 }], mood: null },
          inputTokens: 1, outputTokens: 1, model: "fake-classify",
        };
      },
      generateStream: async () => {
        streamOpenedWhileClassifying = !classifySettled;
        // Let classification finish now, so the turn can complete and emit `attached`.
        releaseClassify();
        return {
          chunks: (async function* () { yield { text: "ok" }; })(),
          usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
        };
      },
    });

    const events = await collect(runTurn({ userDb: client, serviceDb: client, ai: slow },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    expect(streamOpenedWhileClassifying, "the reply must not wait on classification").toBe(true);
    // And it is still delivered, late rather than never.
    expect(events.find((e) => e.type === "attached")).toMatchObject({ tags: ["chạy-bộ"] });
  });

  // §2. The receipt is a stated core product feature and must not slide to after the answer when it
  // does not have to. Ordering is asserted by index, not by presence.
  //
  // Red when: the mid-stream emission is dropped and `attached` is only yielded after the loop.
  it("emits attached during the stream once classification has landed", async () => {
    const { client } = dbs();
    const fast = createFakeAi({
      generateJson: async () => ({
        // Same shape fix as above -- not asserted on here, but a fixture that silently drops its
        // own tags is worth keeping honest.
        value: { intent: "statement", complexity: "simple", domain: "health",
                 domain_meta: {}, tags: [{ name: "sức-khỏe", confidence: 0.9 }], mood: null },
        inputTokens: 1, outputTokens: 1, model: "fake-classify",
      }),
      generateStream: async () => ({
        // Several chunks with a tick between them, so classification has somewhere to land.
        // 8 * 10ms = 80ms of budget for the fake classify call above to settle before the last
        // token arrives -- more margin than the original 4 * 5ms = 20ms gave under CI load,
        // without meaningfully slowing the suite.
        chunks: (async function* () {
          for (const t of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
            await new Promise((r) => setTimeout(r, 10));
            yield { text: t };
          }
        })(),
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
      }),
    });
    const types = (await collect(runTurn({ userDb: client, serviceDb: client, ai: fast },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }))).map((e) => e.type);
    const attachedAt = types.indexOf("attached");
    const lastTokenAt = types.lastIndexOf("token");
    expect(attachedAt).toBeGreaterThan(-1);
    expect(attachedAt, "attached must not wait for the answer to finish").toBeLessThan(lastTokenAt);
  });

  // §4. `asked` is now written from what the reply actually SAID, after the fact. S2 §5 already
  // conceded the `?` test was "the honest approximation" of an instruction we could not verify;
  // post-hoc it is an observation of text the turn is holding.
  //
  // Red when: `asked` is written unconditionally, which would let a backfill fire off a reply that
  // asked nothing.
  it.each([
    ["Bạn xem phim gì vậy?", true],
    ["Đã lưu nhé.", false],
  ])("records asked only when the reply actually contains a question (%s)", async (reply, expected) => {
    const { client, inserted } = dbs();
    const mediaAi = createFakeAi({
      generateJson: async () => ({
        value: { intent: "statement", complexity: "simple", domain: "media",
                 domain_meta: {}, tags: [], mood: null },
        inputTokens: 1, outputTokens: 1, model: "fake-classify",
      }),
      generateStream: async () => ({
        chunks: (async function* () { yield { text: reply }; })(),
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: ANSWER_MODEL }),
      }),
    });
    await collect(runTurn({ userDb: client, serviceDb: client, ai: mediaAi },
      { userId: "u1", noteId: "n1", budgetUsd: 5 }));
    const assistantRow = (inserted.chat_messages ?? []).find((r) => r.role === "assistant");
    const meta = assistantRow?.retrieval_meta as { asked?: unknown } | undefined;
    expect(meta?.asked !== undefined).toBe(expected);
  });
});

// One recorder for the whole describe: each of these cases cares about the same three
// outputs -- which prompt ran, on which model, with grounding on or off.
const recordTurn = async (extraction: Record<string, unknown>) => {
  const { client, updated } = dbs();
  const seen: { prompt?: string; model?: string; grounding?: boolean }[] = [];
  const ai = createFakeAi({
    generateJson: async () => ({
      value: { intent: "statement", complexity: "simple", domain: null,
               domain_meta: {}, tags: [], mood: null, ...extraction },
      inputTokens: 10, outputTokens: 5, model: "fake-classify",
    }),
    generateStream: async (a) => {
      seen.push(a);
      return {
        chunks: (async function* () { yield { text: "ok" }; })(),
        usage: () => ({ inputTokens: 1, outputTokens: 1, model: "fake" }),
      };
    },
  });
  await collect(runTurn({ userDb: client, serviceDb: client, ai },
    { userId: "u1", noteId: "n1", budgetUsd: 5 }));
  return { seen, updated };
};

describe("the answer path", () => {
  it("sends a flagged statement to the reasoning model", async () => {
    const { seen } = await recordTurn({ checkable_claim: true });
    expect(seen[0]?.model).toBe(ANSWER_MODEL);
  });

  // Was "leaves an unflagged statement on the cheap model" until 2026-08-29 -- THE CEILING that
  // kept the flag from being indistinguishable from "route every statement to the expensive
  // model" (§9.2). There is no cheap model left to leave anything on: `checkable_claim` is
  // RECORDED, NOT ACTED ON now (extract.ts), and every statement, flagged or not, reaches
  // ANSWER_MODEL the same way.
  it("answers an unflagged statement on the answer model too", async () => {
    const { seen } = await recordTurn({ checkable_claim: false });
    expect(seen[0]?.model).toBe(ANSWER_MODEL);
  });

  // Was "keeps a flagged statement on the acknowledge prompt" until 2026-08-29. The acknowledge
  // prompt this asserted is gone along with the gate that chose it -- buildTurnPrompt never
  // announces a filing at all (prompts.ts §5.1: classification has not settled when the prompt is
  // built, so "You filed it under: X" would be a claim about data that does not exist yet). The
  // `attached` SSE event carries that instead, on both clients, on the same turn.
  it("does not announce a filing for a flagged statement either", async () => {
    const { seen } = await recordTurn({ checkable_claim: true });
    expect(seen[0]?.prompt).not.toMatch(/You filed it under/i);
  });

  // THE COLLISION, decided in design doc §1.1. Both flags fire on "Omega-3 chữa được cận thị,
  // có đúng không?" -- a recordable statement, a question, and a doubtful claim in one
  // sentence. The user asked, so the user gets an answer; being corrected INSTEAD of answered
  // is the same silent drop Part A exists to fix, reached through a different branch. Two
  // independent `if`s is how this would have gone unnoticed, which is why the chain is ordered.
  it("answers rather than corrects when the turn asks a question too", async () => {
    const { seen, updated } = await recordTurn({ alsoWantsAnswer: true, checkable_claim: true });
    expect(seen[0]?.prompt).not.toMatch(/You filed it under/i);
    expect(seen[0]?.grounding).toBe(true);
    // Still a statement as far as FILING goes, and so still recallable -- 2026-08-23, same
    // reason as "answers a statement that also asks something" above.
    expect((updated.notes ?? []).some((r) => "source_type" in r)).toBe(false);
  });

  // A flagged statement grounds, so the check has a second source rather than only the model's
  // own memory (C5 §9.3's last paragraph). Separate from the model assertion: they are set on
  // two different lines and a partial edit moves one without the other.
  it("grounds a flagged statement", async () => {
    const { seen } = await recordTurn({ checkable_claim: true });
    expect(seen[0]?.grounding).toBe(true);
  });

  // Was "never promotes chitchat" until 2026-08-29 -- chitchat was checked before the claim flag
  // and never promoted by it. There is no checking order left: chitchat reaches ANSWER_MODEL with
  // grounding offered the same as a flagged statement does, whether or not `checkable_claim` is
  // also set.
  it("answers a chitchat turn with a flagged claim on the answer model too", async () => {
    const { seen } = await recordTurn({ intent: "chitchat", checkable_claim: true });
    expect(seen[0]?.model).toBe(ANSWER_MODEL);
    expect(seen[0]?.grounding).toBe(true);
  });
});
