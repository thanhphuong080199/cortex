import { beforeEach, describe, expect, it } from "vitest";
import { createFakeAi } from "../ai/fake.js";
import { createServiceClient } from "../supabase.js";
import { extractNote } from "./extract.js";

const db = createServiceClient();
let userId: string;

const aiReturning = (value: unknown) =>
  createFakeAi({
    generateJson: async () => ({ value, inputTokens: 10, outputTokens: 5, model: "fake-classify" }),
  });

async function seedNote(content: string) {
  const { data } = await db.from("notes").insert({ user_id: userId, content }).select("id, content_text").single();
  const { data: hash } = await db.rpc("_test_md5_content_text", { p_note_id: data!.id });
  return { noteId: data!.id, userId, contentText: data!.content_text, contentHash: hash as string };
}

const tagsOn = async (noteId: string) => {
  const { data } = await db.from("note_tags")
    .select("status, source, confidence, tags(name)").eq("note_id", noteId);
  return (data ?? []) as unknown as { status: string; source: string; confidence: number; tags: { name: string } }[];
};

describe("extractNote", () => {
  beforeEach(async () => {
    // 00008_invite_gate.sql fires on every auth.users insert, including through the admin
    // API, so createUser fails with "Signup not allowed" unless the email is allow-listed
    // first -- the same step every other suite's harness performs.
    const email = `extract-${Date.now()}@example.com`;
    const { error: upsertErr } = await db.from("allowed_emails").upsert({ email });
    if (upsertErr) throw upsertErr;
    const { data } = await db.auth.admin.createUser({
      email, password: "x".repeat(16), email_confirm: true,
    });
    userId = data.user!.id;
  });

  it("attaches suggested tags with source 'ai' and the model's confidence", async () => {
    const note = await seedNote("thoughts on pricing psychology");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [{ name: "pricing", confidence: 0.8 }] });
    const out = await extractNote({ db, ai }, note);

    expect(out.tags).toBe(1);
    expect(await tagsOn(note.noteId)).toMatchObject([
      { status: "suggested", source: "ai", confidence: 0.8, tags: { name: "pricing" } },
    ]);
  });

  // RULE 1 — the vocabulary-drift guard.
  it("reuses an existing tag that differs only by case", async () => {
    const { data: existing } = await db.from("tags").insert({ user_id: userId, name: "pricing" }).select("id").single();
    const note = await seedNote("more on pricing");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [{ name: "Pricing", confidence: 0.9 }] });
    await extractNote({ db, ai }, note);

    const { data: allTags } = await db.from("tags").select("id, name").eq("user_id", userId);
    expect(allTags).toHaveLength(1);
    const { data: links } = await db.from("note_tags").select("tag_id").eq("note_id", note.noteId);
    expect(links![0]!.tag_id).toBe(existing!.id);
  });

  // RULE 2.
  it("creates at most one new tag per run, preferring the highest confidence", async () => {
    await db.from("tags").insert({ user_id: userId, name: "known" });
    const note = await seedNote("body");
    const ai = aiReturning({
      domain: null, domain_meta: {},
      tags: [
        { name: "known", confidence: 0.9 },
        { name: "brand-new-a", confidence: 0.5 },
        { name: "brand-new-b", confidence: 0.8 },
      ],
    });
    await extractNote({ db, ai }, note);

    const names = (await tagsOn(note.noteId)).map((t) => t.tags.name).sort();
    expect(names).toEqual(["brand-new-b", "known"]);
  });

  // RULE 3 — what makes a rejection stick.
  it("does not re-suggest a tag the user already rejected on this note", async () => {
    const { data: tag } = await db.from("tags").insert({ user_id: userId, name: "nope" }).select("id").single();
    const note = await seedNote("body");
    await db.from("note_tags").insert({
      user_id: userId, note_id: note.noteId, tag_id: tag!.id, source: "ai", status: "rejected",
    });

    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [{ name: "nope", confidence: 0.99 }] });
    await extractNote({ db, ai }, note);

    const rows = await tagsOn(note.noteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("rejected");
  });

  it("suggests a domain and validated domain_meta", async () => {
    const note = await seedNote("ran 5km, felt heavy");
    const ai = aiReturning({
      domain: "health", domain_meta: { activity_type: "run", duration_min: 30 }, tags: [],
    });
    await extractNote({ db, ai }, note);

    const { data } = await db.from("notes").select("domain, domain_meta, enriched_at").eq("id", note.noteId).single();
    expect(data!.domain).toBe("health");
    expect(data!.domain_meta).toMatchObject({ activity_type: "run", duration_min: 30 });
    expect(data!.enriched_at).not.toBeNull();
  });

  it("drops domain_meta that fails the domain's schema rather than writing it", async () => {
    const note = await seedNote("ran 5km");
    const ai = aiReturning({ domain: "health", domain_meta: { duration_min: "half an hour" }, tags: [] });
    await extractNote({ db, ai }, note);

    const { data } = await db.from("notes").select("domain, domain_meta").eq("id", note.noteId).single();
    expect(data!.domain).toBe("health");
    expect(data!.domain_meta).toEqual({});
  });

  it("never overwrites a domain the user set by hand", async () => {
    const note = await seedNote("body");
    await db.from("notes").update({ domain: "finance" }).eq("id", note.noteId);
    const ai = aiReturning({ domain: "health", domain_meta: {}, tags: [] });
    await extractNote({ db, ai }, note);

    const { data } = await db.from("notes").select("domain").eq("id", note.noteId).single();
    expect(data!.domain).toBe("finance");
  });

  it("rejects an unknown domain instead of writing one the CHECK constraint refuses", async () => {
    const note = await seedNote("body");
    const ai = aiReturning({ domain: "astrology", domain_meta: {}, tags: [] });
    await extractNote({ db, ai }, note);

    const { data } = await db.from("notes").select("domain").eq("id", note.noteId).single();
    expect(data!.domain).toBeNull();
  });

  it("stamps extracted_hash", async () => {
    const note = await seedNote("body");
    await extractNote({ db, ai: aiReturning({ domain: null, domain_meta: {}, tags: [] }) }, note);
    const { data } = await db.from("note_enrichment").select("extracted_hash").eq("note_id", note.noteId).single();
    expect(data!.extracted_hash).toBe(note.contentHash);
  });

  // A real, non-mocked mid-run failure, with no malformed AI output needed: the note is
  // deleted out from under the job before extractNote runs. That fails the read that checks
  // for a hand-set domain (`.select("domain")...single()` errors when zero rows match), and
  // even if that read's error were ignored, the final note_enrichment upsert would still fail
  // on its own FK to notes(id) -- two independent reasons the hash cannot get stamped here,
  // which is the property this test pins: if extracted_hash got stamped anyway, the sweep
  // would never retry this note and the failure would be permanent and silent.
  it("does not stamp extracted_hash when a write fails partway through", async () => {
    const note = await seedNote("body");
    const { error: delErr } = await db.from("notes").delete().eq("id", note.noteId);
    if (delErr) throw delErr;

    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [] });
    await expect(extractNote({ db, ai }, note)).rejects.toBeTruthy();

    const { data } = await db.from("note_enrichment").select("extracted_hash").eq("note_id", note.noteId).maybeSingle();
    expect(data).toBeNull();
  });
});
