"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { createDebouncedSaver, type SaveStatus } from "@/lib/use-debounced-save";
import { TagChips, type TagRow } from "./tag-chips";

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: "", saving: "Saving…", saved: "Saved", error: "Save failed — retry",
};

export function Editor({ token, note, initialTags }: {
  token: string;
  note: { id: string; title: string | null; content: string; lifecycle: string };
  initialTags: TagRow[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(note.title ?? "");
  const [content, setContent] = useState(note.content);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [busy, setBusy] = useState(false);

  const saver = useMemo(
    () => createDebouncedSaver(
      (patch) => api.updateNote(token, note.id, patch).then(() => undefined),
      800,
      setStatus,
    ),
    [token, note.id],
  );

  // Keep the latest saver in a ref so the unmount/beforeunload flush below never
  // captures a stale one.
  const saverRef = useRef(saver);
  saverRef.current = saver;

  useEffect(() => {
    const flush = () => { void saverRef.current.flush(); };
    window.addEventListener("beforeunload", flush);
    return () => { window.removeEventListener("beforeunload", flush); flush(); };
  }, []);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await saver.flush(); // don't lose in-flight edits when leaving the page
      await fn();
      router.push("/");
      router.refresh();
    } catch {
      setStatus("error");
      setBusy(false);
    }
  }

  return (
    <>
      <input
        type="text"
        value={title}
        placeholder="Title (optional)"
        aria-label="Title"
        onChange={(e) => { setTitle(e.target.value); saver.queue({ title: e.target.value || null }); }}
        onBlur={() => void saver.flush()}
      />

      <div className="editor-bar">
        <span className={status === "error" ? "status err" : "status"} role="status">
          {STATUS_TEXT[status]}
        </span>
        {status === "error" && <button onClick={() => void saver.flush()}>Retry</button>}
        <span style={{ flex: 1 }} />
        {note.lifecycle !== "archived" && (
          <button disabled={busy} onClick={() => void act(() => api.updateNote(token, note.id, { lifecycle: "archived" }))}>
            Archive
          </button>
        )}
        <button className="danger" disabled={busy} onClick={() => void act(() => api.deleteNote(token, note.id))}>
          Move to trash
        </button>
      </div>

      <textarea
        rows={18}
        value={content}
        placeholder="Write…"
        aria-label="Note content"
        onChange={(e) => { setContent(e.target.value); saver.queue({ content: e.target.value }); }}
        onBlur={() => void saver.flush()}
      />

      <TagChips token={token} noteId={note.id} initialTags={initialTags} />
    </>
  );
}
