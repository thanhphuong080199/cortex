// Moved to @cortex/shared in stage C4 so the web transcript pane can reach it -- apps/web
// depends on shared and not on core. Re-exported here under the same names so this module
// stays the one import site for the assistant's context and session rules.
export { SESSION_IDLE_RESET_MS, isStale, resolveCurrentSession } from "@cortex/shared";

/**
 * A token BUDGET, not a turn count: one turn may be a word and the next a pasted page
 * (parent spec §9).
 */
export const CONTEXT_TOKEN_BUDGET = 2000;

export interface ThreadTurn {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

// chars/4 -- the same English-biased estimate 00027's header records, and it errs the SAME
// way here as it does in the ledger, not the opposite way: under-counting means this filler
// accepts turns until the real token count is past the budget, not short of it. H3 in
// docs/phase-2-issue-log.md measures Vietnamese at 2-3 chars/token, so a full 2000-token
// window is nearer 3300-4000 real tokens. Kept anyway -- guessing a better divisor is the
// trade H3 rejected, and 2000 is our own window, not a model limit.
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
 * so the rendered prompt runs slightly OVER budget -- the SAME direction as `chars/4`'s
 * under-count, not the opposite one. Both push the rendered prompt past 2000, so treat 2000 as
 * a soft target that runs over, never as headroom Task 6 can spend.
 */
export function selectContext(turns: ThreadTurn[], budget = CONTEXT_TOKEN_BUDGET): ThreadTurn[] {
  // Plain `<`/`>`, never `localeCompare`: ICU collation weights `.` and `+` as punctuation
  // rather than by code point, so "2026-08-12T08:00:01+00:00".localeCompare(
  // "2026-08-12T08:00:01.113+00:00") is +1 -- claiming the whole second is LATER than the .113
  // that follows it. Plain comparison gets that pair right. Both spellings come from PostgREST,
  // which renders a row landing on a whole second with no fractional digits at all.
  // `Date.parse` would order every spelling correctly but returns NaN on an unparseable string,
  // and NaN in a comparator scrambles the array rather than failing; string comparison degrades
  // to leaving order alone, which is the safer failure.
  const ordered = [...turns].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
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
