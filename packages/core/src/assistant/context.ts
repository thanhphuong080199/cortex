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
 * Turns are sorted by `createdAt` ascending on a COPY before the budget is filled, so the
 * result is returned oldest-first regardless of input order and the caller's array is never
 * mutated. Recency is read off `createdAt`, not off array position: a caller handing us
 * `order by created_at desc limit N` -- the natural shape of a "recent turns" query -- would
 * otherwise get the OLDEST turns back, plausibly shaped and silently wrong.
 *
 * Whole turns only. Half an exchange is worse than none, because the model reads a truncated
 * question as the whole question -- so a single turn larger than the entire budget yields
 * nothing rather than a fragment.
 *
 * Budget note for the renderer: only `content` is charged. The per-turn framing the prompt
 * adds around it (role labels, separators) is real in the rendered string but uncharged here,
 * so the rendered prompt runs slightly OVER budget -- the opposite direction from `chars/4`'s
 * under-count. That is why 2000 is a soft target carrying headroom, not a hard ceiling.
 */
export function selectContext(turns: ThreadTurn[], budget = CONTEXT_TOKEN_BUDGET): ThreadTurn[] {
  const ordered = [...turns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const kept: ThreadTurn[] = [];
  let used = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const t = ordered[i]!;
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
