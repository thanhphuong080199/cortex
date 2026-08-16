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

  it("accepts content and createdAt for a note the server has never seen", () => {
    const r = assistantInput.safeParse({
      noteId: crypto.randomUUID(),
      content: "vừa xem xong Inception",
      createdAt: "2026-08-15T03:04:05.000Z",
    });
    expect(r.success).toBe(true);
  });

  // Red if content is added without a floor: the create path would insert an empty note.
  it("rejects empty content rather than creating an empty note", () => {
    const r = assistantInput.safeParse({ noteId: crypto.randomUUID(), content: "" });
    expect(r.success).toBe(false);
  });

  it("rejects a createdAt that is not a timestamp", () => {
    const r = assistantInput.safeParse({ noteId: crypto.randomUUID(), createdAt: "yesterday" });
    expect(r.success).toBe(false);
  });
});
