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
      .insert({ user_id: id, title: "Ship phase 0", source: "user" })
      .select("status").single();
    expect(error).toBeNull();
    expect(data!.status).toBe("suggested");
  });

  it("tasks accept an explicit status", async () => {
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

  it("digests are read-only for clients", async () => {
    const { client, id } = await makeUser("schema-b@test.local");
    const { error: insertErr } = await client.from("digests")
      .insert({ user_id: id, period: "weekly", period_start: "2026-07-27", period_end: "2026-08-02" });
    expect(insertErr).not.toBeNull();                       // no insert policy / grant
    const { error: adminErr } = await admin.from("digests")
      .insert({ user_id: id, period: "weekly", period_start: "2026-07-27", period_end: "2026-08-02" });
    expect(adminErr).toBeNull();                            // service role writes
    const { data } = await client.from("digests").select("period");
    expect(data).toHaveLength(1);                           // select policy works
  });

  it("client-writable tables accept inserts across the FK chain", async () => {
    const { client, id } = await makeUser("schema-b@test.local");

    const { data: note, error: noteErr } = await client.from("notes")
      .insert({ user_id: id, content: "primary note" }).select("id").single();
    expect(noteErr, "notes").toBeNull();

    const { data: note2, error: note2Err } = await client.from("notes")
      .insert({ user_id: id, content: "linked note" }).select("id").single();
    expect(note2Err, "notes (second)").toBeNull();

    const { data: tag, error: tagErr } = await client.from("tags")
      .insert({ user_id: id, name: "chain-tag" }).select("id").single();
    expect(tagErr, "tags").toBeNull();

    const { error: noteTagErr } = await client.from("note_tags")
      .insert({ user_id: id, note_id: note!.id, tag_id: tag!.id, source: "user" });
    expect(noteTagErr, "note_tags").toBeNull();

    const { error: linkErr } = await client.from("links")
      .insert({ user_id: id, from_note_id: note!.id, to_note_id: note2!.id });
    expect(linkErr, "links").toBeNull();

    const { error: reviewErr } = await client.from("review_queue")
      .insert({ user_id: id, note_id: note!.id, due_at: new Date().toISOString() });
    expect(reviewErr, "review_queue").toBeNull();

    const { data: session, error: sessionErr } = await client.from("chat_sessions")
      .insert({ user_id: id, title: "chain session" }).select("id").single();
    expect(sessionErr, "chat_sessions").toBeNull();

    const { error: messageErr } = await client.from("chat_messages")
      .insert({ user_id: id, session_id: session!.id, role: "user", content: "hello" });
    expect(messageErr, "chat_messages").toBeNull();

    const { error: calendarErr } = await client.from("calendar_links")
      .insert({ user_id: id, note_id: note!.id, event_id: "evt-1", event_start: new Date().toISOString() });
    expect(calendarErr, "calendar_links").toBeNull();
  });
});
