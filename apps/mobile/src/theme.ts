/**
 * Mobile's design tokens, with THE SAME NAMES web uses in globals.css's `:root` block.
 *
 * The two clients cannot share styling code -- React Native has no CSS -- but sharing the
 * vocabulary is what makes it possible to change one and notice the other. The values below are
 * copied from globals.css deliberately, not approximated.
 *
 * This file imports nothing from react-native on purpose: `useColorScheme` is called by the
 * component, and keeping this module pure is what lets it have a test at all (mobile's vitest
 * environment is `node`, and there is no component-test harness).
 */
export interface Theme {
  bg: string; panel: string; text: string; muted: string;
  line: string; accent: string; danger: string;
}

export const LIGHT: Theme = {
  bg: "#fbfbfa", panel: "#ffffff", text: "#1f1f1d", muted: "#6b6b66",
  line: "#e4e4e0", accent: "#3b6ef0", danger: "#b3261e",
};

export const DARK: Theme = {
  bg: "#17171a", panel: "#1f1f23", text: "#ececea", muted: "#9a9a94",
  line: "#32323a", accent: "#7d9dff", danger: "#f2705f",
};

/**
 * `useColorScheme()` returns null while the value is resolving, and the screen still paints on
 * that frame. Light is the safe landing -- a dark theme flashed over a white system background
 * is the more jarring of the two mistakes.
 */
export function themeFor(scheme: "light" | "dark" | null | undefined): Theme {
  return scheme === "dark" ? DARK : LIGHT;
}
