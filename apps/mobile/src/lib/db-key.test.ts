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
  // Note what this read does NOT do: consult the caller's `requireAuthentication`. That is
  // faithful, not a shortcut. On Android the read takes the flag from the STORED item
  // (SecureStoreModule.readJSONEncodedItem line 130), and AESEncryptor spells out why:
  // "We aren't using requiresAuthentication from the options, because it's not a necessary
  // option for read requests". So an un-gated key reads back cleanly even when the caller
  // asks for a gated read -- which is what lets one key survive a change of device security.
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

/** A device that can satisfy Class 3 biometrics, so the key is stored auth-gated. */
const GATED = { strongBiometrics: true } as const;
/** A PIN/pattern-only device, or one with only Class 2 face unlock. */
const UNGATED = { strongBiometrics: false } as const;

beforeEach(() => {
  store.clear();
  authGated.clear();
  failWritesTo = null;
  failReadsTo = null;
});

describe("getOrCreateDatabaseKey", () => {
  it("creates a key on first run", async () => {
    const r = await getOrCreateDatabaseKey(GATED);
    expect(r.status).toBe("created");
    expect(keyOf(r)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the key behind biometric authentication", async () => {
    await getOrCreateDatabaseKey(GATED);
    expect(authGated.has(DB_KEY_NAME)).toBe(true);
  });

  it("loads the same key on the next run", async () => {
    const first = await getOrCreateDatabaseKey(GATED);
    const second = await getOrCreateDatabaseKey(GATED);
    expect(second.status).toBe("loaded");
    expect(keyOf(second)).toBe(keyOf(first));
  });

  it("reports 'lost' -- not 'created' -- after a biometric enrollment", async () => {
    await getOrCreateDatabaseKey(GATED);
    simulateBiometricEnrollment();
    const r = await getOrCreateDatabaseKey(GATED);
    expect(r.status).toBe("lost");
  });

  it("issues a usable, freshly stored key alongside the 'lost' status", async () => {
    const first = await getOrCreateDatabaseKey(GATED);
    simulateBiometricEnrollment();
    expect(store.has(DB_KEY_NAME)).toBe(false); // the OS really destroyed it

    const r = await getOrCreateDatabaseKey(GATED);
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
   * `const { key } = await getOrCreateDatabaseKey(GATED)` type-checks, runs, and silently skips the
   * wipe that `lost` exists to demand -- opening SQLCipher with a key that cannot decrypt the
   * file, far from the code that caused it. Naming it `unusableKey` breaks that destructure at
   * compile time. Types are erased at runtime, so this asserts the shape the compiler relies on.
   */
  it("does not expose a 'key' field on the lost variant", async () => {
    await getOrCreateDatabaseKey(GATED);
    simulateBiometricEnrollment();

    const r = await getOrCreateDatabaseKey(GATED);
    expect(r.status).toBe("lost");
    expect(Object.keys(r).sort()).toEqual(["status", "unusableKey"]);
  });

  it("returns to 'created' after clearDatabaseKey, since the init flag is gone too", async () => {
    await getOrCreateDatabaseKey(GATED);
    await clearDatabaseKey();
    expect((await getOrCreateDatabaseKey(GATED)).status).toBe("created");
  });

  it("stores the init flag WITHOUT authentication, so enrollment cannot erase it", async () => {
    await getOrCreateDatabaseKey(GATED);
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
      await expect(getOrCreateDatabaseKey(GATED)).rejects.toThrow();
      failWritesTo = null;

      // The next boot succeeds and hands over a key; the caller builds the real database.
      const boot = await getOrCreateDatabaseKey(GATED);
      expect(keyOf(boot)).toMatch(/^[0-9a-f]{64}$/);

      simulateBiometricEnrollment();
      expect((await getOrCreateDatabaseKey(GATED)).status).toBe("lost");
    },
  );

  // A store that is already inconsistent -- key present, flag absent -- must not stay that way,
  // or the very next enrollment reports `created` over a live database.
  it("repairs a missing init flag on the load path", async () => {
    store.set(DB_KEY_NAME, "a".repeat(64));
    authGated.add(DB_KEY_NAME);

    expect((await getOrCreateDatabaseKey(GATED)).status).toBe("loaded");
    expect(store.get(INIT_FLAG_NAME)).toBe("1");

    simulateBiometricEnrollment();
    expect((await getOrCreateDatabaseKey(GATED)).status).toBe("lost");
  });

  // Writing an auth-gated value prompts on Android just as reading one does, so the CREATION
  // path can fail on a cancelled prompt exactly like the read path. It must map to the same
  // error, or the caller sees a raw platform exception from one path and a mapped one from the
  // other for the identical user action.
  it("maps a failed prompt on the key write to biometric_prompt_failed", async () => {
    failWritesTo = DB_KEY_NAME;
    await expect(getOrCreateDatabaseKey(GATED)).rejects.toThrow("biometric_prompt_failed");
  });

  it("maps a failed prompt on the key read to biometric_prompt_failed", async () => {
    await getOrCreateDatabaseKey(GATED);
    failReadsTo = DB_KEY_NAME;
    await expect(getOrCreateDatabaseKey(GATED)).rejects.toThrow("biometric_prompt_failed");
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
    await expect(getOrCreateDatabaseKey(GATED)).rejects.toMatchObject({
      message: "biometric_prompt_failed",
      cause: expect.objectContaining({ message: "native write failed" }),
    });

    failWritesTo = null;
    await getOrCreateDatabaseKey(GATED);

    failReadsTo = DB_KEY_NAME;
    await expect(getOrCreateDatabaseKey(GATED)).rejects.toMatchObject({
      message: "biometric_prompt_failed",
      cause: expect.objectContaining({ message: "native read failed" }),
    });
  });
});

/**
 * Devices that cannot satisfy Class 3 biometrics.
 *
 * Spec §7.6 keeps `disableDeviceFallback: false` precisely so a PIN-only device is not locked
 * out — but `requireAuthentication` has no fallback, and SecureStore throws on both the read
 * and the write path when no strong biometric is enrolled. Gating the WRITE on what the device
 * can actually do is what keeps those users in. Their key is still Keystore-backed and the
 * database is still SQLCipher-encrypted; it is simply not bound to a user-auth event.
 */
describe("getOrCreateDatabaseKey on a device without strong biometrics", () => {
  it("stores the key WITHOUT authentication, so the write cannot throw", async () => {
    const r = await getOrCreateDatabaseKey(UNGATED);
    expect(r.status).toBe("created");
    expect(store.get(DB_KEY_NAME)).toBe(keyOf(r));
    expect(authGated.has(DB_KEY_NAME)).toBe(false);
  });

  it("keeps the init flag un-gated too, so both entries survive", async () => {
    await getOrCreateDatabaseKey(UNGATED);
    expect(store.get(INIT_FLAG_NAME)).toBe("1");
    expect(authGated.has(INIT_FLAG_NAME)).toBe(false);
  });

  it("cannot reach 'lost', because nothing invalidates an un-gated key", async () => {
    const first = await getOrCreateDatabaseKey(UNGATED);
    simulateBiometricEnrollment(); // destroys only auth-gated entries, as the OS does

    const second = await getOrCreateDatabaseKey(UNGATED);
    expect(second.status).toBe("loaded");
    expect(keyOf(second)).toBe(keyOf(first));
  });

  /**
   * The upgrade transition. A PIN-only user enrols a fingerprint; their un-gated key was never
   * invalidated, and the read is mode-agnostic, so it must still load. Reporting `lost` here
   * would wipe a perfectly readable database for a user who did nothing but improve their
   * device security.
   *
   * The key is deliberately NOT re-gated on the way through. Doing so would silently arm the
   * invalidation path — and therefore the wipe — for someone who previously had no such
   * exposure. The app lock now demands Class 3 either way, so access is already tightened.
   */
  it("still loads an un-gated key once a strong biometric is enrolled", async () => {
    const first = await getOrCreateDatabaseKey(UNGATED);

    const second = await getOrCreateDatabaseKey(GATED);
    expect(second.status).toBe("loaded");
    expect(keyOf(second)).toBe(keyOf(first));
    expect(authGated.has(DB_KEY_NAME)).toBe(false);
  });

  /**
   * The downgrade transition. Removing every enrolled biometric invalidates the gated key, and
   * Android reports that as `null` (KeyPermanentlyInvalidatedException -> return null, in
   * readJSONEncodedItem). The flag survives, so this is a true `lost` — and the replacement
   * key has to be written un-gated, or the recovery write throws on the device it is
   * recovering.
   */
  it("reports 'lost' and re-mints un-gated after biometrics are removed", async () => {
    await getOrCreateDatabaseKey(GATED);
    simulateBiometricEnrollment();

    const r = await getOrCreateDatabaseKey(UNGATED);
    expect(r.status).toBe("lost");
    expect(store.get(DB_KEY_NAME)).toBe(keyOf(r));
    expect(authGated.has(DB_KEY_NAME)).toBe(false);
  });
});
