import { describe, expect, it, vi } from "vitest";

import {
  describeSearchFailure,
  OfflineError,
  SEARCH_OFFLINE_MESSAGE,
  semanticSearch,
} from "./semantic-search.js";

const ok = { results: [{ noteId: "n1", title: null, snippet: "s", score: 1, matchedBy: "vector" }] };

/** Fails loudly with a real assertion message instead of letting `undefined` flow through. */
function firstCall(fetchFn: ReturnType<typeof vi.fn>): [unknown, unknown] {
  const call = fetchFn.mock.calls[0];
  if (!call) throw new Error("fetchFn was never called");
  return call as [unknown, unknown];
}

describe("semanticSearch", () => {
  it("posts the query with the caller's token", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ok });
    await semanticSearch({ q: "pricing", token: "jwt", apiUrl: "https://api.test", fetchFn });

    const [url, init] = firstCall(fetchFn);
    expect(url).toBe("https://api.test/search");
    expect((init as RequestInit).method).toBe("POST");
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt",
    );
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ q: "pricing" });
  });

  it("includes limit only when the caller passes one", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ok });
    await semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", limit: 5, fetchFn });

    const [, init] = firstCall(fetchFn);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ q: "x", limit: 5 });
  });

  // `limit: 0` is not a valid input -- the shared DTO requires a positive integer. Dropping it
  // here would turn the caller's bad input into a successful search over the default 20.
  it("sends a zero limit through rather than silently dropping it", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ok });
    await semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", limit: 0, fetchFn });

    const [, init] = firstCall(fetchFn);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ q: "x", limit: 0 });
  });

  it("returns the results", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ok });
    const out = await semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", fetchFn });
    expect(out).toEqual(ok.results);
  });

  // Offline must be its own outcome. Returning [] would render as "no notes matched", which
  // is a lie -- the notes may well be there.
  it("throws OfflineError when the request cannot be made", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Network request failed"));
    await expect(
      semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", fetchFn }),
    ).rejects.toMatchObject({ name: "OfflineError" });
    await expect(
      semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", fetchFn }),
    ).rejects.toBeInstanceOf(OfflineError);
  });

  it("throws on a non-2xx rather than returning an empty list", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(
      semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", fetchFn }),
    ).rejects.toThrow(/500/);
  });

  // The Task 15 contract is `{ results: [...] }`. A response that does not have that shape --
  // a proxy error page, an API version skew -- must not come back as `undefined` and get
  // rendered by the screen as though it were an empty, successful search.
  it("throws when the response body has no results array", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ oops: true }) });
    await expect(
      semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", fetchFn }),
    ).rejects.toThrow(/results/);
  });
});

// The screen renders whatever this returns, so this is where the offline-vs-everything-else
// contract is actually decided. It lives here, out of the `.tsx`, precisely so it can be tested.
describe("describeSearchFailure", () => {
  it("gives OfflineError the offline copy", () => {
    expect(describeSearchFailure(new OfflineError("boom"))).toBe(SEARCH_OFFLINE_MESSAGE);
  });

  // The screen hits the network in supabase.auth.getSession() before semanticSearch ever runs,
  // and that one rejects with a raw platform message, not an OfflineError. Same situation to the
  // user, so the same copy -- otherwise being offline shows "Network request failed" roughly
  // half the time depending on which call happens to go first.
  it("gives a raw network failure the offline copy too", () => {
    expect(describeSearchFailure(new TypeError("Network request failed"))).toBe(
      SEARCH_OFFLINE_MESSAGE,
    );
    expect(describeSearchFailure(new Error("Failed to fetch"))).toBe(SEARCH_OFFLINE_MESSAGE);
  });

  it("passes any other error's message through so a real failure stays diagnosable", () => {
    expect(describeSearchFailure(new Error("search failed (500)"))).toBe("search failed (500)");
    expect(describeSearchFailure(new Error("not signed in"))).toBe("not signed in");
  });

  it("has copy for a thrown non-Error", () => {
    expect(describeSearchFailure("nope")).toBe("Search failed. Try again.");
  });
});
