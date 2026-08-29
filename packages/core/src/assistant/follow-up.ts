/**
 * A gap worth exactly one question (S2 design §2).
 *
 * The rule is not "a meta field is missing" -- it is "the missing field is one without which no
 * ENTITY can exist". `media` qualifies because `media_items` is a real table that
 * `resolveNoteMediaLink` creates and reuses; without a title there is no row and the record is
 * unusable later. `health`, `finance` and `learning` do not, because their `domain_meta` is
 * decorative jsonb that nothing reads back -- answering creates nothing.
 *
 * That is what keeps the assistant from interviewing the user, and it is why S2 needs no
 * invented per-day quota: the trigger is rare by construction rather than by rate limit.
 *
 * A domain that later gains an entity table gets a branch here and inherits the whole mechanism
 * -- the prompt rule, the pending record, the cooldown and the backfill -- with no new policy.
 */
export interface EntityGap {
  domain: "media";
  /**
   * The dotted path of what is missing. Stored in `chat_messages.retrieval_meta.asked.field`, so
   * a later read can say what was asked for without re-deriving it from the note.
   */
  field: string;
  // `wants` -- the English phrase handed to followUpRule -- lived here until 2026-08-29. The
  // prompt no longer receives the gap at all: the reply is generated before classification
  // settles, and ENGAGE_RULE draws the question out generically. This interface now records only
  // what is written down, never what is asked for. Recoverable from git history.
}

/**
 * Pure: no database, no AI client, no clock. Everything it needs is already in `extractNote`'s
 * return value, which is why the follow-up costs no extra call.
 *
 * `meta` is the POST-VALIDATION meta (`extractNote`'s `domainMeta`), not the model's raw output.
 * That matters: a half-filled `pending_item` fails `domainMetaSchemas.media` and arrives here as
 * `{}`, which this function correctly reads as "no title".
 *
 * `detectEntityGap` no longer decides whether the assistant *asks* -- buildTurnPrompt renders no
 * gap-specific question at all, ENGAGE_RULE draws out one generic line unconditionally instead --
 * only whether the turn *records* that something was missing, for a later read to use.
 */
export function detectEntityGap(
  domain: string | null,
  meta: Record<string, unknown>,
): EntityGap | null {
  if (domain !== "media") return null;

  const pending = meta.pending_item;
  const title =
    typeof pending === "object" && pending !== null
      ? (pending as { title?: unknown }).title
      : undefined;

  // Trimmed, and a blank string counts as absent: pendingMediaItem is z.string().min(1), so "  "
  // could never have produced a media_items row either. Keying on `pending_item !== undefined`
  // instead would call a title-less pending_item complete.
  if (typeof title === "string" && title.trim() !== "") return null;

  return {
    domain: "media",
    field: "pending_item.title",
  };
}
