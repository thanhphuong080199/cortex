import { usePowerSync } from "@powersync/react-native";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { logCheckin, undoCheckin } from "../lib/checkins";
import { createInFlightGuard } from "../lib/in-flight";

const MOOD_LABELS = ["very bad", "bad", "okay", "good", "very good"];

/**
 * Two taps, offline, from the couch -- the most mobile-native surface in the product.
 *
 * Check-ins are inserts and deletes only (life-domains spec §2.3): a wrong mood is undone and
 * re-tapped, never edited. Both work offline unchanged, because neither needs a server-side
 * decision. The SQL lives in `../lib/checkins`, where a test can execute it.
 */
export function CheckinWidget() {
  const db = usePowerSync();
  const [lastId, setLastId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `disabled={busy}` is not enough on its own: state updates are async, so two quick taps can
  // both pass the check before either re-render lands, and each one is a separate check-in.
  // The guard this widget introduced now lives in lib/in-flight, where it is tested and where
  // capture, the media form and export share it.
  const guard = useRef(createInFlightGuard()).current;

  async function run(action: () => Promise<void>) {
    await guard(async () => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <View style={{ padding: 16, gap: 10 }}>
      <Text>How are you?</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {[1, 2, 3, 4, 5].map((m) => (
          <Pressable
            key={m}
            disabled={busy}
            onPress={() => {
              void run(async () => setLastId(await logCheckin(db, m)));
            }}
            accessibilityRole="button"
            // Valence in the label, not just a number: "Mood 4" tells a screen-reader user
            // nothing about direction (issue-log E7).
            accessibilityLabel={`Mood ${m} of 5 — ${MOOD_LABELS[m - 1]}`}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: "#eee",
              alignItems: "center",
              justifyContent: "center",
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Text>{m}</Text>
          </Pressable>
        ))}
      </View>
      {lastId ? (
        <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
          <Text accessibilityRole="text">Logged ✓</Text>
          <Pressable
            onPress={() => {
              const id = lastId;
              void run(async () => {
                await undoCheckin(db, id);
                setLastId(null);
              });
            }}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={{ textDecorationLine: "underline" }}>Undo</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
