// parseNoteFilters / matchesFilters / applyNoteFilters are tested in @cortex/shared and
// @cortex/core -- one description, one suite. What stays here is web-only: presentation,
// and the fact that this module's re-export actually resolves.
import { describe, expect, it } from "vitest";
import { NOTE_VIEWS, VIEW_LABELS, applyNoteFilters, parseNoteFilters } from "./note-views";

describe("VIEW_LABELS", () => {
  it("labels every view", () => {
    for (const v of NOTE_VIEWS) expect(VIEW_LABELS[v]).toBeTruthy();
  });

  it("labels nothing that is not a view", () => {
    // Catches a label left behind after a view is renamed or removed, which would
    // otherwise sit in the nav as a dead entry.
    expect(Object.keys(VIEW_LABELS).sort()).toEqual([...NOTE_VIEWS].sort());
  });
});

describe("the shared filter re-export", () => {
  it("resolves the functions both web call sites need", () => {
    // page.tsx and note-list.tsx both import through this module. A re-export naming a
    // symbol that does not exist is a build error, but one that resolves to undefined is
    // not -- and note-list.tsx only reaches applyNoteFilters inside an effect, so a
    // browser would be the first thing to notice.
    expect(typeof parseNoteFilters).toBe("function");
    expect(typeof applyNoteFilters).toBe("function");
    expect(parseNoteFilters({ view: "trash" }).view).toBe("trash");
  });
});
