import { noteDomain } from "../enums.js";

/**
 * THE description of a note-list narrowing (phase 1b spec §3).
 *
 * It existed twice before this -- once in the web SSR query and once in the Realtime
 * refetch -- and the two disagreeing is issue-log E5: the refetch dropped q and tag, so
 * `/?q=...` rendered three search results and then silently replaced them with the whole
 * inbox. Mobile would have been a third copy.
 *
 * One parser, one supabase-js applier used by BOTH web call sites, one predicate for
 * live-patched rows, and (in noteFiltersToSql) one SQLite translation.
 *
 * This lives in @cortex/shared rather than @cortex/core deliberately. Its consumers are a
 * "use client" React component and a React Native app, and @cortex/core's barrel reaches
 * `archiver` through the export service -- core declares no `sideEffects: false`, so a
 * bundler must keep that graph and would drag Node builtins into both. Nothing here needs
 * more than the domain enum, so the dependency-free package is the right home. Core
 * re-exports it for server-side consumers.
 */
export type NoteView = "inbox" | "active" | "archived" | "trash";
export const NOTE_VIEWS: readonly NoteView[] = ["inbox", "active", "archived", "trash"];

export interface NoteFilters {
  view: NoteView;
  q?: string;
  tag?: string;
  domain?: string;
}

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/** Narrows untrusted search params. Anything unrecognised is dropped, never passed on. */
export function parseNoteFilters(
  params: Record<string, string | string[] | undefined>,
): NoteFilters {
  const rawView = one(params.view);
  const view = (NOTE_VIEWS as readonly string[]).includes(rawView ?? "")
    ? (rawView as NoteView)
    : "inbox";

  const q = one(params.q)?.trim();
  const tag = one(params.tag)?.trim();
  const rawDomain = one(params.domain);
  const domain = (noteDomain.options as readonly string[]).includes(rawDomain ?? "")
    ? rawDomain
    : undefined;

  // Spread-if rather than assigning undefined: these round-trip through a URLSearchParams
  // in the web nav helpers, where a present-but-undefined key becomes an empty `?q=`.
  return {
    view,
    ...(q ? { q } : {}),
    ...(tag ? { tag } : {}),
    ...(domain ? { domain } : {}),
  };
}

/** The `.select()` string: the note_tags join exists only when a tag filter needs it. */
export function noteSelect(f: NoteFilters): string {
  return f.tag ? "*, note_tags!inner(tag_id, deleted_at)" : "*";
}

/**
 * Applies every narrowing to a supabase-js query builder. Used by web SSR and by the
 * Realtime refetch -- the same function, so they cannot disagree again.
 */
export function applyNoteFilters<T>(query: T, f: NoteFilters): T {
  // The builder is chainable and each method returns the same type; typing it structurally
  // avoids importing supabase-js's internal generics into every call site -- and keeps this
  // package free of a supabase-js dependency it would otherwise need only for a type.
  let q = query as unknown as {
    is: (c: string, v: null) => typeof q;
    not: (c: string, op: string, v: null) => typeof q;
    in: (c: string, v: string[]) => typeof q;
    eq: (c: string, v: string) => typeof q;
    order: (c: string, o: { ascending: boolean }) => typeof q;
    textSearch: (c: string, v: string, o: Record<string, string>) => typeof q;
  };

  q = q.order("updated_at", { ascending: false });
  q = f.view === "trash" ? q.not("deleted_at", "is", null) : q.is("deleted_at", null);
  // One view over two lifecycle states: `active` and `evergreen` are both live working
  // notes. Trash spans every lifecycle, so it narrows on deleted_at alone.
  if (f.view === "active") q = q.in("lifecycle", ["active", "evergreen"]);
  else if (f.view !== "trash") q = q.eq("lifecycle", f.view);

  // The `config` is load-bearing, not cosmetic. With it, PostgREST emits
  //   to_tsvector('english', content_text) @@ websearch_to_tsquery('english', q)
  // which matches notes_fts_idx. Drop it and PostgREST emits the bare form, which
  // resolves to the default-config operator, matches no index, and silently seq-scans.
  if (f.q) q = q.textSearch("content_text", f.q, { type: "websearch", config: "english" });
  if (f.tag) q = q.eq("note_tags.tag_id", f.tag).is("note_tags.deleted_at", null);
  // Backed by notes_user_domain_idx. matchesFilters applies the same narrowing to
  // Realtime rows, so a live-patched note can never disagree with what a reload shows.
  if (f.domain) q = q.eq("domain", f.domain);

  return q as unknown as T;
}

/**
 * The same narrowing as a predicate, for rows arriving over Realtime. `q` and `tag` are
 * absent here on purpose: FTS ranking and tag membership cannot be evaluated client-side,
 * so a caller with either refetches instead of patching locally -- see requiresRefetch.
 *
 * `domain` narrows, it never overrides: a trashed health note is still only in trash.
 * `note.domain` is optional in the type because Realtime hands back whatever the row
 * shape is, and an undomained note simply has null there.
 */
export function matchesFilters(
  note: { lifecycle: string; deleted_at: string | null; domain?: string | null },
  f: NoteFilters,
): boolean {
  if (f.domain && note.domain !== f.domain) return false;
  if (f.view === "trash") return note.deleted_at !== null;
  if (note.deleted_at !== null) return false;
  if (f.view === "active") return note.lifecycle === "active" || note.lifecycle === "evergreen";
  return note.lifecycle === f.view;
}

/**
 * True when live-patching a Realtime row would be wrong and a refetch is required.
 *
 * These are exactly the two fields matchesFilters ignores. Patching a row in under either
 * one re-admits notes the query excluded, which is the half of E5 that survived the first
 * fix -- so the pairing is deliberate, not incidental.
 */
export function requiresRefetch(f: NoteFilters): boolean {
  return Boolean(f.q || f.tag);
}
