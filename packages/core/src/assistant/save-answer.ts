import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage, mapPostgrestError } from "../errors.js";

export interface SaveAnswerArgs {
  userId: string;
  /** What is being saved: the model's contribution, not the whole reply. */
  statement: string;
  /** The web source it came from, when grounding produced one. Absent means general knowledge. */
  sourceUrl?: string;
  /**
   * The `chat_messages` row this save came from, when the caller has a real one. Used only to
   * mark that message saved (see `markMessageSaved`) -- never written onto the note row itself,
   * which stays exactly `buildSavedAnswerRow`'s five columns.
   */
  forMessageId?: string;
}

/**
 * THE row for a saved answer, built in one place because it is reached today by the offer's
 * accept action (C5 §11). The second path -- the user-initiated save trigger §6.3 describes --
 * is not built yet by this plan; when it lands it must come through this same function, which is
 * what makes the two indistinguishable BY CONSTRUCTION rather than by discipline, per C5 §13.
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
 * The "already saved" indicator's durable half (reported 2026-08-24: it forgot on every
 * refresh, because `saved` on both clients was `useState` alone -- see assistant-box.tsx). Marks
 * the source message rather than the note: `buildSavedAnswerRow`'s own test pins the note's
 * column set exactly, on purpose, so a link back has to live on the OTHER side.
 *
 * Read-modify-write, not a single `update`: PostgREST replaces a jsonb column wholesale rather
 * than merging into it, and `retrieval_meta` already carries `requestId`/`asked`/`answeredAsk`
 * that a bare `update({ retrieval_meta: { savedAnswerNoteId } })` would erase. No migration adds
 * a merge RPC for this -- it is a low-frequency, latency-insensitive write.
 *
 * Best-effort: the note above is already written and IS the deliverable. A failed link must not
 * turn a successful save into a failed one -- the same trade turn.ts's S2 backfill makes for the
 * same reason.
 */
async function markMessageSaved(
  db: SupabaseClient,
  a: { messageId: string; noteId: string },
): Promise<void> {
  try {
    const { data } = await db
      .from("chat_messages").select("retrieval_meta").eq("id", a.messageId).maybeSingle();
    const current = (data as { retrieval_meta: Record<string, unknown> | null } | null)
      ?.retrieval_meta ?? {};
    await db.from("chat_messages")
      .update({ retrieval_meta: { ...current, savedAnswerNoteId: a.noteId } })
      .eq("id", a.messageId);
  } catch (err) {
    console.error(`[notes] could not mark message ${a.messageId} saved: ${errorMessage(err)}`);
  }
}

/**
 * Writes it. Takes the USER's client, so RLS is what proves ownership -- this is a note in the
 * user's own corpus and there is no reason for it to go through the service role. The same client
 * is what scopes `markMessageSaved`'s read and write to this user's own messages, with no
 * redundant `user_id` filter needed alongside it.
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
  const noteId = (data as { id: string }).id;

  if (a.forMessageId !== undefined) {
    await markMessageSaved(db, { messageId: a.forMessageId, noteId });
  }

  return { id: noteId };
}
