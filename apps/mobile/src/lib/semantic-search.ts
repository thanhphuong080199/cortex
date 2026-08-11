import { searchInput, type SearchResult } from "@cortex/shared";

/**
 * The shape POST /search returns, from @cortex/shared rather than hand-copied here -- three
 * independent copies of a response type all typecheck happily while disagreeing with the server.
 *
 * Aliased rather than used under its own name because on THIS screen the distinction that
 * matters is semantic (server, online, costs an embedding call) versus the local FTS5 rows the
 * list always shows; `SemanticResult` is the vocabulary note-list.tsx is written in. The alias
 * is a rename of one declaration, not a second one -- a field renamed in shared changes this
 * type too.
 */
export type SemanticResult = SearchResult;

export class OfflineError extends Error {
  override name = "OfflineError";
}

/**
 * The request was never made because the input could not be valid. Distinct from OfflineError
 * (the request could not be made) and from the generic `search failed (400)` a rejected request
 * produces -- all three are things the user must be told apart.
 */
export class SearchInputError extends Error {
  override name = "SearchInputError";
}

/**
 * Validates against the SAME schema the API validates with (`searchInput`, packages/shared),
 * before the request leaves the device -- exactly what apps/web/src/lib/api.ts's `validated()`
 * does for the browser, and what this file was missing.
 *
 * Without it an over-long query (500 chars is the schema's cap; paste an article into the search
 * box and Android will happily hand over 800) reaches the server, fails validation there, and
 * comes back as `search failed (400)`. The screen renders that verbatim, so a VALIDATION problem
 * arrives wearing a REQUEST FAILURE's clothes -- the user is told the search broke when in fact
 * their query was simply too long, and there is nothing in the message to act on. That
 * conflation is the exact one the web round removed, and it survived one task longer here.
 *
 * The `q` cap is not restated as a local constant: the number below is read off the schema's own
 * issue, so raising the server's limit cannot leave this message quoting a stale one.
 */
function validate(args: { q: string; limit?: number }): void {
  const parsed = searchInput.safeParse(
    args.limit !== undefined ? { q: args.q, limit: args.limit } : { q: args.q },
  );
  if (parsed.success) return;

  const tooLong = parsed.error.issues.find(
    (i): i is Extract<typeof i, { code: "too_big" }> => i.code === "too_big" && i.path[0] === "q",
  );
  if (tooLong) {
    throw new SearchInputError(
      `That search is too long — ${String(tooLong.maximum)} characters max, ` +
        `this one is ${args.q.trim().length}.`,
    );
  }
  // Anything else here (an empty query, a non-positive `limit`) is a caller bug rather than
  // something the user typed, so it names the offending field for a developer instead of
  // pretending to be user-facing copy. It still must not be silently dropped: passing a bad
  // `limit` through would turn it into a successful search over the default 20.
  const first = parsed.error.issues[0];
  throw new SearchInputError(
    `Search input is not valid: ${first ? `${first.path.join(".") || "input"} — ${first.message}` : "unknown"}`,
  );
}

export const SEARCH_OFFLINE_MESSAGE = "Semantic search needs a connection — showing local results";

/**
 * `semanticSearch` only raises OfflineError for its own fetch. The screen's flow reaches the
 * network once before that, in `supabase.auth.getSession()`, which goes out to refresh an expired
 * token and -- offline -- rejects with the platform's raw fetch message instead. That is the same
 * situation from the user's side, so it gets the same copy rather than "Network request failed".
 */
const NETWORK_FAILURE = /network request failed|failed to fetch|network error|ERR_NETWORK/i;

/**
 * The offline-vs-everything-else mapping, out here rather than inline in the screen so it is
 * directly testable: it is the one half of the offline contract that is a decision rather than
 * rendering, and a `.tsx` is the one place this app cannot put a test on.
 */
export function describeSearchFailure(err: unknown): string {
  if (err instanceof OfflineError) return SEARCH_OFFLINE_MESSAGE;
  if (err instanceof Error) {
    return NETWORK_FAILURE.test(err.message) ? SEARCH_OFFLINE_MESSAGE : err.message;
  }
  return "Search failed. Try again.";
}

/**
 * The ONLY online-dependent read on this device. The local FTS5 index (phase 1b Task 19) stays
 * the instant, offline path, and this is an explicit action on top of it.
 *
 * fetchFn is injected so the test needs no network and no RN mock -- the same reason capture.ts
 * exists rather than logic living in the screen.
 */
export async function semanticSearch(args: {
  q: string;
  token: string;
  apiUrl: string;
  limit?: number;
  fetchFn?: typeof fetch;
}): Promise<SemanticResult[]> {
  // Before `doFetch` is even chosen: a query that cannot be valid must cost no request at all.
  validate(args);

  const doFetch = args.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${args.apiUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${args.token}` },
      // `!== undefined`, not truthiness: `limit: 0` is rejected by the shared DTO, and dropping
      // it here would quietly turn a caller's bad input into a successful default-20 search.
      body: JSON.stringify(
        args.limit !== undefined ? { q: args.q, limit: args.limit } : { q: args.q },
      ),
    });
  } catch {
    // Distinct from "no results". Rendering an offline failure as an empty list tells the user
    // their notes are not there, which is false.
    throw new OfflineError("Semantic search needs a connection");
  }
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const body = (await res.json()) as { results?: unknown };
  // The Task 15 contract is `{ results: [...] }`. A response that does not have that shape --
  // a proxy error page, an API version skew -- must not silently become `undefined` and get
  // rendered by the screen as though it were a real, empty search result.
  if (!Array.isArray(body.results)) {
    throw new Error("search response was missing a results array");
  }
  return body.results as SemanticResult[];
}
