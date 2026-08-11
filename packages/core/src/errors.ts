import type { PostgrestError } from "@supabase/supabase-js";

export type CoreErrorKind = "not_found" | "conflict" | "validation" | "internal";
// `message` is caller-facing copy (the API filter returns it verbatim for conflict and
// validation), so it must never carry PostgREST internals -- those stay in `cause`.
export interface CoreError { kind: CoreErrorKind; cause?: unknown; message?: string }

// Keeps PostgREST codes from leaking into HTTP responses (spec §6).
export function mapPostgrestError(error: PostgrestError): CoreError {
  if (error.code === "PGRST116") return { kind: "not_found", cause: error };
  if (error.code === "23505") return { kind: "conflict", cause: error };
  return { kind: "internal", cause: error };
}

/**
 * The best diagnostic string available for an unknown thrown value, for a LOG or a stored
 * `last_error` -- never for an HTTP response body (PostgREST internals are not caller-facing,
 * spec §6; that is what mapPostgrestError above is for).
 *
 * `err instanceof Error ? err.message : String(err)` is not enough anywhere in this codebase that
 * touches PostgREST. Every throw site in packages/core's enrichment pipeline rethrows the raw
 * error object supabase-js hands back, and that object is a PLAIN object, not an Error:
 * `PostgrestError extends Error` is only constructed under `shouldThrowOnError`, which this repo
 * never sets. `String()` on it is the literal "[object Object]". The consequence found in review:
 * a note whose note_chunks upsert failed on a dimension mismatch failed five times and had
 * "[object Object]" written into note_enrichment.last_error all five times, so the one field in
 * the schema designed to hold a diagnostic held nothing at all. search.controller.ts:50 already
 * states this exact fact about PostgREST errors and fixes it there; this carries it to the
 * pipeline.
 *
 * `code` is included because it is what makes a failure actionable without a debugger (23505 vs.
 * 22000 vs. PGRST301 are wholly different problems). `details` and `hint` are deliberately NOT:
 * PostgREST puts the offending row's key VALUES in `details`, and a 23505 on tags_user_name_uidx
 * therefore reads `Key (user_id, lower(name))=(..., <tag name>) already exists` -- a tag name is
 * model output derived from the note's text, and spec §15.6 rule 1 says no note content reaches
 * a log line.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown; code?: unknown };
    if (typeof e.message === "string" && e.message !== "") {
      return typeof e.code === "string" && e.code !== "" ? `${e.code}: ${e.message}` : e.message;
    }
    // No message to read. Naming the constructor is still strictly better than "[object Object]",
    // which tells a reader nothing at all -- not even that the message was the part that was
    // missing. The keys are named, the VALUES are not: an unknown object's values are exactly
    // where note content would be hiding.
    return `non-Error thrown (${err.constructor?.name ?? "object"}; keys: ${Object.keys(err).join(",") || "none"})`;
  }
  return String(err);
}

// Thrown for rows the caller may not touch. Deliberately indistinguishable from
// "does not exist" -- a 403 would confirm the row exists (spec §6).
export function notFound(cause?: PostgrestError): CoreError {
  return { kind: "not_found", cause };
}
