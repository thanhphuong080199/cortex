import { describe, expect, it } from "vitest";
import { assistantInput, distillInput, readCitation } from "./assistant.js";

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
      type: "note", noteId: "n1", title: "Dune", createdAt: null, snippet: "…", score: 0.8,
      matchedBy: "fts",
    });
  });

  it("reads an explicit note citation unchanged", () => {
    const row = {
      type: "note", noteId: "n1", title: null, createdAt: null, snippet: "s", score: 0.5,
      matchedBy: "vec",
    };
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

  // THE BACKWARD-COMPATIBILITY GUARD, second edition. Stage C3 added `type` and defaulted its
  // absence; this adds `createdAt` and defaults its absence to null. Every chat_messages row
  // written before today has citations with no date, and there is no backfill -- the column is
  // jsonb and rewriting a user's conversation history is not worth a migration. Rendering a
  // missing date as anything but nothing is how a reloaded transcript starts asserting dates
  // nobody wrote.
  it("reads a citation with no createdAt as having no date", () => {
    expect(readCitation({
      type: "note", noteId: "n1", title: null, snippet: "s", score: 1, matchedBy: "fts",
    })).toMatchObject({ createdAt: null });
  });

  it("reads a createdAt when there is one", () => {
    expect(readCitation({
      type: "note", noteId: "n1", title: null, snippet: "s", score: 1, matchedBy: "fts",
      createdAt: "2026-08-12T03:00:00.000Z",
    })).toMatchObject({ createdAt: "2026-08-12T03:00:00.000Z" });
  });

  it("ignores a createdAt that is not a string", () => {
    expect(readCitation({
      type: "note", noteId: "n1", title: null, snippet: "s", score: 1, matchedBy: "fts",
      createdAt: 1_754_000_000,
    })).toMatchObject({ createdAt: null });
  });
});

describe("distillInput", () => {
  it("accepts an answer with an optional question", () => {
    expect(distillInput.parse({ answer: "a" })).toEqual({ answer: "a" });
    expect(distillInput.parse({ answer: "a", question: "q" }).question).toBe("q");
  });

  // Same cap as saveAnswerInput and createNoteInput, for the same reason that comment gives: a
  // value acceptable through POST /notes and rejected here would be the same note failing for no
  // reason the user can see.
  it("caps the answer at 100_000, matching saveAnswerInput", () => {
    expect(() => distillInput.parse({ answer: "x".repeat(100_001) })).toThrow();
    expect(distillInput.parse({ answer: "x".repeat(100_000) }).answer).toHaveLength(100_000);
  });

  // .strict(), matching every other body in this file: the user id comes from the verified JWT
  // and a body carrying one must be a 400, not a value the server quietly drops.
  it("rejects an unknown key", () => {
    expect(() => distillInput.parse({ answer: "a", userId: "u" })).toThrow();
  });

  // No sourceUrl. Distillation does not write a note -- the client sends the url to
  // POST /notes/save-answer afterwards -- so a url here would be an unused field the server
  // would have to be trusted not to act on.
  it("has no sourceUrl field", () => {
    expect(() => distillInput.parse({ answer: "a", sourceUrl: "https://example.com" })).toThrow();
  });
});
