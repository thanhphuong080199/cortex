import { describe, expect, it } from "vitest";
import {
  NOTE_VIEWS,
  applyNoteFilters,
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
    // A real uuid, because the tag is now validated as one -- see the dedicated block below.
    const tag = "6f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071";
    expect(parseNoteFilters({ tag: `  ${tag} ` }).tag).toBe(tag);
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
  const note = { lifecycle: "inbox", deleted_at: null, domain: "media", source_type: "quick" };

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
    const plain = { lifecycle: "inbox", deleted_at: null, domain: null, source_type: "quick" };
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

describe("parseNoteFilters drops a tag that is not a uuid", () => {
  const uuid = "6f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071";

  it("keeps a real uuid", () => {
    expect(parseNoteFilters({ tag: uuid })).toEqual({ view: "inbox", tag: uuid });
  });

  it("drops one that is not, rather than passing it to the database", () => {
    // `note_tags.tag_id` is a uuid column, so PostgREST answers `?tag=abc` with 22P02 and the
    // whole page renders its error boundary, while SQLite silently returns nothing. Dropping
    // it is the only answer that makes both show the same thing.
    expect(parseNoteFilters({ tag: "abc" })).toEqual({ view: "inbox" });
    expect(parseNoteFilters({ tag: "'; drop table notes; --" })).toEqual({ view: "inbox" });
    expect(parseNoteFilters({ tag: `${uuid}x` })).toEqual({ view: "inbox" });
  });

  it("keeps the view it was asked for while dropping the bad tag", () => {
    // The failure mode to avoid is throwing the whole filter away and silently showing inbox.
    expect(parseNoteFilters({ view: "trash", tag: "abc" })).toEqual({ view: "trash" });
  });
});

describe("applyNoteFilters and noteFiltersToSql agree about an empty q", () => {
  it("neither engine searches when the query is only whitespace", () => {
    // Unguarded these diverge on identical input: an empty tsquery matches zero rows while the
    // SQLite side drops its clause and shows the view. Same NoteFilters, two answers.
    const calls: string[] = [];
    const builder = {
      is: () => builder, not: () => builder, in: () => builder, eq: () => builder, neq: () => builder,
      order: () => builder,
      textSearch: () => {
        calls.push("textSearch");
        return builder;
      },
    };
    applyNoteFilters(builder, { view: "inbox", q: "   " });

    expect(calls).toEqual([]);
    expect(noteFiltersToSql({ view: "inbox", q: "   " }).where).not.toContain("notes_fts");
  });

  it("both still search for a real query", () => {
    const calls: string[] = [];
    const builder = {
      is: () => builder, not: () => builder, in: () => builder, eq: () => builder, neq: () => builder,
      order: () => builder,
      textSearch: () => {
        calls.push("textSearch");
        return builder;
      },
    };
    applyNoteFilters(builder, { view: "inbox", q: "pricing" });

    expect(calls).toEqual(["textSearch"]);
    expect(noteFiltersToSql({ view: "inbox", q: "pricing" }).where).toContain("notes_fts");
  });
});

describe("chitchat is not a note anyone browses", () => {
  // Applier 1. Asserted through a recording double rather than a live query, the way this
  // file's other applyNoteFilters cases are: what matters is the CALL, since a missing `neq`
  // is invisible in a result set that happens to contain no chitchat.
  it("applyNoteFilters excludes it from every view", () => {
    for (const view of NOTE_VIEWS) {
      const calls: [string, unknown][] = [];
      const q = new Proxy({}, {
        get: (_t, prop: string) => (...args: unknown[]) => { calls.push([prop, args]); return q; },
      });
      applyNoteFilters(q, { view });
      expect(calls, `view=${view}`).toContainEqual(["neq", ["source_type", "chitchat"]]);
    }
  });

  // Applier 2. Trash included: chitchat is excluded everywhere, not just from the live views.
  it("noteFiltersToSql excludes it from every view", () => {
    for (const view of NOTE_VIEWS) {
      const { where, params } = noteFiltersToSql({ view });
      expect(where, `view=${view}`).toContain("source_type");
      expect(params, `view=${view}`).toContain("chitchat");
    }
  });

  // Applier 3, AND the reason it is separate from applier 1. A chitchat note is created as
  // 'quick' and stamped only after classification, so Realtime delivers it to the list first
  // and the stamping UPDATE arrives second. Without this the SSR query excludes it and the
  // live patch puts it straight back -- E5's surviving half, exactly.
  it("matchesFilters evicts a row that has just been stamped chitchat", () => {
    const row = { lifecycle: "inbox", deleted_at: null, source_type: "chitchat" };
    expect(matchesFilters(row, { view: "inbox" })).toBe(false);
  });

  it("matchesFilters still admits an ordinary note", () => {
    const row = { lifecycle: "inbox", deleted_at: null, source_type: "quick" };
    expect(matchesFilters(row, { view: "inbox" })).toBe(true);
  });

  // A note in the trash is still not browsable banter. Checked separately because the trash
  // branch of matchesFilters returns before the lifecycle checks.
  it("matchesFilters evicts chitchat from trash too", () => {
    const row = { lifecycle: "inbox", deleted_at: "2026-08-16T00:00:00Z", source_type: "chitchat" };
    expect(matchesFilters(row, { view: "trash" })).toBe(false);
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
    // Params now include "chitchat" from the source_type exclusion clause.
    expect(params).toEqual(["chitchat", "inbox"]);
  });
});
