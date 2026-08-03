"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import {
  applyNoteFilters, matchesFilters, noteSelect, requiresRefetch, type NoteFilters,
} from "@/lib/note-views";

export interface NoteRow {
  id: string; title: string | null; content: string;
  lifecycle: string; updated_at: string; deleted_at: string | null;
  domain?: string | null;
}

const preview = (n: NoteRow) => n.title?.trim() || n.content.split("\n")[0]?.trim() || "(empty note)";

export function NoteList({ initialNotes, filters, userId, token }: {
  initialNotes: NoteRow[]; filters: NoteFilters; userId: string; token: string;
}) {
  const [notes, setNotes] = useState<NoteRow[]>(initialNotes);
  const [busy, setBusy] = useState<string | null>(null);
  const { view, q, tag, domain } = filters;

  useEffect(() => { setNotes(initialNotes); }, [initialNotes]);

  const refetch = useCallback(async () => {
    // postgres_changes drops events while disconnected and does NOT replay them, so
    // refetch on every transition back to SUBSCRIBED -- not only on mount (spec §5.4).
    // applyNoteFilters is the SAME function page.tsx builds its SSR query with, so this
    // can no longer drop `q`/`tag` and silently replace 3 search results with the whole
    // inbox (issue-log E5).
    const supabase = createClient();
    const { data } = await applyNoteFilters(
      supabase.from("notes").select(noteSelect(filters)),
      filters,
    );
    // Double cast for the same reason as page.tsx: the conditional select string
    // defeats supabase-js's embedded-resource type parser.
    if (data) setNotes((data as unknown as NoteRow[]).filter((n) => matchesFilters(n, filters)));
  }, [filters]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notes-list-${view}-${domain ?? "all"}-${tag ?? ""}-${q ?? ""}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "notes", filter: `user_id=eq.${userId}` },
        (payload) => {
          // FTS and tag membership cannot be evaluated client-side, so while `q`/`tag`
          // narrow the list, patching rows in locally would re-admit non-matching notes.
          // Refetch instead -- correctness over the saved round-trip. requiresRefetch
          // names exactly the fields matchesFilters ignores, so the two cannot drift.
          if (requiresRefetch(filters)) {
            void refetch();
            return;
          }
          setNotes((prev) => {
            const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as NoteRow;
            const without = prev.filter((n) => n.id !== row.id); // dedupe by id -- own-write echo is a no-op
            if (payload.eventType !== "DELETE" && matchesFilters(row, filters)) {
              return [row, ...without].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
            }
            return without; // soft-deletes arrive as UPDATEs failing matchesFilters → drop (spec §5.4)
          });
        })
      .subscribe((status) => { if (status === "SUBSCRIBED") void refetch(); });
    return () => { void supabase.removeChannel(channel); };
  }, [userId, view, domain, q, tag, filters, refetch]);

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
