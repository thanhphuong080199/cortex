import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({ randomUUID: () => randomUUID() }));

const { LOG_CHECKIN_SQL, UNDO_CHECKIN_SQL, logCheckin, undoCheckin } =
  await import("./checkins.js");
type CheckinTarget = Parameters<typeof logCheckin>[0];

function sqlite() {
  const db = new Database(":memory:");
  // Mirrors packages/sync/src/schema.ts, which is a view over PowerSync's JSON storage.
  db.exec(`CREATE TABLE checkins (
    id TEXT PRIMARY KEY, mood INTEGER, energy INTEGER, label TEXT,
    created_at TEXT, updated_at TEXT, deleted_at TEXT
  )`);
  return db;
}

function target(db: Database.Database): CheckinTarget {
  return { execute: async (sql, params) => db.prepare(sql).run((params ?? []) as never[]) };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let db: Database.Database;
beforeEach(() => {
  db = sqlite();
});
afterEach(() => {
  db.close();
});

const rows = () => db.prepare("SELECT * FROM checkins").all() as Record<string, unknown>[];

describe("logCheckin", () => {
  it("writes one check-in and hands back its id", async () => {
    const id = await logCheckin(target(db), 4);

    const [row] = rows();
    expect(row.id).toBe(id);
    expect(row.mood).toBe(4);
    // The id has to come back, or there is nothing for undo to name.
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stamps created_at in ISO form", async () => {
    await logCheckin(target(db), 3);
    expect(rows()[0].created_at).toMatch(ISO);
  });

  it("leaves energy and label null rather than inventing values", async () => {
    await logCheckin(target(db), 5);

    const [row] = rows();
    // `checkins_mood_or_energy` only demands one of the two, and a fabricated energy would be
    // data the user never gave.
    expect(row.energy).toBeNull();
    expect(row.label).toBeNull();
  });

  it("gives each tap its own row and id", async () => {
    const first = await logCheckin(target(db), 1);
    const second = await logCheckin(target(db), 5);

    expect(first).not.toBe(second);
    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.mood).sort()).toEqual([1, 5]);
  });

  it("binds id and mood in the order the statement expects", async () => {
    const id = await logCheckin(target(db), 2);

    // Swapped, this stores the uuid as the mood and fails the server's
    // `mood between 1 and 5` check only after it has synced.
    expect(rows()[0].mood).toBe(2);
    expect(rows()[0].id).toBe(id);
  });
});

describe("undoCheckin", () => {
  /**
   * The one that matters. The sync router accepts only PUT and DELETE on checkins and throws
   * `validation` on anything else; PowerSync turns a local UPDATE into a PATCH. The plan's
   * `UPDATE checkins SET deleted_at = ...` therefore lands in `failed` inside a 200 response,
   * the connector completes the batch, and the undo is discarded -- the check-in lives on the
   * server forever while the phone shows it gone.
   */
  it("issues a DELETE, because a PATCH on checkins is rejected server-side", () => {
    expect(UNDO_CHECKIN_SQL.trimStart().slice(0, 6).toUpperCase()).toBe("DELETE");
    expect(UNDO_CHECKIN_SQL.toUpperCase()).not.toContain("UPDATE");
    expect(UNDO_CHECKIN_SQL.toUpperCase()).not.toContain("DELETED_AT");
  });

  it("removes the row from this device", async () => {
    const id = await logCheckin(target(db), 4);

    await undoCheckin(target(db), id);

    // Hard locally, soft on the server: the user asked for it to be gone here, and the
    // tombstone every synced table needs is the server's job.
    expect(rows()).toEqual([]);
  });

  it("removes only the check-in it names", async () => {
    const keep = await logCheckin(target(db), 2);
    const drop = await logCheckin(target(db), 5);

    await undoCheckin(target(db), drop);

    expect(rows()).toHaveLength(1);
    expect(rows()[0].id).toBe(keep);
  });

  it("is harmless when the row is already gone", async () => {
    const id = await logCheckin(target(db), 3);
    await undoCheckin(target(db), id);

    // Double-tapping undo must not throw and strand the widget in a busy state.
    await expect(undoCheckin(target(db), id)).resolves.toBeUndefined();
  });
});

describe("the statements themselves", () => {
  it("never writes updated_at, which public.checkins does not have", () => {
    // packages/sync declares the column, migration 00013 does not. Writing it produces a value
    // that exists on one device and is null the moment the server's row syncs back.
    expect(LOG_CHECKIN_SQL.toUpperCase()).not.toContain("UPDATED_AT");
  });
});
