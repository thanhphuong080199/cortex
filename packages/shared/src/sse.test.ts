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
    const cut = 29; // lands inside the two bytes of "đ"
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
