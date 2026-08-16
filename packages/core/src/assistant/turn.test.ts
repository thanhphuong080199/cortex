import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeAi } from "../ai/fake.js";
import { runTurn, type AssistantEvent } from "./turn.js";

const NOTE = {
  id: "n1", user_id: "u1",
  content_text: "hôm nay tôi chạy bộ ở công viên",
  created_at: "2026-08-14T01:02:03.000Z",
};

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
function dbs(
  opts: {
    over?: boolean; history?: HistoryRow[]; note?: typeof NOTE | null;
    failInsertOn?: string;
    mediaItem?: { id: string; title: string; kind: string };
  } = {},
) {
  const inserted: Record<string, Record<string, unknown>[]> = {};

  function chain(resolve: () => { data: unknown; error: unknown }) {
    const self: Record<string, unknown> = {
      eq: () => self,
      is: () => self,
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
      // The "last message" probe (session resolution): always empty, so every turn in this
      // suite starts a fresh session -- none of these tests need cross-turn session reuse.
      if (name === "chat_messages" && cols?.includes("session_id")) {
        return chain(() => ({ data: [], error: null }));
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
          return { data: [...(opts.history ?? []), ...already], error: null };
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
      // MediaService.reconcileYear's backfill (`.update({ year }).eq().eq().select().single()`)
      // when the fixture item is missing the year `pending_item` supplies. Spread the row back,
      // same trick insertChain uses above -- the caller reads the UPDATED item off this, not a
      // placeholder.
      if (name === "media_items") {
        return chain(() => (
          opts.mediaItem ? { data: { ...mediaItemRow(), ...row }, error: null } : { data: null, error: null }
        ));
      }
      // resolveNoteMediaLink's link write (`.update({ media_item_id, domain_meta })...
      // .select("id").maybeSingle()`). A null noteId row (this suite's "note not found" fixtures
      // never carry domain: "media", so this branch is otherwise unreached) falls through to the
      // generic case below rather than crashing on `.id`.
      if (name === "notes" && "media_item_id" in row) {
        const noteRow = opts.note === undefined ? NOTE : opts.note;
        return chain(() => (
          noteRow ? { data: { id: noteRow.id }, error: null } : { data: null, error: null }
        ));
      }
      return chain(() => ({ data: null, error: null }));
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

  return { client, inserted };
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

  // Finding 2 (Stage C1 review round 1): the user's turn is written before history is read, and
  // with no exclusion the just-inserted row IS the history -- renderHistory then shows the model
  // its own current note/question a second time, mislabeled as something that already happened.
  it("does not duplicate the current turn's own message into its history", async () => {
    const { client } = dbs();
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
    expect(seen).not.toMatch(/earlier in this conversation/i);
    expect(seen.match(new RegExp(NOTE.content_text, "g"))?.length ?? 0).toBe(1);
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
});
