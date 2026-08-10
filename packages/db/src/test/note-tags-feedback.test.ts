import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, makeUser } from "./clients";

describe("note_tags -> feedback_events", () => {
  let userId: string;
  let client: SupabaseClient;
  let noteId: string;

  beforeAll(async () => {
    ({ id: userId, client } = await makeUser("tag-feedback@example.com"));
    // Idempotency (see note-tags-reattach.test.ts): makeUser reuses users by email and no
    // suite tears down its rows, so a second run of this file without `supabase db reset`
    // hits tags' unique index (user_id, lower(name)) on these fixed names -- the insert
    // below is unchecked, so the failure would surface as a confusing "Cannot read
    // properties of null". Clear last run's tags first.
    await admin.from("tags").delete().eq("user_id", userId).in("name",
      ["accept-me", "reject-me", "web-path", "noop", "once", "manual"]);
    const { data } = await admin.from("notes")
      .insert({ user_id: userId, content: "body" }).select("id").single();
    noteId = data!.id;
  });

  const suggest = async (tagName: string) => {
    const { data: tag } = await admin.from("tags")
      .insert({ user_id: userId, name: tagName }).select("id").single();
    const { data: link } = await admin.from("note_tags")
      .insert({ user_id: userId, note_id: noteId, tag_id: tag!.id, source: "ai", status: "suggested", confidence: 0.7 })
      .select("id").single();
    return link!.id as string;
  };

  const events = async (subjectId: string) =>
    (await admin.from("feedback_events").select("*").eq("subject_id", subjectId)).data ?? [];

  it("records an accept", async () => {
    const id = await suggest("accept-me");
    await admin.from("note_tags").update({ status: "accepted" }).eq("id", id);
    const rows = await events(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: userId, subject_type: "tag", action: "accept" });
  });

  it("records a reject", async () => {
    const id = await suggest("reject-me");
    await admin.from("note_tags").update({ status: "rejected" }).eq("id", id);
    expect(await events(id)).toMatchObject([{ action: "reject" }]);
  });

  // The property that matters: no client path can skip it. Web writes note_tags through
  // PostgREST with the user's own JWT, never through the API.
  it("fires for a direct PostgREST update by the user", async () => {
    const id = await suggest("web-path");
    const { error } = await client.from("note_tags").update({ status: "accepted" }).eq("id", id);
    expect(error).toBeNull();
    expect(await events(id)).toMatchObject([{ action: "accept" }]);
  });

  it("does not fire when a suggestion is merely re-saved", async () => {
    const id = await suggest("noop");
    await admin.from("note_tags").update({ confidence: 0.9 }).eq("id", id);
    expect(await events(id)).toHaveLength(0);
  });

  it("does not fire twice when an accepted tag is updated again", async () => {
    const id = await suggest("once");
    await admin.from("note_tags").update({ status: "accepted" }).eq("id", id);
    await admin.from("note_tags").update({ status: "accepted" }).eq("id", id);
    expect(await events(id)).toHaveLength(1);
  });

  it("does not fire for a user-created tag that was never suggested", async () => {
    const { data: tag } = await admin.from("tags")
      .insert({ user_id: userId, name: "manual" }).select("id").single();
    const { data: link } = await admin.from("note_tags")
      .insert({ user_id: userId, note_id: noteId, tag_id: tag!.id, source: "user", status: "accepted" })
      .select("id").single();
    expect(await events(link!.id)).toHaveLength(0);
  });
});
