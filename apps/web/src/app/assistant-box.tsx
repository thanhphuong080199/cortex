"use client";
import { useEffect, useRef, useState } from "react";
import { readEvents, type AnyCitation, type Citation, type WebCitation } from "@cortex/shared";
import { api } from "@/lib/api";
import { Provenance } from "./provenance";
import { Markdown } from "./markdown";

type Attached = {
  domain: string | null;
  domainMeta: Record<string, unknown>;
  tags: string[];
  degraded?: boolean;
};

type Web = { sources: WebCitation[]; queries: string[]; entryPoint?: string };

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
}

/**
 * The one chat box (see memory: Cortex's UI target is a single ChatGPT-style thread, not
 * the domain forms). Past captures render as user bubbles above the composer; mood, media
 * and domain/tag are attached by the assistant itself rather than picked in this UI --
 * the sidebar's widgets exist only as accelerators, never as the primary path.
 */
export function AssistantBox(
  { token, initialTurns }: { token: string; initialTurns?: TranscriptTurn[] },
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
  const [online, setOnline] = useState(true);
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

  // Keeps the newest turn in view -- turns, the reply bubble, the loading indicator and errors
  // all land at the bottom of an ever-growing thread, exactly the case a chat UI has to
  // autoscroll for.
  useEffect(() => {
    // `scrollTop =` rather than `.scrollTo(...)`: it's a plain property every DOM
    // implementation (including jsdom, where this component's tests run) supports, with
    // no smooth-scroll API surface to be missing.
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, attached, citations, web, answer, status, error, phase]);

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
    }]);
    setText("");

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

  if (!online) {
    return <div className="banner" role="status">Offline — capture is disabled until the connection returns.</div>;
  }

  const hasReply =
    attached !== null || citations.length > 0 || web !== null || answer !== "" || status !== null;

  return (
    <div className="chat-pane">
      <div className="chat-scroll" ref={scrollRef}>
        {turns.length === 0 && !hasReply && (
          <p className="chat-empty">What are you thinking?</p>
        )}

        {turns.map((t) => (
          t.role === "user" ? (
            <div key={t.id} className="bubble user"><p>{t.content}</p></div>
          ) : (
            <div key={t.id} className="bubble assistant">
              <Provenance citations={t.citations} />
              {t.content && <div className="answer"><Markdown>{t.content}</Markdown></div>}
              {t.incomplete && (
                // An interrupted answer and a short answer are the same string in `content`.
                // Only retrieval_meta.incomplete tells them apart, and the user is the one who
                // needs to know -- the model is already shielded from it at turn.ts:134.
                <p className="interrupted" role="note">Câu trả lời bị gián đoạn (interrupted).</p>
              )}
            </div>
          )
        ))}

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

            {!error && status && <p className="hint" role="status">{status}</p>}
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

      <form
        className="chat-composer"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <textarea
          rows={1}
          value={text}
          placeholder="What are you thinking?"
          aria-label="What are you thinking?"
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit(); }}
        />
        <button type="submit" disabled={busy}>Send</button>
      </form>
    </div>
  );
}
