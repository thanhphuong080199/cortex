"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import { dayKey, daySeparatorLabel, readEvents, type AnyCitation, type Citation, type Offer, type WebCitation } from "@cortex/shared";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { fetchOlderTurns, type TranscriptClient } from "@/lib/transcript";
import { Provenance } from "./provenance";
import { Markdown } from "./markdown";

type Attached = {
  domain: string | null;
  domainMeta: Record<string, unknown>;
  tags: string[];
  degraded?: boolean;
};

type Web = { sources: WebCitation[]; queries: string[]; entryPoint?: string };

/** The first web source on a reply, which is what turns a save into a 'web_search' note. */
const webUrlOf = (citations: AnyCitation[]): string | undefined =>
  citations.find((c): c is WebCitation => c.type === "web")?.url;

/**
 * One row of chat_messages, ready to render. Built in page.tsx, where the jsonb `citations`
 * column is read through readCitation -- the single place a pre-C3 entry with no `type` key
 * becomes a note citation, and a malformed one is dropped rather than taking the transcript
 * down with it.
 */
export interface TranscriptTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: AnyCitation[];
  /** retrieval_meta.incomplete: the stream died mid-answer. Shown, never hidden. */
  incomplete: boolean;
  /** ISO. Feeds the day separators (Task 4) and the pagination cursor (Task 5). */
  createdAt: string;
}

/**
 * The one chat box (see memory: Cortex's UI target is a single ChatGPT-style thread, not
 * the domain forms). Past captures render as user bubbles above the composer; mood, media
 * and domain/tag are attached by the assistant itself rather than picked in this UI --
 * the sidebar's widgets exist only as accelerators, never as the primary path.
 */
export function AssistantBox(
  {
    token, userId, initialTurns, hasMore,
    // Overridable only for tests: the real default calls createClient()
    // (apps/web/src/lib/supabase/client.ts), which throws in the jsdom test environment because
    // NEXT_PUBLIC_SUPABASE_URL/ANON_KEY are unset there -- createBrowserClient checks eagerly,
    // before ever making a request, so no amount of stubbing global fetch reaches it. Tests pass
    // a fake here instead; no caller outside a test ever does.
    //
    // Cast to TranscriptClient rather than left inferred: the real SupabaseClient's generics are
    // deep enough that structurally checking it against TranscriptClient's chained call shape
    // inline hits TS2589 ("Type instantiation is excessively deep and possibly infinite"). The
    // cast is where that structural match is asserted once, instead of on every call site.
    fetchOlder = (before: string) =>
      fetchOlderTurns(createClient() as unknown as TranscriptClient, userId, before),
  }:
    {
      token: string;
      userId: string;
      initialTurns?: TranscriptTurn[];
      hasMore?: boolean;
      fetchOlder?: (before: string) => ReturnType<typeof fetchOlderTurns>;
    },
) {
  const [turns, setTurns] = useState<TranscriptTurn[]>(initialTurns ?? []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Separate from `status`: `status` covers outcomes AFTER the note is saved (a dead stream,
  // a budget decline). `error` covers the save itself failing -- nothing was written, so it
  // reads differently ("Couldn't save") and, unlike `status`, the text must not be cleared.
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<Attached | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [web, setWeb] = useState<Web | null>(null);
  const [answer, setAnswer] = useState("");
  // NOT reset by flushLiveIntoTurns: unlike attached/citations/web/answer, the offer must
  // survive the hand-off into `turns` -- it is the whole point of the row, and it disappears
  // only when the user acts on it (accept/decline) or the next submit() starts.
  const [offer, setOffer] = useState<Offer | null>(null);
  // The MANUAL save, distinct from `offer` above in both direction and meaning: `offer` is the
  // assistant proposing something unasked, this is the user asking. They can be on screen at the
  // same time, on the same reply, which is why the two boxes are labelled differently rather than
  // being two identically-named buttons.
  const [proposal, setProposal] = useState<
    { forId: string; statement: string; sourceUrl?: string } | null
  >(null);
  const [proposing, setProposing] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [more, setMore] = useState(hasMore ?? false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Mirrors `answer` without the stale-closure lag: the SSE event loop is one long-lived async
  // function whose closure captured `answer` at call time, so `setAnswer` updates the state the
  // NEXT render sees but the loop's own reads of `answer` never do. The `done` branch needs the
  // full text the instant it arrives, not next-render's copy of it.
  const answerRef = useRef("");
  // Same stale-closure problem as `answerRef`, for the other two pieces the `done` branch reads:
  // without these, `done` sees whatever `citations`/`web` were at the moment `submit()` was
  // called (always the pre-turn empty values), so every persisted turn silently lost its note
  // and web citations. Caught by the pre-existing "renders attached and citations whichever
  // order they arrive in" test, which asserts the citation survives past `done`.
  const citationsRef = useRef<Citation[]>([]);
  const webRef = useRef<Web | null>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  /**
   * What to tell the user while the turn is in flight, or null when nothing is.
   *
   * Three phases and no more, because three is how many the server actually reports. The long
   * silence users hit is the middle one -- the model is searching the web, and the `web` event
   * that would say so is emitted only AFTER the stream completes (turn.ts:295). So this says
   * "looking for an answer" and not "searching the web": the box does not know whether this
   * turn grounded, and printing a guess as a fact is worse than printing less.
   *
   * Once tokens arrive there is no label at all -- the tokens are the progress.
   */
  const phase: string | null =
    !busy || answer !== ""
      ? null
      : attached === null && citations.length === 0
        ? "Đang lưu…"
        : "Đang tìm câu trả lời…";

  // Keeps the newest turn in view -- the reply bubble, the loading indicator and errors all
  // land at the bottom of an ever-growing thread, exactly the case a chat UI has to autoscroll
  // for. Only the LIVE parts of the turn scroll the thread down. `turns` was in this list, and
  // with pagination it must not be: loading older messages prepends to the front, and an effect
  // that pins to the bottom on every `turns` change would undo the scroll-anchoring in
  // loadOlder() below instantly. Because `turns` leaves this list, a newly sent message needs
  // its own explicit scroll-to-bottom -- added at the end of the optimistic-bubble block in
  // submit().
  useEffect(() => {
    // `scrollTop =` rather than `.scrollTo(...)`: it's a plain property every DOM
    // implementation (including jsdom, where this component's tests run) supports, with
    // no smooth-scroll API surface to be missing.
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [attached, citations, web, answer, status, error, phase]);

  // Scroll-anchored, and this is the fiddly half. Prepending rows moves everything the user was
  // reading downward by the height of what arrived; capturing scrollHeight before the paint and
  // restoring the delta after it is what keeps their place. Without it the thread jumps to the
  // top on every page and the user cannot read backwards at all.
  async function loadOlder() {
    const el = scrollRef.current;
    const oldest = turns[0];
    if (!el || !oldest || loadingOlder || !more) return;
    setLoadingOlder(true);
    const heightBefore = el.scrollHeight;
    try {
      const { turns: older, hasMore: stillMore } = await fetchOlder(oldest.createdAt);
      setTurns((prev) => [...older, ...prev]);
      setMore(stillMore);
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - heightBefore; });
    } catch {
      // Leave `more` alone: a failed fetch is not proof the thread ended, and setting it false
      // would make one dropped request look permanently like the beginning of history.
    } finally {
      setLoadingOlder(false);
    }
  }

  async function submit() {
    if (!text.trim() || busy) return;
    // Diagnostic only, temporary: one line per milestone on this turn, all relative to t0, with
    // requestId correlating to the matching `[assistant:timing]` lines runTurn logs server-side.
    const t0 = Date.now();
    const requestId = Math.random().toString(36).slice(2, 8);
    const mark = (label: string) =>
      console.log(`[assistant-box:timing] ${requestId} ${label} +${Date.now() - t0}ms`);
    mark("submit");

    const pendingText = text;
    setBusy(true);
    setStatus(null);
    setError(null);
    setAttached(null);
    setCitations([]);
    setWeb(null);
    setAnswer("");
    setOffer(null);
    answerRef.current = "";
    citationsRef.current = [];
    webRef.current = null;

    // Shown the INSTANT Send is pressed, before createNote is even awaited -- otherwise `busy`
    // (and therefore `phase`'s "Đang lưu…") goes true a whole network round trip before this
    // turn's own bubble exists, and the thread reads backwards: the assistant appears to be
    // thinking about a message the user cannot see yet (observed 2026-08-17). A temp id keeps
    // this reconcilable: swapped for the real note id on success below, removed entirely on
    // failure, which is what keeps "never a bubble for a message that was never actually saved"
    // true -- enforced by removal now instead of by delay.
    const tempId = `pending-${t0}`;
    setTurns((prev) => [...prev, {
      id: tempId, role: "user", content: pendingText, citations: [], incomplete: false,
      createdAt: new Date().toISOString(),
    }]);
    setText("");
    // The user just pressed Send; their own bubble must be visible. Explicit now that `turns`
    // no longer drives the autoscroll effect.
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });

    let note: { id: string };
    try {
      // Awaited in its OWN try/catch. The note is the deliverable; the answer is a bonus.
      note = await api.createNote(token, { content: pendingText });
      mark("note saved");
    } catch {
      setTurns((prev) => prev.filter((t) => t.id !== tempId));
      setText(pendingText);
      setError("Couldn't save — your text is still here.");
      setBusy(false);
      mark("note save failed");
      return;
    }

    // Reconciled to the server's real id -- a reload replaces this turn with the persisted one
    // from chat_messages either way, so the id only has to be locally unique until then.
    setTurns((prev) => prev.map((t) => (t.id === tempId ? { ...t, id: note.id } : t)));

    // THE HAND-OFF, generalized. Both the normal "done" event and an interrupted stream that
    // ends without one migrate the live state into `turns` through this one path, so there is
    // exactly one place that resets `attached`/`answer`/`citations`/`web`/`status` together.
    // Before this, `done` cleared everything EXCEPT `attached` -- nothing else ever reset it, so
    // a bare "Filed under: X" bubble (the live reply bubble with everything else empty) sat below
    // the transcript forever, until the next submit() overwrote it. `status` had the same bug on
    // the interrupted path specifically: once that path started migrating the answer into
    // `turns` too, the "Saved. No answer right now." hint set by the (now-removed) inline `error`
    // handler was never cleared alongside it, so a second, decoupled bubble containing only that
    // hint sat below the just-landed interrupted turn. Reads the *Ref mirrors, not the
    // `citations`/`web` state directly: this event loop is one long-lived async function whose
    // closure captured those at call time, so the state variables here are always their pre-turn
    // values (usually empty) -- same stale-closure trap `answerRef` exists for.
    const flushLiveIntoTurns = (id: string, incomplete: boolean) => {
      setTurns((prev) => [...prev, {
        id,
        role: "assistant",
        content: answerRef.current,
        citations: [...citationsRef.current, ...(webRef.current?.sources ?? [])],
        incomplete,
        createdAt: new Date().toISOString(),
      }]);
      setAttached(null);
      setAnswer("");
      setCitations([]);
      setWeb(null);
      setStatus(null);
    };

    // Set inside the `done` branch below. turn.ts:363 yields `done` only `if (!incomplete)` --
    // an interrupted turn (network drop, mid-stream model error) gets its row written to
    // chat_messages with `retrieval_meta.incomplete: true` but NO `done` event, so the stream
    // just ends. Without tracking this, that partial answer stayed solely in the ephemeral
    // `answer`/`citations` state: the next submit() resets them at the top of this function, and
    // the interrupted reply vanished from the screen entirely until a full reload re-read it
    // from chat_messages -- exactly backwards from the brief's "shown, never hidden" for
    // `incomplete`.
    let sawDone = false;
    // A DECLINED turn is NOT an interrupted one -- turn.ts:239-240 yields `citations` (so
    // `citationsRef.current` is routinely non-empty by then) and then `declined`, and returns
    // BEFORE ever inserting a chat_messages row at all. Flushing that into `turns` would invent
    // a phantom turn with no row behind it. `declined` and `error` both also end the stream
    // without `done`, so this flag is what tells the settle step apart from a genuine mid-answer
    // interruption.
    let declined = false;

    // Called once, after the stream has ended one way or another (loop exhausted, or the read
    // itself threw) without a `done` event. Decides between the two things a dead stream can
    // mean: something was already produced and belongs in the transcript as an interrupted turn
    // (the turn's own "interrupted" marker then carries the explanation, so a separate hint
    // would be redundant), or nothing was produced yet and the hint is the ONLY thing telling the
    // user their note is still safe. `declined` never reaches here with a message to show -- its
    // own branch above already set one, and it must not be overwritten.
    const settleWithoutDone = () => {
      if (sawDone || declined) return;
      if (answerRef.current !== "" || citationsRef.current.length > 0 || webRef.current) {
        flushLiveIntoTurns(`local-${Date.now()}`, true);
      } else {
        setStatus("Saved. No answer right now.");
      }
    };

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          noteId: note.id,
          // Read per turn rather than captured once: it costs nothing and it is correct across
          // a DST change or a flight. The server validates it (resolveTimeZone) -- this value
          // comes from the browser, and the browser is not trusted input.
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      mark(`fetch headers received (status ${res.status})`);
      if (!res.ok || !res.body) {
        setStatus("Saved. No answer right now.");
        return;
      }
      let sawFirstToken = false;
      for await (const ev of readEvents(res.body)) {
        if (ev.type === "attached") { mark("event: attached"); setAttached(ev.data as unknown as Attached); }
        else if (ev.type === "citations") {
          mark("event: citations");
          const cs = (ev.data as unknown as { citations: Citation[] }).citations;
          citationsRef.current = cs;
          setCitations(cs);
        } else if (ev.type === "token") {
          // First token only -- one line per streamed chunk would flood the console on a long
          // answer and bury the milestone that actually matters (how long the silence was).
          if (!sawFirstToken) { sawFirstToken = true; mark("event: first token"); }
          const chunk = String((ev.data as { text?: unknown }).text ?? "");
          answerRef.current += chunk;
          setAnswer((a) => a + chunk);
        } else if (ev.type === "web") {
          mark("event: web");
          const d = ev.data as { sources?: unknown; queries?: unknown; entryPoint?: unknown };
          const w: Web = {
            sources: (Array.isArray(d.sources) ? d.sources : []) as WebCitation[],
            queries: (Array.isArray(d.queries) ? d.queries : []) as string[],
            ...(typeof d.entryPoint === "string" ? { entryPoint: d.entryPoint } : {}),
          };
          webRef.current = w;
          setWeb(w);
        } else if (ev.type === "offer") {
          mark("event: offer");
          const d = ev.data as { statement?: unknown; sourceUrl?: unknown };
          if (typeof d.statement === "string" && d.statement !== "") {
            setOffer({
              statement: d.statement,
              ...(typeof d.sourceUrl === "string" ? { sourceUrl: d.sourceUrl } : {}),
            });
          }
        } else if (ev.type === "declined") {
          mark("event: declined");
          declined = true;
          setStatus("Saved. No answer right now (spending limit).");
        }
        // "error" is intentionally NOT handled here. It always means the stream will end without
        // a `done` -- but whether that deserves a status hint or an interrupted transcript row
        // depends on whether anything was produced before it, which is only knowable once the
        // stream has actually finished. settleWithoutDone(), below, makes that call once.
        else if (ev.type === "done") {
          mark("event: done");
          sawDone = true;
          const d = ev.data as { messageId?: unknown };
          flushLiveIntoTurns(
            typeof d.messageId === "string" && d.messageId !== "" ? d.messageId : `local-${Date.now()}`,
            false,
          );
        }
      }

      mark("stream loop exited");
      settleWithoutDone();
    } catch {
      // The note was already saved above -- only the stream failed (the read itself threw,
      // rather than the server sending an orderly "error" event). Same rule: keep whatever was
      // accumulated before the connection died, marked incomplete, or fall back to the hint if
      // nothing was ever produced. `declined` can't be true here (its branch never throws), but
      // settleWithoutDone() checks it anyway rather than this call site relying on that.
      mark("stream threw");
      settleWithoutDone();
    } finally {
      setBusy(false);
      mark("submit finished");
    }
  }

  // Cleared immediately -- optimistic, same as the rest of this box's saves. A failed write
  // here costs the user one skipped note, not their answer or their transcript, so there is
  // nothing worth rolling the UI back to.
  async function acceptOffer(o: Offer) {
    setOffer(null);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/notes/save-answer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          statement: o.statement,
          ...(o.sourceUrl !== undefined ? { sourceUrl: o.sourceUrl } : {}),
        }),
      });
    } catch {
      // Best-effort: the offer is already off the screen, and re-showing it after a failed
      // save would be its own kind of nag. Nothing else to do here today.
    }
  }

  // §11: "declining costs nothing" -- a claim about LATENCY as much as about writes. setOffer(null)
  // runs FIRST, synchronously, and the fetch below is deliberately NOT awaited ahead of it: the
  // offer must be gone the instant the button is clicked, whether the network is slow, offline, or
  // the request fails outright. If the write never lands, the worst case is the same fact gets
  // offered again later -- fine, per §11 -- which is why the catch below does nothing at all.
  function declineOffer(o: Offer) {
    setOffer(null);
    void fetch(`${process.env.NEXT_PUBLIC_API_URL}/assistant/decline`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ statement: o.statement }),
    }).catch(() => {
      // Best-effort, same as acceptOffer: the offer is already off the screen.
    });
  }

  /**
   * Ask the server to condense a reply, then show it back for confirmation. Writes nothing.
   *
   * NEVER dead-ends: a null statement, a non-200, or a thrown fetch all fall through to the
   * verbatim reply. The user pressed a button and must get a box either way -- a silent no-op is
   * indistinguishable from a broken control.
   */
  async function proposeSave(forId: string, answerText: string, question?: string, sourceUrl?: string) {
    setProposal(null);
    setProposing(forId);
    let statement = answerText;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/assistant/distill`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ answer: answerText, ...(question ? { question } : {}) }),
      });
      if (res.ok) {
        const d = (await res.json()) as { statement: string | null };
        if (typeof d.statement === "string" && d.statement !== "") statement = d.statement;
      }
    } catch {
      // Fall through to the verbatim reply, deliberately silent: the box below IS the feedback.
    } finally {
      setProposing(null);
    }
    setProposal({ forId, statement, ...(sourceUrl !== undefined ? { sourceUrl } : {}) });
  }

  /**
   * The write. Same endpoint and same body shape the offer's accept uses, which is what makes the
   * two produce an identical row -- see save-answer.ts's buildSavedAnswerRow doc.
   *
   * Dismissing instead calls NOTHING. Not POST /assistant/decline: a decline records that the
   * ASSISTANT should stop offering a fact, and the user declining to keep an answer they asked
   * about is not that.
   */
  async function confirmSave(p: { statement: string; sourceUrl?: string }) {
    setProposal(null);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/notes/save-answer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          statement: p.statement,
          ...(p.sourceUrl !== undefined ? { sourceUrl: p.sourceUrl } : {}),
        }),
      });
    } catch {
      // Best-effort, same as acceptOffer: the box is already off screen.
    }
  }

  const hasReply =
    attached !== null || citations.length > 0 || web !== null || answer !== "" || status !== null;

  // Read once per render, not per row: Intl resolution is not free and the answer cannot change
  // between two rows of the same paint.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();

  return (
    <div className="chat-pane">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => { if (e.currentTarget.scrollTop < 80) void loadOlder(); }}
      >
        {more && (
          <p className="chat-older" role="status">
            {loadingOlder ? "Đang tải…" : "Cuộn lên để xem thêm"}
          </p>
        )}

        {turns.length === 0 && !hasReply && (
          <p className="chat-empty">What are you thinking?</p>
        )}

        {turns.map((t, i) => {
          const prev = i > 0 ? turns[i - 1] : undefined;
          const key = dayKey(t.createdAt, timeZone);
          // A separator before the FIRST row too (prev === undefined): the top of a loaded page
          // is a day boundary as far as the reader is concerned, and without it the oldest
          // visible day is the only undated one on screen.
          const showSeparator = key !== "" && (prev === undefined || dayKey(prev.createdAt, timeZone) !== key);
          return (
            <Fragment key={t.id}>
              {showSeparator && (
                <p className="day-separator" role="separator">
                  {daySeparatorLabel(t.createdAt, now, timeZone)}
                </p>
              )}
              {t.role === "user" ? (
                <div className="bubble user"><p>{t.content}</p></div>
              ) : (
                <div className="bubble assistant">
                  <Provenance citations={t.citations} />
                  {t.content && <div className="answer"><Markdown>{t.content}</Markdown></div>}
                  {t.incomplete && (
                    // An interrupted answer and a short answer are the same string in `content`.
                    // Only retrieval_meta.incomplete tells them apart, and the user is the one who
                    // needs to know -- the model is already shielded from it at turn.ts:134.
                    <p className="interrupted" role="note">Câu trả lời bị gián đoạn (interrupted).</p>
                  )}
                  {t.content && (
                    <button
                      type="button"
                      className="save-answer"
                      disabled={proposing === t.id}
                      onClick={() => void proposeSave(
                        t.id,
                        t.content,
                        turns[i - 1]?.role === "user" ? turns[i - 1]!.content : undefined,
                        webUrlOf(t.citations),
                      )}
                    >
                      {proposing === t.id ? "Đang rút gọn…" : "Lưu câu trả lời"}
                    </button>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}

        {hasReply && (
          <div className="bubble assistant">
            {/* attached and citations are separate pieces of state: the server emits them
                concurrently, and either can arrive first. */}
            {attached && (
              <p className="attached">
                {attached.domain ? `Filed under: ${attached.domain}` : "Not filed under a domain"}
                {attached.tags.length > 0 ? ` — tagged ${attached.tags.join(", ")}` : ""}
              </p>
            )}

            <Provenance
              citations={[...citations, ...(web?.sources ?? [])]}
              {...(web?.entryPoint !== undefined ? { entryPoint: web.entryPoint } : {})}
            />

            {answer && <div className="answer"><Markdown>{answer}</Markdown></div>}

            {answer && (
              <button
                type="button"
                className="save-answer"
                disabled={proposing === "live"}
                onClick={() => void proposeSave("live", answer, undefined, web?.sources[0]?.url)}
              >
                {proposing === "live" ? "Đang rút gọn…" : "Lưu câu trả lời"}
              </button>
            )}

            {!error && status && <p className="hint" role="status">{status}</p>}
          </div>
        )}

        {offer && (
          // One line, two buttons, easy to ignore (§11). Not a modal and not a blocking step:
          // an offer that interrupts is a nag, and a nag is what makes a user stop reading them.
          // Rendered OUTSIDE `hasReply`, deliberately: `hasReply` goes false the instant the
          // turn's live state is flushed into `turns` (done event), and the offer must still be
          // sitting on screen after that -- it is not part of the ephemeral reply, it is its own
          // standing prompt until the user acts on it.
          <div className="offer" role="group" aria-label="Lưu vào notes?">
            <p>{offer.statement}</p>
            <button type="button" onClick={() => void acceptOffer(offer)}>Lưu</button>
            <button type="button" onClick={() => void declineOffer(offer)}>Bỏ qua</button>
          </div>
        )}

        {proposal && (
          // Deliberately worded differently from the offer box above. Both can be on screen at
          // once, on the same reply, and they mean different things: the offer's statement was
          // chosen by the assistant, this one by the user. Two buttons both saying "Lưu" would be
          // a coin flip.
          <div className="save-proposal" role="group" aria-label="Lưu câu trả lời này?">
            <p>{proposal.statement}</p>
            <button type="button" onClick={() => void confirmSave(proposal)}>Lưu câu này</button>
            <button type="button" onClick={() => setProposal(null)}>Thôi</button>
          </div>
        )}

        {phase && (
          // aria-live="polite" and not "assertive": this is progress, and it must not interrupt
          // a screen reader mid-sentence on a label that changes twice a turn.
          <div className="bubble assistant thinking" role="status" aria-live="polite">
            <p>{phase}<span className="dots" aria-hidden="true" /></p>
          </div>
        )}
      </div>

      {error && (
        <p className="error chat-error" role="alert">
          {error} <button type="button" onClick={() => void submit()}>Retry</button>
        </p>
      )}

      {!online && (
        <p className="chat-offline" role="status">
          Mất mạng — chưa gửi được. Hội thoại cũ vẫn xem được.
        </p>
      )}

      <form
        className="chat-composer"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <textarea
          rows={1}
          value={text}
          placeholder="What are you thinking?"
          aria-label="What are you thinking?"
          disabled={busy || !online}
          onChange={(e) => {
            setText(e.target.value);
            // Reset before measuring: scrollHeight never shrinks on its own, so without the
            // first line the box grows and never comes back down after a delete.
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
          }}
          onKeyDown={(e) => {
            // Shift+Enter is a newline; the browser's default already does that, so the only
            // job here is to NOT intercept it. Cmd/Ctrl+Enter is kept as well -- it was the
            // only way to send until 2026-08-22 and muscle memory is cheap to honour.
            if (e.key !== "Enter") return;
            if (e.shiftKey) return;
            e.preventDefault();
            void submit();
          }}
        />
        <button type="submit" disabled={busy || !online}>Send</button>
      </form>
    </div>
  );
}
