import { ANDROID_DATABASE_PATH } from "@op-engineering/op-sqlite";
import { AppSchema } from "@cortex/sync";
import { PowerSyncDatabase } from "@powersync/react-native";
import { File } from "expo-file-system";

// Extensionless, NOT the `./x.js` form the rest of the monorepo uses. Those packages compile
// to dist/ under NodeNext, where the suffix is required; apps/mobile is bundled by Metro, which
// resolves `./app-lock.js` against a file that does not exist and fails the build outright.
// `expo/tsconfig.base` uses bundler resolution, so extensionless is the correct idiom here.
import { hasStrongBiometrics } from "./app-lock";
import { ApiConnector } from "./connector";
import { getOrCreateDatabaseKey } from "./db-key";
import { setupNotesFts } from "./fts";

export const DB_FILENAME = "cortex.db";

/**
 * Where the database file lives, pinned rather than inferred.
 *
 * `OPSqliteAdapter.openDatabase` picks a location in three steps: an explicit `dbLocation`
 * wins; otherwise it asks `NativeModules.NativePowerSyncHelper.resolveDefaultDatabaseLocation`,
 * which returns `context.filesDir` IF a database from the old React Native Quick SQLite era
 * already sits there; otherwise op-sqlite's own default, `context.getDatabasePath()`.
 *
 * Leaving it unset would make the location depend on a file's existence, and the recovery
 * delete below would have to reproduce that decision to find the same file -- a wrong guess
 * deletes nothing, succeeds silently, and the open then hits the still-present old database.
 * Setting it explicitly collapses all three branches to one constant that open and delete
 * share. The RNQS branch can never apply here in any case: no cortex build has ever shipped
 * a local database, so there is nothing at the legacy path to stay compatible with.
 *
 * `ANDROID_DATABASE_PATH` is op-sqlite's own native constant for that directory, not a string
 * assembled here, and op-sqlite `create_directories` it on open (cpp/bridge.cpp), so pinning it
 * is safe on a first run where the directory does not exist yet.
 */
export const DB_DIRECTORY: string = ANDROID_DATABASE_PATH;

let db: PowerSyncDatabase | null = null;
// `initPowerSync` is awaited across several ticks. Without this, two callers racing the first
// mount both see `db === null` and construct a second PowerSyncDatabase over the same file.
let opening: Promise<{ db: PowerSyncDatabase; wiped: boolean }> | null = null;
// Set the instant `new PowerSyncDatabase(...)` succeeds, cleared once open finishes (either
// way). Lets the catch below close a handle that was constructed but never finished opening --
// see the comment there for why leaving it open is a data-loss-adjacent bug, not a cosmetic one.
let constructing: PowerSyncDatabase | null = null;

export function getPowerSync(): PowerSyncDatabase | null {
  return db;
}

/**
 * Removes the encrypted database and everything that can resurrect it.
 *
 * The `-wal` and `-shm` siblings are not optional extras: WAL pages that outlive the main file
 * are pages of the OLD database, and leaving them beside a freshly created file is how a wipe
 * appears to succeed and then hands back data it was supposed to destroy.
 *
 * Deleting a file that is not there is the normal case on a first run, so absence is not an
 * error -- but a delete that FAILS is, and must not be swallowed: continuing would open a
 * database against a key that cannot decrypt it, failing later and somewhere else.
 */
export async function deleteLocalDatabaseFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = new File(DB_DIRECTORY, `${DB_FILENAME}${suffix}`);
    if (file.exists) file.delete();
  }
}

/**
 * Opens the SQLCipher-encrypted local replica (spec §7.4).
 *
 * `wiped` is true when the Keystore key was destroyed by a biometric enrollment (§7.5):
 * the old database cannot be decrypted, so it is deleted and resynced from the server.
 * The caller MUST warn the user first -- committed data is safe (the server is
 * authoritative) but local changes not yet uploaded are lost.
 */
export async function initPowerSync(): Promise<{ db: PowerSyncDatabase; wiped: boolean }> {
  if (db) return { db, wiped: false };
  if (opening) return opening;

  opening = (async () => {
    // Required, and it must come from app-lock's `hasStrongBiometrics()`. Hardcoding `true`
    // rejects every PIN-only device; hardcoding `false` drops the auth binding on devices that
    // could have had it. See Task 10's AS SHIPPED note.
    const outcome = await getOrCreateDatabaseKey({
      strongBiometrics: await hasStrongBiometrics(),
    });
    const wiped = outcome.status === "lost";

    // The old file must be GONE BEFORE the database is constructed, not cleared afterwards.
    // `unusableKey` is a fresh key for a database that does not exist yet: SQLCipher cannot
    // decrypt the existing cortex.db with it, so anything that opens the handle first --
    // including `disconnectAndClear()`, which has to init the database before it can clear it --
    // fails on "file is not a database" instead of recovering. Delete, then open clean.
    if (outcome.status === "lost") await deleteLocalDatabaseFiles();

    const encryptionKey = outcome.status === "lost" ? outcome.unusableKey : outcome.key;

    const opened = new PowerSyncDatabase({
      schema: AppSchema,
      database: {
        dbFilename: DB_FILENAME,
        // Android only -- no getDylibPath/iOS branch, per the phase's platform constraint.
        dbLocation: DB_DIRECTORY,
        sqliteOptions: { encryptionKey },
      },
    });
    constructing = opened;

    // Before connect, so no transition -- including the very first one -- can fire before
    // anything is listening.
    //
    // The STILL OPEN question from the handoff: on the one device this has run on,
    // `"connected":true` was never observed, yet uploads succeeded and a save was later seen to
    // bring the rest of the backlog down with it. Nothing in the app previously surfaced sync
    // status at all, so that observation came from a temporary trace-level SDK logger, added and
    // removed for one session. This is the permanent, low-volume replacement: one line per
    // status transition, not a firehose of the SDK's internal protocol.
    opened.registerListener({
      statusChanged: (status) => {
        console.log(
          `[powersync] connected=${status.connected} connecting=${status.connecting} ` +
            `downloading=${status.downloading} uploading=${status.uploading} ` +
            `hasSynced=${status.hasSynced} lastSyncedAt=${status.lastSyncedAt?.toISOString() ?? "never"} ` +
            `downloadError=${status.downloadError?.message ?? "none"}`,
        );
      },
    });

    // Before connect, so the first batch replication delivers is already covered by the
    // triggers rather than racing them. `execute` waits for the schema to be applied, which is
    // what creates `ps_data__notes` for the triggers to hang off.
    await setupNotesFts(opened);

    /**
     * NOT awaited, and that is the whole point.
     *
     * `connect()` resolves only once the sync status has passed through `connecting` and back
     * out again (AbstractStreamingSyncImplementation.connect). On a real device it was observed
     * never to do so: four consecutive launches produced `powersync_control(start)` and an
     * `EstablishSyncStream` request, and `"connected":true` appeared exactly zero times.
     *
     * Awaited, that holds `db` at null forever, and `PowerSyncProvider` renders a spinner over
     * the entire app -- including the sign-in button, which lives inside it. An offline-first
     * app was unusable, offline or online, because a network call had not come back. The local
     * database is fully usable the moment it is open; connecting is what fills it, later.
     *
     * Rejections are logged rather than thrown: nothing here can act on one, and an unhandled
     * rejection in React Native is a redbox over a working app.
     */
    void opened.connect(new ApiConnector()).catch((cause: unknown) => {
      console.error("PowerSync could not connect; local data is still available", cause);
    });
    db = opened;
    constructing = null;
    return { db: opened, wiped };
  })();

  try {
    return await opening;
  } catch (error) {
    // A failed open must not leave a poisoned promise every later caller re-awaits: the user
    // can fix a cancelled biometric prompt by retrying, and there would be nothing to retry.
    opening = null;

    // If `setupNotesFts` (or anything else after construction) threw, `constructing` still
    // holds the handle that was never closed. Left open, the retry this reset exists to allow
    // opens a SECOND PowerSyncDatabase over the same encrypted file -- the exact state the
    // in-flight guard above prevents for concurrent callers, now reachable sequentially instead.
    if (constructing) {
      const failed = constructing;
      constructing = null;
      await failed.close().catch((closeError: unknown) => {
        console.error("failed to close a database handle left over from a failed open", closeError);
      });
    }
    throw error;
  }
}
