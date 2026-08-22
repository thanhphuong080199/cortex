import { useStatus } from "@powersync/react-native";
import { useColorScheme, Text, View } from "react-native";

import { themeFor } from "../theme";

/**
 * Whether the download stream is alive, said out loud.
 *
 * Two jobs, and the second is the load-bearing one. For the user: in an app that is nothing but
 * a chat box, "you are offline, this reply came from your own notes" is the honest frame for
 * what offline-answer.ts produces. For the suite: ExportButton's label used to be the only UI
 * proof PowerSync was connected (02-online-basics.yaml keys on it), and export went with the
 * note browser.
 *
 * ALWAYS rendered, never conditionally, and with BOTH states carrying the same testID. A pill
 * that only exists when offline cannot be told apart from a screen that has not mounted yet --
 * an assertion against it would pass on a broken app.
 */
export function ConnectionPill() {
  const theme = themeFor(useColorScheme());
  const connected = useStatus().connected;
  return (
    <View style={{ alignItems: "center", paddingTop: 6 }}>
      <Text
        testID="conn-status"
        style={{ fontSize: 12, color: connected ? theme.muted : theme.danger }}
      >
        {connected ? "Trực tuyến" : "Ngoại tuyến"}
      </Text>
    </View>
  );
}
