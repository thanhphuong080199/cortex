import { Stack } from "expo-router";

import { AppLockGate } from "../src/components/app-lock-gate";

export default function RootLayout() {
  return (
    <AppLockGate>
      <Stack screenOptions={{ headerTitle: "Cortex" }} />
    </AppLockGate>
  );
}
