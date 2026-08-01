import { describe, expect, it } from "vitest";
import { createCheckinInput } from "./checkins.js";

describe("createCheckinInput", () => {
  it("accepts mood-only, energy-only, and both", () => {
    expect(createCheckinInput.safeParse({ mood: 3 }).success).toBe(true);
    expect(createCheckinInput.safeParse({ energy: 5 }).success).toBe(true);
    expect(createCheckinInput.safeParse({ mood: 1, energy: 2, label: "meh" }).success).toBe(true);
  });

  it("rejects a check-in with neither mood nor energy", () => {
    // Mirrors the checkins_mood_or_energy constraint (00013): a label alone is not a
    // check-in. Catching it here makes it a 400 with a message instead of a 23514.
    expect(createCheckinInput.safeParse({ label: "just words" }).success).toBe(false);
    expect(createCheckinInput.safeParse({}).success).toBe(false);
  });

  it("rejects out-of-range and non-integer scores", () => {
    expect(createCheckinInput.safeParse({ mood: 0 }).success).toBe(false);
    expect(createCheckinInput.safeParse({ mood: 6 }).success).toBe(false);
    expect(createCheckinInput.safeParse({ energy: 2.5 }).success).toBe(false);
  });

  it("rejects a label longer than the column expects", () => {
    expect(createCheckinInput.safeParse({ mood: 3, label: "x".repeat(101) }).success).toBe(false);
  });
});
