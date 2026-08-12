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
