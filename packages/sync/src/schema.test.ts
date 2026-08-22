import { describe, expect, it } from "vitest";
import { SERVER_ONLY_TABLES, SYNCED_TABLES } from "@cortex/shared";
import { AppSchema } from "./schema.js";

const tableNames = () => AppSchema.tables.map((t) => t.name).sort();

describe("AppSchema", () => {
  it("declares exactly the synced tables plus the local-only edit-base table", () => {
    expect(tableNames()).toEqual([...SYNCED_TABLES, "note_edit_base"].sort());
  });

  it("never declares a server-only table", () => {
    for (const t of SERVER_ONLY_TABLES) expect(tableNames()).not.toContain(t);
  });

  it("marks note_edit_base local-only so a base timestamp never uploads", () => {
    const t = AppSchema.tables.find((x) => x.name === "note_edit_base")!;
    expect(t.localOnly).toBe(true);
  });

  it("carries updated_at on notes, which sync ordering depends on", () => {
    const notes = AppSchema.tables.find((t) => t.name === "notes")!;
    expect(notes.columns.map((c) => c.name)).toContain("updated_at");
  });

  /**
   * The assertion that pins the local schema to the database. `note_tags.source` is
   * `text not null` with no default (00003_organization.sql:20) and AppSchema did not declare
   * the column at all. PowerSync's local schema is a VIEW, so an omitted column is invisible
   * on the device rather than an error -- the device sends a row without `source` and Postgres
   * answers 23502, with nothing on the device able to explain it. Phase 2's auto-tag
   * accept/reject is the first client writer of this table.
   *
   * `confidence` is deliberately not asserted here. It is a plain nullable `real` with no
   * NOT NULL and no default, unlike `source` (NOT NULL, no default) and `status` (NOT NULL,
   * default 'accepted') -- so a device omitting it alone cannot produce the 23502 this test
   * exists to prevent, and pinning it here would not be catching a real trap.
   */
  it("declares every column note_tags requires", () => {
    const noteTags = AppSchema.tables.find((t) => t.name === "note_tags")!;
    expect(noteTags.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["note_id", "tag_id", "source", "status"]),
    );
  });
});
