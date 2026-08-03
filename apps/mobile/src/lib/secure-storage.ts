import * as SecureStore from "expo-secure-store";

/**
 * supabase-js storage backed by Android Keystore (phase 1b spec §7.2).
 *
 * Replaces AsyncStorage, which on Android is unencrypted app-sandbox storage INCLUDED IN
 * ANDROID AUTO BACKUP to Google Drive. A Supabase refresh token is long-lived, so leaving
 * it there put full account access in a cloud backup.
 *
 * No `requireAuthentication` here, deliberately: a biometric prompt on every token refresh
 * would be unusable, and the app-lock gate (Task 10) is where user presence is checked.
 * The key that DOES use requireAuthentication is the database key (Task 9), which is why
 * only that one needs the invalidation-recovery path.
 */

// SecureStore's docs give 2048 BYTES as the per-value ceiling. expo-secure-store 57.0.1
// enforces no limit anywhere (JS, Android Kotlin, iOS), so the chunking below is defensive:
// the docs say the cap may start being enforced in a future SDK, and a session that stopped
// persisting after an SDK bump would look like a login bug, not a storage-size bug.
//
// The budget is in UTF-8 BYTES, not `String.length` UTF-16 code units. Those differ by up to
// 3x: precomposed Vietnamese diacritics (U+1EA0-U+1EF9, very likely in a Google `full_name`)
// are one code unit and three bytes each, so a 1024-code-unit slice can be 3072 bytes -- 1.5x
// OVER the documented cap. 1024 bytes is half the cap, which leaves room for the key name and
// for any per-entry overhead the platform adds on top of the value.
export const SECURE_CHUNK_SIZE = 1024;

// `removeItem` sweeps this many indices past the recorded count. A crash between the chunk
// writes and the count write leaves chunks no count key covers: unreachable to `getItem` AND
// undeletable by a `removeItem` that trusts the count, i.e. session material that sign-out can
// never clear. A realistic Supabase session (access JWT + refresh token + user_metadata) is a
// few KB, so a crashed maximal write followed by a minimal one strands ~3 chunks; 4 covers that
// with room to spare, and the cost is 4 no-op native deletes on a path that runs at sign-out.
const ORPHAN_SWEEP_MARGIN = 4;

const encoder = new TextEncoder();

const countKey = (key: string) => `${key}__chunks`;
const chunkKey = (key: string, i: number) => `${key}__${i}`;

async function readCount(key: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(countKey(key));
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Split a value into chunks of at most SECURE_CHUNK_SIZE UTF-8 bytes, never mid-code-point.
 *
 * `for...of` over a string iterates code points, so a surrogate pair is never split across two
 * chunks. That matters beyond tidiness: Hermes converts a JS string to UTF-8 when it crosses
 * into a native module, and a lone surrogate has no UTF-8 encoding, so an emoji landing on a
 * chunk boundary would come back as two U+FFFD and corrupt the rejoined JSON.
 */
function splitIntoChunks(value: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const codePoint of value) {
    const size = encoder.encode(codePoint).length;
    if (currentBytes > 0 && currentBytes + size > SECURE_CHUNK_SIZE) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += size;
  }

  // Always emit at least one chunk, so `setItem(key, "")` round-trips as "" rather than null.
  if (currentBytes > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

// Hoisted out of the object literal so nothing depends on the call site preserving `this`.
// supabase-js 2.x holds the adapter whole and only ever calls it as a method, but session
// persistence should not rest on a third party's internal calling convention: a version that
// destructured would otherwise throw on EVERY session write, and no method-call unit test
// would catch it.
async function readValue(key: string): Promise<string | null> {
  const count = await readCount(key);
  if (count === 0) return null;

  // One Keystore decrypt per chunk; Task 10's app-lock and Stage 3 call getSession() often, so
  // issue them together rather than count+1 sequential native round-trips.
  const parts = await Promise.all(
    Array.from({ length: count }, (_, i) => SecureStore.getItemAsync(chunkKey(key, i))),
  );

  let value = "";
  for (const part of parts) {
    if (part === null) return null; // torn write: treat as absent, force a re-login
    value += part;
  }
  return value;
}

async function writeValue(key: string, value: string): Promise<void> {
  // Drop the previous chunks FIRST: shrinking from 3 chunks to 1 without this would
  // leave chunk 2 behind, and the next read would splice a stale tail onto the value.
  await clearValue(key);
  const chunks = splitIntoChunks(value);
  for (const [i, part] of chunks.entries()) {
    await SecureStore.setItemAsync(chunkKey(key, i), part);
  }
  // The count key is written LAST and is the commit point: it exists only once every chunk of
  // THIS value is on disk, and is absent for the whole window in which chunks are being
  // written. Every crash point therefore reads back as the intact previous value or as null,
  // never as a wrong or spliced one. Do not move this write earlier.
  await SecureStore.setItemAsync(countKey(key), String(chunks.length));
}

async function clearValue(key: string): Promise<void> {
  const count = await readCount(key);
  await Promise.all(
    Array.from({ length: count + ORPHAN_SWEEP_MARGIN }, (_, i) =>
      SecureStore.deleteItemAsync(chunkKey(key, i)),
    ),
  );
  // Same ordering rule as the write path, mirrored: the count key goes last, so a crash mid-
  // delete leaves a count key whose chunks are missing, which `getItem` already reads as null.
  await SecureStore.deleteItemAsync(countKey(key));
}

// @supabase/auth-js runs LOCKLESS by default (`this.lock = null` unless a `lock` option is
// passed), so nothing upstream stops two operations on the session key from interleaving:
// two writes could splice chunk 0 of one value onto chunks 1..n of another, and a sign-out
// landing inside a write could read count = 0, delete nothing, and leave a live refresh token
// in Keystore while the UI reports the user signed out. One promise chain per key removes the
// interleaving entirely.
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  // The stored tail always resolves, so one failed operation cannot poison the ones behind it.
  // Dropping the entry once the chain drains keeps the map from growing with dead keys.
  const tail: Promise<unknown> = result
    .catch(() => undefined)
    .then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
  queues.set(key, tail);
  return result;
}

// Arrow properties, not methods: these work whether called as `storage.getItem(k)` or
// destructured (see the hoisting note above).
export const secureStorageAdapter = {
  getItem: (key: string): Promise<string | null> => serialize(key, () => readValue(key)),
  setItem: (key: string, value: string): Promise<void> =>
    serialize(key, () => writeValue(key, value)),
  removeItem: (key: string): Promise<void> => serialize(key, () => clearValue(key)),
};
