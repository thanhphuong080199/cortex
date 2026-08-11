"use client";

import { useState } from "react";
import Link from "next/link";
import type { SearchResult } from "@/lib/api";

const WHY: Record<string, string> = {
  vector: "by meaning",
  fts: "by wording",
  both: "by meaning and wording",
};

export function SearchForm({ onSearch }: { onSearch: (q: string) => Promise<SearchResult[]> }) {
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get("q");
    if (typeof q !== "string" || q.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      setResults(await onSearch(q.trim()));
    } catch {
      // Never render a failure as an empty result: "nothing matched" and "the request failed"
      // are different facts, and conflating them makes a broken search look like an empty
      // corpus.
      setError("Search failed. Try again.");
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* Submit-driven, never search-as-you-type: each query costs an embedding call. */}
      <form className="search" role="search" onSubmit={submit}>
        <input type="search" name="q" placeholder="Search your notes by meaning…" aria-label="Search notes" />
        <button type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      {results !== null && results.length === 0 && !error && <p className="empty">No notes matched.</p>}

      <ul className="notes">
        {(results ?? []).map((r) => (
          <li key={r.noteId}>
            <Link className="title" href={`/notes/${r.noteId}`}>{r.title ?? "Untitled"}</Link>
            <p>{r.snippet}</p>
            <div className="meta">
              <small>{WHY[r.matchedBy] ?? r.matchedBy}</small>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
