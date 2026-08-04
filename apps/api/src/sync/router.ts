import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CheckinService, MediaService, NoteService, mapPostgrestError, type CoreErrorKind,
} from "@cortex/core";
import type { SyncOp } from "@cortex/shared";

export interface SyncUploadResult {
  applied: string[];
  failed: { op_id: string; kind: CoreErrorKind; message?: string }[];
  conflict_copies: { op_id: string; note_id: string }[];
  resolved_media: { op_id: string; note_id: string }[];
  // op_ids whose conflict copy was written but its `conflict_copy` link could not be --
  // see NoteService.updateWithConflictCopy. The copy itself is never lost; this is how a
  // caller finds the ones that need re-linking.
  link_failures: string[];
  // A note whose write landed but whose media resolution then failed -- e.g. a year
  // conflict from MediaService.resolveNoteMediaLink. NOT `failed`: the note already
  // exists, so a PowerSync resend cannot help and would only wedge the queue.
  media_unresolved: { op_id: string; note_id: string; kind: CoreErrorKind }[];
}

/**
 * Reads `domain_meta` off a CRUD op, in EITHER of the two shapes that legitimately arrive.
 *
 * The device sends a STRING. PowerSync's local schema has no jsonb type, so
 * `packages/sync/src/schema.ts` declares `domain_meta: column.text` and the row's value is the
 * serialised JSON. Every op from a phone therefore carries `"{}"`, not `{}`. The API's own
 * clients send the object.
 *
 * `(data.domain_meta ?? {}) as Record<string, unknown>` -- what this replaced -- is a cast, so
 * it silenced the difference instead of handling it, and every consequence was silent:
 *
 *   - With a domain set, `validateDomainMeta` parses a string against an object schema, fails,
 *     and `createWithId` throws `validation`. The op is reported in `failed` while the request
 *     is still 200, so the connector completes the batch and the note is dropped -- present on
 *     the device forever, never on the server, with nothing surfaced to the user.
 *   - With no domain the string reaches PostgREST and lands in the jsonb column as the JSON
 *     STRING "{}" rather than the object {}, which every later reader has to cope with.
 *   - `domainMeta.pending_item` on a string is undefined, so an offline media log never
 *     resolves its media item (spec §5.3) and reports nothing either.
 *
 * Malformed or non-object JSON throws `validation` rather than defaulting to `{}`: a device
 * that serialises this wrongly needs to show up in `failed`, not to have its metadata quietly
 * discarded while the note saves.
 */
export function readDomainMeta(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};

  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw { kind: "validation", message: "domain_meta is not valid JSON", cause } as const;
    }
    // `null` parses fine and is not an object; so do `5`, `"x"` and `[]`. An array is the
    // dangerous one -- typeof [] is "object", so only the Array check keeps it out.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw { kind: "validation", message: "domain_meta must be a JSON object" } as const;
    }
    return parsed as Record<string, unknown>;
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw { kind: "validation", message: "domain_meta must be a JSON object" } as const;
  }
  return raw as Record<string, unknown>;
}

function asCoreError(err: unknown): { kind: CoreErrorKind; message?: string } {
  const e = err as { kind?: CoreErrorKind; message?: string };
  return e?.kind
    ? (e.message ? { kind: e.kind, message: e.message } : { kind: e.kind })
    : { kind: "internal" };
}

/**
 * Replays a PowerSync CRUD batch through the core services (phase 1b spec §5.1).
 *
 * An operation ROUTER, not a generic row-writer. A generic writer would be thinner and
 * would bypass the entire validation layer, leaving every invariant built in phase 1c
 * unenforced on the mobile write path -- domain_meta re-validation (issue-log B3), media
 * item identity (A3/E6), and conflict copies would all simply not happen.
 *
 * Ops are applied sequentially and independently: one bad op is reported, not fatal, so a
 * single unresolvable row cannot wedge a device's queue forever.
 */
export async function applySyncOps(
  client: SupabaseClient,
  userId: string,
  ops: SyncOp[],
): Promise<SyncUploadResult> {
  const notes = new NoteService(client, userId);
  const media = new MediaService(client, userId);
  const checkins = new CheckinService(client, userId);

  const result: SyncUploadResult = {
    applied: [], failed: [], conflict_copies: [], resolved_media: [],
    link_failures: [], media_unresolved: [],
  };

  for (const op of ops) {
    try {
      switch (op.table) {
        case "notes":
          await applyNoteOp(op, notes, media, result);
          break;
        case "checkins":
          if (op.op === "DELETE") await checkins.softDelete(op.id);
          else if (op.op === "PUT") {
            await checkins.createWithId(op.id, {
              mood: op.data?.mood as number | undefined,
              energy: op.data?.energy as number | undefined,
              label: op.data?.label as string | undefined,
            });
          } else throw { kind: "validation", message: "checkins are insert-or-delete only" };
          break;
        default:
          await applyGenericOp(client, userId, op);
      }
      result.applied.push(op.op_id);
    } catch (err) {
      result.failed.push({ op_id: op.op_id, ...asCoreError(err) });
    }
  }
  return result;
}

async function applyNoteOp(
  op: SyncOp,
  notes: NoteService,
  media: MediaService,
  result: SyncUploadResult,
): Promise<void> {
  if (op.op === "DELETE") { await notes.softDelete(op.id); return; }

  const data = (op.data ?? {}) as Record<string, unknown>;
  const domainMeta = readDomainMeta(data.domain_meta);

  if (op.op === "PUT") {
    // The id comes from the device so the local optimistic row and the server row are the
    // same row -- replication then patches rather than duplicating.
    await notes.createWithId(op.id, {
      content: String(data.content ?? ""),
      title: data.title === null || data.title === undefined ? undefined : String(data.title),
      domain: data.domain as never,
      domainMeta,
    });
  } else {
    // `deleted_at` is a PATCH field, not just a DELETE op. The device trashes and restores with
    // an UPDATE (`TRASH_NOTE_SQL` / `RESTORE_NOTE_SQL`), and PowerSync emits every UPDATE as a
    // PATCH -- so trash arrives here, not in the DELETE branch above. Left out of `patch` it was
    // dropped silently: the update ran with an empty body, the op still reported applied, and
    // the next sync delivered the still-live row back to the phone. The note the user trashed
    // reappeared, and nothing anywhere reported a problem.
    //
    // Routed to softDelete/restore rather than patched through: both carry the guard that makes
    // them idempotent-ish (`is deleted_at null` / `not is null`) and softDelete is what the
    // DELETE op already uses, so the two paths cannot drift.
    // A restore runs BEFORE the patch and a soft delete AFTER it, because `update` only matches
    // live rows: patch-then-restore leaves the edit rejected as not_found, and delete-then-patch
    // does the same. Ordering it this way makes the row live for exactly as long as the patch
    // needs it, in both directions.
    if (data.deleted_at === null) await notes.restore(op.id);

    const patch = {
      ...(data.content !== undefined ? { content: String(data.content) } : {}),
      ...(data.title !== undefined ? { title: data.title as string | null } : {}),
      ...(data.lifecycle !== undefined ? { lifecycle: data.lifecycle as never } : {}),
      ...(data.domain !== undefined ? { domain: data.domain as never } : {}),
    };
    // An UPDATE that only touched deleted_at leaves nothing to patch, and `update()` rejects an
    // empty body -- so the trash op would fail on the work it had just done. Skipped rather
    // than returned, because the media resolution below still has to run.
    if (Object.keys(patch).length > 0) {
      const r = await notes.updateWithConflictCopy(op.id, patch, op.base_content);
      if (r.conflictCopy) {
        result.conflict_copies.push({ op_id: op.op_id, note_id: r.conflictCopy.id });
        // The copy itself is never dropped (that flag exists precisely so it isn't), but a
        // failed link would otherwise vanish from this response with nothing to notice it by.
        if (r.linkFailed) result.link_failures.push(op.op_id);
      }
    }

    if (data.deleted_at !== undefined && data.deleted_at !== null) await notes.softDelete(op.id);
  }

  // Offline media logs arrive as ordinary notes carrying pending_item; identity is
  // resolved here because the device could not consult the unique index (spec §5.3).
  //
  // Resolution failure must NOT fail the op. The note is already durably written, so
  // reporting `failed` would make PowerSync resend an op whose resend cannot help -- and
  // before createWithId became idempotent, that resend threw 23505 before ever reaching
  // this code, wedging the note's pending_item unresolved forever. A year 409 is the
  // realistic trigger and it does not clear on retry, so it needs a report, not a loop.
  if (domainMeta.pending_item !== undefined) {
    try {
      const item = await media.resolveNoteMediaLink(op.id, domainMeta);
      if (item) result.resolved_media.push({ op_id: op.op_id, note_id: op.id });
    } catch (err) {
      result.media_unresolved.push({
        op_id: op.op_id, note_id: op.id, kind: asCoreError(err).kind,
      });
    }
  }
}

/**
 * Tables with no service of their own: tags, note_tags, links, media_items. These are
 * join/lookup rows with no invariants beyond RLS and their own constraints, so a
 * validated generic write is the honest shape -- inventing a service to route through
 * would be indirection without a rule to enforce.
 */
async function applyGenericOp(
  client: SupabaseClient, userId: string, op: SyncOp,
): Promise<void> {
  // Every branch selects and routes through mapPostgrestError. Without the select, a
  // PATCH or DELETE against a missing or already-deleted row matches zero rows, PostgREST
  // returns no error, and the op lands in `applied` while nothing changed -- the device
  // believes an edit stuck when it did not. CheckinService.softDelete and
  // NoteService.softDelete both already use .select().single() for exactly this reason.
  // Raw PostgrestErrors must not escape either: asCoreError has no `kind` to read off one,
  // so it would flatten a 23505 or a check-constraint violation into "internal" and the
  // client could not tell a retryable failure from a server fault.
  if (op.op === "DELETE") {
    const { error } = await client.from(op.table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", op.id).eq("user_id", userId).is("deleted_at", null)
      .select("id").single();
    if (error) throw mapPostgrestError(error);   // zero rows → PGRST116 → not_found
    return;
  }
  if (op.op === "PUT") {
    const row = { ...(op.data ?? {}), id: op.id, user_id: userId };
    const { error } = await client.from(op.table).upsert(row).select("id").single();
    if (error) throw mapPostgrestError(error);
    return;
  }
  const { error } = await client.from(op.table)
    .update(op.data ?? {}).eq("id", op.id).eq("user_id", userId)
    .select("id").single();
  if (error) throw mapPostgrestError(error);
}
