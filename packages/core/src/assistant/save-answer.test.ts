import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { buildSavedAnswerRow, saveAnswer } from "./save-answer.js";

describe("buildSavedAnswerRow", () => {
  // The source type carries the provenance the retrieval ranking keys on. search_notes
  // down-weights 'web_search' and 'assistant' by 0.8 (00022:92); written as 'quick' the saved
  // answer would rank as the user's OWN thinking and be cited back to them as such.
  it("marks a web-cited answer as web_search", () => {
    const row = buildSavedAnswerRow({
      userId: "u1", statement: "Omega-3 có trong cá hồi.", sourceUrl: "https://e.com/a",
    });
    expect(row.source_type).toBe("web_search");
    expect(row.source_meta).toEqual({ url: "https://e.com/a" });
  });

  it("marks an ungrounded answer as assistant", () => {
    const row = buildSavedAnswerRow({ userId: "u1", statement: "Omega-3 có trong cá hồi." });
    expect(row.source_type).toBe("assistant");
    // {} and not { url: undefined }: source_meta is `not null default '{}'`, and a key whose
    // value is undefined survives JSON.stringify as an absent key on some paths and as null on
    // others. An empty object has one meaning.
    expect(row.source_meta).toEqual({});
  });

  // §6.3: it lands in the inbox like any other capture, for the user to file or discard. It is
  // not pre-filed as something they already decided to keep.
  it("lands in the inbox", () => {
    expect(buildSavedAnswerRow({ userId: "u1", statement: "x" }).lifecycle).toBe("inbox");
  });

  // §13, AND THE KEY SET IS THE ASSERTION. `buildSavedAnswerRow(args) === buildSavedAnswerRow(args)`
  // would be a test that cannot fail -- a pure function called twice with one object. Pinning the
  // exact key set is what goes red: the way the two paths stop matching is somebody adding a
  // discriminating field (`via: "offer"`, an `offered_at`, a nondeterministic id) to tell them
  // apart later, and a new key breaks this line the moment it is written.
  // `content`, not `content_text`: the latter is a `generated always as (strip_markdown(content))
  // stored` column (00002_content.sql:7) and Postgres rejects a direct insert into it --
  // content_text derives from this automatically, the same way NoteService.create() writes it.
  it("writes exactly these columns and no discriminator", () => {
    const row = buildSavedAnswerRow({ userId: "u1", statement: "s", sourceUrl: "https://e.com/a" });
    expect(Object.keys(row).sort()).toEqual(
      ["content", "lifecycle", "source_meta", "source_type", "user_id"],
    );
  });
});

/**
 * A minimal double covering exactly the two tables `saveAnswer` touches: `notes.insert(...)
 * .select("id").single()`, and, only when `forMessageId` is given, `chat_messages.select(...)
 * .eq().maybeSingle()` followed by `.update(...).eq()`. `marks` records every `chat_messages`
 * update so a test can assert what was written and to which row, the same shape turn.test.ts's
 * `dbs()` double uses for the same reason.
 */
function fakeDb(opts: { existingMeta?: Record<string, unknown> | null; failSelect?: boolean } = {}) {
  const marks: { row: Record<string, unknown>; id: unknown }[] = [];
  const client = {
    from(table: string) {
      if (table === "notes") {
        return {
          insert: () => ({
            select: () => ({ single: async () => ({ data: { id: "note-1" }, error: null }) }),
          }),
        };
      }
      if (table === "chat_messages") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (opts.failSelect) throw new Error("select boom");
                return { data: { retrieval_meta: opts.existingMeta ?? null }, error: null };
              },
            }),
          }),
          update: (row: Record<string, unknown>) => ({
            eq: async (_col: string, id: unknown) => {
              marks.push({ row, id });
              return { data: null, error: null };
            },
          }),
        };
      }
      throw new Error(`fakeDb: unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, marks };
}

describe("saveAnswer", () => {
  // The common case: an offer or a manual save whose caller has no chat_messages id to give
  // (the "live" reply, streaming before its own row exists -- see assistant-box.tsx). No id
  // means no attempt, not a call with an undefined id.
  it("writes nothing to chat_messages when there is no message to link", async () => {
    const { client, marks } = fakeDb();
    const result = await saveAnswer(client, { userId: "u1", statement: "s" });
    expect(result).toEqual({ id: "note-1" });
    expect(marks).toEqual([]);
  });

  // THE DELIVERABLE: the message the save came from is marked with the note it produced.
  it("marks the source message with the new note's id", async () => {
    const { client, marks } = fakeDb();
    await saveAnswer(client, { userId: "u1", statement: "s", forMessageId: "m1" });
    expect(marks).toEqual([{ row: { retrieval_meta: { savedAnswerNoteId: "note-1" } }, id: "m1" }]);
  });

  // PostgREST replaces the whole jsonb column on a bare update -- a version that skipped the
  // read and wrote only `{ savedAnswerNoteId }` would erase `requestId` and every other key
  // turn.ts already put there, silently, on every save.
  it("merges into the message's existing retrieval_meta rather than replacing it", async () => {
    const { client, marks } = fakeDb({ existingMeta: { requestId: "r1", incomplete: false } });
    await saveAnswer(client, { userId: "u1", statement: "s", forMessageId: "m1" });
    expect(marks[0]!.row.retrieval_meta).toEqual({
      requestId: "r1", incomplete: false, savedAnswerNoteId: "note-1",
    });
  });

  // Best-effort: the note is already written by the time this runs, and it is the actual
  // deliverable the user asked for. A failed link must not turn a successful save into a
  // failed one.
  it("still returns the saved note when marking the message fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { client } = fakeDb({ failSelect: true });
      const result = await saveAnswer(client, { userId: "u1", statement: "s", forMessageId: "m1" });
      expect(result).toEqual({ id: "note-1" });
    } finally {
      spy.mockRestore();
    }
  });
});
