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

// SecureStore rejects values over 2048 bytes; chunk below that with headroom for the fact
// that the limit is in BYTES while `length` counts UTF-16 units.
export const SECURE_CHUNK_SIZE = 1024;

const countKey = (key: string) => `${key}__chunks`;
const chunkKey = (key: string, i: number) => `${key}__${i}`;

async function readCount(key: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(countKey(key));
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export const secureStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    const count = await readCount(key);
    if (count === 0) return null;
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(chunkKey(key, i));
      if (part === null) return null; // torn write: treat as absent, force a re-login
      parts.push(part);
    }
    return parts.join("");
  },

  async setItem(key: string, value: string): Promise<void> {
    // Drop the previous chunks FIRST: shrinking from 3 chunks to 1 without this would
    // leave chunk 2 behind, and the next read would splice a stale tail onto the value.
    await this.removeItem(key);
    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += SECURE_CHUNK_SIZE) {
      chunks.push(value.slice(i, i + SECURE_CHUNK_SIZE));
    }
    for (const [i, part] of chunks.entries()) {
      await SecureStore.setItemAsync(chunkKey(key, i), part);
    }
    await SecureStore.setItemAsync(countKey(key), String(chunks.length));
  },

  async removeItem(key: string): Promise<void> {
    const count = await readCount(key);
    for (let i = 0; i < count; i++) await SecureStore.deleteItemAsync(chunkKey(key, i));
    await SecureStore.deleteItemAsync(countKey(key));
  },
};
