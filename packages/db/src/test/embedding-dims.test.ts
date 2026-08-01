import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "@cortex/shared";
import { admin } from "./clients.js";

// The provider switch Voyage -> Gemini (life-domains spec §1) changes the embedding
// width from 1024 to 1536. Nothing reads these columns yet, so the only thing that can
// catch a half-applied switch -- migration written but `EMBEDDING_DIM` left at 1024, or
// vice versa -- is asserting both against each other and against the LIVE column.
//
// pgvector stores a column's declared dimension directly in pg_attribute.atttypmod
// (unlike varchar, which offsets by 4). `_test_column_vector_dim` is the narrow
// SECURITY DEFINER reader added in 00012, matching the two catalog helpers in 00001.
const VECTOR_COLUMNS = [
  { table: "note_chunks", column: "embedding" },
  { table: "memory_facts", column: "embedding" },
];

describe("embedding dimensions (gemini switch, life-domains spec §1)", () => {
  it.each(VECTOR_COLUMNS)("$table.$column is a 1536-dim vector", async ({ table, column }) => {
    const { data, error } = await admin.rpc("_test_column_vector_dim", {
      p_table: table, p_column: column,
    });
    expect(error, `RPC error reading ${table}.${column}`).toBeNull();
    // Literal 1536, not EMBEDDING_DIM: while shared still says 1024 this must be red
    // against the live columns rather than agreeing with a stale constant.
    expect(data).toBe(1536);
  });

  it("EMBEDDING_DIM matches what the columns actually declare", () => {
    expect(EMBEDDING_DIM).toBe(1536);
  });
});
