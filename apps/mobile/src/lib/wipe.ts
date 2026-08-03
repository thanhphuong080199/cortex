import { clearDatabaseKey } from "./db-key.js";

/**
 * Removes every trace of the signed-in user from the device (phase 1b spec §7.7).
 *
 * Without this, signing out leaves the full note corpus on the phone permanently -- the
 * account is gone from the UI while the data it protected is not.
 *
 * The key is cleared LAST and unconditionally: a database that failed to clear must not be
 * left with a live key beside it, and an orphaned encrypted file with no key is inert.
 *
 * A failure still propagates once the key is gone. `signOut` awaits this before
 * `supabase.auth.signOut()`, so swallowing here would report "signed out" over a device that
 * was only partly cleaned -- and PowerSync may still be holding a live stream.
 *
 * NOT the recovery path for a `lost` key. That case cannot use `disconnectAndClear()` at all,
 * because the database cannot be opened to clear it; it needs the file deleted outright
 * (see the closing note in `db-key.ts`).
 */
export async function wipeLocalData(
  db: { disconnectAndClear(): Promise<void> } | null,
): Promise<void> {
  try {
    await db?.disconnectAndClear();
  } finally {
    await clearDatabaseKey();
  }
}
