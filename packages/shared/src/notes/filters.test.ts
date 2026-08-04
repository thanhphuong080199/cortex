import { describe, expect, it } from "vitest";
import {
  NOTE_VIEWS,
  matchesFilters,
  noteSelect,
  parseNoteFilters,
  noteFiltersToSql,
  requiresRefetch,
  toFtsQuery,
} from "./filters.js";

describe("parseNoteFilters", () => {
  it("defaults to the inbox view", () => {
    expect(parseNoteFilters({})).toEqual({ view: "inbox" });
  });
  it("rejects an unknown view", () => {
    expect(parseNoteFilters({ view: "../../etc" }).view).toBe("inbox");
  });
  it("keeps every known view", () => {
    for (const v of NOTE_VIEWS) expect(parseNoteFilters({ view: v }).view).toBe(v);
  });
  it("rejects an unknown domain", () => {
    expect(parseNoteFilters({ domain: "nonsense" }).domain).toBeUndefined();
  });
  it("keeps a known domain", () => {
    expect(parseNoteFilters({ domain: "media" }).domain).toBe("media");
  });
  it("takes the first value of a repeated param", () => {
    expect(parseNoteFilters({ q: ["first", "second"] }).q).toBe("first");
  });
  it("trims and drops a whitespace-only query", () => {
    expect(parseNoteFilters({ q: "  hello " }).q).toBe("hello");
    expect(parseNoteFilters({ q: "   " }).q).toBeUndefined();
  });
  it("trims and drops a whitespace-only tag", () => {
    expect(parseNoteFilters({ tag: "  t1 " }).tag).toBe("t1");
    expect(parseNoteFilters({ tag: "   " }).tag).toBeUndefined();
  });
  it("omits absent keys rather than setting them undefined", () => {
    // toEqual ignores explicit-undefined properties, so assert on the key set instead:
    // `{q: undefined}` would serialise into a URL as `?q=` and round-trip differently.
    expect(Object.keys(parseNoteFilters({ view: "trash" }))).toEqual(["view"]);
  });
});

describe("noteSelect", () => {
  it("joins note_tags only when a tag filter is present", () => {
    expect(noteSelect({ view: "inbox" })).toBe("*");
    expect(noteSelect({ view: "inbox", tag: "t" })).toContain("note_tags!inner");
  });
});

describe("matchesFilters", () => {
  const note = { lifecycle: "inbox", deleted_at: null, domain: "media" };

  it("agrees with the inbox view", () => {
    expect(matchesFilters(note, { view: "inbox" })).toBe(true);
  });
  it("excludes a note of another lifecycle", () => {
    expect(matchesFilters(note, { view: "archived" })).toBe(false);
  });
  it("excludes a note of another domain", () => {
    expect(matchesFilters(note, { view: "inbox", domain: "health" })).toBe(false);
  });
  it("admits an undomained note only when no domain is filtered", () => {
    const plain = { lifecycle: "inbox", deleted_at: null, domain: null };
    expect(matchesFilters(plain, { view: "inbox" })).toBe(true);
    expect(matchesFilters(plain, { view: "inbox", domain: "media" })).toBe(false);
  });
  it("covers BOTH active and evergreen under the active view", () => {
    // The named risk: `active` is one view over two lifecycle states. A predicate that
    // forgot evergreen would still satisfy every other case in this file.
    expect(matchesFilters({ ...note, lifecycle: "active" }, { view: "active" })).toBe(true);
    expect(matchesFilters({ ...note, lifecycle: "evergreen" }, { view: "active" })).toBe(true);
    expect(matchesFilters({ ...note, lifecycle: "inbox" }, { view: "active" })).toBe(false);
    expect(matchesFilters({ ...note, lifecycle: "archived" }, { view: "active" })).toBe(false);
  });
  it("treats a soft-deleted note as trash-only", () => {
    const gone = { ...note, deleted_at: "2026-08-02T00:00:00Z" };
    expect(matchesFilters(gone, { view: "inbox" })).toBe(false);
    expect(matchesFilters(gone, { view: "active" })).toBe(false);
    expect(matchesFilters(gone, { view: "archived" })).toBe(false);
    expect(matchesFilters(gone, { view: "trash" })).toBe(true);
  });
  it("keeps a live note out of trash whatever its lifecycle", () => {
    for (const lifecycle of ["inbox", "active", "evergreen", "archived"]) {
      expect(matchesFilters({ ...note, lifecycle }, { view: "trash" })).toBe(false);
    }
  });
  it("narrows a trashed note by domain without re-admitting it to another view", () => {
    const gone = { ...note, deleted_at: "2026-08-02T00:00:00Z" };
    expect(matchesFilters(gone, { view: "trash", domain: "media" })).toBe(true);
    expect(matchesFilters(gone, { view: "trash", domain: "health" })).toBe(false);
  });
});

describe("requiresRefetch", () => {
  it("is false for a filter a client can evaluate on its own", () => {
    expect(requiresRefetch({ view: "inbox" })).toBe(false);
    expect(requiresRefetch({ view: "trash", domain: "media" })).toBe(false);
  });
  it("is true for q and for tag, which matchesFilters cannot evaluate", () => {
    // These two are exactly the fields matchesFilters ignores. If this ever answered
    // false for them, a Realtime patch would re-admit notes the query had excluded --
    // issue-log E5's other half.
    expect(requiresRefetch({ view: "inbox", q: "pricing" })).toBe(true);
    expect(requiresRefetch({ view: "inbox", tag: "t1" })).toBe(true);
  });
});

describe("toFtsQuery", () => {
  /**
   * The whole point: FTS5 parses the BOUND string as a query expression, so ordinary typing
   * used to raise a syntax error. These pin the shape; that the shape actually EXECUTES on
   * FTS5 -- and that the unescaped input genuinely throws -- is asserted against real SQLite
   * in apps/mobile/src/lib/fts.test.ts, which is where the emitted clause runs.
   */
  it("quotes an apostrophe instead of letting FTS5 parse it", () => {
    expect(toFtsQuery("don't")).toBe(`"don't"`);
  });

  it("escapes an embedded double quote by doubling it", () => {
    expect(toFtsQuery('foo"')).toBe('"foo"""');
  });

  it("strips operators of their meaning rather than rejecting them", () => {
    // A search box is not a query language. `websearch_to_tsquery` is forgiving too.
    expect(toFtsQuery("hello AND")).toBe('"hello" "AND"');
    expect(toFtsQuery("-hello")).toBe('"-hello"');
    expect(toFtsQuery("content:hello")).toBe('"content:hello"');
  });

  it("joins multiple words as separate terms", () => {
    expect(toFtsQuery("plain text")).toBe('"plain" "text"');
  });

  it("collapses runs of whitespace", () => {
    expect(toFtsQuery("  a\t\n b  ")).toBe('"a" "b"');
  });

  it("returns empty for input that tokenises to nothing", () => {
    // The caller drops the clause on this: `notes_fts match ''` is itself a syntax error.
    expect(toFtsQuery("   ")).toBe("");
    expect(toFtsQuery("")).toBe("");
  });
});

describe("noteFiltersToSql q handling", () => {
  it("binds the escaped query, never the raw input", () => {
    const { where, params } = noteFiltersToSql({ view: "inbox", q: "don't" });
    expect(where).toContain("notes_fts match");
    expect(params).toContain(`"don't"`);
    expect(params).not.toContain("don't");
  });

  it("omits the FTS clause entirely when the query tokenises to nothing", () => {
    const { where, params } = noteFiltersToSql({ view: "inbox", q: "   " });
    // Emitting an empty MATCH would make every such search throw instead of showing the view.
    expect(where).not.toContain("notes_fts");
    expect(params).toEqual(["inbox"]);
  });
});
