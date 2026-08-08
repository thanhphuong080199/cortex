import type { SupabaseClient } from "@supabase/supabase-js";
import { pendingMediaItem, validateDomainMeta, type LogMediaInput } from "@cortex/shared";
import { mapPostgrestError, notFound } from "../errors.js";
import { anchoredIRegex } from "../like.js";
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
    // imatch (anchored, regex-escaped), not ilike: see like.ts for the two rounds of
    // wildcard bugs this replaces.
    const { data, error } = await this.client.from("media_items")
      .select().eq("user_id", this.userId).eq("kind", kind)
      .filter("title", "imatch", anchoredIRegex(title)).is("deleted_at", null);
    if (error) throw mapPostgrestError(error);
    // The lower() comparison is the authority, mirroring media_items_user_kind_title_uidx,
    // which this races with.
    const target = title.toLowerCase();
    return (data as MediaItem[]).find((i) => i.title.toLowerCase() === target) ?? null;
  }

  async findOrCreateItem(input: FindOrCreateItemInput): Promise<MediaItem> {
    return (await this.findOrCreate(input)).item;
  }

  private async findOrCreate(input: FindOrCreateItemInput): Promise<{ item: MediaItem; created: boolean }> {
    const existing = await this.findLiveByTitle(input.kind, input.title);
    if (existing) return { item: await this.reconcileYear(existing, input), created: false };

    const inserted = await this.client.from("media_items")
      .insert({
        user_id: this.userId, kind: input.kind, title: input.title,
        year: input.year ?? null, creator: input.creator ?? null,
      })
      .select().single();
    if (!inserted.error) return { item: inserted.data as MediaItem, created: true };

    // 23505 race: another request created it between the select and the insert --
    // retry the lookup once and return the existing row (same as TagService.findOrCreate).
    if (inserted.error.code === "23505") {
      const retry = await this.findLiveByTitle(input.kind, input.title);
      if (retry) return { item: await this.reconcileYear(retry, input), created: false };
    }
    throw mapPostgrestError(inserted.error);
  }

  // Item identity is (kind, lower(title)); year is descriptive metadata. But an
  // accepted-then-discarded input is how "Dune (1984)" silently attaches to the 2021
  // film -- so a missing year gets backfilled, and a contradicting one is a 409 the
  // caller has to resolve rather than a value that vanishes.
  private async reconcileYear(item: MediaItem, input: FindOrCreateItemInput): Promise<MediaItem> {
    if (input.year === undefined || item.year === input.year) return item;
    if (item.year !== null) {
      throw {
        kind: "conflict",
        message: `"${item.title}" already exists with year ${item.year}`,
      } as const;
    }
    const { data, error } = await this.client.from("media_items")
      .update({ year: input.year }).eq("id", item.id).eq("user_id", this.userId)
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as MediaItem;
  }

  async logMedia(input: LogMediaInput): Promise<{ item: MediaItem; note: Note }> {
    const { item, created } = await this.findOrCreate(input);

    // Only defined fields: an absent rating must stay absent rather than becoming null,
    // because domainMetaSchemas.media is strict and phase-7 signals count entries.
    const meta: Record<string, unknown> = { status: input.status ?? "finished" };
    if (input.rating !== undefined) meta.rating = input.rating;
    if (input.consumedAt !== undefined) meta.consumed_at = input.consumedAt;

    // Content is the impression and may be empty -- a rating alone is a valid log. The
    // note is what carries the impression into embeddings, links and digests later.
    const notes = new NoteService(this.client, this.userId);
    try {
      const note = await notes.create({
        content: input.impression ?? "",
        title: item.title,
        domain: "media",
        domainMeta: meta,
        mediaItemId: item.id,
      });
      return { item, note };
    } catch (err) {
      // No transaction spans the two PostgREST writes, so a failed note insert would
      // otherwise strand a just-created item in the library (and the autocomplete)
      // forever -- there is no delete surface for media_items. Best-effort compensation;
      // an item that existed before this call is left alone.
      if (created) {
        await this.client.from("media_items").delete()
          .eq("id", item.id).eq("user_id", this.userId).then(() => undefined, () => undefined);
      }
      throw err;
    }
  }

  /**
   * Links an offline-created media note to its canonical media_item (phase 1b spec §5.3).
   *
   * The device wrote the note with domain_meta.pending_item because media-item identity
   * is (user_id, kind, lower(title)) enforced by a unique index it could not consult
   * offline. Resolution runs here so findOrCreate's escaping, anchored imatch and year
   * reconciliation stay in exactly one implementation -- issue-log A3 and E6 are two
   * rounds of bugs in that logic, and a client-side copy would be a third.
   */
  async resolveNoteMediaLink(
    noteId: string,
    meta: Record<string, unknown>,
  ): Promise<MediaItem | null> {
    const parsed = pendingMediaItem.safeParse(meta.pending_item);
    if (!parsed.success) return null;

    // findOrCreate, not findOrCreateItem: the `created` flag is what makes the
    // compensation below correct -- an item that existed before this call must be left
    // alone even when the note update fails.
    const { item, created } = await this.findOrCreate(parsed.data);

    // pending_item is scaffolding, not data: leaving it behind would make the note
    // re-resolve on every subsequent upload.
    const { pending_item: _resolved, ...cleaned } = meta;

    // Every other write path validates before storing (NoteService.create/createWithId/
    // update). This one did not, so the sync router was a route by which a device could
    // put meta into the column that domainMetaSchemas.media rejects -- and phase 2 is what
    // has to read it back. Validated against "media" specifically: resolveNoteMediaLink is
    // only ever reached for a media note, since pending_item is a member of that schema
    // alone.
    const check = validateDomainMeta("media", cleaned);
    if (!check.success) {
      if (created) {
        await this.client.from("media_items").delete()
          .eq("id", item.id).eq("user_id", this.userId)
          .then(() => undefined, () => undefined);
      }
      throw {
        kind: "validation",
        message: "domain_meta does not fit domain \"media\"",
        cause: check.error,
      } as const;
    }

    const { data, error } = await this.client.from("notes")
      .update({ media_item_id: item.id, domain_meta: cleaned })
      // `.is("deleted_at", null)` matches NoteService.update/getById/softDelete. Without it a
      // trashed note still matched, so a link attached to a note the user had thrown away.
      // With it the row count is zero and the compensation below fires, which is the already
      // -tested behaviour for "this note cannot receive the link".
      .eq("id", noteId).eq("user_id", this.userId).is("deleted_at", null)
      .select("id").maybeSingle();

    // A missing or foreign noteId matches zero rows. WITHOUT the select this returns
    // success, and the item created moments ago becomes a permanent orphan -- there is no
    // delete surface for media_items. logMedia already compensates for exactly this shape
    // of failure; so must this.
    if (error || data === null) {
      if (created) {
        await this.client.from("media_items").delete()
          .eq("id", item.id).eq("user_id", this.userId)
          .then(() => undefined, () => undefined);
      }
      throw error ? mapPostgrestError(error) : notFound();
    }

    return item;
  }
}
