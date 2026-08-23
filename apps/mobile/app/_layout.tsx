import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppLockGate } from "../src/components/app-lock-gate";
import { PowerSyncProvider } from "../src/components/powersync-provider";

export default function RootLayout() {
  return (
    // SafeAreaProvider OUTSIDE the lock gate, not inside it. `react-native-safe-area-context`
    // has been a dependency since phase 1b and was imported nowhere, which is why the composer
    // sat under Android's gesture navigation bar (reported 2026-08-23). The gate and the
    // PowerSync spinner both render full-screen UI of their own and need insets too, so the
    // provider has to be above them -- and `useSafeAreaInsets` throws outside a provider, so
    // this placement is what makes the hook safe to reach for anywhere below.
    <SafeAreaProvider>
      {/* PowerSync INSIDE the lock: opening the database prompts for the biometric guarding its
          key, and no local data may be touched before the gate has run (spec §7.7). */}
      <AppLockGate>
        <PowerSyncProvider>
          <Stack screenOptions={{ headerTitle: "Cortex" }} />
        </PowerSyncProvider>
      </AppLockGate>
    </SafeAreaProvider>
  );
}
