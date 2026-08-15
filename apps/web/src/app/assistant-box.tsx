"use client";
import { useEffect, useState } from "react";
import type { Citation } from "@cortex/shared";
import { api } from "@/lib/api";

type Attached = {
  domain: string | null;
  domainMeta: Record<string, unknown>;
  tags: string[];
  degraded?: boolean;
};

/**
 * Reads an SSE body. Holds the tail: a network chunk can end mid-event, and parsing half a
 * JSON object throws. Same rule the server-side reader in gemini.ts follows.
 */
async function* readEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parse = (raw: string) => {
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

export function AssistantBox({ token }: { token: string }) {
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

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

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

    // Cleared only after createNote resolves -- a capture box never loses a thought.
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

  return (
    <div className="assistant-box">
      <textarea
        rows={3}
        value={text}
        placeholder="What are you thinking?"
        aria-label="What are you thinking?"
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit(); }}
      />
      <button type="button" disabled={busy} onClick={() => void submit()}>Send</button>

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

      {error ? (
        <p className="error" role="alert">
          {error} <button type="button" onClick={() => void submit()}>Retry</button>
        </p>
      ) : (
        status && <p className="hint" role="status">{status}</p>
      )}
    </div>
  );
}
