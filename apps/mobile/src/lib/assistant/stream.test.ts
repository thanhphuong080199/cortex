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

  it("yields a web event with its sources and queries", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse(
        'event: token\ndata: {"text":"ừ"}\n\n' +
        'event: web\ndata: {"sources":[{"type":"web","url":"https://a.example","title":"a"}],' +
        '"queries":["Dune 3"]}\n\n' +
        'event: done\ndata: {"messageId":"m1","sessionId":"s1"}\n\n',
      ),
    );

    const events = await collect(streamAssistantTurn({ ...args, fetchFn }));
    expect(events).toContainEqual({
      type: "web",
      sources: [{ type: "web", url: "https://a.example", title: "a" }],
      queries: ["Dune 3"],
    });
  });

  // The server has emitted this event since C5 and this client has silently dropped it since C5 --
  // which is why an answer could never be kept on the device at all (S1.5 §"Current architecture").
  it("yields the offer event", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse(
        `event: offer\ndata: ${JSON.stringify({ statement: "Cá hồi giàu omega-3.", sourceUrl: "https://e.com" })}\n\n`,
      ),
    );
    const events = await collect(streamAssistantTurn({ ...args, fetchFn }));
    expect(events).toContainEqual({
      type: "offer", statement: "Cá hồi giàu omega-3.", sourceUrl: "https://e.com",
    });
  });

  // sourceUrl is absent for general knowledge, and an explicit `sourceUrl: undefined` would be
  // written into the note's source_meta as a null on one path and an absent key on another --
  // the exact split buildSavedAnswerRow's spread-if comment exists to prevent.
  it("omits sourceUrl entirely when the offer carries none", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse(`event: offer\ndata: ${JSON.stringify({ statement: "S." })}\n\n`),
    );
    const events = await collect(streamAssistantTurn({ ...args, fetchFn }));
    expect(events).toContainEqual({ type: "offer", statement: "S." });
  });

  it("drops an offer event with no statement", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      sseResponse(`event: offer\ndata: ${JSON.stringify({})}\n\n`),
    );
    const events = await collect(streamAssistantTurn({ ...args, fetchFn }));
    expect(events.some((e) => (e as { type: string }).type === "offer")).toBe(false);
  });
});
