import { describe, expect, it } from "vitest";
import { buildSavedAnswerRow } from "./save-answer.js";

describe("buildSavedAnswerRow", () => {
  // The source type carries the provenance the retrieval ranking keys on. search_notes
  // down-weights 'web_search' and 'assistant' by 0.8 (00022:92); written as 'quick' the saved
  // answer would rank as the user's OWN thinking and be cited back to them as such.
  it("marks a web-cited answer as web_search", () => {
    const row = buildSavedAnswerRow({
      userId: "u1", statement: "Omega-3 có trong cá hồi.", sourceUrl: "https://e.com/a",
    });
    expect(row.source_type).toBe("web_search");
    expect(row.source_meta).toEqual({ url: "https://e.com/a" });
  });

  it("marks an ungrounded answer as assistant", () => {
    const row = buildSavedAnswerRow({ userId: "u1", statement: "Omega-3 có trong cá hồi." });
    expect(row.source_type).toBe("assistant");
    // {} and not { url: undefined }: source_meta is `not null default '{}'`, and a key whose
    // value is undefined survives JSON.stringify as an absent key on some paths and as null on
    // others. An empty object has one meaning.
    expect(row.source_meta).toEqual({});
  });

  // §6.3: it lands in the inbox like any other capture, for the user to file or discard. It is
  // not pre-filed as something they already decided to keep.
  it("lands in the inbox", () => {
    expect(buildSavedAnswerRow({ userId: "u1", statement: "x" }).lifecycle).toBe("inbox");
  });

  // §13, AND THE KEY SET IS THE ASSERTION. `buildSavedAnswerRow(args) === buildSavedAnswerRow(args)`
  // would be a test that cannot fail -- a pure function called twice with one object. Pinning the
  // exact key set is what goes red: the way the two paths stop matching is somebody adding a
  // discriminating field (`via: "offer"`, an `offered_at`, a nondeterministic id) to tell them
  // apart later, and a new key breaks this line the moment it is written.
  // `content`, not `content_text`: the latter is a `generated always as (strip_markdown(content))
  // stored` column (00002_content.sql:7) and Postgres rejects a direct insert into it --
  // content_text derives from this automatically, the same way NoteService.create() writes it.
  it("writes exactly these columns and no discriminator", () => {
    const row = buildSavedAnswerRow({ userId: "u1", statement: "s", sourceUrl: "https://e.com/a" });
    expect(Object.keys(row).sort()).toEqual(
      ["content", "lifecycle", "source_meta", "source_type", "user_id"],
    );
  });
});
