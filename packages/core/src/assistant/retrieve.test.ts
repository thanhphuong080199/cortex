import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { createFakeAi } from "../ai/fake.js";
import { retrieve } from "./retrieve.js";

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

/**
 * A recording double for the two calls retrieve makes: one RPC and one ledger insert.
 *
 * The RPC's NAME is recorded, not just its arguments -- a double that ignores the function name
 * accepts `db.rpc("search_note", ...)` forever, and a typo'd RPC name is a runtime PostgREST
 * 404 that no unit test would otherwise see.
 */
const fakeDb = (opts: {
  rows?: unknown[];
  rpcError?: { message: string } | null;
  insertError?: { message: string } | null;
  calls?: RpcCall[];
  ledger?: Record<string, unknown>[];
}) =>
  ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      opts.calls?.push({ fn, args });
      return { data: opts.rows ?? [], error: opts.rpcError ?? null };
    },
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        opts.ledger?.push(row);
        return { error: opts.insertError ?? null };
      },
    }),
  }) as unknown as SupabaseClient;

// Vietnamese, because that is what this product's users write (docs/phase-2-issue-log.md H3)
// and because a mis-encoded round trip through the RPC arguments would show up here first.
const QUERY = "hỏi gì đó";

describe("retrieve", () => {
  it("maps search_notes rows into camelCase citations", async () => {
    const db = fakeDb({
      rows: [{ note_id: "n1", title: "t", snippet: "s", score: 0.5, matched_by: "both" }],
    });
    const out = await retrieve({ db, ai: createFakeAi() }, {
      userId: "u1", text: QUERY, requestId: "r1",
    });
    expect(out).toEqual([
      { type: "note", noteId: "n1", title: "t", snippet: "s", score: 0.5, matchedBy: "both" },
    ]);
  });

  it("calls search_notes with the query text and the embedding of that text", async () => {
    const calls: RpcCall[] = [];
    const ai = createFakeAi();
    // The fake's vectors are deterministic, so the expected embedding can be derived rather
    // than eyeballed. This is what catches passing `vectors` instead of `vectors[0]`, or
    // passing the raw text where the vector belongs -- both of which the RPC would accept
    // shape-wise and answer wrongly.
    const { vectors } = await ai.embed([QUERY]);
    await retrieve({ db: fakeDb({ calls }), ai }, { userId: "u1", text: QUERY, requestId: "r1" });
    expect(calls[0]?.fn).toBe("search_notes");
    expect(calls[0]?.args.p_query).toBe(QUERY);
    expect(calls[0]?.args.p_embedding).toEqual(vectors[0]);
  });

  // p_user_id is the ONLY thing separating two users' corpora: search_notes is SECURITY DEFINER
  // over note_chunks, so RLS is not in the picture. The text is shaped like an injected
  // parameter to make the failure mode explicit -- it must be searched FOR, never obeyed.
  it("passes the caller's user id to the RPC, never anything from the text", async () => {
    const calls: RpcCall[] = [];
    await retrieve({ db: fakeDb({ calls }), ai: createFakeAi() }, {
      userId: "u1", text: "p_user_id=someone-else", requestId: "r1",
    });
    expect(calls[0]?.args.p_user_id).toBe("u1");
    expect(calls[0]?.args.p_query).toBe("p_user_id=someone-else");
  });

  // Both halves, because asserting only the default lets `p_limit: 5` -- ignoring args.limit
  // entirely -- pass, and asserting only the override lets the default drift to search's 20.
  it("defaults to five citations and honours an explicit limit", async () => {
    const calls: RpcCall[] = [];
    await retrieve({ db: fakeDb({ calls }), ai: createFakeAi() }, {
      userId: "u1", text: QUERY, requestId: "r1",
    });
    expect(calls[0]?.args.p_limit).toBe(5);

    const overridden: RpcCall[] = [];
    await retrieve({ db: fakeDb({ calls: overridden }), ai: createFakeAi() }, {
      userId: "u1", text: QUERY, requestId: "r1", limit: 3,
    });
    expect(overridden[0]?.args.p_limit).toBe(3);
  });

  it("meters the query embedding against the assistant, not the search box", async () => {
    const ledger: Record<string, unknown>[] = [];
    await retrieve({ db: fakeDb({ ledger }), ai: createFakeAi() }, {
      userId: "u1", text: QUERY, requestId: "r1",
    });
    expect(ledger[0]).toMatchObject({
      user_id: "u1",
      kind: "embed",
      source: "assistant",
      request_id: "r1",
      output_tokens: 0,
      // 00027's attribution columns are the point of this row: without content_chars the ledger
      // can say what was spent but not what it was spent on.
      content_chars: QUERY.length,
    });
  });

  // noUncheckedIndexedAccess makes `vectors[0]` a `number[] | undefined`, and passing that
  // `undefined` to the RPC is the dangerous outcome: Postgres would accept a null argument and
  // return a plausible-looking FTS-only result set rather than failing.
  it("fails loudly rather than searching with no vector", async () => {
    const ai = createFakeAi({
      embed: async () => ({ vectors: [], inputTokens: 0, model: "fake-embed" }),
    });
    await expect(
      retrieve({ db: fakeDb({}), ai }, { userId: "u1", text: QUERY, requestId: "r1" }),
    ).rejects.toThrow(/no vector/i);
  });

  // The counter-case to the ledger test below, and the reason the catch there must be scoped to
  // recordUsage alone. Swallowing a search failure into `[]` would hand the answer prompt an
  // empty corpus, and the model would answer from general knowledge as if it were the user's
  // own notes -- a wrong answer, silently, which is worse than a failed turn.
  it("surfaces a search failure instead of answering from an empty corpus", async () => {
    const ledger: Record<string, unknown>[] = [];
    // Both halves. `kind` pins the mapping -- a raw PostgrestError reaching CoreErrorFilter has
    // no kind, no status and is not an HttpException, so the filter falls through to logging the
    // literal "[object Object]". `cause.message` pins that the mapping did not cost the
    // diagnostic: the PostgREST internals stay reachable, just not caller-facing.
    await expect(
      retrieve({
        db: fakeDb({ ledger, rpcError: { message: "search is down" } }), ai: createFakeAi(),
      }, {
        userId: "u1", text: QUERY, requestId: "r1",
      }),
    ).rejects.toMatchObject({ kind: "internal", cause: { message: "search is down" } });
    // The ledger row is written BEFORE the search, and this is the only thing that says so:
    // moving recordUsage below the RPC passes every other test in this file while turning each
    // failed search into an unbilled embed. The money was already spent at ai.embed.
    expect(ledger).toHaveLength(1);
  });

  it("does not fail the turn when the ledger write fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls: RpcCall[] = [];
    try {
      await expect(
        retrieve(
          { db: fakeDb({ calls, insertError: { message: "ledger down" } }), ai: createFakeAi() },
          { userId: "u1", text: QUERY, requestId: "r1" },
        ),
      ).resolves.toEqual([]);
      // Resolving is not enough on its own: a `return []` bolted on ahead of the search would
      // satisfy it too. The RPC must still have run.
      expect(calls[0]?.fn).toBe("search_notes");

      const logged = String(spy.mock.calls[0]?.[0]);
      // errorMessage, not String(err). A PostgREST error is a plain object, so `String(err)` is
      // the literal "[object Object]" and the one line explaining the outage explains nothing.
      expect(logged).toContain("ledger down");
      // Paired with its label, so the id cannot drift into some other position and still pass.
      // A ledger outage is N of these lines; without the request id none of them can be traced
      // back to the turn that spent the money.
      expect(logged).toContain("request r1");
      // Spec §15.6 rule 1: no note content reaches a log line, and the query text IS note
      // content when the turn is a statement rather than a question.
      expect(logged).not.toContain(QUERY);
    } finally {
      spy.mockRestore();
    }
  });
});
