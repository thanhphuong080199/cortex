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
