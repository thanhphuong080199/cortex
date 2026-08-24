/**
 * The two typefaces, named once.
 *
 * Imports NOTHING on purpose -- these strings are the family names React Native resolves after
 * `font-gate.tsx` has registered the .ttf assets, and theme.ts (which is tested under a plain
 * `node` environment with no react-native available) needs to reference them. The loading half
 * lives in components/font-gate.tsx, which is the only file that may import expo-font.
 *
 * WHY THESE TWO
 *
 * Be Vietnam Pro carries every word the user reads. Cortex's users write in Vietnamese, and
 * Vietnamese stacks two marks on one vowel (ẫ, ể, ỗ, ự) -- in a face that composites its
 * diacritics from a Latin base, those collide with the line above or drift off-centre. Be Vietnam
 * Pro draws them. That is the whole reason it is here, and it is why `lineHeight` in TYPE below
 * is looser than a Latin-only app would need.
 *
 * Fraunces appears in exactly one role: the questions the app asks and then waits on -- the empty
 * thread, the lock screen, the sign-in screen -- set in ITALIC. Not as a headline face. A soft
 * serif used for statements would read as an editorial template; used only where the app is
 * asking rather than telling, it reads as handwriting in a notebook, which is what this screen
 * actually is. The one exception is the wordmark, which is upright.
 */
export const FONT = {
  /** Fraunces upright. The wordmark only. */
  display: "Fraunces_600SemiBold",
  /** Fraunces italic. Only for a question the app is waiting on an answer to. */
  ask: "Fraunces_400Regular_Italic",
  body: "BeVietnamPro_400Regular",
  medium: "BeVietnamPro_500Medium",
  semibold: "BeVietnamPro_600SemiBold",
  bold: "BeVietnamPro_700Bold",
} as const;

/**
 * The type scale. `lineHeight` is ~1.5x rather than the ~1.35x a Latin-only UI would use, for
 * the stacked-diacritic reason in the module doc: at 1.35 the hook of an `ể` on one line touches
 * the descender of a `g` on the line above.
 *
 * Sizes are a flat five-step scale, not a ratio -- on a phone there is only ever one thing at a
 * time that wants to be big, and inventing intermediate steps just produces headings that argue
 * with each other.
 */
export const TYPE = {
  /** The wordmark. Upright Fraunces, tightened -- it is a logo, not running text. */
  wordmark: { fontFamily: FONT.display, fontSize: 19, letterSpacing: -0.3 },
  /** A question the app is waiting on. See the module doc for why this is the only italic. */
  ask: { fontFamily: FONT.ask, fontSize: 25, lineHeight: 36, letterSpacing: -0.2 },
  title: { fontFamily: FONT.semibold, fontSize: 19, lineHeight: 27, letterSpacing: -0.2 },
  /** Everything the user reads at length: their own words, and the assistant's. */
  body: { fontFamily: FONT.body, fontSize: 15.5, lineHeight: 23 },
  bodyMedium: { fontFamily: FONT.medium, fontSize: 15.5, lineHeight: 23 },
  small: { fontFamily: FONT.body, fontSize: 13, lineHeight: 19 },
  smallMedium: { fontFamily: FONT.medium, fontSize: 13, lineHeight: 19 },
  /** Labels, never sentences. Tracked open because it is small and often set in a chip. */
  micro: { fontFamily: FONT.medium, fontSize: 11, lineHeight: 15, letterSpacing: 0.4 },
} as const;

/** 4px rhythm. Named so a stray `padding: 13` is visible in review as the accident it is. */
export const SPACE = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 32,
} as const;

/**
 * The corner family. `lg` and up are what carry the direction: this is a soft, layered design,
 * and a 20px radius on a 44px-tall row is the difference between "card" and "pebble".
 */
export const RADIUS = {
  sm: 10, md: 14, lg: 20, xl: 26, pill: 999,
} as const;
