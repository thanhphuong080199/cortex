import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncedSaver } from "./use-debounced-save";

describe("createDebouncedSaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges patches and saves once after the delay", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = createDebouncedSaver(save, 800, () => {});
    s.queue({ content: "a" });
    s.queue({ content: "ab", title: "t" });
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ content: "ab", title: "t" });
  });

  it("flush saves immediately and cancels the timer", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = createDebouncedSaver(save, 800, () => {});
    s.queue({ content: "x" });
    await s.flush();
    expect(save).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledOnce(); // no double fire
  });

  it("flush with nothing pending does not call save", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = createDebouncedSaver(save, 800, () => {});
    await s.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("reports error status and keeps the patch for retry", async () => {
    const statuses: string[] = [];
    const save = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const s = createDebouncedSaver(save, 800, (st) => statuses.push(st));
    s.queue({ content: "keep me" });
    await vi.advanceTimersByTimeAsync(800);
    expect(statuses).toContain("error");
    await s.flush(); // retry sends the same pending patch
    expect(save).toHaveBeenLastCalledWith({ content: "keep me" });
    expect(statuses[statuses.length - 1]).toBe("saved");
  });

  it("keeps edits made while a save is in flight", async () => {
    let release: () => void = () => {};
    const save = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { release = r; }))
      .mockResolvedValue(undefined);
    const s = createDebouncedSaver(save, 800, () => {});
    s.queue({ content: "first" });
    await vi.advanceTimersByTimeAsync(800);   // save #1 in flight
    s.queue({ content: "typed during save" }); // must not be lost when #1 resolves
    release();
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenLastCalledWith({ content: "typed during save" });
  });
});
