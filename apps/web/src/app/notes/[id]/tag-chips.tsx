"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

export interface TagRow { id: string; name: string }

export function TagChips({ token, noteId, initialTags }: {
  token: string; noteId: string; initialTags: TagRow[];
}) {
  const [attached, setAttached] = useState<TagRow[]>(initialTags);
  const [all, setAll] = useState<TagRow[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void createClient().from("tags").select("id, name").is("deleted_at", null)
      .then(({ data }) => setAll((data as TagRow[] | null) ?? []));
  }, []);

  async function add(name: string) {
    setError(null);
    try {
      const tag = await api.createTag(token, { name }) as TagRow; // find-or-create
      await api.attachTag(token, noteId, { tagId: tag.id });
      setAttached((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]));
      setAll((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]));
      setDraft("");
    } catch {
      setError(`Couldn't add “${name}”.`);
    }
  }

  async function remove(tagId: string) {
    setError(null);
    try {
      await api.detachTag(token, noteId, tagId);
      setAttached((prev) => prev.filter((t) => t.id !== tagId));
    } catch {
      setError("Couldn't remove that tag.");
    }
  }

  return (
    <>
      <div className="chips">
        {attached.map((t) => (
          <span className="chip" key={t.id}>
            <Link href={`/?tag=${t.id}`}>#{t.name}</Link>
            <button aria-label={`remove ${t.name}`} onClick={() => void remove(t.id)}>×</button>
          </span>
        ))}
        <input
          list="all-tags"
          type="text"
          value={draft}
          placeholder="+ tag"
          aria-label="Add a tag"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); if (draft.trim()) void add(draft.trim()); }
          }}
        />
        <datalist id="all-tags">
          {all.map((t) => <option key={t.id} value={t.name} />)}
        </datalist>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
