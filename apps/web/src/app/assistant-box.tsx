"use client";
import { useEffect, useRef, useState } from "react";
import { readEvents, type AnyCitation, type Citation, type WebCitation } from "@cortex/shared";
import { api } from "@/lib/api";
import { Provenance } from "./provenance";

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

    let note: { id: string };
    try {
      // FIRST, and awaited, in its OWN try/catch. The note is the deliverable; the answer is
      // a bonus. Nothing was saved if this throws, so it returns before ever touching `text`
      // or the SSE fetch -- the retry button below just resubmits what's still in state.
      note = await api.createNote(token, { content: text });
    } catch {
      setError("Couldn't save — your text is still here.");
      setBusy(false);
      return;
    }

    // Appended only after createNote resolves -- a capture box never loses a thought, and never
    // shows a bubble for a message that was never actually saved. The server writes the real
    // chat_messages row inside runTurn; this is the optimistic twin of it, and a reload replaces
    // it with the persisted one.
    setTurns((prev) => [...prev, {
      id: note.id, role: "user", content: text, citations: [], incomplete: false,
    }]);
    setText("");

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ noteId: note.id }),
      });
      if (!res.ok || !res.body) {
        setStatus("Saved. No answer right now.");
        return;
      }
      for await (const ev of readEvents(res.body)) {
        if (ev.type === "attached") setAttached(ev.data as unknown as Attached);
        else if (ev.type === "citations") {
          const cs = (ev.data as unknown as { citations: Citation[] }).citations;
          citationsRef.current = cs;
          setCitations(cs);
        } else if (ev.type === "token") {
          const chunk = String((ev.data as { text?: unknown }).text ?? "");
          answerRef.current += chunk;
          setAnswer((a) => a + chunk);
        } else if (ev.type === "web") {
          const d = ev.data as { sources?: unknown; queries?: unknown; entryPoint?: unknown };
          const w: Web = {
            sources: (Array.isArray(d.sources) ? d.sources : []) as WebCitation[],
            queries: (Array.isArray(d.queries) ? d.queries : []) as string[],
            ...(typeof d.entryPoint === "string" ? { entryPoint: d.entryPoint } : {}),
          };
          webRef.current = w;
          setWeb(w);
        } else if (ev.type === "declined") setStatus("Saved. No answer right now (spending limit).");
        else if (ev.type === "error") setStatus("Saved. No answer right now.");
        else if (ev.type === "done") {
          // THE HAND-OFF. The turn is in the database now, so the transcript owns it and the
          // live state is cleared in the same update. Without this the last turn renders twice
          // -- once from `answer` and once from the row it was just appended to.
          //
          // Reads the *Ref mirrors, not the `citations`/`web` state directly: this event loop is
          // one long-lived async function whose closure captured those at call time, so the state
          // variables here are always their pre-turn values (usually empty) -- same stale-closure
          // trap `answerRef` exists for.
          const d = ev.data as { messageId?: unknown };
          setTurns((prev) => [...prev, {
            id: typeof d.messageId === "string" && d.messageId !== "" ? d.messageId : `local-${Date.now()}`,
            role: "assistant",
            content: answerRef.current,
            citations: [...citationsRef.current, ...(webRef.current?.sources ?? [])],
            incomplete: false,
          }]);
          setAnswer("");
          setCitations([]);
          setWeb(null);
        }
      }
    } catch {
      // The note was already saved above -- only the stream failed. Never say it was lost.
      setStatus("Saved. No answer right now.");
    } finally {
      setBusy(false);
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
              {t.content && <p className="answer">{t.content}</p>}
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

            {answer && <p className="answer">{answer}</p>}

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
