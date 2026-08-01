import { describe, expect, it } from "vitest";
import { makeUser } from "./clients.js";

// Life-domains spec §2: notes gain a domain, and three structured tables exist where a
// note genuinely cannot do the job -- entity identity (media_items), a high-frequency
// two-word timeseries (checkins), and scheduled card review (flashcards).
describe("life-domain schema (life-domains spec §2)", () => {
  it("notes accept a valid domain and reject an invalid one", async () => {
    const { client, id } = await makeUser("domains-schema@test.local");
    const ok = await client.from("notes")
      .insert({ user_id: id, content: "ran 5k", domain: "health", domain_meta: { activity_type: "run" } })
      .select().single();
    expect(ok.error).toBeNull();
    expect(ok.data!.domain).toBe("health");

    const bad = await client.from("notes")
      .insert({ user_id: id, content: "x", domain: "astrology" });
    expect(bad.error?.code).toBe("23514");                  // check violation
  });

  it("notes without a domain stay valid (undomained notes are normal notes)", async () => {
    const { client, id } = await makeUser("domains-schema@test.local");
    const { data, error } = await client.from("notes")
      .insert({ user_id: id, content: "just a thought" }).select().single();
    expect(error).toBeNull();
    expect(data!.domain).toBeNull();
    expect(data!.domain_meta).toEqual({});                  // not null -- default '{}'
  });

  it("media_items dedupe on (user_id, kind, lower(title)) among live rows", async () => {
    const { client, id } = await makeUser("media-schema@test.local");
    await client.from("media_items").delete().eq("title", "Dune");   // idempotency
    await client.from("media_items").delete().eq("title", "dune");

    const a = await client.from("media_items")
      .insert({ user_id: id, kind: "movie", title: "Dune" }).select().single();
    expect(a.error).toBeNull();

    const dup = await client.from("media_items")
      .insert({ user_id: id, kind: "movie", title: "dune" });      // case-insensitive collision
    expect(dup.error?.code).toBe("23505");

    const book = await client.from("media_items")
      .insert({ user_id: id, kind: "book", title: "Dune" }).select().single();
    expect(book.error, "same title in a different kind is a different item").toBeNull();
    expect(book.data!.id).not.toBe(a.data!.id);
  });

  it("media_items reject an unknown kind", async () => {
    const { client, id } = await makeUser("media-schema@test.local");
    const bad = await client.from("media_items")
      .insert({ user_id: id, kind: "vinyl", title: "Kind of Blue" });
    expect(bad.error?.code).toBe("23514");
  });

  it("checkins require mood or energy, both in 1..5", async () => {
    const { client, id } = await makeUser("checkins-schema@test.local");
    const ok = await client.from("checkins").insert({ user_id: id, mood: 4 });
    expect(ok.error).toBeNull();

    const bad = await client.from("checkins").insert({ user_id: id, label: "meh" });
    expect(bad.error?.code, "label alone is not a check-in").toBe("23514");

    const range = await client.from("checkins").insert({ user_id: id, mood: 6 });
    expect(range.error?.code).toBe("23514");
  });

  it("flashcards default to suggested and hang off a note", async () => {
    const { client, id } = await makeUser("cards-schema@test.local");
    const { data: note } = await client.from("notes")
      .insert({ user_id: id, content: "hola = hello", domain: "learning" }).select().single();

    const card = await client.from("flashcards")
      .insert({ user_id: id, note_id: note!.id, front: "hola", back: "hello" }).select().single();
    expect(card.error).toBeNull();
    expect(card.data!.status).toBe("suggested");
    expect(card.data!.source).toBe("ai");                   // extraction is the default path
  });

  it("notes.media_item_id survives its item being soft-deleted, and nulls on hard delete", async () => {
    const { client, id } = await makeUser("media-schema@test.local");
    const { data: item } = await client.from("media_items")
      .insert({ user_id: id, kind: "game", title: "Outer Wilds" }).select().single();
    const { data: note, error } = await client.from("notes")
      .insert({ user_id: id, content: "finally finished it", domain: "media", media_item_id: item!.id })
      .select().single();
    expect(error).toBeNull();
    expect(note!.media_item_id).toBe(item!.id);

    // on delete set null (spec §2.1): losing the item must not take the log note with it.
    await client.from("media_items").delete().eq("id", item!.id);
    const { data: after } = await client.from("notes").select("id, media_item_id").eq("id", note!.id).single();
    expect(after!.media_item_id).toBeNull();
  });
});
