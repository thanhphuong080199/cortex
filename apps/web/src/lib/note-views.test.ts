import { describe, expect, it } from "vitest";
import { matchesView, parseView } from "./note-views";

const live = (lifecycle: string) => ({ lifecycle, deleted_at: null });

describe("matchesView", () => {
  it("inbox shows only live inbox notes", () => {
    expect(matchesView(live("inbox"), "inbox")).toBe(true);
    expect(matchesView(live("active"), "inbox")).toBe(false);
    expect(matchesView({ lifecycle: "inbox", deleted_at: "2026-08-01" }, "inbox")).toBe(false);
  });
  it("active shows active and evergreen", () => {
    expect(matchesView(live("active"), "active")).toBe(true);
    expect(matchesView(live("evergreen"), "active")).toBe(true);
    expect(matchesView(live("archived"), "active")).toBe(false);
  });
  it("archived shows only live archived notes", () => {
    expect(matchesView(live("archived"), "archived")).toBe(true);
    expect(matchesView(live("inbox"), "archived")).toBe(false);
  });
  it("trash shows any deleted note regardless of lifecycle", () => {
    expect(matchesView({ lifecycle: "archived", deleted_at: "2026-08-01" }, "trash")).toBe(true);
    expect(matchesView(live("archived"), "trash")).toBe(false);
  });
});

describe("parseView", () => {
  it("accepts the four known views", () => {
    expect(parseView("trash")).toBe("trash");
    expect(parseView("active")).toBe("active");
  });
  it("falls back to inbox for anything else", () => {
    expect(parseView(undefined)).toBe("inbox");
    expect(parseView("nonsense")).toBe("inbox");
  });
});
