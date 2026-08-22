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

  // THE DEDUP. `chat_messages.id` is a server-generated `gen_random_uuid()` -- turn.ts never
  // sets it to the note's id -- so the replicated rows' ids here are realistic-looking server
  // UUIDs that share NOTHING with `noteId: "n1"`. The match has to come from content, role and
  // timing instead. The replicated rows arrive a second or two after the stream ends; for that
  // window both exist, and without this the user watches their own message appear twice.
  //
  // `live.answer` is empty here on purpose: this fixture represents the turn having fully
  // settled -- both rows replicated -- which in the real app means `AssistantBox`'s `finally`
  // has already cleared `live` to `null` before either row could land (see the next test for
  // the case that actually matters while the answer is still in flight). An empty answer keeps
  // this test honest about what it is asserting: the user half stays deduped once its row
  // exists, full stop, with nothing left over from the live overlay to duplicate the assistant
  // row either.
  it("drops the live turn once its rows have replicated", () => {
    const items = buildTranscript([
      row({
        id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        created_at: "2026-08-22T02:30:01.000Z", content: "mỏi mắt ăn gì",
      }),
      row({
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        created_at: "2026-08-22T02:30:05.000Z", role: "assistant", content: "Cá hồi.",
      }),
    ], {
      noteId: "n1", text: "mỏi mắt ăn gì", answer: "",
      createdAt: "2026-08-22T02:30:00.000Z",
    }, now, tz);
    expect(items.filter((i) => i.kind === "message")).toHaveLength(2);
  });

  // A same-text ASSISTANT row must not stand in for the user's own message -- matching on
  // content alone, without the role check, would drop the live turn against the wrong half of
  // someone else's exchange.
  it("does not dedup the live turn against a same-text row of the other role", () => {
    const items = buildTranscript([
      row({
        id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", role: "assistant",
        created_at: "2026-08-22T02:30:01.000Z", content: "mỏi mắt ăn gì",
      }),
    ], {
      noteId: "n1", text: "mỏi mắt ăn gì", answer: "",
      createdAt: "2026-08-22T02:30:00.000Z",
    }, now, tz);
    // The row (assistant) plus the still-live user bubble (no answer token yet): 2 messages,
    // not 1 -- the live turn was NOT dropped.
    expect(items.filter((i) => i.kind === "message")).toHaveLength(2);
  });

  // A same-text row from far outside the match window is a different conversation, not this
  // turn's replica -- e.g. the user asking the identical question again days later.
  it("does not dedup the live turn against a same-text row outside the time window", () => {
    const items = buildTranscript([
      row({
        id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        created_at: "2026-08-20T02:30:00.000Z", content: "mỏi mắt ăn gì",
      }),
    ], {
      noteId: "n1", text: "mỏi mắt ăn gì", answer: "",
      createdAt: "2026-08-22T02:30:00.000Z",
    }, now, tz);
    expect(items.filter((i) => i.kind === "message")).toHaveLength(2);
  });

  // THE MID-GENERATION REPLICATION CASE. turn.ts writes the user's row right after
  // session/history resolution -- well before the assistant's row, which is a single insert of
  // the FINAL text after generation completes. So the user's row routinely replicates WHILE the
  // answer is still streaming, and the two halves must be gated independently: suppressing the
  // still-accumulating answer the instant the user's row replicates would blank the streaming
  // preview for the rest of most turns, which is the opposite of "the answer streams in below".
  it("keeps streaming the live answer after the user's own row has replicated", () => {
    const items = buildTranscript([
      row({
        id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        created_at: "2026-08-22T02:30:01.000Z", content: "mỏi mắt ăn gì",
      }),
    ], {
      noteId: "n1", text: "mỏi mắt ăn gì", answer: "Cá",
      createdAt: "2026-08-22T02:30:00.000Z",
    }, now, tz);
    const messages = items.filter((i) => i.kind === "message");
    // The user's message appears exactly once -- from the replicated row, not duplicated by a
    // still-showing live bubble -- and the live answer bubble is still present even though the
    // assistant's own row has not replicated (and never will, in this fixture).
    expect(messages).toHaveLength(2);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: "mỏi mắt ăn gì" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Cá", id: "live-answer-n1" });
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
