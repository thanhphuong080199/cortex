import { describe, expect, it } from "vitest";
import {
  flashcardStatus, mediaKind, memoryCategory, memoryStatus, noteDomain,
  noteLifecycle, noteSourceType, paraCategory, suggestionStatus, taskStatus,
} from "@cortex/shared";
import { admin } from "./clients.js";

// Plan Task 2 claims "Task 4's SQL check constraints must match these enum values
// exactly." Nothing enforced that. This reads the LIVE constraint definition straight
// out of pg_constraint (via the _test_check_constraint_def RPC -- see
// 00001_extensions_helpers.sql) and asserts it matches the corresponding zod enum's
// values, for exactly the pairs that packages/shared/src/enums.ts documents as the same
// vocabulary. links.status and notes.para_status are deliberately NOT included here --
// they're distinct vocabularies per design spec §6.2/§6.1, not instances of
// suggestionStatus (see the comment block in enums.ts).
const PAIRS: Array<{ table: string; constraint: string; enum: { options: readonly string[] } }> = [
  { table: "notes", constraint: "notes_lifecycle_check", enum: noteLifecycle },
  { table: "notes", constraint: "notes_source_type_check", enum: noteSourceType },
  { table: "notes", constraint: "notes_para_category_check", enum: paraCategory },
  { table: "note_tags", constraint: "note_tags_status_check", enum: suggestionStatus },
  { table: "tasks", constraint: "tasks_status_check", enum: taskStatus },
  { table: "memory_facts", constraint: "memory_facts_category_check", enum: memoryCategory },
  { table: "memory_facts", constraint: "memory_facts_status_check", enum: memoryStatus },
  { table: "notes", constraint: "notes_domain_check", enum: noteDomain },
  { table: "media_items", constraint: "media_items_kind_check", enum: mediaKind },
  { table: "flashcards", constraint: "flashcards_status_check", enum: flashcardStatus },
];

/** Extracts the ordered set of `'value'::text` literals out of a pg_get_constraintdef() string. */
function valuesFromConstraintDef(def: string): string[] {
  return [...def.matchAll(/'([^']*)'::text/g)].map((m) => m[1] ?? "");
}

describe("enum parity: packages/shared/src/enums.ts <-> SQL check constraints", () => {
  it.each(PAIRS)("$table.$constraint matches its zod enum exactly", async ({ table, constraint, enum: zodEnum }) => {
    const { data, error } = await admin.rpc("_test_check_constraint_def", {
      p_table: table, p_constraint: constraint,
    });
    expect(error, `RPC error reading ${table}.${constraint}`).toBeNull();
    expect(data, `constraint ${constraint} not found on ${table}`).not.toBeNull();

    const sqlValues = valuesFromConstraintDef(data as string);
    expect(sqlValues.length, `no quoted values parsed out of: ${data}`).toBeGreaterThan(0);
    expect(sqlValues).toEqual([...zodEnum.options]);
  });
});
