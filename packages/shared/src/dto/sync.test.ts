import { describe, expect, it } from "vitest";
import { SYNC_TABLES, syncUploadInput } from "./sync.js";

const op = {
  op_id: "1", op: "PUT" as const, table: "notes",
  id: "11111111-1111-4111-8111-111111111111", data: { content: "hi" },
};

describe("syncUploadInput", () => {
  it("accepts a well-formed batch", () => {
    expect(syncUploadInput.safeParse({ ops: [op] }).success).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(syncUploadInput.safeParse({ ops: [] }).success).toBe(false);
  });

  it("rejects a batch over 500 ops", () => {
    const ops = Array.from({ length: 501 }, (_, i) => ({ ...op, op_id: String(i) }));
    expect(syncUploadInput.safeParse({ ops }).success).toBe(false);
  });

  it("rejects a table outside SYNC_TABLES", () => {
    const r = syncUploadInput.safeParse({ ops: [{ ...op, table: "usage_ledger" }] });
    expect(r.success).toBe(false);
  });

  it("rejects a non-uuid row id", () => {
    expect(syncUploadInput.safeParse({ ops: [{ ...op, id: "nope" }] }).success).toBe(false);
  });

  it("accepts base_updated_at on a notes PATCH", () => {
    const r = syncUploadInput.safeParse({
      ops: [{ ...op, op: "PATCH", base_updated_at: "2026-08-02T10:00:00.000Z" }],
    });
    expect(r.success).toBe(true);
  });

  it("exposes exactly the six synced tables", () => {
    expect([...SYNC_TABLES].sort()).toEqual(
      ["checkins", "links", "media_items", "note_tags", "notes", "tags"],
    );
  });
});
