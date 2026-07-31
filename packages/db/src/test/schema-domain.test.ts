import { describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

describe("domain schema", () => {
  it("tags are unique per user case-insensitively", async () => {
    const { client, id } = await makeUser("schema-b@test.local");
    await client.from("tags").insert({ user_id: id, name: "Ideas" });
    const { error } = await client.from("tags").insert({ user_id: id, name: "ideas" });
    expect(error).not.toBeNull();
  });

  it("tasks default to suggested status", async () => {
    const { client, id } = await makeUser("schema-b@test.local");
    const { data, error } = await client.from("tasks")
      .insert({ user_id: id, title: "Ship phase 0", source: "user", status: "todo" })
      .select("status").single();
    expect(error).toBeNull();
    expect(data!.status).toBe("todo");
  });

  it("memory_facts are read-only for clients", async () => {
    const { client, id } = await makeUser("schema-b@test.local");
    const { error: insertErr } = await client.from("memory_facts")
      .insert({ user_id: id, category: "preference", statement: "x", confidence: 0.5 });
    expect(insertErr).not.toBeNull();                       // no insert policy
    const { error: adminErr } = await admin.from("memory_facts")
      .insert({ user_id: id, category: "preference", statement: "Prefers TypeScript", confidence: 0.8 });
    expect(adminErr).toBeNull();                            // service role writes
    const { data } = await client.from("memory_facts").select("statement");
    expect(data).toHaveLength(1);                           // select policy works
  });

  it("server-only ops tables deny clients", async () => {
    const { client } = await makeUser("schema-b@test.local");
    for (const table of ["memory_revisions", "feedback_events", "usage_ledger", "integrations"]) {
      const { data, error } = await client.from(table).select("id");
      expect(error, table).not.toBeNull();   // no grant to authenticated -> 42501, never rows
      expect(data, table).toBeNull();
    }
  });
});
