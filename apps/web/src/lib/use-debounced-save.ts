export type SaveStatus = "idle" | "saving" | "saved" | "error";
export type Patch = Record<string, unknown>;

/**
 * Coalesces keystrokes into one PATCH per quiet period.
 *
 * The invariant that matters: a failed save NEVER discards the pending patch, so the
 * user's text survives a dead network and `flush()` retries it (spec §5.3).
 */
export function createDebouncedSaver(
  save: (patch: Patch) => Promise<void>,
  delayMs: number,
  onStatus: (s: SaveStatus) => void,
) {
  let pending: Patch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function fire() {
    if (!pending) return;
    const patch = pending;
    onStatus("saving");
    try {
      await save(patch);
      // Only clear if nothing new was queued while the request was in flight --
      // otherwise keystrokes typed during the save would be silently dropped.
      if (pending === patch) pending = null;
      onStatus("saved");
    } catch {
      onStatus("error"); // patch stays pending -- retry via flush()
    }
  }

  return {
    queue(patch: Patch) {
      pending = { ...pending, ...patch };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fire(), delayMs);
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      await fire();
    },
  };
}
