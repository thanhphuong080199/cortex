export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Reads an SSE body. Holds the tail: a network chunk can end mid-event, and parsing half a
 * JSON object throws. Same rule the server-side reader in gemini.ts follows.
 *
 * Lives in @cortex/shared rather than in either client because both need all four of its
 * subtleties, and two copies means paying for each of them twice.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parse = (raw: string): SseEvent | null => {
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
