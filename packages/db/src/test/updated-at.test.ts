import { describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

// notes_user_updated_idx (00002_content.sql) is built on updated_at, and Phase 1's
// PowerSync ordering will depend on it advancing on every UPDATE -- nothing in the
// schema made that true before the moddatetime triggers added here. Proves it for one
// representative table per migration file that got a trigger (notes, tasks,
// review_queue, memory_facts, chat_sessions, integrations).
describe("updated_at triggers", () => {
  it("notes.updated_at advances past created_at on UPDATE", async () => {
    const { client, id } = await makeUser("updated-at@test.local");
    const { data: inserted } = await client.from("notes")
      .insert({ user_id: id, content: "original" }).select("id, created_at, updated_at").single();
    expect(inserted!.created_at).toBe(inserted!.updated_at);

    await new Promise((r) => setTimeout(r, 1100)); // timestamptz has second-level visible drift here
    const { data: updated, error } = await client.from("notes")
      .update({ title: "changed" }).eq("id", inserted!.id).select("created_at, updated_at").single();
    expect(error).toBeNull();
    expect(new Date(updated!.updated_at).getTime()).toBeGreaterThan(new Date(updated!.created_at).getTime());
  });

  it("tasks.updated_at advances on UPDATE", async () => {
    const { client, id } = await makeUser("updated-at@test.local");
    const { data: inserted } = await client.from("tasks")
      .insert({ user_id: id, title: "t", source: "user" }).select("id, created_at, updated_at").single();
    await new Promise((r) => setTimeout(r, 1100));
    const { data: updated } = await client.from("tasks")
      .update({ status: "doing" }).eq("id", inserted!.id).select("created_at, updated_at").single();
    expect(new Date(updated!.updated_at).getTime()).toBeGreaterThan(new Date(updated!.created_at).getTime());
  });

  it("review_queue.updated_at advances on UPDATE", async () => {
    const { client, id } = await makeUser("updated-at@test.local");
    const { data: note } = await client.from("notes").insert({ user_id: id, content: "n" }).select("id").single();
    const { data: inserted } = await client.from("review_queue")
      .insert({ user_id: id, note_id: note!.id, due_at: new Date().toISOString() })
      .select("id, created_at, updated_at").single();
    await new Promise((r) => setTimeout(r, 1100));
    const { data: updated } = await client.from("review_queue")
      .update({ ease: 2.5 }).eq("id", inserted!.id).select("created_at, updated_at").single();
    expect(new Date(updated!.updated_at).getTime()).toBeGreaterThan(new Date(updated!.created_at).getTime());
  });

  it("memory_facts.updated_at advances on UPDATE (via service_role)", async () => {
    const { id } = await makeUser("updated-at@test.local");
    const { data: inserted } = await admin.from("memory_facts")
      .insert({ user_id: id, category: "preference", statement: "s", confidence: 0.5 })
      .select("id, created_at, updated_at").single();
    await new Promise((r) => setTimeout(r, 1100));
    const { data: updated } = await admin.from("memory_facts")
      .update({ salience: 0.9 }).eq("id", inserted!.id).select("created_at, updated_at").single();
    expect(new Date(updated!.updated_at).getTime()).toBeGreaterThan(new Date(updated!.created_at).getTime());
  });

  it("chat_sessions.updated_at advances on UPDATE", async () => {
    const { client, id } = await makeUser("updated-at@test.local");
    const { data: inserted } = await client.from("chat_sessions")
      .insert({ user_id: id, title: "s" }).select("id, created_at, updated_at").single();
    await new Promise((r) => setTimeout(r, 1100));
    const { data: updated } = await client.from("chat_sessions")
      .update({ title: "renamed" }).eq("id", inserted!.id).select("created_at, updated_at").single();
    expect(new Date(updated!.updated_at).getTime()).toBeGreaterThan(new Date(updated!.created_at).getTime());
  });

  it("integrations.updated_at advances on UPDATE (via service_role)", async () => {
    const { id } = await makeUser("updated-at@test.local");
    const { data: inserted } = await admin.from("integrations")
      .insert({ user_id: id, provider: "telegram", external_id: "ext-1" })
      .select("id, created_at, updated_at").single();
    await new Promise((r) => setTimeout(r, 1100));
    const { data: updated } = await admin.from("integrations")
      .update({ status: "revoked" }).eq("id", inserted!.id).select("created_at, updated_at").single();
    expect(new Date(updated!.updated_at).getTime()).toBeGreaterThan(new Date(updated!.created_at).getTime());
  });
});
