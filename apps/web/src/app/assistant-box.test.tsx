// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

  // The other half of "a dead assistant must never cost a capture": this is the case where
  // the SAVE ITSELF never happened, not just the answer. It must read differently from
  // "Saved. No answer right now." -- that message would be a lie here -- and the text must
  // stay put so the only thing the user has to do is retry.
  it("keeps the text and offers a retry when the save itself fails", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response("boom", { status: 500 });
    }) as typeof fetch;

    render(<AssistantBox token="t" />);
    const textarea = screen.getByLabelText(/what are you thinking/i);
    await userEvent.type(textarea, "ghi chú chưa lưu");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent(/couldn't save/i);
    expect(within(error).getByRole("button", { name: /retry/i })).toBeInTheDocument();

    // Never cleared: the text is still there to retry, unlike the success path.
    expect(textarea).toHaveValue("ghi chú chưa lưu");
    // The stream must never be reached when the save itself never happened.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/notes$/);
  });

  it("retrying re-submits the same text and can succeed the second time", async () => {
    const calls: string[] = [];
    let noteAttempt = 0;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/notes")) {
        noteAttempt += 1;
        return noteAttempt === 1
          ? new Response("boom", { status: 500 })
          : new Response(JSON.stringify({ id: "n1" }), { status: 201 });
      }
      return sse([["done", { messageId: "m1", sessionId: "s1" }]]);
    }) as typeof fetch;

    render(<AssistantBox token="t" />);
    const textarea = screen.getByLabelText(/what are you thinking/i);
    await userEvent.type(textarea, "ghi chú chưa lưu");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    const error = await screen.findByRole("alert");
    await userEvent.click(within(error).getByRole("button", { name: /retry/i }));

    // The retry resubmitted the SAME text -- no re-typing required -- and this time the
    // save succeeded, so the textarea clears and the stream is reached.
    await waitFor(() => expect(textarea).toHaveValue(""));
    expect(calls.filter((u) => u.endsWith("/notes"))).toHaveLength(2);
    expect(calls.filter((u) => u.endsWith("/assistant"))).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
