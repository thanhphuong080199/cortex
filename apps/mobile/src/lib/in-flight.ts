/**
 * A one-at-a-time guard for a button that writes.
 *
 * `disabled={busy}` and `if (busy) return` are BOTH insufficient on their own, and the reason is
 * the same for each: `busy` is React state, so it does not change until a re-render lands. Two
 * taps inside one frame therefore both read `false`, both pass the check, and both run -- which
 * for capture is two notes, for a media log two entries, and for a check-in two rows the user
 * has to undo twice. The second one is invisible until it syncs, so nothing on screen says it
 * happened.
 *
 * A module-level mutable flag flips synchronously inside the handler, so the second tap sees it.
 * Keep the state variable as well: it is what greys the button out and tells the user why it is
 * unresponsive. The state is for the human, this is for the race.
 *
 * Deliberately NOT a hook. Anything that has to run inside a React Native component cannot be
 * tested here -- importing an RN component under `environment: "node"` dies with a Rollup Flow
 * parse error -- so the guard is a plain closure the component parks in a `useRef`, and the
 * behaviour that matters is exercised directly.
 */
export interface InFlightGuard {
  /**
   * Runs `action` unless a previous call is still running. Resolves `true` if it ran, `false` if
   * it was dropped as a duplicate, so a caller can tell "declined" from "did nothing".
   *
   * Errors propagate: the guard decides whether to run, never what a failure means. It still
   * releases, or one thrown error would leave the button dead for the rest of the session.
   */
  (action: () => Promise<void>): Promise<boolean>;
}

export function createInFlightGuard(): InFlightGuard {
  let running = false;
  return async (action) => {
    if (running) return false;
    running = true;
    try {
      await action();
      return true;
    } finally {
      running = false;
    }
  };
}
