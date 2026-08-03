import { PowerSyncContext } from "@powersync/react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { initPowerSync } from "../lib/powersync";
import type { PowerSyncDatabase } from "@powersync/react-native";

/**
 * Opens the encrypted local replica once and hands it to the tree (spec §7.4).
 *
 * Mounted INSIDE `AppLockGate`, never outside it: opening the database prompts for the
 * biometric that guards its key, and doing that before the app lock has run would authenticate
 * the user twice for one entry -- and would touch local data ahead of the gate that exists to
 * stop exactly that (§7.7).
 */
export function PowerSyncProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<PowerSyncDatabase | null>(null);
  const [wiped, setWiped] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    initPowerSync().then(
      (result) => {
        if (!live) return;
        setDb(result.db);
        setWiped(result.wiped);
      },
      (cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (error) {
    // Overwhelmingly this is a cancelled biometric prompt, which the user fixes by trying
    // again -- so offer that rather than a dead end. `initPowerSync` clears its in-flight
    // promise on failure, so a retry genuinely re-runs.
    return (
      <View style={styles.centre}>
        <Text style={{ fontSize: 18 }}>Cortex could not open its offline copy</Text>
        <Text style={{ opacity: 0.7, textAlign: "center" }}>
          Unlocking was not completed. Try again to continue.
        </Text>
        <Pressable
          onPress={() => setAttempt((n) => n + 1)}
          accessibilityRole="button"
          style={styles.button}
        >
          <Text style={{ color: "white" }}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!db) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <PowerSyncContext.Provider value={db}>
      {wiped && !dismissed ? (
        <View style={styles.banner}>
          <Text style={{ flex: 1 }}>
            This device&apos;s offline copy was reset because the screen lock changed. Notes saved
            on the server are safe; anything captured offline and not yet uploaded was lost.
          </Text>
          <Pressable onPress={() => setDismissed(true)} accessibilityRole="button">
            <Text style={{ fontWeight: "600" }}>Dismiss</Text>
          </Pressable>
        </View>
      ) : null}
      {children}
    </PowerSyncContext.Provider>
  );
}

const styles = {
  centre: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: "#222",
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    backgroundColor: "#fdf0d5",
  },
} as const;
