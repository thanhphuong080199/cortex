import { describe, expect, it } from "vitest";

import { createInFlightGuard } from "./in-flight.js";

/** A promise this test controls, standing in for a write that has not finished yet. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createInFlightGuard", () => {
  it("drops a second call made before the first resolves", async () => {
    const run = createInFlightGuard();
    const gate = deferred();
    let calls = 0;

    // Both taps happen while the first write is still in flight -- the case a `busy` state
    // variable cannot catch, because no re-render has happened between them.
    const first = run(async () => {
      calls += 1;
      await gate.promise;
    });
    const second = run(async () => {
      calls += 1;
    });

    expect(await second).toBe(false);
    expect(calls).toBe(1);

    gate.resolve();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
  });

  it("runs the next call once the previous one has finished", async () => {
    const run = createInFlightGuard();
    let calls = 0;
    const action = async () => {
      calls += 1;
    };

    expect(await run(action)).toBe(true);
    expect(await run(action)).toBe(true);
    // Undo-then-log-again is an ordinary sequence; a guard that latched would break it.
    expect(calls).toBe(2);
  });

  it("releases after the action throws, rather than wedging the button", async () => {
    const run = createInFlightGuard();
    let calls = 0;

    await expect(
      run(async () => {
        calls += 1;
        throw new Error("local write failed");
      }),
    ).rejects.toThrow("local write failed");

    // One failed save must not make the screen permanently unresponsive -- retrying is the
    // whole point of telling the user it failed.
    expect(await run(async () => void (calls += 1))).toBe(true);
    expect(calls).toBe(2);
  });

  it("propagates the error rather than reporting the call as declined", async () => {
    const run = createInFlightGuard();
    // Swallowing here would make a failed write indistinguishable from a duplicate tap, and
    // the screens use that distinction to decide whether to show an error.
    await expect(run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("guards each instance separately", async () => {
    const capture = createInFlightGuard();
    const log = createInFlightGuard();
    const gate = deferred();

    const pending = capture(async () => {
      await gate.promise;
    });
    // A capture in flight must not disable the media form on another screen.
    expect(await log(async () => undefined)).toBe(true);

    gate.resolve();
    await pending;
  });
});
