import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, Text, View, type AppStateStatus } from "react-native";

import { authenticate, shouldRelock } from "../lib/app-lock";

/**
 * Renders nothing but an unlock prompt until the user authenticates. Wraps the whole app
 * so no screen -- and no local database read -- happens before unlock (spec §7.7).
 */
export function AppLockGate({ children }: { children: React.ReactNode }) {
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

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 }}>
      <Text style={{ fontSize: 18 }}>Cortex is locked</Text>
      {failed ? <Text style={{ opacity: 0.7 }}>Unlock to continue.</Text> : null}
      <Pressable
        onPress={() => {
          void unlock();
        }}
        accessibilityRole="button"
        style={{
          paddingVertical: 12,
          paddingHorizontal: 24,
          borderRadius: 8,
          backgroundColor: "#222",
        }}
      >
        <Text style={{ color: "white" }}>Unlock</Text>
      </Pressable>
    </View>
  );
}
