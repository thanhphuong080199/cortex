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
      body: JSON.stringify(args.limit ? { q: args.q, limit: args.limit } : { q: args.q }),
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
