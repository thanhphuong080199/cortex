import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateTagInput } from "@cortex/shared";
import { mapPostgrestError, notFound } from "../errors.js";
import { anchoredIRegex } from "../like.js";

export interface Tag { id: string; user_id: string; name: string; color: string | null; created_by: string; created_at: string; deleted_at: string | null }
export interface NoteTag { id: string; note_id: string; tag_id: string; source: string; status: string }

export class TagService {
  constructor(private client: SupabaseClient, private userId: string) {}

  /**
   * note_tags' RLS policy only constrains `user_id`, and Postgres evaluates the foreign
   * keys to notes/tags as the table owner -- which bypasses RLS. Nothing in the database
   * therefore stops one user from linking their tag to ANOTHER user's note, so ownership
   * has to be checked here. Missing, foreign and soft-deleted rows all surface as
   * not_found so they stay indistinguishable (spec §6).
   */
  private async assertOwnedAndLive(table: "notes" | "tags", id: string): Promise<void> {
    const { data, error } = await this.client.from(table)
      .select("id").eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .maybeSingle();
    if (error) throw mapPostgrestError(error);
    if (!data) throw notFound();
  }

  /** Live tag whose name matches case-insensitively, or null. */
  private async findLiveByName(name: string): Promise<Tag | null> {
    // imatch (anchored, regex-escaped), not ilike: see like.ts for the wildcard bugs.
    const { data, error } = await this.client.from("tags")
      .select().eq("user_id", this.userId)
      .filter("name", "imatch", anchoredIRegex(name))
      .is("deleted_at", null);
    if (error) throw mapPostgrestError(error);
    // The lower() comparison is the authority, mirroring the tags_user_name_uidx index
    // this find-or-create races with.
    const target = name.toLowerCase();
    return (data as Tag[]).find((t) => t.name.toLowerCase() === target) ?? null;
  }

  async findOrCreate(input: CreateTagInput): Promise<Tag> {
    const existing = await this.findLiveByName(input.name);
    if (existing) return existing;

    const inserted = await this.client.from("tags")
      .insert({ user_id: this.userId, name: input.name, color: input.color ?? null, created_by: "user" })
      .select().single();
    if (!inserted.error) return inserted.data as Tag;

    // 23505 race: another request created it between our select and insert --
    // retry the lookup once and return the existing row (spec §6).
    if (inserted.error.code === "23505") {
      const retry = await this.findLiveByName(input.name);
      if (retry) return retry;
    }
    throw mapPostgrestError(inserted.error);
  }

  async attach(noteId: string, tagId: string): Promise<NoteTag> {
    await this.assertOwnedAndLive("notes", noteId);
    await this.assertOwnedAndLive("tags", tagId);

    const { data, error } = await this.client.from("note_tags")
      .insert({ user_id: this.userId, note_id: noteId, tag_id: tagId, source: "user", status: "accepted" })
      .select("id, note_id, tag_id, source, status").single();
    if (error) {
      // Defense in depth behind the checks above: an FK violation (23503) or RLS check
      // failure (42501) must also read as "does not exist", never as 403 (spec §6).
      if (error.code === "23503" || error.code === "42501") throw notFound(error);
      throw mapPostgrestError(error); // 23505 (already attached) → conflict
    }
    return data as NoteTag;
  }

  async detach(noteId: string, tagId: string): Promise<void> {
    const { error } = await this.client.from("note_tags")
      .update({ deleted_at: new Date().toISOString() })
      .eq("user_id", this.userId).eq("note_id", noteId).eq("tag_id", tagId)
      .is("deleted_at", null)
      .select("id").single();
    if (error) throw mapPostgrestError(error); // zero rows → PGRST116 → not_found
  }
}
