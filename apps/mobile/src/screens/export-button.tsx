import { useStatus } from "@powersync/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { exportArchive } from "../lib/export";
import { supabase } from "../lib/supabase";

/**
 * Export is inherently ONLINE: `GET /export` streams a server-generated archive and nothing
 * local can produce one (spec §0 footnote). Parity means the feature exists, not that it works
 * offline -- so it is disabled with an explanation rather than failing on tap.
 */
export function ExportButton() {
  const status = useStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = status.connected;

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      await exportArchive({
        token: session?.access_token ?? null,
        apiUrl: process.env.EXPO_PUBLIC_API_URL,
      });
    } catch (cause) {
      // A download that dies partway leaves nothing the user can act on, so it has to say so
      // -- silence here is indistinguishable from a share sheet the user dismissed.
      setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ padding: 12, gap: 6 }}>
      <Pressable
        onPress={() => {
          void run();
        }}
        disabled={!online || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: !online || busy }}
        style={{ opacity: online && !busy ? 1 : 0.5 }}
      >
        <Text>
          {busy
            ? "Preparing export…"
            : online
              ? "Export all notes"
              : "Export needs a connection"}
        </Text>
      </Pressable>
      {error ? <Text style={{ color: "crimson" }}>{error}</Text> : null}
    </View>
  );
}
