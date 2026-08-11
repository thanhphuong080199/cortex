import { describe, expect, it } from "vitest";
import { searchInput } from "./search.js";

describe("searchInput", () => {
  it("trims and requires a non-empty query", () => {
    expect(searchInput.safeParse({ q: "  " }).success).toBe(false);
    expect(searchInput.parse({ q: " marginal cost " }).q).toBe("marginal cost");
  });

  // .strict() is what turns a body-supplied userId into a 400 instead of a value that gets
  // silently dropped -- load-bearing for the isolation property POST /search depends on
  // (search_notes's p_user_id must come only from the verified JWT, never the body).
  it("rejects unknown fields, e.g. a body-supplied userId", () => {
    expect(searchInput.safeParse({ q: "x", userId: "not-from-the-jwt" }).success).toBe(false);
  });

  it("bounds limit to a positive integer at most 50", () => {
    expect(searchInput.safeParse({ q: "x", limit: 0 }).success).toBe(false);
    expect(searchInput.safeParse({ q: "x", limit: 1.5 }).success).toBe(false);
    expect(searchInput.safeParse({ q: "x", limit: 51 }).success).toBe(false);
    expect(searchInput.safeParse({ q: "x", limit: 50 }).success).toBe(true);
  });

  it("allows limit to be omitted", () => {
    expect(searchInput.safeParse({ q: "x" }).success).toBe(true);
  });
});
