"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { matchesView, type NoteView } from "@/lib/note-views";

export interface NoteRow {
  id: string; title: string | null; content: string;
  lifecycle: string; updated_at: string; deleted_at: string | null;
}

const preview = (n: NoteRow) => n.title?.trim() || n.content.split("\n")[0]?.trim() || "(empty note)";

export function NoteList({ initialNotes, view, userId, token }: {
  initialNotes: NoteRow[]; view: NoteView; userId: string; token: string;
}) {
  const [notes, setNotes] = useState<NoteRow[]>(initialNotes);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { setNotes(initialNotes); }, [initialNotes]);

  const refetch = useCallback(async () => {
    // postgres_changes drops events while disconnected and does NOT replay them, so
    // refetch on every transition back to SUBSCRIBED -- not only on mount (spec §5.4).
    const supabase = createClient();
    let q = supabase.from("notes").select("*").order("updated_at", { ascending: false });
    q = view === "trash" ? q.not("deleted_at", "is", null) : q.is("deleted_at", null);
    const { data } = await q;
    if (data) setNotes((data as NoteRow[]).filter((n) => matchesView(n, view)));
  }, [view]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notes-list-${view}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "notes", filter: `user_id=eq.${userId}` },
        (payload) => {
          setNotes((prev) => {
            const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as NoteRow;
            const without = prev.filter((n) => n.id !== row.id); // dedupe by id -- own-write echo is a no-op
            if (payload.eventType !== "DELETE" && matchesView(row, view)) {
              return [row, ...without].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
            }
            return without; // soft-deletes arrive as UPDATEs failing matchesView → drop (spec §5.4)
          });
        })
      .subscribe((status) => { if (status === "SUBSCRIBED") void refetch(); });
    return () => { void supabase.removeChannel(channel); };
  }, [userId, view, refetch]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try {
      await fn();
      // The Realtime UPDATE/DELETE event removes the row; drop it now so the click
      // feels immediate even if the socket is slow.
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch {
      void refetch();
    } finally {
      setBusy(null);
    }
  }

  if (notes.length === 0) {
    return <p className="empty">{view === "trash" ? "Trash is empty." : "Nothing here yet."}</p>;
  }

  return (
    <ul className="notes">
      {notes.map((n) => (
        <li key={n.id}>
          {view === "trash"
            ? <span className="title">{preview(n)}</span>
            : <Link className="title" href={`/notes/${n.id}`}>{preview(n)}</Link>}
          <div className="meta">
            <time dateTime={n.updated_at}>{new Date(n.updated_at).toLocaleString()}</time>
            <span>{n.lifecycle}</span>
          </div>
          {view === "trash" && (
            <div className="row-actions">
              <button disabled={busy === n.id} onClick={() => void act(n.id, () => api.restoreNote(token, n.id))}>
                Restore
              </button>
              <button
                className="danger"
                disabled={busy === n.id}
                onClick={() => {
                  if (confirm("Permanently delete this note? This cannot be undone.")) {
                    void act(n.id, () => api.purgeNote(token, n.id));
                  }
                }}
              >
                Delete forever
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
