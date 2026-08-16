/**
 * An idle gap rather than a calendar boundary, so someone writing at 1am is not cut
 * mid-thought.
 */
export const SESSION_IDLE_RESET_MS = 4 * 60 * 60 * 1000;

/** No history is stale: a first message starts a session rather than joining one. */
export function isStale(lastMessageAt: string | null, now: Date): boolean {
  if (lastMessageAt === null) return true;
  return now.getTime() - new Date(lastMessageAt).getTime() >= SESSION_IDLE_RESET_MS;
}

/**
 * THE answer to "which session is the user currently in?", given their most recent message.
 * `null` means there is no live session -- either nothing was ever written, or the idle gap
 * has passed and the next turn will open a new one.
 *
 * Two callers, one function, for the reason recorded in notes/filters.ts: this narrowing
 * existed in `turn.ts` alone, and stage C4 adds a second consumer (the web transcript pane)
 * that has to reach the SAME answer. A pane that computed it separately would drift the day
 * the gap changed, and the symptom -- yesterday's conversation rendered above today's first
 * reply -- looks like a sync bug rather than a duplicated constant.
 *
 * It lives in @cortex/shared and not @cortex/core for the same reason applyNoteFilters does:
 * apps/web depends on @cortex/shared only, and core's barrel reaches Node builtins that a
 * bundler must then follow into a "use client" component. Core re-exports it.
 *
 * The row shape is snake_case because both callers hand it a PostgREST row verbatim; mapping
 * it into camelCase first would be a second place for the column names to be written down.
 */
export function resolveCurrentSession(
  last: { session_id: string; created_at: string } | null,
  now: Date,
): string | null {
  if (last === null) return null;
  return isStale(last.created_at, now) ? null : last.session_id;
}
