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

const connect = vi.fn(async () => {});
vi.mock("@powersync/react-native", () => ({
  PowerSyncDatabase: class {
    constructor(readonly options: unknown) {
      order.push("construct");
    }
    connect = connect;
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
    ]);
  });

  it("never deletes anything when the key loaded normally", async () => {
    const mod = await freshModule();
    outcome = { status: "loaded", key: "aa" };

    const { wiped } = await mod.initPowerSync();

    expect(wiped).toBe(false);
    expect(order).toEqual(["construct", "fts"]);
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
    expect(order).toEqual(["construct", "fts"]);
    expect(connect).toHaveBeenCalledOnce();
  });
});
