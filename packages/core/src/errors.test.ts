import { describe, expect, it } from "vitest";
import { errorMessage, mapPostgrestError } from "./errors.js";

const pgErr = (code: string) => ({ code, message: "m", details: "", hint: "" }) as never;

describe("mapPostgrestError", () => {
  it("maps PGRST116 (zero rows on .single()) to not_found", () => {
    expect(mapPostgrestError(pgErr("PGRST116")).kind).toBe("not_found");
  });
  it("maps 23505 to conflict", () => {
    expect(mapPostgrestError(pgErr("23505")).kind).toBe("conflict");
  });
  it("maps anything else to internal", () => {
    expect(mapPostgrestError(pgErr("XX000")).kind).toBe("internal");
  });
});

describe("errorMessage", () => {
  it("returns an Error's own message", () => {
    expect(errorMessage(new Error("gemini 500"))).toBe("gemini 500");
  });

  // THE DIAGNOSTIC. Every throw site in the enrichment pipeline rethrows the RAW PostgREST
  // error object, which is a PLAIN object -- `PostgrestError extends Error` is only constructed
  // under `shouldThrowOnError`, which this repo never sets. `String(err)` on it is the literal
  // "[object Object]", which is what note_enrichment.last_error and every log line held for a
  // failing note before this: five attempts, five tombstoned records of nothing.
  it("reads the message off a raw PostgREST error object, not [object Object]", () => {
    const raw = {
      message: "expected 1536 dimensions, not 3",
      details: null, hint: null, code: "22000",
    };
    const out = errorMessage(raw);
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("expected 1536 dimensions, not 3");
    expect(out).toContain("22000");
  });

  // `details` is deliberately NOT included. PostgREST puts the offending row's key values there
  // -- a 23505 on tags_user_name_uidx reads `Key (user_id, lower(name))=(..., <tag>) already
  // exists`, and that tag name is model output derived from the note's text. Spec §15.6 rule 1
  // says no note content reaches a log line, and last_error is written straight from this.
  it("never carries PostgREST `details`, which can hold note-derived values", () => {
    const raw = {
      message: 'duplicate key value violates unique constraint "tags_user_name_uidx"',
      details: "Key (user_id, lower(name))=(00000000-0000-0000-0000-000000000000, chemotherapy) already exists.",
      hint: null, code: "23505",
    };
    expect(errorMessage(raw)).not.toContain("chemotherapy");
  });

  it("falls back to String() for a thrown primitive", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(null)).toBe("null");
  });

  // An object with no usable message must still not stringify to "[object Object]" -- that is
  // the exact non-diagnostic this function exists to eliminate, and a caller reading a log needs
  // to be able to tell "unknown shape" apart from "we lost the message".
  it("names the shape when an object carries no message at all", () => {
    expect(errorMessage({ weird: true })).not.toContain("[object Object]");
  });
});
