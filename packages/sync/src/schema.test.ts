import { describe, expect, it } from "vitest";
import { SYNC_TABLES } from "@cortex/shared";
import { AppSchema } from "./schema.js";

const tableNames = () => AppSchema.tables.map((t) => t.name).sort();

describe("AppSchema", () => {
  it("declares exactly the synced tables plus the local-only edit-base table", () => {
    expect(tableNames()).toEqual([...SYNC_TABLES, "note_edit_base"].sort());
  });

  it("never declares a server-only table", () => {
    const forbidden = [
      "note_chunks", "ingest_inbox", "memory_revisions",
      "feedback_events", "usage_ledger", "integrations", "flashcards",
    ];
    for (const t of forbidden) expect(tableNames()).not.toContain(t);
  });

  it("marks note_edit_base local-only so a base timestamp never uploads", () => {
    const t = AppSchema.tables.find((x) => x.name === "note_edit_base")!;
    expect(t.localOnly).toBe(true);
  });

  it("carries updated_at on notes, which sync ordering depends on", () => {
    const notes = AppSchema.tables.find((t) => t.name === "notes")!;
    expect(notes.columns.map((c) => c.name)).toContain("updated_at");
  });
});
