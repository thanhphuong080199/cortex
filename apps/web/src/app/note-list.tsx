"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
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

  // `filters` is an object prop, so `useCallback([filters])` rebuilds refetch on every render
  // where the parent recreated it -- which re-registers the Realtime effect below for a value
  // that did not change. NoteFilters is exactly these four fields
  // (packages/shared/src/notes/filters.ts:24-29), so this is the same object by value with a
  // stable identity.
  const stableFilters = useMemo(() => ({ view, q, tag, domain }), [view, q, tag, domain]);

  useEffect(() => { setNotes(initialNotes); }, [initialNotes]);

  const refetch = useCallback(async () => {
    // postgres_changes drops events while disconnected and does NOT replay them, so
    // refetch on every transition back to SUBSCRIBED -- not only on mount (spec §5.4).
    // applyNoteFilters is the SAME function page.tsx builds its SSR query with, so this
    // can no longer drop `q`/`tag` and silently replace 3 search results with the whole
    // inbox (issue-log E5).
    const supabase = createClient();
    const { data } = await applyNoteFilters(
      supabase.from("notes").select(noteSelect(stableFilters)),
      stableFilters,
    );
    // Double cast for the same reason as page.tsx: the conditional select string
    // defeats supabase-js's embedded-resource type parser.
    if (data) setNotes((data as unknown as NoteRow[]).filter((n) => matchesFilters(n, filters)));
  }, [stableFilters]);

  useEffect(() => {
    const supabase = createClient();
    // WITHOUT THIS, NO EVENT EVER ARRIVES -- and nothing looks wrong.
    //
    // Realtime evaluates postgres_changes filters against the role in the socket's JWT:
    // realtime.subscription_check_filters() builds its list of filterable columns from
    // has_column_privilege(claims->>'role', ...). createClient() returns a NEW browser client
    // that hydrates its session from cookies asynchronously, so subscribing straight away sends
    // no token and the role is `anon` -- which has SELECT on zero columns of public.notes
    // (00009 revoked the defaults, correctly). Zero columns means every filter is rejected:
    //
    //   ERROR P0001 (raise_exception) invalid column for filter user_id
    //
    // The message points at the column, which exists; the actual subject is the role. The
    // channel still replies `status: ok` and the rejection arrives afterwards as a separate
    // `system` frame, so the client reports a healthy subscription that silently receives
    // nothing -- reloads always showed correct data, which is why this survived so long.
    //
    // `token` is the server component's session token, passed down by page.tsx, so it is
    // already here and needs no await.
    supabase.realtime.setAuth(token);
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
  }, [userId, view, domain, q, tag, filters, refetch, token]);

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
