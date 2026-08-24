import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppLockGate } from "../src/components/app-lock-gate";
import { FontGate } from "../src/components/font-gate";
import { PowerSyncProvider } from "../src/components/powersync-provider";
import { themeFor } from "../src/theme";

export default function RootLayout() {
  const theme = themeFor(useColorScheme());

  return (
    // SafeAreaProvider OUTSIDE the lock gate, not inside it. `react-native-safe-area-context`
    // has been a dependency since phase 1b and was imported nowhere, which is why the composer
    // sat under Android's gesture navigation bar (reported 2026-08-23). The gate and the
    // PowerSync spinner both render full-screen UI of their own and need insets too, so the
    // provider has to be above them -- and `useSafeAreaInsets` throws outside a provider, so
    // this placement is what makes the hook safe to reach for anywhere below.
    <SafeAreaProvider>
      {/* `auto` inverts the clock and battery icons with the colour scheme. Without it the dark
          scheme gets black system icons on a near-black header. */}
      <StatusBar style="auto" />
      {/* FontGate OUTSIDE the lock, unlike PowerSyncProvider: loading a .ttf touches no user
          data, and the lock screen has type on it that should already be in the right face. */}
      <FontGate>
        {/* PowerSync INSIDE the lock: opening the database prompts for the biometric guarding its
            key, and no local data may be touched before the gate has run (spec §7.7). */}
        <AppLockGate>
          <PowerSyncProvider>
            <Stack
              screenOptions={{
                // The native header is gone. Its title could not be set in Fraunces without
                // importing `@react-navigation/elements`, which is not a direct dependency here
                // and would be a phantom dependency under pnpm's strict layout -- so the chat
                // screen draws its own header instead (components/chat-header.tsx), which is
                // also what lets the wordmark, the connection dot and sign-out be one designed
                // row rather than three platform defaults.
                headerShown: false,
                // Without this the router's own screen background is white, and it flashes
                // between routes on the dark scheme.
                contentStyle: { backgroundColor: theme.bg },
              }}
            />
          </PowerSyncProvider>
        </AppLockGate>
      </FontGate>
    </SafeAreaProvider>
  );
}
