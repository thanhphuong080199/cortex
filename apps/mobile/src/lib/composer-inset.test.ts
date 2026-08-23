import { describe, expect, it } from "vitest";
import { composerInset } from "./composer-inset";

/**
 * The arithmetic behind both halves of the 2026-08-23 mobile report: the composer sitting under
 * the gesture navigation bar, and the keyboard drawing straight over it.
 *
 * Only the pure function is covered here. `useComposerInset` reads a native keyboard frame and a
 * native safe-area provider, neither of which exists under vitest; a test that mocked both would
 * be asserting the mocks. What CAN be wrong without a device is the combining rule, so that is
 * what is pinned.
 */
describe("composerInset", () => {
  // Keyboard closed. This is the half that was missing entirely -- nothing in the tree applied
  // an inset, so the composer's bottom edge was the screen's bottom edge and Android drew the
  // gesture bar on top of it.
  it("clears the navigation bar when no keyboard is up", () => {
    expect(composerInset({ keyboardHeight: 0, safeAreaBottom: 48 })).toBe(48);
  });

  // Keyboard open. The other missing half: Android got `behavior={undefined}`, which is
  // KeyboardAvoidingView doing nothing.
  it("clears the keyboard when one is up", () => {
    expect(composerInset({ keyboardHeight: 320, safeAreaBottom: 48 })).toBe(320);
  });

  // THE ONE THAT MATTERS, and the reason this is `max` and not `+`. The keyboard is drawn OVER
  // the navigation bar, so the two overlap. Summing them (368) would leave a nav-bar-high band
  // of dead space between the composer and the top of the keyboard -- a bug that looks like
  // sloppy spacing rather than like the wrong operator, which is exactly why it is worth a test.
  it("does not stack the two when the keyboard covers the navigation bar", () => {
    expect(composerInset({ keyboardHeight: 320, safeAreaBottom: 48 })).not.toBe(368);
  });

  // A device with hardware buttons and no keyboard reports 0 for both. Padding must be 0, not
  // some floor -- a phone with no insets should look exactly as it did before this change.
  it("adds nothing on a device that needs nothing", () => {
    expect(composerInset({ keyboardHeight: 0, safeAreaBottom: 0 })).toBe(0);
  });
});
