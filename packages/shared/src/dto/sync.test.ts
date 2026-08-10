import { describe, expect, it } from "vitest";
import { SERVER_ONLY_TABLES, SYNC_TABLES, syncUploadInput } from "./sync.js";

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

  it("accepts base_content on a notes PATCH", () => {
    const r = syncUploadInput.safeParse({
      ops: [{ ...op, op: "PATCH", base_content: "the body this edit started from" }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts an EMPTY base_content", () => {
    // "" is a real base -- a note edited down to nothing, then edited again. A `.min(1)` here,
    // or any falsy guard on the way to it, turns that note's next edit into an unconditional
    // last-write-wins over whatever the server holds.
    const r = syncUploadInput.safeParse({ ops: [{ ...op, op: "PATCH", base_content: "" }] });
    expect(r.success).toBe(true);
    // Parsed back out, not just accepted: a schema that admits "" and then drops it on the way
    // through leaves the server with no base at all, which is the failure this guards.
    expect(r.data?.ops[0]?.base_content).toBe("");
  });

  it("exposes exactly the six synced tables", () => {
    expect([...SYNC_TABLES].sort()).toEqual(
      ["checkins", "links", "media_items", "note_tags", "notes", "tags"],
    );
  });
});

describe("SERVER_ONLY_TABLES", () => {
  it("names every table deliberately excluded from replication", () => {
    expect([...SERVER_ONLY_TABLES].sort()).toEqual(
      [
        "feedback_events",
        "flashcards",
        "ingest_inbox",
        "integrations",
        "memory_revisions",
        "note_chunks",
        "usage_ledger",
      ].sort(),
    );
  });

  it("shares no table with SYNC_TABLES", () => {
    const synced = new Set<string>(SYNC_TABLES);
    for (const t of SERVER_ONLY_TABLES) {
      expect(synced.has(t), `${t} is in both lists`).toBe(false);
    }
  });
});
