import { describe, expect, it } from "vitest";
import { logMediaInput } from "./media.js";

describe("logMediaInput", () => {
  it("accepts a minimal log -- kind and title are the only required fields", () => {
    expect(logMediaInput.safeParse({ kind: "movie", title: "Dune" }).success).toBe(true);
  });

  it("accepts a full log", () => {
    const full = logMediaInput.safeParse({
      kind: "book", title: "Thinking, Fast and Slow", year: 2011,
      rating: 5, impression: "changed how I see bias", consumedAt: "2026-07-14",
    });
    expect(full.success).toBe(true);
  });

  it("rejects an unknown kind and an empty title", () => {
    expect(logMediaInput.safeParse({ kind: "vinyl", title: "x" }).success).toBe(false);
    expect(logMediaInput.safeParse({ kind: "book", title: "" }).success).toBe(false);
    expect(logMediaInput.safeParse({ kind: "book", title: "   " }).success).toBe(false);
  });

  it("trims the title, so ' Dune ' and 'Dune' find the same media item", () => {
    const parsed = logMediaInput.parse({ kind: "movie", title: "  Dune  " });
    expect(parsed.title).toBe("Dune");
  });

  it("rejects a malformed consumedAt", () => {
    expect(logMediaInput.safeParse({ kind: "tv", title: "Severance", consumedAt: "14/07/2026" }).success)
      .toBe(false);
  });
});
