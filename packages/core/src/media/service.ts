import type { SupabaseClient } from "@supabase/supabase-js";
import type { LogMediaInput } from "@cortex/shared";
import { mapPostgrestError } from "../errors.js";
import { escapeLike } from "../like.js";
import { NoteService, type Note } from "../notes/service.js";

export interface MediaItem {
  id: string; user_id: string; kind: string; title: string;
  year: number | null; creator: string | null;
  external_meta: Record<string, unknown>;
  created_at: string; deleted_at: string | null;
}

export interface FindOrCreateItemInput {
  kind: string; title: string; year?: number; creator?: string;
}

// The media *item* is an entity; the *log* is a note (life-domains spec §2.2, the
// Letterboxd model). A rewatch is a second note against the same item, each carrying its
// own rating and impression in domain_meta -- never a second item.
export class MediaService {
  constructor(private client: SupabaseClient, private userId: string) {}

  /** Live item whose title matches case-insensitively within the kind, or null. */
  private async findLiveByTitle(kind: string, title: string): Promise<MediaItem | null> {
    const { data, error } = await this.client.from("media_items")
      .select().eq("user_id", this.userId).eq("kind", kind)
      .ilike("title", escapeLike(title)).is("deleted_at", null);
    if (error) throw mapPostgrestError(error);
    // The escaped ilike should already be a literal match; the lower() comparison is the
    // authority, mirroring media_items_user_kind_title_uidx, which this races with.
    const target = title.toLowerCase();
    return (data as MediaItem[]).find((i) => i.title.toLowerCase() === target) ?? null;
  }

  async findOrCreateItem(input: FindOrCreateItemInput): Promise<MediaItem> {
    const existing = await this.findLiveByTitle(input.kind, input.title);
    if (existing) return existing;

    const inserted = await this.client.from("media_items")
      .insert({
        user_id: this.userId, kind: input.kind, title: input.title,
        year: input.year ?? null, creator: input.creator ?? null,
      })
      .select().single();
    if (!inserted.error) return inserted.data as MediaItem;

    // 23505 race: another request created it between the select and the insert --
    // retry the lookup once and return the existing row (same as TagService.findOrCreate).
    if (inserted.error.code === "23505") {
      const retry = await this.findLiveByTitle(input.kind, input.title);
      if (retry) return retry;
    }
    throw mapPostgrestError(inserted.error);
  }

  async logMedia(input: LogMediaInput): Promise<{ item: MediaItem; note: Note }> {
    const item = await this.findOrCreateItem(input);

    // Only defined fields: an absent rating must stay absent rather than becoming null,
    // because domainMetaSchemas.media is strict and phase-7 signals count entries.
    const meta: Record<string, unknown> = { status: "finished" };
    if (input.rating !== undefined) meta.rating = input.rating;
    if (input.consumedAt !== undefined) meta.consumed_at = input.consumedAt;

    // Content is the impression and may be empty -- a rating alone is a valid log. The
    // note is what carries the impression into embeddings, links and digests later.
    const notes = new NoteService(this.client, this.userId);
    const note = await notes.create({
      content: input.impression ?? "",
      title: item.title,
      domain: "media",
      domainMeta: meta,
      mediaItemId: item.id,
    });
    return { item, note };
  }
}
