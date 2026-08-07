import { beforeAll, describe, expect, it } from "vitest";
import { makeUser } from "./clients.js";

let alice: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  alice = await makeUser("db-conflict-link-alice@test.local");
});

async function makeNote(content: string): Promise<string> {
  const { data, error } = await alice.client.from("notes")
    .insert({ user_id: alice.id, content }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

describe("links.kind conflict_copy", () => {
  it("accepts a conflict_copy link between two of the user's notes", async () => {
    const from = await makeNote("conflict copy body");
    const to = await makeNote("server body");
    const { data, error } = await alice.client.from("links")
      .insert({ user_id: alice.id, from_note_id: from, to_note_id: to, kind: "conflict_copy" })
      .select("kind").single();
    expect(error).toBeNull();
    expect(data!.kind).toBe("conflict_copy");
  });

  it("still rejects an unknown kind", async () => {
    const from = await makeNote("a");
    const to = await makeNote("b");
    const { error } = await alice.client.from("links")
      .insert({ user_id: alice.id, from_note_id: from, to_note_id: to, kind: "nonsense" });
    expect(error?.code).toBe("23514"); // check_violation
  });
});
