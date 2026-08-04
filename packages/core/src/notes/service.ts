import type { SupabaseClient } from "@supabase/supabase-js";
import { validateDomainMeta, type CreateNoteInput, type UpdateNoteInput } from "@cortex/shared";
import { mapPostgrestError } from "../errors.js";

export interface Note {
  id: string; user_id: string; title: string | null; content: string;
  lifecycle: string; source_type: string; pinned: boolean;
  domain: string | null; domain_meta: Record<string, unknown>; media_item_id: string | null;
  created_at: string; updated_at: string; deleted_at: string | null;
}

// domain_meta and media_item_id are not part of createNoteInput: the HTTP surface only
// takes `domain` (a one-tap chip), while structured meta comes from MediaService or, from
// phase 2, enrichment. This is defense-in-depth for the API path only, NOT enforcement:
// the notes grant and RLS policy are row-scoped, so a row's owner can write arbitrary
// domain_meta straight through PostgREST with their own JWT. Phase 2 must therefore
// validate meta on READ and treat what it finds as untrusted.
export interface CreateNoteOptions {
  domainMeta?: Record<string, unknown>;
  mediaItemId?: string;
}

// Services take a client + userId and know nothing about HTTP (spec §2.2).
// RLS enforces isolation; the explicit .eq("user_id") is belt-and-suspenders
// and makes zero-row results (→ not_found) deterministic in tests.
export class NoteService {
  constructor(private client: SupabaseClient, private userId: string) {}

  async create(input: CreateNoteInput & CreateNoteOptions): Promise<Note> {
    // domain_meta is untyped jsonb, so the only thing standing between a typo and a row
    // nobody can read back is this check. Meta without a domain is meaningless, hence
    // the pair being validated together rather than field by field in the DTO.
    const domainMeta = input.domainMeta ?? {};
    if (input.domain) {
      const check = validateDomainMeta(input.domain, domainMeta);
      if (!check.success) throw { kind: "internal", cause: check.error } as const;
    }
    const { data, error } = await this.client.from("notes")
      .insert({
        user_id: this.userId, content: input.content, title: input.title ?? null,
        domain: input.domain ?? null,
        domain_meta: domainMeta,
        media_item_id: input.mediaItemId ?? null,
      })
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as Note;
  }

  /**
   * create(), but with the id chosen by the caller. Only the sync upload path uses this:
   * the device already inserted this row into its local SQLite under this id, so the
   * server row must share it -- otherwise replication would deliver a second copy and the
   * user would see their note twice.
   */
  async createWithId(id: string, input: CreateNoteInput & CreateNoteOptions): Promise<Note> {
    // MUST be idempotent. PowerSync resends a batch whenever the response is lost -- a
    // dropped connection after the insert commits is ordinary, not exceptional -- and a
    // resend that throws on its own prior success would wedge the device's queue forever.
    // The id is client-chosen, so "this id already exists and is mine" means the write
    // already landed, not that two different rows collided.
    const domainMeta = input.domainMeta ?? {};
    if (input.domain) {
      // No stripping: `pending_item` is a legitimate member of domainMetaSchemas.media
      // (Task 4). It must PERSIST when resolution fails -- a year 409, say -- because it
      // is the only record of which item the note was trying to reach, and therefore the
      // only thing a retry could work from. Stripping it here would make that failure
      // silently unrecoverable.
      //
      // `validation`, not `internal` as create() throws for the identical check: this
      // input arrives from an untrusted mobile payload via the sync router, so a schema
      // mismatch here is a caller error, not a bug in our own code. The two methods
      // deliberately disagree on kind for that reason -- do not "fix" them to match.
      const check = validateDomainMeta(input.domain, domainMeta);
      if (!check.success) throw { kind: "validation", message: "domain_meta does not fit domain", cause: check.error } as const;
    }
    const { data, error } = await this.client.from("notes")
      .insert({
        id, user_id: this.userId, content: input.content, title: input.title ?? null,
        domain: input.domain ?? null, domain_meta: domainMeta,
        media_item_id: input.mediaItemId ?? null,
      })
      .select().single();
    if (error) {
      // 23505 on an id the caller already owns is a replayed op, not a conflict.
      if (error.code === "23505") return this.getById(id);
      throw mapPostgrestError(error);
    }
    return data as Note;
  }

  async update(id: string, input: UpdateNoteInput): Promise<Note> {
    // Patch on `!== undefined`, not truthiness: `title: null` means "clear the title"
    // and `content: ""` is a legitimate empty note.
    const patch: Record<string, unknown> = {};
    if (input.content !== undefined) patch.content = input.content;
    if (input.title !== undefined) patch.title = input.title;
    if (input.lifecycle !== undefined) patch.lifecycle = input.lifecycle;
    // `domain: null` clears a wrong domain; absent leaves it alone -- same asymmetry as title.
    if (input.domain !== undefined) patch.domain = input.domain;
    // Moving a note to a new domain must not carry meta the new domain's schema rejects
    // (a media note's {rating} patched to domain:"health" would otherwise persist a row
    // phase 2 can never read back). Clearing the domain skips this: meta without a
    // domain is dormant, and create() accepts that pairing too. Read-then-update race is
    // acceptable -- meta is service-written only, and the authority is validate-on-read.
    if (typeof input.domain === "string") {
      const { data: current, error: readError } = await this.client.from("notes")
        .select("domain_meta")
        .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
      if (readError) throw mapPostgrestError(readError);
      const check = validateDomainMeta(input.domain, current.domain_meta ?? {});
      if (!check.success) {
        throw {
          kind: "validation",
          message: `existing domain_meta does not fit domain "${input.domain}"; clear the domain first or use a matching domain`,
          cause: check.error,
        } as const;
      }
    }
    const { data, error } = await this.client.from("notes")
      .update(patch)
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .select().single();
    if (error) throw mapPostgrestError(error); // zero rows → PGRST116 → not_found
    return data as Note;
  }

  /**
   * The offline write path's update (phase 1b spec §6). `baseContent` is the note BODY the
   * client's edit was based on.
   *
   * Body conflicts are the only ones worth machinery: metadata columns are small and
   * independently settable, so last-write-wins on those is invisible, while
   * last-write-wins on a note body is silent, unrecoverable data loss.
   *
   * Comparison is on `content`, NOT `content_text` -- the latter is a generated column
   * (strip_markdown(content), 00002_content.sql:6) and is not client-writable, so two
   * genuinely different bodies can share one content_text.
   *
   * THE BASE IS A BODY, NOT A TIMESTAMP, and that is a correction rather than a preference.
   * `base_updated_at` produced a conflict copy on every single edit: `updated_at` is
   * server-owned (`default now()` plus the `notes_set_updated_at` trigger), so a device-created
   * note never holds the server's value, and even a downloaded one is written by PowerSync as
   * `...916374Z` against PostgREST's `...916374+00:00`. Comparing bodies needs no clock and no
   * agreement between two serialisers.
   *
   * An empty string is a real base -- a note edited down to nothing and then edited again --
   * so the guard tests `undefined`, not falsiness.
   */
  async updateWithConflictCopy(
    id: string,
    input: UpdateNoteInput,
    baseContent?: string,
  ): Promise<{ note: Note; conflictCopy: Note | null; linkFailed?: boolean }> {
    if (baseContent === undefined || input.content === undefined) {
      return { note: await this.update(id, input), conflictCopy: null };
    }

    const { data: current, error: readError } = await this.client.from("notes")
      .select("content")
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (readError) throw mapPostgrestError(readError);

    // "Someone changed the body since the client last saw it." Under the old timestamp form
    // this was `moved`, and it was true even when nobody had touched the note.
    const moved = current.content !== baseContent;
    const diverged = current.content !== input.content;
    if (!moved || !diverged) {
      return { note: await this.update(id, input), conflictCopy: null };
    }

    // Server body wins. Everything except content is still applied to it -- a lifecycle
    // change made offline is not in conflict with a body edit made on web.
    const { content: _losing, ...metadata } = input;
    const note = Object.keys(metadata).length > 0
      ? await this.update(id, metadata as UpdateNoteInput)
      : await this.getById(id);

    const conflictCopy = await this.create({
      content: input.content,
      title: note.title ?? undefined,
    });

    // The copy is the thing that must not be lost, so a failed link does NOT throw --
    // an untraceable-but-present note beats discarding the user's text to report an error.
    // But it must not vanish either: if `00015` were missing from an environment, every
    // conflict copy would silently become an orphan with nothing to notice it by. The flag
    // is how the caller finds out.
    const { error: linkError } = await this.client.from("links").insert({
      user_id: this.userId,
      from_note_id: conflictCopy.id,
      to_note_id: id,
      kind: "conflict_copy",
    });

    return { note, conflictCopy, ...(linkError ? { linkFailed: true } : {}) };
  }

  /** Reads one live note the caller owns. not_found for missing, deleted, or foreign. */
  async getById(id: string): Promise<Note> {
    const { data, error } = await this.client.from("notes")
      .select()
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error) throw mapPostgrestError(error);
    return data as Note;
  }

  async softDelete(id: string): Promise<{ id: string; deleted_at: string }> {
    const { data, error } = await this.client.from("notes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .select("id, deleted_at").single();
    if (error) throw mapPostgrestError(error);
    return data as { id: string; deleted_at: string };
  }

  async restore(id: string): Promise<Note> {
    const { data, error } = await this.client.from("notes")
      .update({ deleted_at: null })
      .eq("id", id).eq("user_id", this.userId).not("deleted_at", "is", null)
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as Note;
  }

  async purge(id: string): Promise<{ id: string }> {
    // Hard delete allowed ONLY from trash. delete() returns the deleted rows via
    // .select(); zero rows (live note / foreign / missing) → PGRST116 → not_found.
    const { data, error } = await this.client.from("notes")
      .delete()
      .eq("id", id).eq("user_id", this.userId).not("deleted_at", "is", null)
      .select("id").single();
    if (error) throw mapPostgrestError(error);
    return data as { id: string };
  }
}
