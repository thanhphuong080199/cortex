import { describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

describe("content schema", () => {
  it("inserts a note and generates content_text", async () => {
    const { client, id } = await makeUser("schema-a@test.local");
    const { data, error } = await client
      .from("notes")
      .insert({ user_id: id, content: "# Hello\n\n**world**" })
      .select("id, content_text, lifecycle, source_type")
      .single();
    expect(error).toBeNull();
    expect(data!.content_text).toBe("Hello world");
    expect(data!.lifecycle).toBe("inbox");
    expect(data!.source_type).toBe("quick");
  });

  it("rejects invalid lifecycle values", async () => {
    const { client, id } = await makeUser("schema-a@test.local");
    const { error } = await client.from("notes").insert({ user_id: id, content: "x", lifecycle: "trash" });
    expect(error).not.toBeNull();
  });

  it("denies client access to server-only tables", async () => {
    const { client } = await makeUser("schema-a@test.local");
    for (const table of ["note_chunks", "ingest_inbox"]) {
      const { data } = await client.from(table).select("id");
      expect(data ?? []).toHaveLength(0);      // RLS: no policies -> empty, never rows
    }
    const { error } = await client.from("note_chunks").insert({ note_id: crypto.randomUUID(), chunk_index: 0, content: "x" });
    expect(error).not.toBeNull();              // insert denied
  });

  it("service role can write note_chunks", async () => {
    const { client, id } = await makeUser("schema-a@test.local");
    const { data: note } = await client.from("notes").insert({ user_id: id, content: "chunk me" }).select("id").single();
    const { error } = await admin.from("note_chunks").insert({
      user_id: id, note_id: note!.id, chunk_index: 0, content: "chunk me", token_count: 3,
    });
    expect(error).toBeNull();
  });
});
