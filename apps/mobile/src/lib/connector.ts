import type {
  CommonPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
} from "@powersync/common";
import { SYNC_UPLOAD_MAX_OPS, type SyncOp } from "@cortex/shared";

import { supabase } from "./supabase.js";

/**
 * PowerSync's CrudEntry in the shape POST /sync/upload validates.
 *
 * Types come from `@powersync/common`, not `@powersync/react-native`. They are the same
 * declarations -- the RN package re-exports the common barrel -- but `@powersync/common` is the
 * one that parses under plain Node, so a future value import here fails loudly at the import
 * rather than as a Rollup Flow parse error deep inside React Native.
 */
export function crudEntryToSyncOp(entry: CrudEntry, baseUpdatedAt?: string): SyncOp {
  const op: SyncOp = {
    op_id: String(entry.clientId),
    op: entry.op as SyncOp["op"],
    table: entry.table as SyncOp["table"],
    id: entry.id,
    // `data` is omitted entirely on a DELETE rather than sent empty: the server's schema makes
    // it nullish, so an empty object would validate and mean "delete, and also apply nothing".
    // On a write it is `{}` at worst -- `opData` is undefined when no column changed, and
    // undefined would serialise the key away and turn a no-op write into a silent drop.
    ...(entry.op === "DELETE" ? {} : { data: entry.opData ?? {} }),
  };
  // Only note bodies get conflict-copy treatment (spec §6.1); a base on any other table
  // would be meaningless and the server ignores it, so do not send one. The `op` half of this
  // guard matters as much as the `table` half: a base on a PUT would tell the server a
  // full-row overwrite was based on a revision, manufacturing a conflict copy for a create.
  if (baseUpdatedAt && entry.table === "notes" && entry.op === "PATCH") {
    op.base_updated_at = baseUpdatedAt;
  }
  return op;
}

/**
 * Routes local writes through the API rather than straight at Postgres: the server replays
 * each op through the core services, so domain_meta validation, media-item identity and
 * conflict copies all still happen on the mobile write path (spec §5.1). Writes execute
 * with the user's JWT -- RLS is the enforcement.
 */
export class ApiConnector implements PowerSyncBackendConnector {
  async fetchCredentials() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return null;
    return {
      endpoint: process.env.EXPO_PUBLIC_POWERSYNC_URL!,
      token: session.access_token,
    };
  }

  async uploadData(database: CommonPowerSyncDatabase): Promise<void> {
    // The limit is NOT optional. Unbounded, this can return more ops than `syncUploadInput`
    // accepts; the server answers 400, and the 4xx branch below treats that as permanent and
    // drops the batch -- the user's offline writes, discarded. `haveMore` on the batch means
    // PowerSync calls back for the remainder, so the cap costs a round trip, never data.
    const batch = await database.getCrudBatch(SYNC_UPLOAD_MAX_OPS);
    if (!batch) return;

    const bases = new Map<string, string>();
    for (const entry of batch.crud) {
      if (entry.table !== "notes" || entry.op !== "PATCH") continue;
      const row = await database.getOptional<{ base_updated_at: string }>(
        "SELECT base_updated_at FROM note_edit_base WHERE note_id = ?",
        [entry.id],
      );
      if (row) bases.set(entry.id, row.base_updated_at);
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw new Error("not signed in");

    const res = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/sync/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ops: batch.crud.map((e) => crudEntryToSyncOp(e, bases.get(e.id))),
      }),
    });

    if (!res.ok) {
      // 4xx is a permanent client-side problem: retrying forever would wedge the queue.
      // 5xx and network failures are transient -- leave the batch unacknowledged so
      // PowerSync retries with backoff.
      if (res.status >= 400 && res.status < 500) {
        await batch.complete();
        throw new Error(`sync upload rejected (${res.status})`);
      }
      throw new Error(`sync upload failed (${res.status})`);
    }

    // A 200 does NOT mean every op applied. The router runs ops independently and reports the
    // casualties in `failed` so one bad row cannot wedge the queue -- but the batch is
    // completed either way, so a failed op is gone from the device's queue with the note still
    // sitting in local SQLite and never on the server. Nothing can retry it usefully (these
    // are validation errors, not transient ones), so the least this can do is stop the loss
    // being invisible. Deciding what to DO with them is still open -- see the handoff.
    const result = (await res.json().catch(() => null)) as { failed?: unknown[] } | null;
    if (result?.failed?.length) {
      console.error("sync upload: ops rejected by the server", result.failed);
    }

    await batch.complete();
    // The bases these ops were checked against are spent; keeping them would apply a stale
    // base to the user's NEXT edit and manufacture a conflict copy that never happened.
    for (const id of bases.keys()) {
      await database.execute("DELETE FROM note_edit_base WHERE note_id = ?", [id]);
    }
  }
}
