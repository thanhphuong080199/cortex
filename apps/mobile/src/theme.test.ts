import { describe, expect, it } from "vitest";
import { DARK, LIGHT, themeFor } from "./theme";

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
    const keys = ["bg", "panel", "text", "muted", "line", "accent", "danger"] as const;
    for (const k of keys) {
      expect(typeof LIGHT[k], `LIGHT.${k}`).toBe("string");
      expect(typeof DARK[k], `DARK.${k}`).toBe("string");
    }
  });

  it("does not use the same value for text and background", () => {
    expect(LIGHT.text).not.toBe(LIGHT.bg);
    expect(DARK.text).not.toBe(DARK.bg);
  });
});
