import { describe, expect, it } from "vitest";
import { assistantInput, readCitation } from "./assistant.js";

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

describe("readCitation", () => {
  // THE BACKWARD-COMPATIBILITY GUARD. Every chat_messages row written before stage C3 has a
  // citations array whose entries carry no `type` key. There is no backfill migration -- the
  // column is jsonb and rewriting a user's conversation history to add a field whose absence
  // already means exactly one thing is not worth the migration. This default is that decision,
  // and it is the only place it exists.
  it("reads a pre-C3 citation, which has no type, as a note", () => {
    expect(readCitation({
      noteId: "n1", title: "Dune", snippet: "…", score: 0.8, matchedBy: "fts",
    })).toEqual({
      type: "note", noteId: "n1", title: "Dune", snippet: "…", score: 0.8, matchedBy: "fts",
    });
  });

  it("reads an explicit note citation unchanged", () => {
    const row = { type: "note", noteId: "n1", title: null, snippet: "s", score: 0.5, matchedBy: "vec" };
    expect(readCitation(row)).toEqual(row);
  });

  it("reads a web citation", () => {
    expect(readCitation({ type: "web", url: "https://a.example", title: "a" }))
      .toEqual({ type: "web", url: "https://a.example", title: "a" });
  });

  // A malformed entry is dropped, not rendered. citations is jsonb with no database-level
  // shape, so a bad row must not take the whole transcript down with it.
  it("returns null for anything it cannot read", () => {
    expect(readCitation(null)).toBeNull();
    expect(readCitation("nope")).toBeNull();
    expect(readCitation({ type: "web" })).toBeNull();          // no url
    expect(readCitation({ title: "no ids at all" })).toBeNull(); // neither noteId nor url
  });
});
