import { describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

// Every `user_id uuid not null references auth.users(id)` was NO ACTION before this
// fix, so once a user owned one row anywhere, `auth.admin.deleteUser()` failed with an
// FK violation -- there was no account-deletion path at all. This proves the cascade
// actually works end-to-end through the real admin API (not just a raw SQL DELETE),
// across several tables at once, using a throwaway user created solely for this test.
describe("user deletion cascades", () => {
  it("admin.auth.admin.deleteUser() succeeds and removes the user's rows everywhere", async () => {
    const { client, id } = await makeUser("delete-cascade@test.local");

    const { error: noteErr } = await client.from("notes")
      .insert({ user_id: id, content: "will be deleted" });
    expect(noteErr, "notes insert").toBeNull();

    const { error: tagErr } = await client.from("tags").insert({ user_id: id, name: "cascade-tag" });
    expect(tagErr, "tags insert").toBeNull();

    const { error: taskErr } = await client.from("tasks")
      .insert({ user_id: id, title: "cascade task", source: "user" });
    expect(taskErr, "tasks insert").toBeNull();

    // Server-only tables: written via service_role, same as production write paths.
    const { error: memoryErr } = await admin.from("memory_facts")
      .insert({ user_id: id, category: "preference", statement: "cascade fact", confidence: 0.5 });
    expect(memoryErr, "memory_facts insert").toBeNull();

    const { error: usageErr } = await admin.from("usage_ledger")
      .insert({ user_id: id, kind: "chat" });
    expect(usageErr, "usage_ledger insert").toBeNull();

    // Sanity: rows exist before deletion.
    expect((await admin.from("notes").select("id").eq("user_id", id)).data).toHaveLength(1);
    expect((await admin.from("tags").select("id").eq("user_id", id)).data).toHaveLength(1);
    expect((await admin.from("tasks").select("id").eq("user_id", id)).data).toHaveLength(1);
    expect((await admin.from("memory_facts").select("id").eq("user_id", id)).data).toHaveLength(1);
    expect((await admin.from("usage_ledger").select("id").eq("user_id", id)).data).toHaveLength(1);

    const { error: deleteErr } = await admin.auth.admin.deleteUser(id);
    expect(deleteErr, "deleteUser should succeed, not fail with an FK violation").toBeNull();

    // The user record itself is gone...
    const { data: gone } = await admin.auth.admin.getUserById(id);
    expect(gone.user).toBeNull();

    // ...and every row it owned went with it via ON DELETE CASCADE.
    expect((await admin.from("notes").select("id").eq("user_id", id)).data).toHaveLength(0);
    expect((await admin.from("tags").select("id").eq("user_id", id)).data).toHaveLength(0);
    expect((await admin.from("tasks").select("id").eq("user_id", id)).data).toHaveLength(0);
    expect((await admin.from("memory_facts").select("id").eq("user_id", id)).data).toHaveLength(0);
    expect((await admin.from("usage_ledger").select("id").eq("user_id", id)).data).toHaveLength(0);
  });
});
