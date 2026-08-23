import { describe, expect, it } from "vitest";
import { viewport } from "./layout";

/**
 * The App Router emits `<meta name="viewport">` from a `viewport` export and from NOTHING else --
 * there is no default and no framework fallback. With the export missing (as it was until
 * 2026-08-23) the tag is simply absent from the document, so a phone browser lays the page out
 * against a ~980px layout viewport and scales the result down. Every width in globals.css -- the
 * 720px column, the 78% bubbles, the composer -- was being measured against a viewport twice the
 * width of the device, which is the whole of the reported "web khi xài ở đt bị break UI".
 *
 * `100dvh` on `body` (globals.css) is measured against that same viewport, which is the second
 * half of it: with no tag, the composer does not sit where the visible bottom of the screen is.
 *
 * Asserted as an export rather than by rendering RootLayout: the metadata/viewport exports are
 * read by the framework at build time, never by React, so rendering the component would prove
 * nothing about what ends up in <head>.
 */
describe("the document", () => {
  it("declares a device-width viewport", () => {
    expect(viewport.width).toBe("device-width");
    expect(viewport.initialScale).toBe(1);
  });

  // Deliberately NOT capped. Locking zoom on an app that is nothing but text is an
  // accessibility regression, iOS has ignored it since 10, and it is the one thing a
  // "make it fit the phone" edit is most likely to add on the way past.
  it("does not lock zoom", () => {
    expect(viewport.maximumScale).toBeUndefined();
    expect(viewport.userScalable).toBeUndefined();
  });

  // What makes env(safe-area-inset-bottom) resolve to a real number instead of 0px. The
  // composer sits on the bottom edge of the screen, which on a gesture-navigation phone is
  // where the system bar is drawn.
  it("extends the layout under the device's insets so the composer can pad for them", () => {
    expect(viewport.viewportFit).toBe("cover");
  });
});
