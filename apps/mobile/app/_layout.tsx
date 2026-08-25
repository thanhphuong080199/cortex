import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { FontGate } from "../src/components/font-gate";
import { PowerSyncProvider } from "../src/components/powersync-provider";
import { themeFor } from "../src/theme";

export default function RootLayout() {
  const theme = themeFor(useColorScheme());

  return (
    // `react-native-safe-area-context` has been a dependency since phase 1b and was imported
    // nowhere, which is why the composer sat under Android's gesture navigation bar (reported
    // 2026-08-23). The PowerSync spinner renders full-screen UI of its own and needs insets too,
    // so the provider has to be above it -- and `useSafeAreaInsets` throws outside a provider, so
    // this placement is what makes the hook safe to reach for anywhere below.
    <SafeAreaProvider>
      {/* `auto` inverts the clock and battery icons with the colour scheme. Without it the dark
          scheme gets black system icons on a near-black header. */}
      <StatusBar style="auto" />
      <FontGate>
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
      </FontGate>
    </SafeAreaProvider>
  );
}
