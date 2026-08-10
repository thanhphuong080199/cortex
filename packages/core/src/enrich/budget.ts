import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * No-op placeholder. Task 12 adds the usage_ledger table and the budget gate, and fills this
 * in (with its own tests) to insert a row per model call. Declared here, ahead of that table
 * existing, so embed.ts (Task 10) and extract.ts (Task 11) can call it now and Task 12 only
 * has to change this one function's body -- neither step's callers or tests change.
 */
export async function recordUsage(
  _db: SupabaseClient,
  _usage: { userId: string; kind: "embed" | "extract"; model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  // Intentionally empty until Task 12.
}
