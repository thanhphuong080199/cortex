import { Pressable, Text, useColorScheme, View } from "react-native";

import { RADIUS, SPACE, TYPE } from "../fonts";
import { moodRampFor, themeFor } from "../theme";

const STEPS = 5;

/**
 * THE SIGNATURE OF THIS DESIGN.
 *
 * A check-in used to read `Đã ghi tâm trạng 4/5` -- a sentence you have to parse, and one that
 * looks identical whether the answer was 1 or 5. Cortex is the only app on the user's phone that
 * records how they felt as a side effect of them just talking, so the one place it is allowed to
 * spend colour is here: five soft segments, filled to the mood, warming from sage to amber.
 *
 * It is the only saturated mark in a design built entirely from low-chroma surfaces. That is the
 * restraint that lets it work -- put a second one anywhere and both stop meaning anything.
 *
 * ACCESSIBILITY. The ramp is decoration with a job, so the fills answer to WCAG's 3:1 non-text
 * bar (enforced in theme.test.ts against all three surfaces). The number itself is never carried
 * by colour alone: `mood/5` is spelled out beside the bar, and the whole row is announced as one
 * accessibility element with that value in its label -- a screen reader gets the reading, not
 * five anonymous views.
 */
export function MoodStreak({ mood, onUndo }: { mood: number; onUndo: () => void }) {
  const scheme = useColorScheme();
  const theme = themeFor(scheme);
  const ramp = moodRampFor(scheme);
  // Defensive: the value arrives from the server's `mood` event. A 0 or a 7 would otherwise
  // render an empty streak or overflow the ramp lookup with `undefined` -- a transparent segment.
  const filled = Math.max(0, Math.min(STEPS, Math.round(mood)));

  return (
    <View
      style={{
        flexDirection: "row", alignItems: "center", gap: SPACE.md,
        paddingVertical: SPACE.sm + 2, paddingHorizontal: SPACE.md,
        backgroundColor: theme.panel, borderRadius: RADIUS.lg, boxShadow: theme.shadow,
      }}
    >
      <View
        testID="box-mood"
        // One element, one reading. Without this the five segments are five unlabelled views and
        // the mood is invisible to anyone not looking at the screen.
        accessible
        accessibilityLabel={`Đã ghi tâm trạng ${filled} trên ${STEPS}`}
        style={{ flexDirection: "row", alignItems: "flex-end", gap: 3 }}
      >
        {Array.from({ length: STEPS }, (_, i) => (
          <View
            key={i}
            style={{
              width: 16,
              // The filled segments also GROW toward the high end, so the streak is legible as a
              // shape in a screenshot, in greyscale, and to anyone who cannot separate the hues.
              height: i < filled ? 10 + i * 2 : 10,
              borderRadius: RADIUS.sm,
              // `track`, not `sunken` -- see theme.ts. An unfilled segment that cannot be seen
              // against the card turns "2 of 5" into "2".
              backgroundColor: i < filled ? ramp[i] : theme.track,
            }}
          />
        ))}
      </View>

      <Text style={{ ...TYPE.smallMedium, color: theme.text }}>
        {`${filled}/${STEPS}`}
      </Text>

      {/* Pushed to the far edge: undo is the rarely-wanted half of this row and should not sit
          under the thumb that just finished typing. */}
      <View style={{ flex: 1 }} />
      <Pressable
        testID="box-mood-undo"
        accessibilityRole="button"
        accessibilityLabel="Hoàn tác ghi tâm trạng"
        onPress={onUndo}
        hitSlop={SPACE.sm}
        style={({ pressed }) => ({
          paddingVertical: SPACE.xs, paddingHorizontal: SPACE.sm + 2,
          borderRadius: RADIUS.pill, backgroundColor: theme.sunken,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ ...TYPE.micro, color: theme.muted }}>Hoàn tác</Text>
      </Pressable>
    </View>
  );
}
