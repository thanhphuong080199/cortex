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
