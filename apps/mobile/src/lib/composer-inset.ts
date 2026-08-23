/**
 * How much space must be kept below the chat, in dp.
 *
 * TWO REPORTED BUGS, ONE NUMBER (2026-08-23):
 *
 *   "input box bị che bởi navigation bar của điện thoại" -- nothing in the tree applied a
 *   bottom safe-area inset. `react-native-safe-area-context` has been a dependency since phase
 *   1b and was imported nowhere. Under Android's gesture navigation the system bar is drawn
 *   over the app's own bottom edge, which is where the composer sits.
 *
 *   "lúc nhấn vô input box keyboard show lên overlay hẳn cái input" -- chat.tsx passed
 *   `behavior={Platform.OS === "ios" ? "padding" : undefined}` to KeyboardAvoidingView, and
 *   `undefined` is not a default: it is that component doing nothing at all. Android got no
 *   keyboard avoidance whatsoever.
 *
 * MAX, not a sum, and that is the whole content of this function. When the keyboard is open it
 * is drawn OVER the navigation bar, so the two insets overlap rather than stack -- adding them
 * leaves a band of dead space the height of the nav bar between the composer and the keyboard.
 * When it is closed the keyboard's contribution is 0 and the nav bar's is all that is left.
 *
 * THIS MODULE IMPORTS NOTHING, for the same reason theme.ts imports nothing from react-native:
 * mobile's vitest environment is `node`, and `react-native`'s entry point is Flow, which rollup
 * cannot parse -- one import of it and this file has no test at all, only a failing suite. The
 * hook that feeds it lives at the call site in screens/chat.tsx, exactly as `themeFor` is paired
 * with a `useColorScheme()` call there.
 */
export function composerInset(
  { keyboardHeight, safeAreaBottom }: { keyboardHeight: number; safeAreaBottom: number },
): number {
  return Math.max(keyboardHeight, safeAreaBottom);
}
