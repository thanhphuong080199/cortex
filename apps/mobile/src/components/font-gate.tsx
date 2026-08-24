import {
  BeVietnamPro_400Regular,
  BeVietnamPro_500Medium,
  BeVietnamPro_600SemiBold,
  BeVietnamPro_700Bold,
} from "@expo-google-fonts/be-vietnam-pro";
import { Fraunces_400Regular_Italic, Fraunces_600SemiBold } from "@expo-google-fonts/fraunces";
import { useFonts } from "expo-font";
import { useColorScheme, View } from "react-native";

import { themeFor } from "../theme";

/**
 * Registers the two typefaces before anything draws text (fonts.ts says which and why).
 *
 * DEGRADES, NEVER BLOCKS. `useFonts` reports `[loaded, error]`, and this renders the app as soon
 * as EITHER is truthy. A font that fails to decode on some device would otherwise leave the user
 * staring at an empty screen forever -- the app would be perfectly functional underneath, just
 * invisible. Falling back to the system face is a cosmetic loss; a permanent splash is not.
 *
 * While loading it paints the page colour rather than `null`. `null` renders as the system's own
 * window background, which is pure white -- a white flash before a silk-coloured app, and a much
 * worse one before the dark scheme.
 *
 * Mounted OUTSIDE `AppLockGate`, unlike PowerSyncProvider: loading a .ttf touches no user data,
 * and the lock screen has type on it that should already be in the right face.
 */
export function FontGate({ children }: { children: React.ReactNode }) {
  const theme = themeFor(useColorScheme());
  const [loaded, error] = useFonts({
    BeVietnamPro_400Regular,
    BeVietnamPro_500Medium,
    BeVietnamPro_600SemiBold,
    BeVietnamPro_700Bold,
    Fraunces_400Regular_Italic,
    Fraunces_600SemiBold,
  });

  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  return <>{children}</>;
}
