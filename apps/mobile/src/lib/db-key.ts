import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

/**
 * The SQLCipher key for the local PowerSync database (phase 1b spec §7.4, §7.5).
 *
 * THE TRAP this module exists to survive, in Expo's own words:
 *
 *   "Keys are invalidated by the system when biometrics change. This only applies to
 *    values stored with requireAuthentication set to true."
 *   getItemAsync "resolves with null if there is no entry for the given key OR IF THE KEY
 *    HAS BEEN INVALIDATED."
 *
 * So enrolling a new fingerprint destroys this key and reports it as `null` -- exactly
 * what first run looks like. Minting a fresh key at that point produces a key that cannot
 * open the existing encrypted database, and the failure surfaces later and elsewhere.
 *
 * INIT_FLAG is stored WITHOUT requireAuthentication, so enrollment cannot erase it.
 * `null` key + flag present therefore means "key lost", and the caller must wipe the
 * local database and resync. The server is authoritative, so nothing committed is lost --
 * but local changes not yet uploaded are, which is why the caller warns before wiping.
 */
export const DB_KEY_NAME = "cortex.db.key";
const INIT_FLAG = "cortex.db.initialized";

export type KeyOutcome =
  | { status: "created"; key: string }
  | { status: "loaded"; key: string }
  // The key CANNOT open the existing database -- it is a fresh key for a database that does
  // not exist yet. The caller MUST delete the local database file before opening anything
  // with it.
  //
  // The field is named `unusableKey`, not `key`, and that asymmetry is the enforcement.
  // With `key` on all three variants, `const { key } = await getOrCreateDatabaseKey()`
  // type-checks and runs while ignoring the one signal that says "wipe first", and SQLCipher
  // then fails to decrypt somewhere far from the cause. With this name, reading a key off the
  // union does not compile at all until the caller has branched on `status`.
  | { status: "lost"; unusableKey: string };

// expo-crypto 57.0.1 exports `getRandomBytes` as a synchronous function returning a
// Uint8Array, backed by the native `ExpoCrypto.getRandomValues`. It is not deprecated.
// 32 bytes is inside its documented 0...1024 range.
function newKey(): string {
  return [...Crypto.getRandomBytes(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getOrCreateDatabaseKey(): Promise<KeyOutcome> {
  // Read the flag FIRST: it is the only thing that distinguishes "no key yet" from
  // "key destroyed by the OS", and both present as a null key. This read is un-gated, so
  // it cannot prompt and cannot fail on a cancelled prompt -- hence it sits outside the
  // try below, where a rejection genuinely would be a storage fault worth surfacing raw.
  const initialized = (await SecureStore.getItemAsync(INIT_FLAG)) === "1";

  let existing: string | null = null;
  try {
    existing = await SecureStore.getItemAsync(DB_KEY_NAME, { requireAuthentication: true });
  } catch (cause) {
    // A rejection is USUALLY the biometric PROMPT failing (user cancelled, too many attempts)
    // -- not an invalidated key. Treat it as "no answer yet" and let the caller retry;
    // reporting `lost` here would wipe a perfectly good database over a cancelled prompt.
    //
    // But it is not always that: a corrupt keystore rejects through here too, and retrying
    // prompts a user who cannot fix it. The mapping stays -- one error shape for what is one
    // action to the user -- but `cause` must survive it, or that case has no diagnostic at all.
    throw new Error("biometric_prompt_failed", { cause });
  }

  if (existing !== null) {
    // Repair a store whose key survived but whose flag did not. That combination is not
    // hypothetical: any interruption that lands between the two writes below, or between
    // the two deletes in clearDatabaseKey, can produce it. Left unrepaired it is a silent
    // data-loss bug -- the NEXT enrollment would find a null key and an absent flag and
    // report `created` over a database full of the user's real data, and the caller would
    // wipe it believing this was a clean device. Idempotent, and un-gated so it never prompts.
    if (!initialized) await SecureStore.setItemAsync(INIT_FLAG, "1");
    return { status: "loaded", key: existing };
  }

  const key = newKey();

  // ORDERING IS LOAD-BEARING: the flag is made durable BEFORE the key.
  //
  // These two writes are not atomic, so a crash can land between them, and the two orders
  // fail very differently:
  //
  //   flag first (this order)  -- crash leaves flag, no key. Next run reports `lost`, so the
  //                               caller wipes a database that does not exist yet. Costs a
  //                               resync. Harmless.
  //   key first                -- crash leaves key, no flag. Next run reports `loaded` and,
  //                               without the repair above, never writes the flag. The caller
  //                               then builds the REAL database on that key, and the first
  //                               biometric enrollment after that reports `created` over live
  //                               data. Silent, total loss of anything not yet uploaded.
  //
  // A false `lost` costs a resync; a false `created` destroys the user's data. Do not swap.
  if (!initialized) await SecureStore.setItemAsync(INIT_FLAG, "1");

  try {
    // Writing an auth-gated value PROMPTS on Android, exactly as reading one does:
    // SecureStoreModule.setItemImpl -> AESEncryptor.createEncryptedItem ->
    // AuthenticationHelper.authenticateCipher -> BiometricPrompt. A cancelled prompt raises
    // AuthenticationException, which is a CodedException and so is rethrown unwrapped and
    // rejects this call. Map it to the same error the read path uses, so the caller does not
    // have to handle a raw platform exception from one path and a mapped one from the other
    // for what is, to the user, the identical action.
    await SecureStore.setItemAsync(DB_KEY_NAME, key, { requireAuthentication: true });
  } catch (cause) {
    // Same mapping, same reason to keep the cause: a full disk rejects here exactly like a
    // cancelled prompt does, and only `cause` tells the two apart after the fact.
    throw new Error("biometric_prompt_failed", { cause });
  }

  return initialized ? { status: "lost", unusableKey: key } : { status: "created", key };
}

/** Sign-out and post-wipe cleanup: both entries go, so the next run is a clean first run. */
export async function clearDatabaseKey(): Promise<void> {
  // Mirrors the write ordering: the key goes first, so an interruption leaves the flag
  // behind rather than the key. A leftover flag reports `lost` (safe); a leftover key
  // would report `loaded` with no flag, which is the dangerous state the repair above exists
  // to mop up. Belt and braces -- do not reorder these either.
  await SecureStore.deleteItemAsync(DB_KEY_NAME);
  await SecureStore.deleteItemAsync(INIT_FLAG);
}

// WHAT THE COMPILER DOES AND DOES NOT ENFORCE, for callers (Task 13's wipe, Task 17's open):
//
// It DOES stop you reaching a key without branching. `outcome.key` does not compile against
// the union, because the `lost` variant has no such field -- so the dangerous shortcut,
// `const { key } = await getOrCreateDatabaseKey()`, is a type error rather than silent
// corruption.
//
// It does NOT verify that the branch you write actually wipes. Nothing here can. On `lost`,
// delete the database FILE before opening anything: `unusableKey` is a key for a database
// that does not exist yet, so handing it to SQLCipher against the old file fails to decrypt.
// Clearing through the database handle after opening it with this key is too late.
