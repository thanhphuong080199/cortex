import { describe, expect, it } from "vitest";
import { assistantInput } from "./assistant.js";

describe("assistantInput", () => {
  it("accepts a note id alone", () => {
    expect(assistantInput.safeParse({ noteId: crypto.randomUUID() }).success).toBe(true);
  });

  it("accepts a note id with a session id", () => {
    const r = assistantInput.safeParse({
      noteId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    });
    expect(r.success).toBe(true);
  });

  // .strict() so a body carrying userId is a 400, not a value that gets quietly dropped --
  // the same rule searchInput follows, for the same reason.
  it("rejects an unexpected field rather than ignoring it", () => {
    const r = assistantInput.safeParse({ noteId: crypto.randomUUID(), userId: "someone-else" });
    expect(r.success).toBe(false);
  });

  it("rejects a non-uuid note id", () => {
    expect(assistantInput.safeParse({ noteId: "../../etc/passwd" }).success).toBe(false);
  });

  it("rejects a non-uuid session id", () => {
    const r = assistantInput.safeParse({ noteId: crypto.randomUUID(), sessionId: "not-a-uuid" });
    expect(r.success).toBe(false);
  });

  it("rejects a missing note id", () => {
    expect(assistantInput.safeParse({}).success).toBe(false);
  });
});
