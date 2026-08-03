import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KeyOutcome } from "./db-key.js";

const store = new Map<string, string>();
const authGated = new Set<string>();
// Fails the write to one named entry, modelling both a cancelled biometric prompt (writing an
// auth-gated value PROMPTS on Android -- see the note in db-key.ts) and process death partway
// through a multi-write sequence.
let failWritesTo: string | null = null;
// Same, for reads: reading the auth-gated key prompts, and the user can cancel that too.
let failReadsTo: string | null = null;

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => {
    if (k === failReadsTo) throw new Error("native read failed");
    return store.get(k) ?? null;
  }),
  setItemAsync: vi.fn(
    async (k: string, v: string, opts?: { requireAuthentication?: boolean }) => {
      if (k === failWritesTo) throw new Error("native write failed");
      store.set(k, v);
      if (opts?.requireAuthentication) authGated.add(k);
      else authGated.delete(k);
    },
  ),
  deleteItemAsync: vi.fn(async (k: string) => {
    store.delete(k);
    authGated.delete(k);
  }),
}));

// Every call must yield a DIFFERENT key. A constant RNG would make `second.key === first.key`
// below a tautology that an implementation minting a fresh key on every run would also pass.
vi.mock("expo-crypto", () => {
  let calls = 0;
  return {
    getRandomBytes: (n: number) => {
      calls += 1;
      return Uint8Array.from({ length: n }, (_, i) => (calls * 31 + i) % 256);
    },
  };
});

const { getOrCreateDatabaseKey, clearDatabaseKey, DB_KEY_NAME } = await import("./db-key.js");

/**
 * The key out of any outcome.
 *
 * `lost` deliberately names its key `unusableKey`, so `outcome.key` does not compile against
 * the union and no caller can reach a key without first branching on `status`. Tests need the
 * bytes regardless of which variant came back, so they go through here -- which is itself the
 * shape every real caller has to adopt.
 */
function keyOf(o: KeyOutcome): string {
  return o.status === "lost" ? o.unusableKey : o.key;
}

/**
 * What Android does when the user enrolls a new biometric.
 *
 * The entry is destroyed OUTRIGHT, so it must leave `authGated` too. Leaving the name behind
 * would make the "recovery re-gates the new key" assertion below pass on the FIRST write's
 * bookkeeping, never checking the recovery at all.
 */
function simulateBiometricEnrollment() {
  for (const k of [...authGated]) {
    store.delete(k);
    authGated.delete(k);
  }
}

const INIT_FLAG_NAME = "cortex.db.initialized";

beforeEach(() => {
  store.clear();
  authGated.clear();
  failWritesTo = null;
  failReadsTo = null;
});

describe("getOrCreateDatabaseKey", () => {
  it("creates a key on first run", async () => {
    const r = await getOrCreateDatabaseKey();
    expect(r.status).toBe("created");
    expect(keyOf(r)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the key behind biometric authentication", async () => {
    await getOrCreateDatabaseKey();
    expect(authGated.has(DB_KEY_NAME)).toBe(true);
  });

  it("loads the same key on the next run", async () => {
    const first = await getOrCreateDatabaseKey();
    const second = await getOrCreateDatabaseKey();
    expect(second.status).toBe("loaded");
    expect(keyOf(second)).toBe(keyOf(first));
  });

  it("reports 'lost' -- not 'created' -- after a biometric enrollment", async () => {
    await getOrCreateDatabaseKey();
    simulateBiometricEnrollment();
    const r = await getOrCreateDatabaseKey();
    expect(r.status).toBe("lost");
  });

  it("issues a usable, freshly stored key alongside the 'lost' status", async () => {
    const first = await getOrCreateDatabaseKey();
    simulateBiometricEnrollment();
    expect(store.has(DB_KEY_NAME)).toBe(false); // the OS really destroyed it

    const r = await getOrCreateDatabaseKey();
    // Narrow before touching the key at all. `lost` is the one variant whose key cannot open
    // the existing database, so it is the one variant that does not expose a `key` field --
    // reaching the bytes REQUIRES having established the status first.
    if (r.status !== "lost") throw new Error(`expected 'lost', got '${r.status}'`);
    expect(r.unusableKey).toMatch(/^[0-9a-f]{64}$/);
    // The old key is gone for good, so a recovery that somehow returned it would be
    // returning a key that cannot open anything.
    expect(r.unusableKey).not.toBe(keyOf(first));
    // The recovery must leave a key actually PERSISTED and auth-gated -- returning a key
    // it failed to store would open the new database once and lock the user out forever.
    expect(store.get(DB_KEY_NAME)).toBe(r.unusableKey);
    expect(authGated.has(DB_KEY_NAME)).toBe(true);
  });

  /**
   * The `lost` variant must NOT carry a field named `key`.
   *
   * That is the whole enforcement mechanism: with `key` on all three variants,
   * `const { key } = await getOrCreateDatabaseKey()` type-checks, runs, and silently skips the
   * wipe that `lost` exists to demand -- opening SQLCipher with a key that cannot decrypt the
   * file, far from the code that caused it. Naming it `unusableKey` breaks that destructure at
   * compile time. Types are erased at runtime, so this asserts the shape the compiler relies on.
   */
  it("does not expose a 'key' field on the lost variant", async () => {
    await getOrCreateDatabaseKey();
    simulateBiometricEnrollment();

    const r = await getOrCreateDatabaseKey();
    expect(r.status).toBe("lost");
    expect(Object.keys(r).sort()).toEqual(["status", "unusableKey"]);
  });

  it("returns to 'created' after clearDatabaseKey, since the init flag is gone too", async () => {
    await getOrCreateDatabaseKey();
    await clearDatabaseKey();
    expect((await getOrCreateDatabaseKey()).status).toBe("created");
  });

  it("stores the init flag WITHOUT authentication, so enrollment cannot erase it", async () => {
    await getOrCreateDatabaseKey();
    simulateBiometricEnrollment();
    expect([...store.keys()].some((k) => k.includes("initialized"))).toBe(true);
  });

  /**
   * THE INVARIANT THAT PROTECTS REAL DATA.
   *
   * Once any run has handed a key back to the caller, that caller may have built the encrypted
   * database with it. From that moment on, a biometric enrollment must report `lost` -- never
   * `created`, which tells the caller it is on a clean device and makes wiping the existing
   * database look correct.
   *
   * Writing the key and the flag is not atomic, so a crash can land between them. This holds
   * the invariant across a crash on EITHER write, which pins down the ordering: the flag has
   * to be durable before the key is, because a false `lost` only costs a resync while a false
   * `created` silently destroys the user's data.
   */
  it.each([DB_KEY_NAME, INIT_FLAG_NAME])(
    "never reports 'created' over a live database after a crashed write to %s",
    async (victim) => {
      failWritesTo = victim;
      await expect(getOrCreateDatabaseKey()).rejects.toThrow();
      failWritesTo = null;

      // The next boot succeeds and hands over a key; the caller builds the real database.
      const boot = await getOrCreateDatabaseKey();
      expect(keyOf(boot)).toMatch(/^[0-9a-f]{64}$/);

      simulateBiometricEnrollment();
      expect((await getOrCreateDatabaseKey()).status).toBe("lost");
    },
  );

  // A store that is already inconsistent -- key present, flag absent -- must not stay that way,
  // or the very next enrollment reports `created` over a live database.
  it("repairs a missing init flag on the load path", async () => {
    store.set(DB_KEY_NAME, "a".repeat(64));
    authGated.add(DB_KEY_NAME);

    expect((await getOrCreateDatabaseKey()).status).toBe("loaded");
    expect(store.get(INIT_FLAG_NAME)).toBe("1");

    simulateBiometricEnrollment();
    expect((await getOrCreateDatabaseKey()).status).toBe("lost");
  });

  // Writing an auth-gated value prompts on Android just as reading one does, so the CREATION
  // path can fail on a cancelled prompt exactly like the read path. It must map to the same
  // error, or the caller sees a raw platform exception from one path and a mapped one from the
  // other for the identical user action.
  it("maps a failed prompt on the key write to biometric_prompt_failed", async () => {
    failWritesTo = DB_KEY_NAME;
    await expect(getOrCreateDatabaseKey()).rejects.toThrow("biometric_prompt_failed");
  });

  it("maps a failed prompt on the key read to biometric_prompt_failed", async () => {
    await getOrCreateDatabaseKey();
    failReadsTo = DB_KEY_NAME;
    await expect(getOrCreateDatabaseKey()).rejects.toThrow("biometric_prompt_failed");
  });

  /**
   * Not every rejection from an auth-gated call is a cancelled prompt. A disk-full write or a
   * corrupt keystore rejects through the same catch, and reporting THAT as
   * `biometric_prompt_failed` tells the caller to re-prompt a user who cannot fix it -- an
   * unbounded prompt loop against a broken store, with the only diagnostic discarded. The
   * mapping stays (one error shape for one user action) but it must not destroy evidence.
   */
  it("preserves the underlying failure as `cause` on both paths", async () => {
    failWritesTo = DB_KEY_NAME;
    await expect(getOrCreateDatabaseKey()).rejects.toMatchObject({
      message: "biometric_prompt_failed",
      cause: expect.objectContaining({ message: "native write failed" }),
    });

    failWritesTo = null;
    await getOrCreateDatabaseKey();

    failReadsTo = DB_KEY_NAME;
    await expect(getOrCreateDatabaseKey()).rejects.toMatchObject({
      message: "biometric_prompt_failed",
      cause: expect.objectContaining({ message: "native read failed" }),
    });
  });
});
