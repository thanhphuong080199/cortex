import { describe, expect, it } from "vitest";
import { matchesView, parseDomain, parseView } from "./note-views";

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

describe("matchesView with a domain filter", () => {
  const health = { lifecycle: "inbox", deleted_at: null, domain: "health" };
  const plain = { lifecycle: "inbox", deleted_at: null, domain: null };

  it("narrows any view to notes carrying that domain", () => {
    expect(matchesView(health, "inbox", "health")).toBe(true);
    expect(matchesView(plain, "inbox", "health")).toBe(false);
    expect(matchesView({ ...health, domain: "media" }, "inbox", "health")).toBe(false);
  });

  it("leaves behaviour unchanged when no domain is given", () => {
    expect(matchesView(health, "inbox")).toBe(true);
    expect(matchesView(plain, "inbox")).toBe(true);
  });

  it("still applies the view rules on top of the domain", () => {
    // The domain narrows; it never overrides. A trashed health note is not in the inbox.
    expect(matchesView({ ...health, deleted_at: "2026-08-01" }, "inbox", "health")).toBe(false);
    expect(matchesView({ ...health, deleted_at: "2026-08-01" }, "trash", "health")).toBe(true);
  });

  it("tolerates rows with no domain key at all", () => {
    // Realtime payloads are whatever the row shape is; an older cached row must not throw.
    expect(matchesView({ lifecycle: "inbox", deleted_at: null }, "inbox", "health")).toBe(false);
    expect(matchesView({ lifecycle: "inbox", deleted_at: null }, "inbox")).toBe(true);
  });
});

describe("parseDomain", () => {
  it("accepts the six known domains", () => {
    expect(parseDomain("health")).toBe("health");
    expect(parseDomain("reflection")).toBe("reflection");
  });
  it("returns undefined for anything else, so the filter is simply absent", () => {
    expect(parseDomain(undefined)).toBeUndefined();
    expect(parseDomain("astrology")).toBeUndefined();
    expect(parseDomain("")).toBeUndefined();
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
