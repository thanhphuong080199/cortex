import { describe, expect, it } from "vitest";
import { noteFilename } from "./slug.js";

describe("noteFilename", () => {
  const id = "a1b2c3d4-0000-0000-0000-000000000000";
  it("slugs the title", () => {
    expect(noteFilename({ id, title: "Pricing Psychology!", content: "" }))
      .toBe("pricing-psychology-a1b2c3d4.md");
  });
  it("falls back to first content line when untitled", () => {
    expect(noteFilename({ id, title: null, content: "sync conflict notes\nmore" }))
      .toBe("sync-conflict-notes-a1b2c3d4.md");
  });
  it("never returns an empty slug", () => {
    expect(noteFilename({ id, title: null, content: "???" }))
      .toBe("note-a1b2c3d4.md");
  });
});
