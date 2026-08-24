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
  /**
   * What the acknowledge prompt is told to ask for. English, like every other prompt rule --
   * LANGUAGE_RULE is what decides the language the reply comes back in.
   */
  wants: string;
}

/**
 * Pure: no database, no AI client, no clock. Everything it needs is already in `extractNote`'s
 * return value, which is why the follow-up costs no extra call.
 *
 * `meta` is the POST-VALIDATION meta (`extractNote`'s `domainMeta`), not the model's raw output.
 * That matters: a half-filled `pending_item` fails `domainMetaSchemas.media` and arrives here as
 * `{}`, which this function correctly reads as "no title".
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
    // Deliberately covers all three media kinds rather than naming one: the classifier may have
    // returned no `kind` either, and "which film was it" about a book is worse than a vague ask.
    wants: "which film, series or book it was",
  };
}
