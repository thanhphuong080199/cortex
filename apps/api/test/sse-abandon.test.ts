import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The premise `assistant.controller.ts` relies on to decide that the client went away.
 *
 * This suite does not boot Nest and does not touch Supabase, deliberately: what broke was a
 * platform contract, not our composition. `POST /assistant` carried
 * `req.on("close", () => abort.abort())` from stage C1 until 2026-08-23 with a comment claiming
 * it stopped the work when the tab was closed. It never ran once. Since Node 16,
 * `http.IncomingMessage` emits 'close' when the request MESSAGE completes -- `express.json()`
 * reads the body to EOF and the event fires on the next tick, before Nest's async
 * SupabaseAuthGuard resolves and the handler gets to register anything.
 *
 * The three facts below are exactly what the fix depends on, and each one is a thing a future
 * Node release could change underneath us without any of our own code moving. `handler` mimics
 * the real shape: body read to EOF (express.json), one await (the guard), THEN the listeners.
 */

// A body read to completion, then one await, then the listeners -- the ordering that matters.
// Resolves with what fired, so each test asserts on facts rather than on timing.
function stream(
  onRequest: (facts: { reqClosed: boolean; resClosed: boolean; endedWhenClosed: boolean | null }) => void,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    await new Promise<void>((resolve) => {
      req.on("data", () => {});
      req.on("end", () => resolve());
    });
    // The guard. One await is all it takes: Node drains its nextTick queue -- where the
    // Readable's autoDestroy 'close' sits -- before any promise continuation runs.
    await Promise.resolve();

    const facts = { reqClosed: false, resClosed: false, endedWhenClosed: null as boolean | null };
    req.on("close", () => { facts.reqClosed = true; });
    res.on("close", () => {
      facts.resClosed = true;
      facts.endedWhenClosed = res.writableEnded;
      onRequest(facts);
    });

    res.setHeader("content-type", "text/event-stream");
    res.flushHeaders();
    // Slow enough that a client can hang up in the middle of it, which is the case the whole
    // abort mechanism exists for.
    for (let i = 0; i < 6; i++) {
      if (res.writableEnded) return;
      res.write(`event: token\ndata: {"text":"${i}"}\n\n`);
      await new Promise((r) => setTimeout(r, 40));
    }
    res.end();
  };
}

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

const listen = (handler: ReturnType<typeof stream>): Promise<number> => {
  server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve) => {
    server!.listen(0, () => resolve((server!.address() as { port: number }).port));
  });
};

describe("detecting an abandoned SSE turn", () => {
  // THE SHIPPED BUG, pinned. A `req` listener registered where a Nest handler registers one is
  // registered after the event, so it can never report an abandonment -- which is why an
  // abandoned turn streamed to completion and billed for all of it.
  it("never reports the client hanging up through the request stream", async () => {
    let seen: { reqClosed: boolean; resClosed: boolean } | undefined;
    let settle!: () => void;
    const closed = new Promise<void>((r) => { settle = r; });
    const port = await listen(stream((facts) => { seen = facts; settle(); }));

    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/assistant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noteId: "n1" }),
      signal: abort.signal,
    });
    // Read one chunk so the stream is genuinely mid-flight, then walk away -- a closed tab.
    await res.body!.getReader().read();
    abort.abort();

    await closed;
    expect(seen!.resClosed).toBe(true);
    // The whole finding. The response knows; the request does not.
    expect(seen!.reqClosed).toBe(false);
  });

  // The fix's positive half: `res` does report it, and reports it as an abandonment.
  it("reports it through the response stream, with the response still unfinished", async () => {
    let seen: { endedWhenClosed: boolean | null } | undefined;
    let settle!: () => void;
    const closed = new Promise<void>((r) => { settle = r; });
    const port = await listen(stream((facts) => { seen = facts; settle(); }));

    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/assistant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noteId: "n1" }),
      signal: abort.signal,
    });
    await res.body!.getReader().read();
    abort.abort();

    await closed;
    // `writableEnded === false` is what the controller's guard keys on. Without this being
    // false here, the fix would detect nothing.
    expect(seen!.endedWhenClosed).toBe(false);
  });

  // Why the guard is not optional. `res` closes on EVERY request, successful ones included --
  // an unguarded `res.on("close", () => abort.abort())` would abort each turn a tick after its
  // own final write, which is harmless only because there is nothing left to cancel by then.
  // Relying on that is relying on an ordering nobody wrote down.
  it("also closes on a turn that finished normally, distinguishable only by writableEnded", async () => {
    let seen: { endedWhenClosed: boolean | null } | undefined;
    let settle!: () => void;
    const closed = new Promise<void>((r) => { settle = r; });
    const port = await listen(stream((facts) => { seen = facts; settle(); }));

    const res = await fetch(`http://127.0.0.1:${port}/assistant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noteId: "n1" }),
    });
    await res.text();

    await closed;
    expect(seen!.endedWhenClosed).toBe(true);
  });
});
