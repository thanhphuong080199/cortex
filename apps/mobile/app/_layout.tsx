import { Stack } from "expo-router";

import { AppLockGate } from "../src/components/app-lock-gate";
import { PowerSyncProvider } from "../src/components/powersync-provider";

export default function RootLayout() {
  return (
    // PowerSync INSIDE the lock: opening the database prompts for the biometric guarding its
    // key, and no local data may be touched before the gate has run (spec §7.7).
    <AppLockGate>
      <PowerSyncProvider>
        <Stack screenOptions={{ headerTitle: "Cortex" }} />
      </PowerSyncProvider>
    </AppLockGate>
  );
}
