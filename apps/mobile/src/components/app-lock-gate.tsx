import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, Text, useColorScheme, View, type AppStateStatus } from "react-native";

import { RADIUS, SPACE, TYPE } from "../fonts";
import { authenticate, shouldRelock } from "../lib/app-lock";
import { themeFor } from "../theme";

/**
 * Renders nothing but an unlock prompt until the user authenticates. Wraps the whole app
 * so no screen -- and no local database read -- happens before unlock (spec §7.7).
 */
export function AppLockGate({ children }: { children: React.ReactNode }) {
  const theme = themeFor(useColorScheme());
  const [unlocked, setUnlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const backgroundedAt = useRef<number | null>(null);
  // The biometric prompt is a system dialog over our own activity, and on some Android
  // devices that alone moves AppState off "active". Without this guard the prompt records a
  // backgroundedAt, its dismissal reads as a return from background, and the gate re-locks
  // and re-prompts the user it just authenticated -- forever, on exactly the devices where
  // the prompt behaves that way. Time spent inside the prompt is not time spent backgrounded.
  const unlocking = useRef(false);

  const unlock = useCallback(async () => {
    if (unlocking.current) return;
    unlocking.current = true;
    setFailed(false);
    try {
      const ok = await authenticate();
      setUnlocked(ok);
      setFailed(!ok);
      // A completed unlock starts the grace period fresh; a stale timestamp from before the
      // prompt would otherwise make the next resume look overdue.
      if (ok) backgroundedAt.current = null;
    } finally {
      unlocking.current = false;
    }
  }, []);

  useEffect(() => {
    void unlock();
  }, [unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (unlocking.current) return;

      if (state === "background") {
        backgroundedAt.current = Date.now();
        return;
      }
      if (state === "active" && shouldRelock(backgroundedAt.current, Date.now())) {
        setUnlocked(false);
        void unlock();
      }
    });
    return () => sub.remove();
  }, [unlock]);

  if (unlocked) return <>{children}</>;

  // Deliberately the quietest screen in the app: a locked door should not look like an error.
  // The copy is Vietnamese like everything else the user reads -- .maestro/01 asserts the closed
  // state's exact string, and was updated with this change rather than left asserting English
  // that no longer appears anywhere.
  return (
    <View
      style={{
        flex: 1, alignItems: "center", justifyContent: "center",
        padding: SPACE.xxl, gap: SPACE.md, backgroundColor: theme.bg,
      }}
    >
      <Text style={{ ...TYPE.wordmark, fontSize: 26, color: theme.text }}>Cortex đang khoá</Text>
      <Text style={{ ...TYPE.small, color: theme.muted, textAlign: "center" }}>
        {failed ? "Mở khoá để tiếp tục." : "Dùng vân tay hoặc khuôn mặt để mở."}
      </Text>
      <Pressable
        onPress={() => {
          void unlock();
        }}
        accessibilityRole="button"
        style={({ pressed }) => ({
          marginTop: SPACE.sm,
          paddingVertical: SPACE.md, paddingHorizontal: SPACE.xxl,
          borderRadius: RADIUS.pill, backgroundColor: theme.accent,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={{ ...TYPE.bodyMedium, color: theme.accentInk }}>Mở khoá</Text>
      </Pressable>
    </View>
  );
}
