import { usePowerSync, useStatus } from "@powersync/react-native";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";

/**
 * TEMPORARY diagnostic. Delete once the empty-note-list investigation is closed.
 *
 * The note list is empty on device even for notes captured on that same device, while those
 * notes reach the server. Reading the code eliminated the sync rules (they match the repo),
 * the SDK version (one physical @powersync/common@2.0.0), the useQuery result shape, and an
 * explicit stream subscription (the stream is auto_subscribe, which the SDK calls isDefault).
 *
 * What is left is invisible from a laptop, so this reports each boundary separately:
 *
 *   ps_data__notes  rows PowerSync has STORED locally (synced + local writes)
 *   notes           rows visible through the generated view the app queries
 *   inbox           rows matching the exact WHERE the note list uses
 *   ps_crud         local writes still queued for upload
 *   ps_buckets      buckets the sync stream has established
 *
 * Each pair splits the space:
 *   ps_data 0 + crud >0  -> local write never landed in storage, or was dropped after upload
 *   ps_data >0 + notes 0 -> the view does not expose what storage holds
 *   notes >0 + inbox 0   -> the filter is wrong (lifecycle/deleted_at), not the sync
 *   buckets 0            -> the stream delivered nothing, whatever `connected` claims
 */
const PROBES: [string, string][] = [
  ["ps_data__notes", "SELECT count(*) AS n FROM ps_data__notes"],
  ["notes(view)", "SELECT count(*) AS n FROM notes"],
  ["inbox(filter)", "SELECT count(*) AS n FROM notes WHERE deleted_at IS NULL AND lifecycle = 'inbox'"],
  ["ps_crud", "SELECT count(*) AS n FROM ps_crud"],
  ["ps_buckets", "SELECT count(*) AS n FROM ps_buckets"],
];

export function SyncDebug() {
  const db = usePowerSync();
  const status = useStatus();
  const [counts, setCounts] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    async function probe() {
      const out: string[] = [];
      for (const [label, sql] of PROBES) {
        try {
          const rows = await db.getAll<{ n: number }>(sql);
          out.push(`${label} = ${rows[0]?.n ?? "?"}`);
        } catch (err) {
          // A failing probe is itself the finding -- a missing table names the layer.
          out.push(`${label} ERR ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (alive) setCounts(out);
    }
    void probe();
    const timer = setInterval(() => void probe(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [db]);

  const lastSynced = status.lastSyncedAt ? status.lastSyncedAt.toISOString() : "never";

  return (
    <ScrollView
      horizontal
      style={{ backgroundColor: "#111", maxHeight: 132 }}
      contentContainerStyle={{ padding: 8 }}
    >
      <View>
        <Text style={{ color: "#0f0", fontSize: 11 }}>
          connected={String(status.connected)} hasSynced={String(status.hasSynced)}
        </Text>
        <Text style={{ color: "#0f0", fontSize: 11 }}>lastSyncedAt={lastSynced}</Text>
        <Text style={{ color: "#ff0", fontSize: 11 }}>
          downloading={String(status.dataFlowStatus?.downloading)} uploading=
          {String(status.dataFlowStatus?.uploading)}
        </Text>
        {status.dataFlowStatus?.downloadError ? (
          <Text style={{ color: "#f66", fontSize: 11 }}>
            downloadError={String(status.dataFlowStatus.downloadError)}
          </Text>
        ) : null}
        {counts.map((c) => (
          <Text key={c} style={{ color: "#fff", fontSize: 11 }}>
            {c}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}
