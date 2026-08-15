// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistantBox } from "./assistant-box";

const sse = (events: [string, unknown][]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const [type, data] of events) {
          c.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        }
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

describe("AssistantBox", () => {
  it("saves the note before it opens the stream", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : sse([["done", { messageId: "m1", sessionId: "s1" }]]);
    }) as typeof fetch;

    render(<AssistantBox token="t" />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "hôm nay tôi chạy bộ");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatch(/\/notes$/);
    expect(calls[1]).toMatch(/\/assistant$/);
  });

  it("renders attached and citations whichever order they arrive in", async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : sse([
            ["citations", { citations: [{ noteId: "x", title: "Older note", snippet: "s", score: 1, matchedBy: "fts" }] }],
            ["attached", { domain: "health", domainMeta: {}, tags: ["thể dục"] }],
            ["token", { text: "Đã lưu." }],
            ["done", { messageId: "m1", sessionId: "s1" }],
          ])) as typeof fetch;

    render(<AssistantBox token="t" />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText(/health/)).toBeInTheDocument();
    expect(await screen.findByText(/Older note/)).toBeInTheDocument();
    expect(await screen.findByText(/Đã lưu\./)).toBeInTheDocument();
  });

  // The guarantee that matters most: a dead assistant must never cost a capture.
  it("keeps the note and says so when the stream fails", async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : new Response("boom", { status: 500 })) as typeof fetch;

    render(<AssistantBox token="t" />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "ghi chú");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });

  it("says plainly that there is no answer when the budget declines", async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : sse([["declined", { reason: "budget" }]])) as typeof fetch;

    render(<AssistantBox token="t" />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "ghi chú");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText(/no answer/i)).toBeInTheDocument();
  });
});
