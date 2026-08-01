"use client";
import { useEffect, useState } from "react";
import { mediaKind, type LogMediaInput } from "@cortex/shared";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

interface MediaItemOption { title: string }

const STATUSES: { value: NonNullable<LogMediaInput["status"]>; label: string }[] = [
  { value: "finished", label: "finished" },
  { value: "in_progress", label: "in progress" },
  { value: "abandoned", label: "abandoned" },
];

/**
 * The item is an entity, the log is a note (spec §2.2). Find-or-create runs server-side,
 * so this form just sends the typed title -- matching an autocomplete entry or not -- and
 * never has to decide whether it is looking at a new item or a rewatch.
 *
 * The impression stays a freeform textarea on purpose: it is the part that later links to
 * ideas, so it must not be reduced to a rating.
 */
export function MediaLogForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [kind, setKind] = useState<LogMediaInput["kind"]>("movie");
  const [title, setTitle] = useState("");
  const [rating, setRating] = useState<number | undefined>();
  const [status, setStatus] = useState<NonNullable<LogMediaInput["status"]>>("finished");
  const [impression, setImpression] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState<MediaItemOption[]>([]);
  const [itemsFailed, setItemsFailed] = useState(false);

  useEffect(() => {
    // Reads go straight to Supabase under RLS; only the write goes through the API.
    // Narrowed server-side (kind + limit) so this stays cheap as the library grows;
    // the same title in two kinds is two different items, so cross-kind rows are noise.
    let stale = false;
    void createClient().from("media_items").select("title")
      .eq("kind", kind).is("deleted_at", null)
      .order("title").limit(200)
      .then(({ data, error: fetchError }) => {
        if (stale) return;
        setItemsFailed(fetchError !== null);
        setItems((data as MediaItemOption[] | null) ?? []);
      });
    return () => { stale = true; };
  }, [kind]);

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.logMedia(token, {
        kind, title, status,
        ...(rating ? { rating } : {}),
        ...(impression.trim() ? { impression } : {}),
      });
      onDone();   // the note arrives in the list via Realtime -- no manual insert
    } catch {
      // Same never-lose-input rule as QuickCapture: nothing is cleared on failure.
      setError("Couldn't save — everything you typed is still here.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="media-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="media-row">
        <select value={kind} aria-label="Media kind" disabled={saving}
                onChange={(e) => setKind(e.target.value as LogMediaInput["kind"])}>
          {mediaKind.options.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input type="text" list="media-titles" required value={title} placeholder="title"
               aria-label="Title" disabled={saving} maxLength={500}
               onChange={(e) => setTitle(e.target.value)} />
        <datalist id="media-titles">
          {items.map((i) => <option key={i.title} value={i.title} />)}
        </datalist>
      </div>

      <div className="media-row">
        {/* Single-select semantics: radios, not toggle buttons -- with aria-pressed the
            filled-but-unpressed stars 1..(n-1) contradicted what a sighted user sees. */}
        <div role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button type="button" key={n} className="star" disabled={saving}
                    role="radio" aria-checked={rating === n}
                    aria-label={`${n} star${n > 1 ? "s" : ""}`}
                    onClick={() => setRating(rating === n ? undefined : n)}>
              {n <= (rating ?? 0) ? "★" : "☆"}
            </button>
          ))}
        </div>
        <select value={status} aria-label="Status" disabled={saving}
                onChange={(e) => setStatus(e.target.value as NonNullable<LogMediaInput["status"]>)}>
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button type="submit" disabled={saving || !title.trim()}>{saving ? "Logging…" : "Log"}</button>
      </div>

      <textarea rows={3} value={impression} placeholder="impressions…" aria-label="Impressions"
                disabled={saving} onChange={(e) => setImpression(e.target.value)} />
      {itemsFailed && <p className="hint">Couldn&apos;t load your library for autocomplete — logging still works.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
