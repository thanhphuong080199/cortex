// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistantBox, type TranscriptTurn } from "./assistant-box";
import { Provenance } from "./provenance";
import { Markdown } from "./markdown";

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

// A stream that opens and then stalls -- never closed, so whatever state the events leave the
// box in holds still for the assertion instead of racing a `done` (or the stream just ending)
// that would immediately reset it. Module-scoped because both the "attached" hand-off test below
// and "the loading phases" describe need a mid-stream snapshot, not an end-of-stream one.
const stalling = (events: [string, unknown][]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const [type, data] of events) {
          c.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        }
        // deliberately never closed
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

  // Observed 2026-08-17: the loading indicator (driven by `busy`, set at the very top of
  // submit()) appeared a whole network round trip BEFORE the user's own message did, because
  // the bubble used to wait for createNote to resolve. The thread read backwards -- the
  // assistant appeared to be "thinking" about a message nobody could see yet. `/notes` is left
  // deliberately unresolved (a pending Promise, never settled in this test) so this assertion
  // is checked in the one window where the bug was live: after Send, before the save returns.
  it("shows the user's own message immediately, before the note is even saved", async () => {
    let resolveNote!: (res: Response) => void;
    const notePromise = new Promise<Response>((resolve) => { resolveNote = resolve; });
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes") ? notePromise : sse([["done", { messageId: "m1", sessionId: "s1" }]])) as typeof fetch;

    render(<AssistantBox token="t" />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ buổi sáng");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // createNote has NOT resolved yet (resolveNote is still unsettled) -- the save is still in
    // flight -- but the bubble must already be on screen.
    expect(screen.getByText("chạy bộ buổi sáng")).toBeInTheDocument();

    resolveNote(new Response(JSON.stringify({ id: "n1" }), { status: 201 }));
  });

  // Checked mid-stream (`stalling`, not `sse`): once `done` lands, `attached` is deliberately
  // cleared (review finding on e226fea -- see "does not leave an orphan 'Filed under' bubble"
  // below), so asserting `/health/` is still onscreen AFTER completion would be asserting the
  // bug this file elsewhere proves was fixed. What has to hold is that BOTH pieces of state
  // render correctly together while the turn is still live, regardless of arrival order.
  it("renders attached and citations whichever order they arrive in", async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : stalling([
            ["citations", { citations: [{ type: "note", noteId: "x", title: "Older note", snippet: "s", score: 1, matchedBy: "fts" }] }],
            ["attached", { domain: "health", domainMeta: {}, tags: ["thể dục"] }],
            ["token", { text: "Đã lưu." }],
          ])) as typeof fetch;

    render(<AssistantBox token="t" />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText(/health/)).toBeInTheDocument();
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
    // The optimistic bubble (added the instant Send was pressed, see the test below) must be
    // rolled back on failure -- otherwise a save that never happened would still show a chat
    // bubble for it, which is exactly the property this whole test exists to prevent. Scoped to
    // `.bubble.user p`: a bare text match also matches the textarea itself, which legitimately
    // still holds this same string (asserted above) -- React renders a controlled textarea's
    // value as its DOM text content, so an unscoped query can't tell "still in the box" apart
    // from "also a chat bubble".
    expect(screen.queryByText("ghi chú chưa lưu", { selector: ".bubble.user p" })).toBeNull();
  });

  it("sends the browser's time zone with the turn", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/notes")) return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
      bodies.push(String(init?.body ?? ""));
      return sse([["done", { messageId: "m1", sessionId: "s1" }]]);
    }) as typeof fetch;

    render(<AssistantBox token="t" initialTurns={[]} />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    // Whatever the test runner's zone is -- asserting a literal would pin the CI machine's
    // configuration, which is not the claim. The claim is that a real zone is sent.
    const sent = JSON.parse(bodies[0]!) as { timeZone?: string };
    expect(sent.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
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

  // The offer's entry point: a fact the answer contributed that the user's own notes did not
  // have, carried on its own SSE event exactly like `web` already is.
  it("shows the offer and saves it on accept", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/notes")) return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
      if (String(url).endsWith("/notes/save-answer")) {
        return new Response(JSON.stringify({ id: "m1" }), { status: 201 });
      }
      return sse([
        ["token", { text: "Cá hồi giàu omega-3." }],
        ["offer", { statement: "Cá hồi giàu omega-3.", sourceUrl: "https://e.com/a" }],
        ["done", { messageId: "m1", sessionId: "s1" }],
      ]);
    }) as typeof fetch;

    render(<AssistantBox token="t" />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "omega-3 ở đâu");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await userEvent.click(await screen.findByRole("button", { name: "Lưu" }));

    const saveCall = calls.find((c) => c.url.endsWith("/notes/save-answer"));
    expect(saveCall).toBeDefined();
    expect(saveCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(saveCall?.init?.body))).toEqual({
      statement: "Cá hồi giàu omega-3.", sourceUrl: "https://e.com/a",
    });
    // Accepting clears the row -- it is a one-shot prompt, not a standing widget.
    expect(screen.queryByRole("button", { name: "Lưu" })).toBeNull();
  });

  // "Costs nothing" is a claim about LATENCY as much as about writes. The offer must be gone
  // before the request settles, so a slow or dead /assistant/decline is invisible to the user.
  // A `fetch` awaited ahead of setOffer(null) passes every other test in this file and fails
  // only this one -- which is the whole reason it is written.
  it("clears the offer without waiting for the decline to land", async () => {
    let resolveDecline!: (res: Response) => void;
    const declinePromise = new Promise<Response>((resolve) => { resolveDecline = resolve; });
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/notes")) return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
      if (String(url).endsWith("/assistant/decline")) return declinePromise;
      return sse([
        ["token", { text: "Cá hồi giàu omega-3." }],
        ["offer", { statement: "Cá hồi giàu omega-3." }],
        ["done", { messageId: "m1", sessionId: "s1" }],
      ]);
    }) as typeof fetch;

    render(<AssistantBox token="t" />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "omega-3 ở đâu");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await userEvent.click(await screen.findByRole("button", { name: "Bỏ qua" }));

    // The request is still in flight -- resolveDecline has not been called.
    expect(screen.queryByRole("group", { name: "Lưu vào notes?" })).toBeNull();
    resolveDecline(new Response(null, { status: 204 }));
  });

  // The other half of "costs nothing": no note, from the client's side. The accept path posts to
  // /notes/save-answer, and the natural way to break this is one shared handler with a flag.
  it("posts no save when the offer is declined", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/notes")) return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
      if (String(url).endsWith("/assistant/decline")) return new Response(null, { status: 204 });
      return sse([
        ["token", { text: "ok" }],
        ["offer", { statement: "Cá hồi giàu omega-3." }],
        ["done", { messageId: "m1", sessionId: "s1" }],
      ]);
    }) as typeof fetch;

    render(<AssistantBox token="t" />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "omega-3 ở đâu");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await userEvent.click(await screen.findByRole("button", { name: "Bỏ qua" }));

    expect(calls.some((u) => u.endsWith("/notes/save-answer"))).toBe(false);
  });

  // §11's "easy to ignore" is only true if it is genuinely optional. A turn with no offer must
  // render no row at all -- not an empty one waiting to be filled.
  it("renders nothing when no offer arrives", async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : sse([
            ["token", { text: "ok" }],
            ["done", { messageId: "m1", sessionId: "s1" }],
          ])) as typeof fetch;

    render(<AssistantBox token="t" />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "Lưu vào notes?" })).toBeNull();
  });
});

const turn = (over: Partial<TranscriptTurn> = {}): TranscriptTurn => ({
  id: "t1", role: "assistant", content: "Đã lưu.", citations: [], incomplete: false, ...over,
});

describe("the transcript", () => {
  it("renders both sides of a past turn", () => {
    render(<AssistantBox token="t" initialTurns={[
      turn({ id: "u1", role: "user", content: "hôm nay tôi chạy bộ" }),
      turn({ id: "a1", role: "assistant", content: "Đã lưu vào health." }),
    ]} />);
    expect(screen.getByText("hôm nay tôi chạy bộ")).toBeInTheDocument();
    expect(screen.getByText("Đã lưu vào health.")).toBeInTheDocument();
  });

  // THE ONE THAT IS INVISIBLE OTHERWISE. retrieval_meta.incomplete marks an answer the stream
  // never finished. It stays in the thread deliberately (it is already kept OUT of the prompt
  // at turn.ts:134, because the model reads a truncated answer as a complete one) -- but in
  // the `content` column alone, an interrupted answer and a short answer are the same string.
  // Only the flag can tell them apart, and only the pane can say so.
  it("marks an interrupted answer as interrupted", () => {
    render(<AssistantBox token="t" initialTurns={[
      turn({ content: "Theo notes của bạn thì", incomplete: true }),
    ]} />);
    expect(screen.getByText(/interrupted|bị gián đoạn/i)).toBeInTheDocument();
  });

  it("does not mark a complete answer", () => {
    render(<AssistantBox token="t" initialTurns={[turn()]} />);
    expect(screen.queryByText(/interrupted|bị gián đoạn/i)).toBeNull();
  });

  // The naive version double-renders the last turn: once from the box's streaming state and
  // once from the transcript it was just appended to. The box owns what is still streaming;
  // the transcript owns everything that is done.
  it("shows a finished turn exactly once", async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : sse([
            ["token", { text: "Đã lưu nhé." }],
            ["done", { messageId: "m1", sessionId: "s1" }],
          ])) as typeof fetch;

    render(<AssistantBox token="t" initialTurns={[]} />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getAllByText("Đã lưu nhé.")).toHaveLength(1));
  });

  // Review finding (e226fea follow-up): `done` reset `answer`/`citations`/`web` but never
  // `attached`, and nothing else ever cleared it -- so the live reply bubble kept rendering
  // forever after every completed turn, containing only the "Filed under" line with nothing
  // else in it. Real note captures hit this on essentially every turn.
  it("does not leave an orphan 'Filed under' bubble once the turn has landed", async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : sse([
            ["attached", { domain: "health", domainMeta: {}, tags: ["thể dục"] }],
            ["token", { text: "Đã lưu." }],
            ["done", { messageId: "m1", sessionId: "s1" }],
          ])) as typeof fetch;

    render(<AssistantBox token="t" initialTurns={[]} />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // The turn landed and carried the "Filed under" fact is still readable once, from the
    // transcript's own copy -- this is not asserting the fact disappeared, only that the
    // ephemeral live bubble stopped re-rendering it after hand-off.
    await waitFor(() => expect(screen.getAllByText("Đã lưu.")).toHaveLength(1));
    expect(screen.queryAllByText(/Filed under/)).toHaveLength(0);
  });

  // Review finding (e226fea follow-up): turn.ts:363 yields `done` only `if (!incomplete)`. A
  // stream that dies mid-answer still gets its row written to chat_messages with
  // `retrieval_meta.incomplete: true`, but the client never sees a `done` event for it. Before
  // this fix the partial answer lived only in the ephemeral `answer` state, which the NEXT
  // submit() resets at its very top -- so an interrupted reply vanished the moment the user sent
  // another message, until a full reload re-read it from chat_messages. This is the client-side
  // half of the brief's own "shown, never hidden" rule for `incomplete`.
  it("keeps an interrupted answer visible after the stream ends without a done event, even past the next submit", async () => {
    let call = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/notes")) {
        return new Response(JSON.stringify({ id: `n${++call}` }), { status: 201 });
      }
      // First turn: tokens arrive, then the stream simply closes -- no `done`, matching a
      // server-side catch that already yielded `error` and inserted an incomplete row.
      if (call === 1) {
        return sse([
          ["token", { text: "Theo notes của bạn thì" }],
          ["error", { message: "boom" }],
        ]);
      }
      // Second turn: a normal, complete reply.
      return sse([
        ["token", { text: "Đã lưu nhé." }],
        ["done", { messageId: "m2", sessionId: "s1" }],
      ]);
    }) as typeof fetch;

    render(<AssistantBox token="t" initialTurns={[]} />);
    const textarea = screen.getByLabelText(/what are you thinking/i);
    const send = screen.getByRole("button", { name: /send/i });

    await userEvent.type(textarea, "câu hỏi đầu tiên");
    await userEvent.click(send);

    // The interrupted turn migrated into the transcript, marked interrupted -- not left behind
    // in `answer`.
    await waitFor(() => expect(screen.getByText(/Theo notes của bạn thì/)).toBeInTheDocument());
    expect(screen.getByText(/interrupted|bị gián đoạn/i)).toBeInTheDocument();
    // Second review finding: `status` (the "Saved. No answer right now." hint, role="status")
    // must not survive alongside the just-landed interrupted turn -- the marker above already
    // says what happened. A leftover hint bubble here would be the same "orphan live state"
    // bug as finding 1, just on the interrupted/error path instead of the normal one.
    expect(screen.queryByRole("status")).toBeNull();

    // Send a second turn. The naive bug clears `answer` at the top of THIS submit() and the
    // interrupted reply was never anywhere else, so it would disappear right here.
    await userEvent.type(textarea, "câu hỏi thứ hai");
    await userEvent.click(send);
    await waitFor(() => expect(screen.getByText("Đã lưu nhé.")).toBeInTheDocument());

    expect(screen.getByText(/Theo notes của bạn thì/)).toBeInTheDocument();
    expect(screen.getByText(/interrupted|bị gián đoạn/i)).toBeInTheDocument();
  });

  // Review finding on adc349a: `flushLiveIntoTurns` reset `attached`/`answer`/`citations`/`web`
  // but not `status`, and `status` is set by the exact same error/catch paths that also migrate
  // an interrupted turn. Since `hasReply` includes `status !== null`, the live reply bubble kept
  // rendering a second, decoupled "Saved. No answer right now." hint below the real transcript
  // row until the next submit()'s top-of-function reset. A narrower, standalone check than the
  // one folded into the test above: nothing else about the turn matters here, only that the hint
  // is gone the moment the interrupted row lands.
  it("clears the status hint once an interrupted turn has landed, not just the answer", async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : sse([
            ["token", { text: "một phần câu trả lời" }],
            ["error", { message: "boom" }],
          ])) as typeof fetch;

    render(<AssistantBox token="t" initialTurns={[]} />);
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/một phần câu trả lời/)).toBeInTheDocument());
    expect(screen.queryByText(/saved\. no answer/i)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("the loading phases", () => {
  // `stalling` is module-scoped above (also used by "renders attached and citations..."): a
  // stream that opens and then stalls, which is what a grounded turn looks like from the
  // client: `attached` and `citations` arrive, and then nothing for several seconds while the
  // model searches the web. `web` is emitted only AFTER the stream completes (turn.ts:295), so
  // this is exactly the state the box has to render something for -- and until now it rendered
  // a frozen screen.
  const stubbed = (res: () => Response) => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : res()) as typeof fetch;
  };

  const send = async () => {
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
  };

  it("says it is saving before anything comes back", async () => {
    stubbed(() => stalling([]));
    render(<AssistantBox token="t" initialTurns={[]} />);
    await send();
    expect(await screen.findByRole("status")).toHaveTextContent(/lưu|saving/i);
  });

  // THE ONE THE USER HIT. This is the multi-second grounding gap, and it is the whole reason
  // this feature exists: the note is filed, the notes are searched, and the model has not said
  // anything yet.
  it("says it is working on an answer once the context has arrived", async () => {
    stubbed(() => stalling([
      ["attached", { domain: "media", domainMeta: {}, tags: ["phim"] }],
      ["citations", { citations: [] }],
    ]));
    render(<AssistantBox token="t" initialTurns={[]} />);
    await send();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/tìm câu trả lời|answer/i));
  });

  // Tokens ARE the progress indicator. Leaving the label up beside a streaming answer says the
  // box is still waiting for something it already has.
  it("drops the indicator once tokens start arriving", async () => {
    stubbed(() => stalling([
      ["attached", { domain: null, domainMeta: {}, tags: [] }],
      ["token", { text: "Theo notes của bạn" }],
    ]));
    render(<AssistantBox token="t" initialTurns={[]} />);
    await send();
    await screen.findByText(/Theo notes của bạn/);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows no indicator when nothing is in flight", () => {
    render(<AssistantBox token="t" initialTurns={[]} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Markdown", () => {
  it("renders emphasis as elements rather than literal asterisks", () => {
    const { container } = render(<Markdown>{"**Cá hồi** tốt cho mắt."}</Markdown>);
    expect(container.querySelector("strong")).toHaveTextContent("Cá hồi");
    expect(container.textContent).not.toContain("**");
  });

  it("renders a list as a list", () => {
    const { container } = render(<Markdown>{"- cá hồi\n- rau xanh"}</Markdown>);
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  // NOT DECORATION. These URLs are chosen by the MODEL, from grounding results we did not vet
  // -- exactly the case provenance.tsx:53 already hardens for. A rendered link without these
  // hands the opener a window reference back into this tab.
  it("hardens links the model produced", () => {
    render(<Markdown>{"xem [ở đây](https://example.com/x)"}</Markdown>);
    const link = screen.getByRole("link", { name: "ở đây" });
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    expect(link).toHaveAttribute("target", "_blank");
  });

  // Raw HTML must NOT be rendered. react-markdown is safe by default (no rehype-raw), and this
  // asserts that nobody adds it later for "richer" output -- model output is untrusted text and
  // this component is the only place it becomes DOM.
  it("does not render raw html from model output", () => {
    const { container } = render(<Markdown>{"<img src=x onerror=alert(1)>"}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
  });

  // A half-written bold marker mid-stream must render as text, not swallow the rest of the
  // answer. This is what every token between "**" and its closing pair looks like.
  it("renders an unterminated marker as text while streaming", () => {
    const { container } = render(<Markdown>{"**Cá h"}</Markdown>);
    expect(container.textContent).toContain("Cá h");
  });
});

describe("provenance", () => {
  const noteCitation = {
    type: "note" as const, noteId: "n1", title: null, createdAt: "2026-08-18T02:00:00.000Z",
    snippet: "dạo này hơi mỏi mắt", score: 0.9, matchedBy: "fts",
  };
  const webCitation = { type: "web" as const, url: "https://e.com/a", title: "Eye health" };

  // The box being removed. Asserted on the HEADING, not on the snippet text: the snippet is
  // the user's own message, which also appears in their own bubble in the transcript, so a
  // snippet-based assertion would stay red for the wrong reason.
  it("does not render a notes section", () => {
    render(<Provenance citations={[noteCitation]} />);
    expect(screen.queryByText(/Từ notes của bạn/i)).toBeNull();
  });

  // THE ONE THAT MATTERS MORE THAN THE REMOVAL. The web block is a Google terms-of-service
  // obligation, not a design choice, and it is rendered by the same component from the same
  // array -- so the natural way to break it is to delete one filter too many.
  it("still renders the web section", () => {
    render(<Provenance citations={[noteCitation, webCitation]} />);
    expect(screen.getByText("Từ web")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Eye health" })).toHaveAttribute("href", webCitation.url);
  });

  // Same obligation, the other half: the entry-point widget must survive on a grounded turn.
  it("still renders the grounding entry point", () => {
    const { container } = render(
      <Provenance citations={[webCitation]} entryPoint='<div id="gse">chips</div>' />,
    );
    expect(container.querySelector("#gse")).not.toBeNull();
  });

  // A turn whose only citations are notes must now render NOTHING at all -- not an empty
  // <section> with a heading and no list, which is what a half-deletion leaves behind.
  it("renders nothing when the only citations are notes", () => {
    const { container } = render(<Provenance citations={[noteCitation]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
