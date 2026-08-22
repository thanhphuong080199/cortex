import { describe, expect, it } from "vitest";
import { admin } from "./clients.js";

// Supabase's pg_default_acl grants TRUNCATE, REFERENCES, TRIGGER, and (on Postgres 17+)
// MAINTAIN to `anon`/`authenticated` on every newly created table in `public`, entirely
// independent of this repo's own explicit GRANT statements. RLS does not apply to
// TRUNCATE/MAINTAIN, so a table whose grant-block comment claims "no DML grant at all"
// for authenticated can still be truncated by it unless 00009_revoke_default_grants.sql's
// revoke (both the immediate `revoke ... on all tables` and the `alter default
// privileges` for future tables) is actually in effect. Verified live before the fix:
// both allowed_emails and integrations showed authenticated:TRUNCATE despite their
// migration comments claiming zero grant.
const SERVER_ONLY_TABLES = [
  "note_chunks", "ingest_inbox", "memory_revisions",
  "feedback_events", "integrations", "usage_ledger", "allowed_emails",
];

describe("default ACL revocation (00009_revoke_default_grants.sql)", () => {
  it.each(SERVER_ONLY_TABLES)("authenticated holds no TRUNCATE on %s", async (table) => {
    const { data, error } = await admin.rpc("_test_has_table_privilege", {
      p_role: "authenticated", p_table: table, p_privilege: "TRUNCATE",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it.each(SERVER_ONLY_TABLES)("authenticated holds no MAINTAIN on %s", async (table) => {
    const { data, error } = await admin.rpc("_test_has_table_privilege", {
      p_role: "authenticated", p_table: table, p_privilege: "MAINTAIN",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it.each(SERVER_ONLY_TABLES)("anon holds no TRUNCATE on %s", async (table) => {
    const { data, error } = await admin.rpc("_test_has_table_privilege", {
      p_role: "anon", p_table: table, p_privilege: "TRUNCATE",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  // Positive control: if the RPC/privilege lookup itself were broken (e.g. always
  // returning false), every test above would false-pass. service_role genuinely does
  // hold TRUNCATE (it needs full DDL-adjacent access to manage these tables), so this
  // proves the has_table_privilege() lookup path actually distinguishes true from false.
  it("service_role does hold TRUNCATE on a server-only table (positive control)", async () => {
    const { data, error } = await admin.rpc("_test_has_table_privilege", {
      p_role: "service_role", p_table: "allowed_emails", p_privilege: "TRUNCATE",
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });
});

// 00032_search_notes_created_at.sql: `search_notes` gained a column, and Postgres refuses to
// change an existing function's RETURNS TABLE with `create or replace` -- so that migration had
// to DROP the function, which discards its ACL, and restate the revoke/grant pair by hand. Every
// assertion in search-notes.test.ts runs as `admin` (service_role) and would stay green even if
// that restatement were silently dropped, so this is the one test that actually exercises the
// risk a DROP-and-CREATE introduces. `_test_has_function_privilege` is 00032's own companion to
// `_test_has_table_privilege` above, added there for the same reason: the suite reaches Postgres
// only through PostgREST, with no direct psql connection to introspect pg_catalog from.
//
// 00035_search_notes_source_type.sql performed the same DROP for the same reason. This block
// needs no edit to cover it -- it asserts against the live signature, which is unchanged.
describe("search_notes execute grant (00032, 00035)", () => {
  const SEARCH_NOTES_SIG = "public.search_notes(uuid, text, extensions.vector(1536), int)";

  it.each(["authenticated", "anon"])("%s holds no EXECUTE on search_notes", async (role) => {
    const { data, error } = await admin.rpc("_test_has_function_privilege", {
      p_role: role, p_function: SEARCH_NOTES_SIG, p_privilege: "EXECUTE",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  // Positive control, same reasoning as the table-privilege one above: proves the lookup path
  // can return true at all, so the two `false` assertions mean something.
  it("service_role does hold EXECUTE on search_notes (positive control)", async () => {
    const { data, error } = await admin.rpc("_test_has_function_privilege", {
      p_role: "service_role", p_function: SEARCH_NOTES_SIG, p_privilege: "EXECUTE",
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });
});
