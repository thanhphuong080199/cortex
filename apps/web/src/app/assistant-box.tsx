"use client";
import { useEffect, useRef, useState } from "react";
import { readEvents, type Citation } from "@cortex/shared";
import { api } from "@/lib/api";

type Attached = {
  domain: string | null;
  domainMeta: Record<string, unknown>;
  tags: string[];
  degraded?: boolean;
};

type Message = { id: string; content: string };

/**
 * The one chat box (see memory: Cortex's UI target is a single ChatGPT-style thread, not
 * the domain forms). Past captures render as user bubbles above the composer; mood, media
 * and domain/tag are attached by the assistant itself rather than picked in this UI --
 * the sidebar's widgets exist only as accelerators, never as the primary path.
 */
export function AssistantBox({ token, initialMessages }: { token: string; initialMessages?: Message[] }) {
  const [messages, setMessages] = useState<Message[]>(initialMessages ?? []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Separate from `status`: `status` covers outcomes AFTER the note is saved (a dead stream,
  // a budget decline). `error` covers the save itself failing -- nothing was written, so it
  // reads differently ("Couldn't save") and, unlike `status`, the text must not be cleared.
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<Attached | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [answer, setAnswer] = useState("");
  const [online, setOnline] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  // Keeps the newest turn in view -- messages, the reply bubble and errors all land at the
  // bottom of an ever-growing thread, exactly the case a chat UI has to autoscroll for.
  useEffect(() => {
    // `scrollTop =` rather than `.scrollTo(...)`: it's a plain property every DOM
    // implementation (including jsdom, where this component's tests run) supports, with
    // no smooth-scroll API surface to be missing.
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, attached, citations, answer, status, error]);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    setAttached(null);
    setCitations([]);
    setAnswer("");

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

    // Appended only after createNote resolves -- a capture box never loses a thought, and
    // never shows a bubble for a message that was never actually saved.
    setMessages((prev) => [...prev, { id: note.id, content: text }]);
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
          setCitations((ev.data as unknown as { citations: Citation[] }).citations);
        } else if (ev.type === "token") {
          setAnswer((a) => a + String((ev.data as { text?: unknown }).text ?? ""));
        } else if (ev.type === "declined") setStatus("Saved. No answer right now (spending limit).");
        else if (ev.type === "error") setStatus("Saved. No answer right now.");
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

  const hasReply = attached !== null || citations.length > 0 || answer !== "" || status !== null;

  return (
    <div className="chat-pane">
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !hasReply && (
          <p className="chat-empty">What are you thinking?</p>
        )}

        {messages.map((m) => (
          <div key={m.id} className="bubble user"><p>{m.content}</p></div>
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

            {citations.length > 0 && (
              <ul className="citations">
                {citations.map((c) => (
                  <li key={c.noteId}>{c.title ?? "Untitled"}</li>
                ))}
              </ul>
            )}

            {answer && <p className="answer">{answer}</p>}

            {!error && status && <p className="hint" role="status">{status}</p>}
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
