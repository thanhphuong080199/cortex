import { mediaStatus, pendingMediaItem, validateDomainMeta } from "@cortex/shared";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOG_MEDIA_SQL, buildMediaMeta, logMedia, type MediaLogTarget } from "./media-log.js";

function sqlite() {
  const db = new Database(":memory:");
  db.function("uuid", () => randomUUID());
  db.exec(`CREATE TABLE notes (
    id TEXT PRIMARY KEY, title TEXT, content TEXT, source_type TEXT, lifecycle TEXT,
    domain TEXT, domain_meta TEXT, media_item_id TEXT, pinned INTEGER,
    created_at TEXT, updated_at TEXT, deleted_at TEXT
  )`);
  return db;
}

function target(db: Database.Database): MediaLogTarget {
  return { execute: async (sql, params) => db.prepare(sql).run((params ?? []) as never[]) };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const base = {
  kind: "movie",
  title: "Solaris",
  status: "finished",
  rating: null,
  impression: "slow and worth it",
} as const;

let db: Database.Database;
beforeEach(() => {
  db = sqlite();
});
afterEach(() => {
  db.close();
});

const rows = () => db.prepare("SELECT * FROM notes").all() as Record<string, unknown>[];
const meta = () => JSON.parse(rows()[0].domain_meta as string) as Record<string, unknown>;

describe("buildMediaMeta", () => {
  /**
   * The decisive one: run the SERVER'S OWN validator over what the form builds.
   *
   * `domainMetaSchemas.media` is `.strict()`, and a payload it rejects does not fail loudly --
   * `createWithId` throws `validation`, the op is reported in `failed` inside a 200 response,
   * the connector completes the batch, and the log is gone. Asserting the object's shape by
   * hand here would just restate the builder; running the real schema is what catches drift
   * between this form and the server.
   */
  it("builds meta the server's strict schema accepts", () => {
    const result = validateDomainMeta("media", buildMediaMeta({ ...base, rating: 4 }));
    expect(result.success).toBe(true);
  });

  it("accepts every status the shared enum defines", () => {
    for (const status of mediaStatus.options) {
      const result = validateDomainMeta("media", buildMediaMeta({ ...base, status }));
      // A hand-written status list that drifted from the enum -- which the plan's form had --
      // is not a type error anywhere; it fails here, at the server's schema.
      expect(result.success, status).toBe(true);
    }
  });

  it("omits rating entirely rather than sending null", () => {
    const built = buildMediaMeta({ ...base, rating: null });

    // `.strict()` treats `rating: null` as a value of the wrong type, not as "no rating".
    expect(Object.hasOwn(built, "rating")).toBe(false);
    expect(validateDomainMeta("media", built).success).toBe(true);
  });

  it("includes a rating when one was chosen", () => {
    expect(buildMediaMeta({ ...base, rating: 5 }).rating).toBe(5);
  });

  it("writes a pending_item the server's own schema can parse", () => {
    const built = buildMediaMeta(base);
    // This is what MediaService.resolveNoteMediaLink reads to find or create the item.
    expect(pendingMediaItem.safeParse(built.pending_item).success).toBe(true);
  });

  it("trims the title, because identity is lower(title)", () => {
    const built = buildMediaMeta({ ...base, title: "  Dune  " });
    const item = built.pending_item as { title: string };
    // Untrimmed, " Dune " and "Dune" become two media_items rows instead of one.
    expect(item.title).toBe("Dune");
  });
});

describe("logMedia", () => {
  it("writes the note SQLite accepts, with the meta as a JSON string", async () => {
    await logMedia(target(db), { ...base, rating: 3 });

    const [row] = rows();
    expect(row.domain).toBe("media");
    expect(row.title).toBe("Solaris");
    expect(row.content).toBe("slow and worth it");
    // A TEXT column holding serialised JSON is the correct wire shape -- PowerSync's local
    // schema has no jsonb type, and the router parses it back (see readDomainMeta).
    expect(typeof row.domain_meta).toBe("string");
    expect(meta().status).toBe("finished");
  });

  it("leaves media_item_id null for the server to fill in", async () => {
    await logMedia(target(db), base);
    // The device cannot consult the (user_id, kind, lower(title)) unique index offline, so
    // guessing an id here would create duplicate items rather than resolve to one.
    expect(rows()[0].media_item_id).toBeNull();
  });

  it("stamps timestamps in ISO form", async () => {
    await logMedia(target(db), base);
    expect(rows()[0].created_at).toMatch(ISO);
    expect(rows()[0].updated_at).toMatch(ISO);
  });

  it("logs as an ordinary inbox note", async () => {
    await logMedia(target(db), base);

    const [row] = rows();
    // Nothing about a media log is special to the notes table -- that is the whole design.
    expect(row.lifecycle).toBe("inbox");
    expect(row.source_type).toBe("quick");
  });

  it("refuses to log without a title", async () => {
    const write = vi.fn();
    const wrote = await logMedia({ execute: write }, { ...base, title: "   " });

    // Without a title there is nothing for the server to resolve identity by.
    expect(wrote).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("stores the trimmed title in the note as well as in pending_item", async () => {
    await logMedia(target(db), { ...base, title: "  Arrival  " });

    expect(rows()[0].title).toBe("Arrival");
    expect((meta().pending_item as { title: string }).title).toBe("Arrival");
  });

  it("binds impression, title and meta in the order the columns expect", async () => {
    await logMedia(target(db), { ...base, impression: "the body", title: "The Title" });

    const [row] = rows();
    // Swapped, this stores the impression as the title and only shows up after syncing.
    expect(row.content).toBe("the body");
    expect(row.title).toBe("The Title");
    expect(LOG_MEDIA_SQL.match(/\?/g)).toHaveLength(3);
  });
});
