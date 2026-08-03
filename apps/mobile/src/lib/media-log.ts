import type { MediaKind, MediaStatus } from "@cortex/shared";

import { NOW_ISO } from "./sql.js";

/**
 * Offline media logging (spec §5.3): the log is written as an ORDINARY NOTE carrying
 * `domain_meta.pending_item`, with `media_item_id` left null.
 *
 * Item identity is `(user_id, kind, lower(title))`, enforced by a unique index this device
 * cannot consult offline, so the server resolves it on upload through
 * `MediaService.resolveNoteMediaLink` -- keeping the escaping, anchored imatch and year
 * reconciliation of issue-log A3/E6 in exactly one implementation. The note itself is never
 * delayed; only the item link materialises after reconnect.
 */
export interface MediaLogTarget {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface MediaLogInput {
  kind: MediaKind;
  title: string;
  status: MediaStatus;
  rating: number | null;
  impression: string;
}

export const LOG_MEDIA_SQL = `INSERT INTO notes (id, content, title, domain, domain_meta, lifecycle,
                    source_type, pinned, created_at, updated_at)
     VALUES (uuid(), ?, ?, 'media', ?, 'inbox', 'quick', 0, ${NOW_ISO}, ${NOW_ISO})`;

/**
 * Builds the `domain_meta` payload, which the server re-validates against
 * `domainMetaSchemas.media` -- a `.strict()` schema.
 *
 * Strict is why absent-versus-null matters here. `rating: null` is not "no rating" to that
 * schema, it is a value of the wrong type, and the op is reported in `failed` inside a 200
 * response, so the log would be dropped with nothing surfaced. The key is omitted instead.
 *
 * The title is trimmed before it goes in, not after: `pending_item.title` is what the server
 * matches against `lower(title)` for identity, so " Dune " and "Dune" have to collapse to one
 * item here or they become two.
 */
export function buildMediaMeta(input: MediaLogInput): Record<string, unknown> {
  return {
    status: input.status,
    pending_item: { kind: input.kind, title: input.title.trim() },
    ...(input.rating !== null ? { rating: input.rating } : {}),
  };
}

/** Returns false without writing when there is no title to identify the item by. */
export async function logMedia(db: MediaLogTarget, input: MediaLogInput): Promise<boolean> {
  const title = input.title.trim();
  if (!title) return false;
  await db.execute(LOG_MEDIA_SQL, [
    input.impression,
    title,
    JSON.stringify(buildMediaMeta(input)),
  ]);
  return true;
}
