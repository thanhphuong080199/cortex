import type { SupabaseClient } from "@supabase/supabase-js";
import { CheckinService, MediaService, NoteService, type CoreErrorKind } from "@cortex/core";
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
    applied: [], failed: [], conflict_copies: [], resolved_media: [], link_failures: [],
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
            await client.from("checkins").insert({
              id: op.id, user_id: userId,
              mood: op.data?.mood ?? null,
              energy: op.data?.energy ?? null,
              label: op.data?.label ?? null,
            }).select().single().then(({ error }) => { if (error) throw error; });
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
  const domainMeta = (data.domain_meta ?? {}) as Record<string, unknown>;

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
    const patch = {
      ...(data.content !== undefined ? { content: String(data.content) } : {}),
      ...(data.title !== undefined ? { title: data.title as string | null } : {}),
      ...(data.lifecycle !== undefined ? { lifecycle: data.lifecycle as never } : {}),
      ...(data.domain !== undefined ? { domain: data.domain as never } : {}),
    };
    const r = await notes.updateWithConflictCopy(op.id, patch, op.base_updated_at);
    if (r.conflictCopy) {
      result.conflict_copies.push({ op_id: op.op_id, note_id: r.conflictCopy.id });
      // The copy itself is never dropped (that flag exists precisely so it isn't), but a
      // failed link would otherwise vanish from this response with nothing to notice it by.
      if (r.linkFailed) result.link_failures.push(op.op_id);
    }
  }

  // Offline media logs arrive as ordinary notes carrying pending_item; identity is
  // resolved here because the device could not consult the unique index (spec §5.3).
  if (domainMeta.pending_item !== undefined) {
    const item = await media.resolveNoteMediaLink(op.id, domainMeta);
    if (item) result.resolved_media.push({ op_id: op.op_id, note_id: op.id });
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
  if (op.op === "DELETE") {
    const { error } = await client.from(op.table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", op.id).eq("user_id", userId).is("deleted_at", null);
    if (error) throw error;
    return;
  }
  const row = { ...(op.data ?? {}), id: op.id, user_id: userId };
  const { error } = op.op === "PUT"
    ? await client.from(op.table).upsert(row).select().single()
    : await client.from(op.table).update(op.data ?? {}).eq("id", op.id).eq("user_id", userId);
  if (error) throw error;
}
