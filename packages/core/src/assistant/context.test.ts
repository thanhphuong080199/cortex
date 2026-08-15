import { describe, expect, it } from "vitest";
import { CONTEXT_TOKEN_BUDGET, isStale, selectContext, type ThreadTurn } from "./context.js";

const turn = (role: "user" | "assistant", content: string, minutesAgo: number): ThreadTurn => ({
  role, content,
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

describe("selectContext", () => {
  it("keeps the newest turns and returns them oldest-first for the prompt", () => {
    const turns = [turn("user", "oldest", 30), turn("assistant", "middle", 20), turn("user", "newest", 10)];
    expect(selectContext(turns).map((t) => t.content)).toEqual(["oldest", "middle", "newest"]);
  });

  it("drops the oldest turns once the budget is exceeded", () => {
    const big = "x".repeat(4 * 1200); // ~1200 tokens at chars/4
    const turns = [turn("user", `OLD${big}`, 30), turn("assistant", `MID${big}`, 20), turn("user", "tiny", 10)];
    const kept = selectContext(turns);
    expect(kept.some((t) => t.content.startsWith("OLD"))).toBe(false);
    expect(kept.some((t) => t.content.startsWith("MID"))).toBe(true);
    expect(kept.some((t) => t.content === "tiny")).toBe(true);
  });

  // Task 7 queries the thread as `order by created_at desc limit N`. Position must not be the
  // recency signal, or that natural query shape silently fills the budget with the OLDEST
  // turns and returns them newest-first -- no error, no empty result, just wrong context.
  it("orders by createdAt, not by array position, so a created_at desc query is safe", () => {
    const ascending = [turn("user", "oldest", 30), turn("assistant", "middle", 20), turn("user", "newest", 10)];
    const descending = [...ascending].reverse();
    expect(selectContext(descending)).toEqual(selectContext(ascending));
    expect(selectContext(descending).map((t) => t.content)).toEqual(["oldest", "middle", "newest"]);
  });

  // The contiguity invariant. A window with a hole in it hands the model a conversation whose
  // middle is missing, which reads as a non-sequitur rather than as missing context -- so the
  // walk STOPS at the first over-budget turn instead of skipping it to reach older ones.
  it("stops at the first over-budget turn rather than skipping it to reach older ones", () => {
    const huge = "z".repeat(4 * (CONTEXT_TOKEN_BUDGET + 500));
    const turns = [turn("user", "small_old", 30), turn("assistant", huge, 20), turn("user", "small_new", 10)];
    expect(selectContext(turns).map((t) => t.content)).toEqual(["small_new"]);
  });

  // Whole turns only: half an exchange is worse context than none, because the model reads a
  // truncated question as the whole question.
  it("never includes a partial turn", () => {
    const huge = "y".repeat(4 * (CONTEXT_TOKEN_BUDGET + 500));
    const kept = selectContext([turn("user", huge, 5)]);
    expect(kept).toEqual([]);
  });
});

describe("isStale", () => {
  const now = new Date("2026-08-12T12:00:00Z");
  it("is stale after four hours of silence", () => {
    expect(isStale("2026-08-12T07:59:00Z", now)).toBe(true);
  });
  it("is not stale inside the window", () => {
    expect(isStale("2026-08-12T08:30:00Z", now)).toBe(false);
  });
  // A user with no history starts a session rather than joining one that does not exist.
  it("treats no history as stale", () => {
    expect(isStale(null, now)).toBe(true);
  });
});
