import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPostgrestError } from "../errors.js";

export interface SaveAnswerArgs {
  userId: string;
  /** What is being saved: the model's contribution, not the whole reply. */
  statement: string;
  /** The web source it came from, when grounding produced one. Absent means general knowledge. */
  sourceUrl?: string;
}

/**
 * THE row for a saved answer, built in one place because it is reached two ways: the user taps
 * the saved-external chip's save action (life-domains §6.3), or they accept an offer the model
 * made (C5 §11). C5 §13 requires the two to be indistinguishable afterwards -- and the only way
 * to get that by construction rather than by discipline is for there to be one builder.
 *
 * The source type is the load-bearing field. search_notes down-weights 'web_search' and
 * 'assistant' by 0.8 (00022:92, 00024:127), which is how §6.3 handles corpus pollution: by
 * provenance rather than prohibition. Written as 'quick', this note would rank as the user's own
 * thinking and be cited back to them as something they wrote.
 *
 * No migration is needed for any of this. source_meta is `jsonb not null default '{}'` since
 * 00002, and both source types have been in notes_source_type_check since 00020.
 */
export function buildSavedAnswerRow(a: SaveAnswerArgs): Record<string, unknown> {
  return {
    user_id: a.userId,
    // `content`, not `content_text`: the latter is `generated always as
    // (strip_markdown(content)) stored` (00002_content.sql:7) and Postgres rejects a direct
    // insert into it. content_text derives from this automatically, the same way
    // NoteService.create() writes it (notes/service.ts:60).
    content: a.statement,
    // The inbox, like any other capture. Not pre-filed: saving is a deliberate act (§6.3), and
    // deciding where it belongs is a second one the user has not made yet.
    lifecycle: "inbox",
    // Grounded or not -- the distinction the user sees when this note is later cited.
    source_type: a.sourceUrl ? "web_search" : "assistant",
    // Spread-if, not `{ url: a.sourceUrl }`: an undefined value round-trips to an absent key on
    // one path and a null on another, and source_meta is a column two readers already parse.
    source_meta: a.sourceUrl ? { url: a.sourceUrl } : {},
  };
}

/**
 * Writes it. Takes the USER's client, so RLS is what proves ownership -- this is a note in the
 * user's own corpus and there is no reason for it to go through the service role.
 */
export async function saveAnswer(
  db: SupabaseClient,
  a: SaveAnswerArgs,
): Promise<{ id: string }> {
  const { data, error } = await db
    .from("notes").insert(buildSavedAnswerRow(a)).select("id").single();
  // Mapped, not rethrown raw: this runs on the HTTP path, and a raw PostgrestError has no
  // `status` and logs as "[object Object]" through CoreErrorFilter (errors.ts:9-13).
  if (error) throw mapPostgrestError(error);
  return { id: (data as { id: string }).id };
}
