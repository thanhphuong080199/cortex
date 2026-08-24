import { PowerSyncContext } from "@powersync/react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, useColorScheme, View } from "react-native";

import { RADIUS, SPACE, TYPE } from "../fonts";
import { initPowerSync } from "../lib/powersync";
import { themeFor } from "../theme";
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
  const theme = themeFor(useColorScheme());
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
      <View style={[styles.centre, { backgroundColor: theme.bg }]}>
        <Text style={{ ...TYPE.title, color: theme.text, textAlign: "center" }}>
          Không mở được bản sao ngoại tuyến
        </Text>
        <Text style={{ ...TYPE.small, color: theme.muted, textAlign: "center" }}>
          Việc mở khoá chưa hoàn tất. Thử lại để tiếp tục.
        </Text>
        <Pressable
          onPress={() => setAttempt((n) => n + 1)}
          accessibilityRole="button"
          style={({ pressed }) => ({
            marginTop: SPACE.sm,
            paddingVertical: SPACE.md, paddingHorizontal: SPACE.xxl,
            borderRadius: RADIUS.pill, backgroundColor: theme.accent,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text style={{ ...TYPE.bodyMedium, color: theme.accentInk }}>Thử lại</Text>
        </Pressable>
      </View>
    );
  }

  if (!db) {
    return (
      <View style={[styles.centre, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  return (
    <PowerSyncContext.Provider value={db}>
      {wiped && !dismissed ? (
        // An amber wash on the panel tone, not the hardcoded #fdf0d5 this used to be -- that
        // colour was a light-mode cream that stayed cream on the dark scheme, under default
        // near-white text. This is the only place `warm` is used outside the mood streak, and it
        // earns it: the message is a loss report, and `danger` would overstate it (the server's
        // copy is fine).
        <View
          style={{
            flexDirection: "row", alignItems: "flex-start", gap: SPACE.md,
            margin: SPACE.md, padding: SPACE.md,
            borderRadius: RADIUS.lg, backgroundColor: theme.panel,
            borderLeftWidth: 3, borderLeftColor: theme.warm,
            boxShadow: theme.shadow,
          }}
        >
          <Text style={{ ...TYPE.small, color: theme.text, flex: 1 }}>
            Bản sao trên máy đã được đặt lại vì khoá màn hình thay đổi. Ghi chú đã lên máy chủ
            vẫn an toàn; những gì ghi khi ngoại tuyến mà chưa kịp tải lên thì đã mất.
          </Text>
          <Pressable
            onPress={() => setDismissed(true)}
            accessibilityRole="button"
            accessibilityLabel="Đóng thông báo"
            hitSlop={SPACE.sm}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={{ ...TYPE.micro, color: theme.muted }}>ĐÓNG</Text>
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
    padding: SPACE.xxl,
    gap: SPACE.md,
  },
} as const;
