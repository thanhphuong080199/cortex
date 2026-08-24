import { Pressable, Text, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ConnectionPill } from "./connection-pill";
import { RADIUS, SPACE, TYPE } from "../fonts";
import { themeFor } from "../theme";

/**
 * The app's only chrome.
 *
 * REPLACES THE NATIVE STACK HEADER, which `_layout.tsx` now switches off. Two reasons, and the
 * first is not cosmetic: expo-router's header is a platform component whose title cannot be set
 * in Fraunces without reaching into `@react-navigation/elements`, which is not a direct
 * dependency of this app -- importing it would be a phantom dependency pnpm's strict layout can
 * drop at any install (the same trap `useComposerInset` documents in chat.tsx). Owning the header
 * outright is what makes the wordmark, the connection dot and the sign-out control one designed
 * row instead of three platform defaults sitting next to each other.
 *
 * It carries the top safe-area inset itself, since with `headerShown: false` nothing else does.
 *
 * NO BOTTOM BORDER. The thread scrolls under nothing -- the header sits on `bg` like everything
 * else, and the only separation is space. A rule here would be the one hard line in a design
 * whose whole argument is soft edges.
 */
export function ChatHeader({ onSignOut, busy }: { onSignOut: () => void; busy: boolean }) {
  const theme = themeFor(useColorScheme());
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flexDirection: "row", alignItems: "center", gap: SPACE.md,
        paddingTop: insets.top + SPACE.sm,
        paddingBottom: SPACE.sm,
        paddingHorizontal: SPACE.lg,
      }}
    >
      <Text style={{ ...TYPE.wordmark, color: theme.text }}>Cortex</Text>
      <ConnectionPill />

      <View style={{ flex: 1 }} />

      {/* A ghost pill on `sunken`, not a filled button. Signing out wipes this device's local
          copy (lib/auth.ts) -- it is the most destructive control in the app and has no business
          being the most prominent one. Keeps the "Đăng xuất" label rather than hiding behind an
          icon: an unlabelled icon in the corner of a chat app gets tapped by accident. */}
      <Pressable
        onPress={onSignOut}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Đăng xuất"
        testID="sign-out"
        hitSlop={SPACE.sm}
        style={({ pressed }) => ({
          paddingVertical: SPACE.xs + 2, paddingHorizontal: SPACE.md,
          borderRadius: RADIUS.pill, backgroundColor: theme.sunken,
          opacity: busy ? 0.5 : pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ ...TYPE.micro, color: theme.muted }}>Đăng xuất</Text>
      </Pressable>
    </View>
  );
}
