export interface SemanticResult {
  noteId: string;
  title: string | null;
  snippet: string;
  score: number;
  matchedBy: string;
}

export class OfflineError extends Error {
  override name = "OfflineError";
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
