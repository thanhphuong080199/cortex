import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAi } from "../ai/fake.js";
import { createServiceClient } from "../supabase.js";
import { embedNote } from "./embed.js";

const db = createServiceClient();
let userId: string;

async function seedNote(content: string): Promise<{ noteId: string; contentText: string; contentHash: string }> {
  const { data } = await db.from("notes").insert({ user_id: userId, content }).select("id, content_text").single();
  const { data: hash } = await db.rpc("_test_md5_content_text", { p_note_id: data!.id });
  return { noteId: data!.id, contentText: data!.content_text, contentHash: hash as string };
}

describe("embedNote", () => {
  beforeEach(async () => {
    // 00008_invite_gate.sql fires on every auth.users insert, including through the admin
    // API, so createUser fails with "Signup not allowed" unless the email is allow-listed
    // first -- the same step every other suite's makeUser/clients.ts helper performs.
    const email = `embed-${Date.now()}@example.com`;
    const { error: upsertErr } = await db.from("allowed_emails").upsert({ email });
    if (upsertErr) throw upsertErr;
    const { data } = await db.auth.admin.createUser({
      email, password: "x".repeat(16), email_confirm: true,
    });
    userId = data.user!.id;
  });

  it("writes one chunk row per chunk, with the embedding and the model", async () => {
    const note = await seedNote("first paragraph\n\nsecond paragraph");
    const out = await embedNote({ db, ai: createFakeAi() }, { ...note, userId });

    expect(out).toEqual({ embedded: 1, reused: 0 });
    const { data } = await db.from("note_chunks").select("chunk_index, content_hash, embedding, embedding_model, embedded_at")
      .eq("note_id", note.noteId).order("chunk_index");
    expect(data).toHaveLength(1);
    const [only] = data ?? [];
    expect(only?.embedding).not.toBeNull();
    expect(only?.embedded_at).not.toBeNull();
  });

  // THE COST PROPERTY.
  //
  // Deliberately NOT three "\n\n"-separated paragraphs: notes.content_text is a GENERATED
  // column computed by strip_markdown(), and strip_markdown's last step is
  // regexp_replace(..., '\s+', ' ', 'g') -- it collapses every run of whitespace, blank
  // lines included, to a single space (confirmed directly: rpc strip_markdown on
  // "a\n\nb" returns "a b"). So content_text never contains "\n\n", chunkText's paragraph
  // split never fires on real note content, and the chunker's boundaries are plain
  // 1800-char (CHUNK_MAX_CHARS) windows over the flattened text. A single unbroken run of
  // one repeated character sidesteps that collapse entirely (there is no whitespace to
  // strip), and landing the edit with margin on both sides of the middle window is what
  // keeps chunk 0 and chunk 2 byte-identical -- which is what the property actually rests
  // on here, not paragraph boundaries that don't survive to content_text.
  it("re-embeds only the changed chunk", async () => {
    const original = "a".repeat(5000);
    const note = await seedNote(original);
    const ai = createFakeAi();
    await embedNote({ db, ai }, { ...note, userId });

    const spy = vi.fn(ai.embed);
    // Chunk boundaries land at 1800 and 3600; this edit sits at [2500, 2520), entirely
    // inside chunk index 1's [1800, 3600) window.
    const mutated = `${original.slice(0, 2500)}${"B".repeat(20)}${original.slice(2520)}`;
    await db.from("notes").update({ content: mutated }).eq("id", note.noteId);
    const { data: updated } = await db.from("notes").select("content_text").eq("id", note.noteId).single();
    const { data: hash } = await db.rpc("_test_md5_content_text", { p_note_id: note.noteId });

    const out = await embedNote(
      { db, ai: { ...ai, embed: spy } },
      { noteId: note.noteId, userId, contentText: updated!.content_text, contentHash: hash as string },
    );

    expect(out).toEqual({ embedded: 1, reused: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("deletes chunks that fall off the end when a note is shortened", async () => {
    const long = (c: string) => c.repeat(1500);
    const note = await seedNote(`${long("a")}\n\n${long("b")}\n\n${long("c")}`);
    await embedNote({ db, ai: createFakeAi() }, { ...note, userId });

    await db.from("notes").update({ content: long("a") }).eq("id", note.noteId);
    const { data: updated } = await db.from("notes").select("content_text").eq("id", note.noteId).single();
    const { data: hash } = await db.rpc("_test_md5_content_text", { p_note_id: note.noteId });
    await embedNote({ db, ai: createFakeAi() }, { noteId: note.noteId, userId, contentText: updated!.content_text, contentHash: hash as string });

    const { data } = await db.from("note_chunks").select("chunk_index").eq("note_id", note.noteId);
    expect(data).toHaveLength(1);
  });

  it("stamps embedded_hash so the sweep stops claiming the note for this step", async () => {
    const note = await seedNote("body");
    await embedNote({ db, ai: createFakeAi() }, { ...note, userId });
    const { data } = await db.from("note_enrichment").select("embedded_hash").eq("note_id", note.noteId).single();
    expect(data!.embedded_hash).toBe(note.contentHash);
  });

  it("is a no-op on a second run", async () => {
    const note = await seedNote("stable text");
    const ai = createFakeAi();
    await embedNote({ db, ai }, { ...note, userId });
    const spy = vi.fn(ai.embed);
    const out = await embedNote({ db, ai: { ...ai, embed: spy } }, { ...note, userId });
    expect(out).toEqual({ embedded: 0, reused: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("writes an empty note's hash without calling the model", async () => {
    const note = await seedNote("");
    const spy = vi.fn(createFakeAi().embed);
    const out = await embedNote({ db, ai: { ...createFakeAi(), embed: spy } }, { ...note, userId });
    expect(out).toEqual({ embedded: 0, reused: 0 });
    expect(spy).not.toHaveBeenCalled();
    const { data } = await db.from("note_enrichment").select("embedded_hash").eq("note_id", note.noteId).single();
    expect(data!.embedded_hash).toBe(note.contentHash);
  });
});
