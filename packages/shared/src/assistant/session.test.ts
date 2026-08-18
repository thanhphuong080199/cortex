import { describe, expect, it } from "vitest";
import { SESSION_IDLE_RESET_MS, isStale, resolveCurrentSession } from "./session.js";

const now = new Date("2026-08-16T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe("resolveCurrentSession", () => {
  it("has no current session when the user has never written anything", () => {
    expect(resolveCurrentSession(null, now)).toBeNull();
  });

  it("continues the session the most recent message belongs to", () => {
    expect(resolveCurrentSession({ session_id: "s1", created_at: ago(60_000) }, now)).toBe("s1");
  });

  // THE ONE THIS FUNCTION EXISTS FOR. Past the idle gap there is no current session: the
  // transcript renders empty and the next turn opens a new one. Two call sites deciding this
  // separately is how a pane ends up showing yesterday's thread above today's first reply --
  // and the day the gap changes, only one of them would move.
  it("has no current session once the idle gap has passed", () => {
    expect(resolveCurrentSession({ session_id: "s1", created_at: ago(SESSION_IDLE_RESET_MS) }, now))
      .toBeNull();
  });

  it("keeps the session one millisecond short of the gap", () => {
    expect(resolveCurrentSession({ session_id: "s1", created_at: ago(SESSION_IDLE_RESET_MS - 1) }, now))
      .toBe("s1");
  });
});

describe("isStale", () => {
  it("treats no history as stale, so a first message starts a session", () => {
    expect(isStale(null, now)).toBe(true);
  });
  it("is exclusive below the gap and inclusive at it", () => {
    expect(isStale(ago(SESSION_IDLE_RESET_MS - 1), now)).toBe(false);
    expect(isStale(ago(SESSION_IDLE_RESET_MS), now)).toBe(true);
  });
});
