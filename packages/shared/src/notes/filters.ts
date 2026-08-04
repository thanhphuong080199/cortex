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

/** Any RFC 4122 version; the database generates v4, but rejecting a real id is the worse error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Narrows untrusted search params. Anything unrecognised is dropped, never passed on. */
export function parseNoteFilters(
  params: Record<string, string | string[] | undefined>,
): NoteFilters {
  const rawView = one(params.view);
  const view = (NOTE_VIEWS as readonly string[]).includes(rawView ?? "")
    ? (rawView as NoteView)
    : "inbox";

  const q = one(params.q)?.trim();
  // `tag` is validated as a uuid, not merely trimmed, because the two appliers disagree about
  // what a malformed one means and neither answer is acceptable. `note_tags.tag_id` is a uuid
  // (00003), so PostgREST answers `/?tag=abc` with 22P02 and the whole page renders its error
  // boundary, while SQLite compares a TEXT column and quietly returns nothing. Dropping it here
  // is what the docstring above already promises, and makes both show the unfiltered view.
  const rawTag = one(params.tag)?.trim();
  const tag = rawTag && UUID.test(rawTag) ? rawTag : undefined;
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
  // Guarded on the TRIMMED value so this agrees with noteFiltersToSql, which drops its clause
  // when the query escapes to nothing. Unguarded the two diverge on the same input: an empty
  // tsquery matches zero rows, while SQLite would show the whole view.
  if (f.q?.trim()) q = q.textSearch("content_text", f.q, { type: "websearch", config: "english" });
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

/**
 * Turns raw search input into an FTS5 query expression that cannot throw.
 *
 * FTS5 parses the string BOUND to `match` as a query language, not as literal text, so binding
 * the value prevents injection but not parsing. Executed against real SQLite
 * (apps/mobile/src/lib/fts.test.ts), ordinary typing raises:
 *
 *     don't          -> fts5: syntax error near "'"
 *     foo"           -> unterminated string
 *     hello AND      -> fts5: syntax error near ""
 *     !!!            -> fts5: syntax error near "!"
 *     content:hello  -> NO error; silently read as a column filter, returning other rows
 *
 * So typing an apostrophe broke search outright, and the search box re-runs this on every
 * keystroke. Postgres `websearch_to_tsquery` accepts every one of them, which makes this the
 * largest real divergence between the two engines.
 *
 * Each whitespace-separated token becomes a quoted string literal (`"` doubled to escape),
 * joined by FTS5's implicit AND. Operators lose their meaning -- `AND`, `OR` and `NEAR` become
 * words to search for, while `*`, `-` and `:` are punctuation the unicode61 tokenizer drops, so
 * `-hello` searches for `hello`. That is the right trade for a search box: `websearch_to_tsquery`
 * is forgiving rather than expressive too, and a user typing an apostrophe wants their note back,
 * not a syntax error.
 */
export function toFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}

/**
 * The same narrowing as a SQL WHERE clause, for mobile's local SQLite replica.
 *
 * Deliberately a SECOND implementation rather than an abstraction over both engines:
 * PostgREST and SQLite genuinely differ (imatch, to_tsvector ranking, RPCs), and a
 * translation layer for all of that is the rejected approach B in spec §2.2. The guard
 * against drift is filters-equivalence.test.ts, not a shared code path.
 *
 * Values are parameterised, never interpolated: a title or tag containing a quote must not
 * be able to reshape the clause.
 *
 * **Contract for the caller.** The clause is written against `notes n`, plus `note_tags nt`
 * when `join` is non-empty. If `q` is set it also reads a table
 *
 *     CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, content)
 *
 * and selects `id` from it -- NOT `rowid`. FTS5 rowids are integers while `notes.id` is a
 * TEXT uuid, so a rowid-based clause compiles, executes, and silently matches nothing. The
 * uuid has to be carried as its own UNINDEXED column, which is also the shape PowerSync's
 * FTS setup uses.
 */
export function noteFiltersToSql(f: NoteFilters): {
  where: string;
  params: unknown[];
  join: string;
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  clauses.push(f.view === "trash" ? "n.deleted_at is not null" : "n.deleted_at is null");
  if (f.view === "active") clauses.push(`n.lifecycle in (${p("active")}, ${p("evergreen")})`);
  else if (f.view !== "trash") clauses.push(`n.lifecycle = ${p(f.view)}`);

  if (f.domain) clauses.push(`n.domain = ${p(f.domain)}`);
  if (f.tag) clauses.push(`nt.tag_id = ${p(f.tag)} and nt.deleted_at is null`);

  // Full text uses SQLite FTS5, a different engine from Postgres FTS -- see the equivalence
  // suite, which asserts structural agreement and each engine's own q behaviour rather than
  // pretending the two rank identically.
  //
  // The bound value is the ESCAPED query -- see toFtsQuery. A q of nothing but whitespace
  // escapes to the empty string, and the clause is then left out rather than bound: `match ''`
  // is itself a syntax error, and "no search" is what parseNoteFilters already makes of an
  // empty q.
  const fts = f.q ? toFtsQuery(f.q) : "";
  if (fts) clauses.push(`n.id in (select id from notes_fts where notes_fts match ${p(fts)})`);

  return {
    where: clauses.join(" and "),
    params,
    join: f.tag ? "join note_tags nt on nt.note_id = n.id" : "",
  };
}

/**
 * SQLite uses positional `?`; the clause is emitted in the numbered `$n` form because
 * numbered placeholders survive being read, logged and reordered. Params are pushed in the
 * order their placeholders are emitted, so a positional rewrite is order-preserving.
 *
 * Both the equivalence suite and mobile's query go through this, so the two run
 * byte-identical SQL.
 */
export function toSqlitePlaceholders(where: string): string {
  return where.replace(/\$\d+/g, "?");
}
