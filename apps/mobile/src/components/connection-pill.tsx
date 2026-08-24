import { useStatus } from "@powersync/react-native";
import { useColorScheme, Text, View } from "react-native";

import { SPACE, TYPE } from "../fonts";
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
 *
 * A DOT AND A WORD, not a word alone. Online is the state the user is in almost always, and a
 * standing sentence about it is noise -- so online is a quiet sage dot with the label in `muted`,
 * and offline swaps both to `danger`. The colour is never the only signal: the words "Trực
 * tuyến"/"Ngoại tuyến" are what change, and they are what 02 and 04a actually assert.
 *
 * Sits inside chat-header.tsx now rather than floating above the thread, which is what web's
 * `.chat-header .conn` has always done.
 */
export function ConnectionPill() {
  const theme = themeFor(useColorScheme());
  const connected = useStatus().connected;
  const tone = connected ? theme.muted : theme.danger;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.xs + 2 }}>
      <View
        style={{
          width: 6, height: 6, borderRadius: 3,
          backgroundColor: connected ? theme.accent : theme.danger,
        }}
      />
      <Text testID="conn-status" style={{ ...TYPE.micro, color: tone }}>
        {connected ? "Trực tuyến" : "Ngoại tuyến"}
      </Text>
    </View>
  );
}
