/**
 * A token BUDGET, not a turn count: one turn may be a word and the next a pasted page
 * (parent spec §9).
 */
export const CONTEXT_TOKEN_BUDGET = 2000;

/**
 * An idle gap rather than a calendar boundary, so someone writing at 1am is not cut
 * mid-thought.
 */
export const SESSION_IDLE_RESET_MS = 4 * 60 * 60 * 1000;

export interface ThreadTurn {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

// chars/4 -- the same English-biased estimate 00027's header records, and SAFE here in a way
// it is not in the ledger: under-counting Vietnamese means the window holds fewer real tokens
// than budgeted, never more. Erring small is the harmless direction for a prompt budget.
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Newest-first while filling the budget, then reversed: the prompt reads oldest-first, which
 * is chronological order, while the thing being protected is the NEWEST context.
 *
 * Whole turns only. Half an exchange is worse than none, because the model reads a truncated
 * question as the whole question -- so a single turn larger than the entire budget yields
 * nothing rather than a fragment.
 */
export function selectContext(turns: ThreadTurn[], budget = CONTEXT_TOKEN_BUDGET): ThreadTurn[] {
  const kept: ThreadTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const cost = estimateTokens(t.content);
    if (used + cost > budget) break;
    used += cost;
    kept.push(t);
  }
  return kept.reverse();
}

/** No history is stale: a first message starts a session rather than joining one. */
export function isStale(lastMessageAt: string | null, now: Date): boolean {
  if (lastMessageAt === null) return true;
  return now.getTime() - new Date(lastMessageAt).getTime() >= SESSION_IDLE_RESET_MS;
}
