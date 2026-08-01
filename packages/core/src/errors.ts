import type { PostgrestError } from "@supabase/supabase-js";

export type CoreErrorKind = "not_found" | "conflict" | "internal";
export interface CoreError { kind: CoreErrorKind; cause?: PostgrestError }

// Keeps PostgREST codes from leaking into HTTP responses (spec §6).
export function mapPostgrestError(error: PostgrestError): CoreError {
  if (error.code === "PGRST116") return { kind: "not_found", cause: error };
  if (error.code === "23505") return { kind: "conflict", cause: error };
  return { kind: "internal", cause: error };
}

// Thrown for rows the caller may not touch. Deliberately indistinguishable from
// "does not exist" -- a 403 would confirm the row exists (spec §6).
export function notFound(cause?: PostgrestError): CoreError {
  return { kind: "not_found", cause };
}
