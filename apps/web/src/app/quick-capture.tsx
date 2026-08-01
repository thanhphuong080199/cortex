"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function QuickCapture({ token }: { token: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
    if (!text.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.createNote(token, { content: text });
      // Cleared ONLY on success -- a capture box must never lose a thought.
      // No optimistic insert: the Realtime echo adds the row and dedupes by id (spec §5.2).
      setText("");
    } catch {
      setError("Couldn't save — your text is still here.");
    } finally {
      setSaving(false);
    }
  }

  if (!online) {
    return <div className="banner" role="status">Offline — capture is disabled until the connection returns.</div>;
  }

  return (
    <div className="capture">
      <textarea
        rows={3}
        value={text}
        placeholder="quick thought…"
        aria-label="Quick capture"
        disabled={saving}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit(); }}
      />
      {error
        ? <p className="error" role="alert">{error} <button onClick={() => void submit()}>Retry</button></p>
        : <p className="hint">{saving ? "Saving…" : "⌘/Ctrl + Enter to capture"}</p>}
    </div>
  );
}
