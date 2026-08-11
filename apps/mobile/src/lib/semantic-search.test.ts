import { describe, expect, it, vi } from "vitest";

import {
  describeSearchFailure,
  OfflineError,
  SEARCH_OFFLINE_MESSAGE,
  SearchInputError,
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

  // `limit: 0` is not a valid input -- the shared DTO requires a positive integer. The invariant
  // this pins is that it is never SILENTLY DROPPED, which would turn the caller's bad input into
  // a successful search over the default 20. It is now rejected here instead of being sent for
  // the server to 400, which is the same reason the length cap below is local: reporting the bad
  // field beats a status code the caller has to decode. The `not.toHaveBeenCalled` is the half
  // that actually rules out the silent-success failure mode.
  it("rejects a zero limit locally rather than silently dropping it", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ok });
    await expect(
      semanticSearch({ q: "x", token: "j", apiUrl: "https://api.test", limit: 0, fetchFn }),
    ).rejects.toBeInstanceOf(SearchInputError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // A pasted article is the realistic case. Before this, 800 characters went to the server, came
  // back 400, and the screen showed "search failed (400)" -- a VALIDATION problem wearing a
  // REQUEST FAILURE's clothes, with nothing in it the user could act on. Web fixed exactly this
  // one round earlier (maxLength={500} plus `validated(searchInput, ...)` in its api.ts); mobile
  // shipped without either.
  it("rejects an over-long query before making any request", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ok });
    await expect(
      semanticSearch({ q: "a".repeat(501), token: "j", apiUrl: "https://api.test", fetchFn }),
    ).rejects.toBeInstanceOf(SearchInputError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // The message has to say what is wrong and what the limit is, or it is no better than the 400
  // it replaced. The cap is quoted from the schema's own issue, so this stays true if the
  // server's limit ever moves.
  it("says the query is too long, and names the limit", async () => {
    const fetchFn = vi.fn();
    await expect(
      semanticSearch({ q: "a".repeat(800), token: "j", apiUrl: "https://api.test", fetchFn }),
    ).rejects.toThrow(/too long.*500/i);
  });

  // The boundary itself, so an off-by-one in either direction is caught: 500 is the largest
  // value the shared schema accepts, and it must still go out.
  it("still sends a query of exactly the maximum length", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ok });
    const q = "a".repeat(500);
    await semanticSearch({ q, token: "j", apiUrl: "https://api.test", fetchFn });

    const [, init] = firstCall(fetchFn);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ q });
  });

  // searchInput trims before measuring, so trailing whitespace must not push an otherwise-legal
  // query over the cap -- the server would have accepted this one.
  it("measures the trimmed query, not the raw one", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ok });
    await semanticSearch({
      q: `${"a".repeat(500)}   `, token: "j", apiUrl: "https://api.test", fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

  // The whole point of validating locally is that the user READS the reason. If this mapping
  // ever swallowed SearchInputError into generic copy, the too-long query would be back to
  // being indistinguishable from a broken search -- just without the round trip.
  it("shows a validation failure's own message, not generic search-failed copy", () => {
    const msg = describeSearchFailure(new SearchInputError("That search is too long — 500 characters max, this one is 800."));
    expect(msg).toMatch(/too long/);
    expect(msg).not.toBe(SEARCH_OFFLINE_MESSAGE);
  });

  it("passes any other error's message through so a real failure stays diagnosable", () => {
    expect(describeSearchFailure(new Error("search failed (500)"))).toBe("search failed (500)");
    expect(describeSearchFailure(new Error("not signed in"))).toBe("not signed in");
  });

  it("has copy for a thrown non-Error", () => {
    expect(describeSearchFailure("nope")).toBe("Search failed. Try again.");
  });
});
