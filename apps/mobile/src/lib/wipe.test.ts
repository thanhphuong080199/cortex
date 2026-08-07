import { beforeEach, describe, expect, it, vi } from "vitest";

const cleared = vi.fn(async () => {});
vi.mock("./db-key.js", () => ({ clearDatabaseKey: cleared }));

const { wipeLocalData } = await import("./wipe.js");

beforeEach(() => {
  cleared.mockClear();
});

describe("wipeLocalData", () => {
  it("clears the database and then the key", async () => {
    const order: string[] = [];
    const db = {
      disconnectAndClear: vi.fn(async () => {
        order.push("db");
      }),
    };
    cleared.mockImplementationOnce(async () => {
      order.push("key");
    });

    await wipeLocalData(db);

    // Order, not just occurrence. The key has to outlive the database clear: dropping the key
    // first would leave `disconnectAndClear` operating on a database it can no longer open.
    expect(order).toEqual(["db", "key"]);
  });

  it("still clears the key when there is no database yet", async () => {
    await wipeLocalData(null);
    expect(cleared).toHaveBeenCalledOnce();
  });

  /**
   * A failed database clear must not swallow itself.
   *
   * The plan's draft called `wipeLocalData(db)` here and asserted only that the key was
   * cleared -- but the `finally` re-raises, so that test fails against its own implementation.
   * Propagating is the right half of that contradiction to keep: `signOut` awaits this before
   * `supabase.auth.signOut()`, and a caller that cannot tell a partial wipe from a complete one
   * will report "signed out" over a device it did not finish cleaning.
   *
   * The key is still gone, which is what makes the leftover file inert rather than dangerous.
   */
  it("clears the key even when clearing the database throws, and still reports the failure", async () => {
    const db = {
      disconnectAndClear: vi.fn(async () => {
        throw new Error("locked");
      }),
    };

    await expect(wipeLocalData(db)).rejects.toThrow("locked");
    expect(cleared).toHaveBeenCalledOnce();
  });

  it("surfaces a failure to clear the key itself", async () => {
    cleared.mockImplementationOnce(async () => {
      throw new Error("keystore unavailable");
    });

    // The dangerous direction: the database is gone but its key survives in Keystore. Silent
    // here would mean signing out while a live key sits beside the wiped database.
    await expect(wipeLocalData(null)).rejects.toThrow("keystore unavailable");
  });
});
