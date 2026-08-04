import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KeyOutcome } from "./db-key.js";

/**
 * Every native module this module reaches has to be mocked. Under `environment: "node"` a real
 * one dies with a Rollup Flow parse error that names neither the module nor the reason.
 */
const order: string[] = [];

const deleted: string[] = [];
let existing = new Set<string>();
vi.mock("expo-file-system", () => ({
  File: class {
    readonly path: string;
    constructor(dir: string, name: string) {
      this.path = `${dir}${name}`;
    }
    get exists() {
      return existing.has(this.path);
    }
    delete() {
      order.push(`delete:${this.path}`);
      deleted.push(this.path);
      existing.delete(this.path);
    }
  },
}));

vi.mock("@op-engineering/op-sqlite", () => ({ ANDROID_DATABASE_PATH: "/data/db/" }));

// Records into `order` as well as counting calls. Without this the ordering test below asserts
// only that `connect` happened at all, and passes just as well with connect BEFORE the index is
// built -- which is the sequence it exists to forbid.
const connect = vi.fn(async () => {
  order.push("connect");
});
let statusListener: ((status: unknown) => void) | undefined;
const registerListener = vi.fn((listener: { statusChanged?: (status: unknown) => void }) => {
  statusListener = listener.statusChanged;
  return () => {};
});
vi.mock("@powersync/react-native", () => ({
  PowerSyncDatabase: class {
    constructor(readonly options: unknown) {
      order.push("construct");
    }
    connect = connect;
    registerListener = registerListener;
  },
}));

vi.mock("@cortex/sync", () => ({ AppSchema: { schemaMarker: true } }));

const setupNotesFts = vi.fn(async () => {
  order.push("fts");
});
vi.mock("./fts.js", () => ({ setupNotesFts }));
vi.mock("./connector.js", () => ({ ApiConnector: class {} }));

const hasStrongBiometrics = vi.fn(async () => true);
vi.mock("./app-lock.js", () => ({ hasStrongBiometrics }));

let outcome: KeyOutcome = { status: "loaded", key: "aa" };
const getOrCreateDatabaseKey = vi.fn(async () => outcome);
vi.mock("./db-key.js", () => ({ getOrCreateDatabaseKey }));

const powersync = await import("./powersync.js");

beforeEach(() => {
  vi.resetModules();
  order.length = 0;
  deleted.length = 0;
  existing = new Set(["/data/db/cortex.db", "/data/db/cortex.db-wal", "/data/db/cortex.db-shm"]);
  outcome = { status: "loaded", key: "aa" };
  hasStrongBiometrics.mockClear();
  setupNotesFts.mockClear();
  getOrCreateDatabaseKey.mockClear();
  connect.mockClear();
  registerListener.mockClear();
  statusListener = undefined;
});

/** A fresh module instance, because `initPowerSync` memoises into module state. */
async function freshModule() {
  vi.resetModules();
  return import("./powersync.js");
}

describe("deleteLocalDatabaseFiles", () => {
  it("removes the database and BOTH of its WAL siblings", async () => {
    await powersync.deleteLocalDatabaseFiles();

    // -wal in particular: WAL pages outliving the main file are pages of the OLD database, so
    // a wipe that leaves them can hand back the very data it was meant to destroy.
    expect(deleted).toEqual([
      "/data/db/cortex.db",
      "/data/db/cortex.db-wal",
      "/data/db/cortex.db-shm",
    ]);
  });

  it("is a no-op when nothing is there, which is the normal first run", async () => {
    existing = new Set();
    await expect(powersync.deleteLocalDatabaseFiles()).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
  });

  it("deletes from the same directory the database is opened in", async () => {
    // A delete aimed at the wrong directory succeeds against nothing and reports success. The
    // only thing that makes it meaningful is that it is the SAME constant the open uses.
    const mod = await freshModule();
    outcome = { status: "lost", unusableKey: "bb" };
    const { db } = await mod.initPowerSync();

    const opened = (db as unknown as { options: { database: { dbLocation: string } } }).options;
    expect(opened.database.dbLocation).toBe("/data/db/");
    expect(deleted.every((p) => p.startsWith(opened.database.dbLocation))).toBe(true);
    expect(deleted).toHaveLength(3);
  });
});

describe("initPowerSync", () => {
  it("deletes the unreadable database BEFORE constructing the new one", async () => {
    const mod = await freshModule();
    outcome = { status: "lost", unusableKey: "bb" };

    const { wiped } = await mod.initPowerSync();

    expect(wiped).toBe(true);
    // Ordering is the entire point, and only an ordering assertion pins it. Constructing first
    // would open the OLD file with a key that cannot decrypt it, and the failure would surface
    // as "file is not a database" far from this cause.
    expect(order).toEqual([
      "delete:/data/db/cortex.db",
      "delete:/data/db/cortex.db-wal",
      "delete:/data/db/cortex.db-shm",
      "construct",
      "fts",
      "connect",
    ]);
  });

  it("never deletes anything when the key loaded normally", async () => {
    const mod = await freshModule();
    outcome = { status: "loaded", key: "aa" };

    const { wiped } = await mod.initPowerSync();

    expect(wiped).toBe(false);
    expect(order).toEqual(["construct", "fts", "connect"]);
  });

  it("never deletes anything on a first run", async () => {
    const mod = await freshModule();
    outcome = { status: "created", key: "cc" };

    const { wiped } = await mod.initPowerSync();

    expect(wiped).toBe(false);
    expect(deleted).toEqual([]);
  });

  it("opens with the key from the outcome, including the unusable one after a wipe", async () => {
    const mod = await freshModule();
    outcome = { status: "lost", unusableKey: "bb" };

    const { db } = await mod.initPowerSync();

    const options = (db as unknown as {
      options: { database: { sqliteOptions: { encryptionKey: string }; dbFilename: string } };
    }).options;
    // Encryption is not optional: an undefined key opens an UNENCRYPTED database rather than
    // failing, which is the quiet version of shipping no encryption at all.
    expect(options.database.sqliteOptions.encryptionKey).toBe("bb");
    expect(options.database.dbFilename).toBe("cortex.db");
  });

  it("asks the device what it can enforce rather than assuming", async () => {
    const mod = await freshModule();
    hasStrongBiometrics.mockResolvedValueOnce(false);

    await mod.initPowerSync();

    // Hardcoding `true` locks every PIN-only device out of its own database; hardcoding
    // `false` drops the auth binding on devices that could have had it.
    expect(getOrCreateDatabaseKey).toHaveBeenCalledWith({ strongBiometrics: false });
  });

  it("opens the database once when two callers race the first mount", async () => {
    const mod = await freshModule();

    const [first, second] = await Promise.all([mod.initPowerSync(), mod.initPowerSync()]);

    // Two PowerSyncDatabase instances over one file is two sync streams and two write queues.
    expect(order.filter((o) => o === "construct")).toHaveLength(1);
    expect(first.db).toBe(second.db);
    expect(mod.getPowerSync()).toBe(first.db);
  });

  it("lets the user retry after a cancelled biometric prompt", async () => {
    const mod = await freshModule();
    getOrCreateDatabaseKey.mockRejectedValueOnce(new Error("biometric_prompt_failed"));

    await expect(mod.initPowerSync()).rejects.toThrow("biometric_prompt_failed");
    // A retained in-flight promise would make every later call re-await the same rejection, so
    // the one thing the user CAN fix -- try the prompt again -- would do nothing forever.
    await expect(mod.initPowerSync()).resolves.toMatchObject({ wiped: false });
  });

  it("reports no database until one is open", async () => {
    const mod = await freshModule();
    expect(mod.getPowerSync()).toBeNull();
    await mod.initPowerSync();
    expect(mod.getPowerSync()).not.toBeNull();
  });
  it("builds the search index before connecting, not after", async () => {
    const mod = await freshModule();

    const { db } = await mod.initPowerSync();

    // After connect, the first batch replication delivers would land in ps_data__notes with no
    // triggers on it yet -- indexed only by the NEXT launch's rebuild, so search silently
    // misses everything that arrived in between.
    expect(setupNotesFts).toHaveBeenCalledWith(db);
    // `connect` has to be IN the sequence, not merely counted: asserting ["construct","fts"]
    // plus a call count holds identically when connect runs first, so the test named after the
    // ordering was the one thing not asserting it.
    expect(order).toEqual(["construct", "fts", "connect"]);
    expect(connect).toHaveBeenCalledOnce();
  });

  /**
   * The STILL OPEN question from the handoff -- whether `connected` ever flips true on a real
   * device, and if so when relative to an upload -- has no way to be answered without this: the
   * app previously surfaced no sync status anywhere, permanently or otherwise.
   */
  it("logs a status line on every sync status transition", async () => {
    const mod = await freshModule();
    await mod.initPowerSync();
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(registerListener).toHaveBeenCalledOnce();
    statusListener?.({
      connected: true,
      connecting: false,
      downloading: false,
      uploading: false,
      hasSynced: true,
      lastSyncedAt: new Date("2026-08-04T00:00:00.000Z"),
      downloadError: undefined,
    });

    expect(logged).toHaveBeenCalledWith(expect.stringContaining("connected=true"));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("lastSyncedAt=2026-08-04T00:00:00.000Z"));
    logged.mockRestore();
  });

  it("registers the status listener before connecting, so no transition can be missed", async () => {
    const mod = await freshModule();
    await mod.initPowerSync();

    expect(order.indexOf("connect")).toBeGreaterThan(-1);
    expect(registerListener.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]!);
  });

  it("opens the database even when connecting never finishes", async () => {
    // Not hypothetical, and not a slow connection: on a real device `connect()` was observed
    // never to settle at all. It resolves only once the sync status has passed through
    // `connecting` and back out (AbstractStreamingSyncImplementation.connect), and across four
    // consecutive launches `"connected":true` was logged exactly zero times.
    //
    // Awaited, that held `db` at null forever and PowerSyncProvider covered the whole app in a
    // spinner -- including the sign-in button, which renders inside it. An offline-first app was
    // unusable, offline AND online, because a network call had not come back. The local database
    // is ready the moment it is open; connecting only fills it, later.
    //
    // The timeout is what makes this bite. Without it a re-awaited `connect` simply hangs the
    // test runner until vitest kills the file, which reads as an unrelated infrastructure
    // failure rather than as this regression.
    connect.mockImplementationOnce(() => new Promise<void>(() => {}));
    const mod = await freshModule();

    const { db } = await Promise.race([
      mod.initPowerSync(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("initPowerSync awaited connect()")), 1000),
      ),
    ]);

    expect(db).not.toBeNull();
    expect(mod.getPowerSync()).not.toBeNull();
    expect(connect).toHaveBeenCalledOnce();
  });
});
