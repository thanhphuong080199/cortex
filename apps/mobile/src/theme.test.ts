import { describe, expect, it } from "vitest";
import { RADIUS, SPACE, TYPE } from "./fonts";
import { DARK, LIGHT, MOOD_DARK, MOOD_LIGHT, moodRampFor, themeFor, type Theme } from "./theme";

describe("themeFor", () => {
  it("falls back to light when the scheme is unknown", () => {
    // useColorScheme() returns null while the value is being resolved, and on that frame the
    // screen still has to paint. Light is the safe landing: a dark theme flashed over a white
    // system background is the more jarring of the two mistakes.
    expect(themeFor(null)).toBe(LIGHT);
    expect(themeFor(undefined)).toBe(LIGHT);
  });

  it("returns dark for dark", () => {
    expect(themeFor("dark")).toBe(DARK);
  });

  // THE ONE THAT CATCHES A HALF-FINISHED THEME. A missing key reads as `undefined` at the use
  // site, and React Native renders `color: undefined` as inherited black -- invisible in light
  // mode and unreadable in dark. Nothing else would notice.
  it("defines every token in both schemes", () => {
    const keys: readonly (keyof Theme)[] = [
      "bg", "sunken", "panel", "line",
      "text", "muted",
      "accent", "accentInk", "accentSoft", "accentSoftInk",
      "bubble", "bubbleInk",
      "warm", "track", "danger",
      "shadow", "shadowLift",
    ];
    for (const k of keys) {
      expect(typeof LIGHT[k], `LIGHT.${k}`).toBe("string");
      expect(typeof DARK[k], `DARK.${k}`).toBe("string");
    }
    // No extra keys either: a token added to one scheme and forgotten in the other is the same
    // `undefined` failure from the other direction, and the loop above cannot see it.
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
  });

  it("keeps the three surfaces distinguishable in both schemes", () => {
    // The whole direction is layered surfaces. If `panel` collapses onto `bg` the assistant's
    // card stops being a card and the design silently becomes flat -- which is exactly what the
    // first dark draft did (panel and sunken were both #241E1A).
    for (const [name, t] of [["LIGHT", LIGHT], ["DARK", DARK]] as const) {
      const surfaces = new Set([t.bg, t.sunken, t.panel]);
      expect(surfaces.size, `${name} bg/sunken/panel must be three distinct values`).toBe(3);
    }
  });
});

/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * Written out here rather than pulled in as a dependency: it is nine lines, and the alternative
 * is a runtime package in a file whose whole job is to hold constants.
 */
function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const channels = [0, 2, 4]
    .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * THE TEST THAT MAKES A PASTEL DIRECTION SAFE TO SHIP.
 *
 * "Mềm" is built out of low-chroma, low-contrast colour, and that is one nudge away from text
 * nobody can read on a phone in daylight. Every pair below is text drawn on a surface somewhere
 * in the app, checked against WCAG AA for body text (4.5:1). It is not decorative coverage: the
 * light scheme's `muted` was #8a7c74 in the first draft and this test is what rejected it.
 *
 * A one-line change to any colour in theme.ts that looks harmless in a screenshot turns this red.
 */
describe("palette contrast", () => {
  const pairs = (t: Theme): readonly (readonly [string, string, string])[] => [
    // Body text, on each of the three surfaces it can land on.
    ["text on bg", t.text, t.bg],
    ["text on panel", t.text, t.panel],
    ["text on sunken", t.text, t.sunken],
    // `muted` is NOT decoration here -- it carries the day separators, "✓ Đã lưu vào notes",
    // the offline match snippets and every status line. It is small text and it must clear AA.
    ["muted on bg", t.muted, t.bg],
    ["muted on panel", t.muted, t.panel],
    ["muted on sunken", t.muted, t.sunken],
    // Ink on the coloured fills.
    ["accentInk on accent", t.accentInk, t.accent],
    ["accentSoftInk on accentSoft", t.accentSoftInk, t.accentSoft],
    ["bubbleInk on bubble", t.bubbleInk, t.bubble],
    // `accent` used AS text: the "Lưu câu này" style controls sit on panel and on bg.
    ["accent on bg", t.accent, t.bg],
    ["accent on panel", t.accent, t.panel],
    // States.
    ["danger on bg", t.danger, t.bg],
    ["danger on panel", t.danger, t.panel],
    ["warm on panel", t.warm, t.panel],
  ];

  for (const [name, theme] of [["LIGHT", LIGHT], ["DARK", DARK]] as const) {
    for (const [label, fg, bg] of pairs(theme)) {
      it(`${name}: ${label} clears AA for body text`, () => {
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("keeps the mood ramp visible against every surface", () => {
    // The ramp is a decorative fill, so 3:1 (WCAG AA for non-text) is the bar, not 4.5:1. The
    // failure this catches is a mid-ramp colour that happens to match `bg` and makes one segment
    // of the streak vanish -- which reads as "your mood was not recorded".
    for (const [name, ramp, t] of [
      ["LIGHT", MOOD_LIGHT, LIGHT], ["DARK", MOOD_DARK, DARK],
    ] as const) {
      for (const [i, fill] of ramp.entries()) {
        expect(contrast(fill, t.panel), `${name} mood step ${i + 1} on panel`)
          .toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps the mood streak's empty segments visible on the card", () => {
    // 1.5:1 is not a WCAG number -- it is the measured floor at which a 6px-tall unfilled
    // segment stops disappearing into the panel behind it. The first build used `sunken` here
    // and landed at 1.26:1 (light) and 1.09:1 (dark): a 2/5 streak rendered as two blobs with
    // no scale behind them, so the reading it exists to give was simply absent.
    //
    // Checked on `panel`, which is the only surface MoodStreak ever draws on.
    for (const [name, t] of [["LIGHT", LIGHT], ["DARK", DARK]] as const) {
      expect(contrast(t.track, t.panel), `${name} track on panel`).toBeGreaterThanOrEqual(1.5);
      // And it must stay quieter than the filled steps, or the empty half of the scale reads as
      // the filled half.
      for (const [i, fill] of (name === "LIGHT" ? MOOD_LIGHT : MOOD_DARK).entries()) {
        expect(contrast(fill, t.panel), `${name} mood step ${i + 1} vs its own track`)
          .toBeGreaterThan(contrast(t.track, t.panel));
      }
    }
  });

  it("gives every mood step its own colour", () => {
    // A ramp with a duplicate makes two different moods look identical on the streak.
    expect(new Set(MOOD_LIGHT).size).toBe(5);
    expect(new Set(MOOD_DARK).size).toBe(5);
  });

  it("picks the ramp that matches the scheme", () => {
    expect(moodRampFor("dark")).toBe(MOOD_DARK);
    expect(moodRampFor(null)).toBe(MOOD_LIGHT);
  });
});

describe("type scale", () => {
  // Vietnamese stacks two marks on one vowel (ẫ, ể, ỗ). At the ~1.35 line-height a Latin-only UI
  // gets away with, the hook of an `ể` collides with the descender above it. Everything that can
  // wrap to a second line is set looser than that on purpose, and this is the guard.
  it("leaves room for stacked diacritics on anything that wraps", () => {
    const wrapping = ["ask", "title", "body", "bodyMedium", "small", "smallMedium"] as const;
    for (const k of wrapping) {
      const { fontSize, lineHeight } = TYPE[k];
      expect(lineHeight / fontSize, `TYPE.${k}`).toBeGreaterThanOrEqual(1.4);
    }
  });

  it("uses the Vietnamese-drawn face for everything the user reads at length", () => {
    // Fraunces earns exactly two slots (see fonts.ts). If it spreads into body copy the app
    // stops being a notebook and starts being a magazine -- and Fraunces's diacritics are not
    // what Be Vietnam Pro's are.
    const fraunces = Object.entries(TYPE)
      .filter(([, v]) => v.fontFamily.startsWith("Fraunces"))
      .map(([k]) => k);
    expect(fraunces.sort()).toEqual(["ask", "wordmark"]);
  });
});

describe("spacing and radius scales", () => {
  it("ascend, so a larger name is never a smaller value", () => {
    const ascends = (xs: readonly number[]) =>
      xs.every((v, i) => i === 0 || v > xs[i - 1]!);
    expect(ascends(Object.values(SPACE))).toBe(true);
    expect(ascends(Object.values(RADIUS))).toBe(true);
  });

  it("keeps the 4px rhythm", () => {
    for (const [k, v] of Object.entries(SPACE)) {
      expect(v % 2, `SPACE.${k}`).toBe(0);
    }
  });
});
