/**
 * Mobile's design tokens.
 *
 * DIRECTION: "Mềm" -- soft, layered. Raw silk (lụa mộc) as the page, cloud-white cards that
 * float on it, the user's own words in a flat dried-rose pill, and one deep mulberry-leaf green
 * for anything the app wants you to press. Warm-cast throughout, including in the dark scheme:
 * night here is a lamp-lit room, not a blue screen.
 *
 * This file imports nothing from react-native on purpose: `useColorScheme` is called by the
 * component, and keeping this module pure is what lets it have a test at all (mobile's vitest
 * environment is `node`, and there is no component-test harness). It imports fonts.ts, which is
 * pure for the same reason.
 *
 * WHY THIS NO LONGER MIRRORS globals.css
 *
 * Until 2026-08-24 these were seven values copied verbatim from web's `:root`, and the comment
 * here said that sharing the vocabulary is what makes it possible to change one and notice the
 * other. That stopped being true the moment the two clients needed different things: web is a
 * one-column page in a browser chrome, mobile is a full-bleed phone screen with its own header,
 * safe areas and keyboard. The token NAMES below are still deliberately web-shaped -- bg, panel,
 * text, muted, line, accent, danger all mean what they mean in globals.css -- so a future port of
 * this direction back to web has a vocabulary to land on. The VALUES are mobile's own.
 *
 * EVERY TEXT PAIR BELOW IS >= 4.5:1. theme.test.ts computes the WCAG ratios and fails on a
 * regression; that test is the reason `muted` is #726259 and not the prettier #8A7C74 the first
 * draft used (3.5:1 -- fine in a mockup, unreadable on a phone outdoors).
 */
export interface Theme {
  /** The page. Raw silk in light, a warm near-black in dark. */
  bg: string;
  /** Recessed below `bg`: day labels, inert chips, the ghost sign-out control. */
  sunken: string;
  /** Lifted above `bg`: the assistant's card, the composer, the offer box. */
  panel: string;
  /** Hairline. Only where two surfaces of the same tone meet -- never as decoration. */
  line: string;

  text: string;
  muted: string;

  /** Mulberry leaf. Anything pressable that matters, and the "online" dot. */
  accent: string;
  /** What sits ON `accent` -- the send arrow, a primary label. */
  accentInk: string;
  /** A wash of `accent` for a passive state (a chip, a confirmation row). */
  accentSoft: string;
  /** What sits ON `accentSoft`. */
  accentSoftInk: string;

  /** Dried rose. The user's own words, and nothing else. */
  bubble: string;
  /** What sits ON `bubble`. Deliberately dark ink, not white -- see the note below. */
  bubbleInk: string;

  /** Amber. The top of the mood scale, and only there. */
  warm: string;
  /**
   * The mood streak's UNFILLED segments, and nothing else.
   *
   * Not `sunken`, which is what the first build used: `sunken` is tuned to sit under text on
   * `bg`, and against `panel` it lands at 1.26:1 in light and 1.09:1 in dark -- close enough to
   * invisible that a 2/5 streak read as two floating blobs rather than two-of-five, which is the
   * entire reading the mark exists to give. theme.test.ts holds it above 1.5:1 on `panel`.
   */
  track: string;
  danger: string;

  /**
   * A CSS `boxShadow` string (React Native >= 0.76 accepts these on both platforms, which is what
   * lets one token cover iOS and Android instead of a shadow* quintet plus `elevation`).
   * Warm-tinted rather than neutral grey: a grey shadow on silk reads as dirt.
   */
  shadow: string;
  /** The stronger of the two. The composer, which must separate from the thread behind it. */
  shadowLift: string;
}

/**
 * `bubbleInk` is dark on both schemes, which is the one place this design departs from every
 * chat app: the user's bubble is normally the saturated brand colour with white on it. Here the
 * user's own words are the softest thing on screen. That is the point -- Cortex is a place you
 * write when you are tired, and a high-chroma block shouting your own sentence back at you is
 * the wrong register. The assistant's reply, which is the part with information in it, gets the
 * lifted card instead.
 */
export const LIGHT: Theme = {
  bg: "#f4efec", sunken: "#eae1dc", panel: "#fffcfb", line: "#e3d8d2",
  text: "#2b2521", muted: "#726259",
  accent: "#546e57", accentInk: "#ffffff", accentSoft: "#dce6dc", accentSoftInk: "#3d5642",
  bubble: "#e8bfb6", bubbleInk: "#3a2723",
  warm: "#9c601f", track: "#d4c6bd", danger: "#a6443e",
  // Raised from 1px/3px/6% after the first render: on silk, a near-white card at 6% did not
  // separate from the page at all, and the assistant's reply -- the one element on screen with
  // new information on it -- read as flat text. Still soft; this is a lift, not a drop shadow.
  shadow: "0px 2px 8px rgba(74, 52, 42, 0.08)",
  shadowLift: "0px 3px 16px rgba(74, 52, 42, 0.12)",
};

export const DARK: Theme = {
  bg: "#191512", sunken: "#221c19", panel: "#2a231f", line: "#372e29",
  text: "#f0e8e2", muted: "#a2938a",
  accent: "#93b197", accentInk: "#16211a", accentSoft: "#2c3830", accentSoftInk: "#b9d0bc",
  bubble: "#8a5b52", bubbleInk: "#fcf1ee",
  warm: "#e0ac75", track: "#4b3e38", danger: "#e8897a",
  // Nearly black rather than warm: on a dark page a tinted shadow is invisible, and the job
  // here is done by the panel being lighter than the page anyway. This is a hint, not a lift.
  shadow: "0px 1px 3px rgba(0, 0, 0, 0.30)",
  shadowLift: "0px 3px 16px rgba(0, 0, 0, 0.45)",
};

/**
 * The five steps of the mood scale, low to high, as fills.
 *
 * DECORATIVE, not text -- these are the segments of the mood streak (components/mood-streak.tsx),
 * so they answer to the 3:1 non-text rule rather than 4.5:1, and the label beside them carries
 * the actual number for anyone who cannot see the ramp at all.
 *
 * Sage through amber, in the theme's own two accents rather than a red-to-green traffic light:
 * a low mood is not an error state and must not be coloured like one. The ramp ends at amber
 * rather than the obvious terracotta -- brick at the top of a mood scale reads as an alarm.
 *
 * These are the ONE saturated thing in a design made of low-chroma surfaces, and that is
 * deliberate: it is the signature mark, so it gets the boldness and everything around it stays
 * quiet. Adjacent steps are close in luminance and separated by hue -- what carries the reading
 * is how many segments are filled, not which shade any one of them is.
 */
export const MOOD_LIGHT = ["#4f6a54", "#6d7546", "#8a7635", "#a2702b", "#b3691c"] as const;
export const MOOD_DARK = ["#8fae95", "#a8b183", "#c0ae6c", "#d1a05e", "#e2a04c"] as const;

export function moodRampFor(scheme: "light" | "dark" | "unspecified" | null | undefined) {
  return scheme === "dark" ? MOOD_DARK : MOOD_LIGHT;
}

/**
 * `useColorScheme()` returns null while the value is resolving, and the screen still paints on
 * that frame. Light is the safe landing -- a dark theme flashed over a white system background
 * is the more jarring of the two mistakes.
 */
export function themeFor(scheme: "light" | "dark" | "unspecified" | null | undefined): Theme {
  return scheme === "dark" ? DARK : LIGHT;
}
