import { toFtsQuery } from "@cortex/shared";

export interface OfflineMatch {
  id: string;
  snippet: string;
}

/** Anything that can run a parameterised read -- PowerSync's db, or SQLite in a test. */
export interface FtsReadTarget {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Three is what the box can show without turning an answer into a list. */
export const OFFLINE_MATCH_LIMIT = 3;

/**
 * `snippet(notes_fts, 1, ...)`: column 1 is `content`. Column 0 is the UNINDEXED uuid, and
 * asking FTS5 to snippet an unindexed column returns an empty string with no error.
 */
const SEARCH_SQL = `SELECT id, snippet(notes_fts, 1, '', '', '…', 12) AS snippet
     FROM notes_fts WHERE notes_fts MATCH ? LIMIT ${OFFLINE_MATCH_LIMIT}`;

/**
 * The offline half of a turn (spec §4): no AI, no cost, no request queued to fire later.
 *
 * Also the fallback for every ONLINE failure -- a fetch that throws, a non-2xx, a stream that
 * dies before the first token. An offline-shaped answer beats an error message, because the
 * local index is there either way.
 *
 * `toFtsQuery` is reused rather than reimplemented. FTS5 parses the string bound to `MATCH` as
 * a query language, so binding prevents injection but not parsing: an apostrophe, a stray
 * quote, a trailing `AND` each raise a syntax error, and people type all three. See the
 * helper's own docstring for the full list.
 */
export async function offlineAnswer(db: FtsReadTarget, text: string): Promise<OfflineMatch[]> {
  const query = toFtsQuery(text);
  // `match ''` is a syntax error in its own right, so an input of nothing but whitespace or
  // punctuation must cost no query at all -- not a query that happens to return nothing.
  if (!query) return [];
  return db.getAll<OfflineMatch>(SEARCH_SQL, [query]);
}
