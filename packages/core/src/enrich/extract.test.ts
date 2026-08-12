import { beforeEach, describe, expect, it } from "vitest";
import { createFakeAi } from "../ai/fake.js";
import { createServiceClient } from "../supabase.js";
import { extractNote, TAG_VOCABULARY_LIMIT } from "./extract.js";

const db = createServiceClient();
let userId: string;

const aiReturning = (value: unknown) =>
  createFakeAi({
    generateJson: async () => ({ value, inputTokens: 10, outputTokens: 5, model: "fake-classify" }),
  });

/** Same script, but hands back the prompt the model was actually shown. */
const aiCapturingPrompt = (value: unknown) => {
  const seen: string[] = [];
  return {
    seen,
    ai: createFakeAi({
      generateJson: async (args) => {
        seen.push(args.prompt);
        return { value, inputTokens: 10, outputTokens: 5, model: "fake-classify" };
      },
    }),
  };
};

/**
 * The comma-separated vocabulary line buildPrompt writes, split back into names.
 *
 * Anchored on the header rather than an absolute line index. An index constrains where every
 * later paragraph of the prompt may go, and it fails SILENTLY -- it returns some other line and
 * splits that on ", ", so a cap test would assert against the wrong text instead of erroring.
 */
const vocabularyIn = (prompt: string): string[] => {
  const lines = prompt.split("\n");
  const header = lines.findIndex((l) => l.startsWith("Their existing tags"));
  if (header === -1) throw new Error(`prompt has no "Their existing tags" header:\n${prompt}`);
  const line = lines[header + 1] ?? "";
  return line === "(none yet)" ? [] : line.split(", ");
};

/**
 * `created_at` is written explicitly and spread over distinct instants. A single batch INSERT
 * stamps every default `now()` with the SAME transaction timestamp, which would make
 * `order by created_at desc` a tie across the whole fixture and "which tags fall outside the cap"
 * non-deterministic -- the tests below would pass or fail by luck.
 */
const seedTags = async (count: number, prefix: string): Promise<string[]> => {
  const base = Date.parse("2020-01-01T00:00:00.000Z");
  const names = Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);
  const { error } = await db.from("tags").insert(
    names.map((name, i) => ({
      user_id: userId, name, created_at: new Date(base + i * 60_000).toISOString(),
    })),
  );
  if (error) throw error;
  return names; // index 0 is the OLDEST, i.e. the first to fall outside a `created_at desc` cap
};

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

/**
 * 00008_invite_gate.sql fires on every auth.users insert, including through the admin
 * API, so createUser fails with "Signup not allowed" unless the email is allow-listed
 * first -- the same step every other suite's harness performs.
 */
async function createTestUser() {
  const email = `extract-${Date.now()}@example.com`;
  const { error: upsertErr } = await db.from("allowed_emails").upsert({ email });
  if (upsertErr) throw upsertErr;
  const { data } = await db.auth.admin.createUser({
    email, password: "x".repeat(16), email_confirm: true,
  });
  userId = data.user!.id;
}

describe("extractNote", () => {
  beforeEach(createTestUser);

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

  // THE max_rows BUG, for the second time. Task 12 already fixed this shape once in
  // monthToDateUsd (see 00021's header): config.toml sets PostgREST's `max_rows = 1000`, which
  // truncates a response at 1000 rows with NO error and no signal short of reading
  // Content-Range. The tag read had no `.limit()` and no pagination, so a user at 1000 tags got
  // an arbitrary 1000-row slice, and every tag outside it read as novel.
  //
  // The cap is now a product decision, not a PostgREST default, and it is well under 1000 --
  // which is what makes this test able to fail: with no `.limit()` at all, the fixture below
  // (LIMIT + 5 tags, still under max_rows) reaches buildPrompt whole.
  it("shows the model at most TAG_VOCABULARY_LIMIT tags, however many the user has", async () => {
    await seedTags(TAG_VOCABULARY_LIMIT + 5, "vocab");
    const note = await seedNote("body");
    const { seen, ai } = aiCapturingPrompt({ domain: null, domain_meta: {}, tags: [] });
    await extractNote({ db, ai }, note);

    expect(vocabularyIn(seen[0]!)).toHaveLength(TAG_VOCABULARY_LIMIT);
  });

  it("keeps the most recent tags when it has to cut", async () => {
    const names = await seedTags(TAG_VOCABULARY_LIMIT + 5, "recency");
    const note = await seedNote("body");
    const { seen, ai } = aiCapturingPrompt({ domain: null, domain_meta: {}, tags: [] });
    await extractNote({ db, ai }, note);

    const shown = new Set(vocabularyIn(seen[0]!));
    expect(shown.has(names.at(-1)!)).toBe(true); // newest survives
    expect(shown.has(names[0]!)).toBe(false); // oldest is the one cut
  });

  // The cap would be a REGRESSION on its own. A tag outside the slice is not in byLowerName, so
  // the old code treated it as novel and inserted it -- against tags_user_name_uidx, a unique
  // index on (user_id, lower(name)) where deleted_at is null. That insert does not silently
  // duplicate, it RAISES, and extract.ts rethrows: the note fails, five times, and 00018's cap
  // tombstones it. Narrowing the vocabulary from 1000 to a few hundred would have made that
  // failure common instead of rare. The vocabulary is what the MODEL sees; it is not the set of
  // tags that exist, and tag resolution must not assume it is.
  it("reuses a tag that exists but fell outside the capped vocabulary", async () => {
    const names = await seedTags(TAG_VOCABULARY_LIMIT + 5, "outside");
    const oldest = names[0]!;
    const { data: existing } = await db.from("tags")
      .select("id").eq("user_id", userId).eq("name", oldest).single();

    const note = await seedNote("body");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [{ name: oldest, confidence: 0.9 }] });
    await extractNote({ db, ai }, note);

    const { data: sameName } = await db.from("tags")
      .select("id").eq("user_id", userId).ilike("name", oldest);
    expect(sameName).toHaveLength(1); // no near-duplicate created
    const { data: links } = await db.from("note_tags").select("tag_id").eq("note_id", note.noteId);
    expect(links).toHaveLength(1);
    expect(links![0]!.tag_id).toBe(existing!.id);
  });

  // Same path, case-varied: the unique index is on lower(name), so "Outside-0000" and
  // "outside-0000" are the SAME tag as far as Postgres is concerned, and the fallback lookup has
  // to agree with the index rather than with `=`.
  it("reuses an out-of-vocabulary tag that differs only by case", async () => {
    const names = await seedTags(TAG_VOCABULARY_LIMIT + 5, "cased");
    const oldest = names[0]!;
    const note = await seedNote("body");
    const ai = aiReturning({
      domain: null, domain_meta: {}, tags: [{ name: oldest.toUpperCase(), confidence: 0.9 }],
    });
    await extractNote({ db, ai }, note);

    const { data: sameName } = await db.from("tags")
      .select("id").eq("user_id", userId).ilike("name", oldest);
    expect(sameName).toHaveLength(1);
  });

  // tags_user_name_uidx is PARTIAL (`where deleted_at is null`), so a soft-deleted tag does not
  // block re-creating its name -- and it must not be offered to the model or resurrected by a
  // link either. The read had no deleted_at filter at all, which meant a tag the user had
  // deleted kept being suggested back to them.
  it("ignores a soft-deleted tag rather than suggesting it back", async () => {
    const { data: gone } = await db.from("tags")
      .insert({ user_id: userId, name: "retired", deleted_at: new Date().toISOString() })
      .select("id").single();
    const note = await seedNote("body");
    const { seen, ai } = aiCapturingPrompt({
      domain: null, domain_meta: {}, tags: [{ name: "retired", confidence: 0.9 }],
    });
    await extractNote({ db, ai }, note);

    expect(vocabularyIn(seen[0]!)).not.toContain("retired");
    const { data: links } = await db.from("note_tags").select("tag_id").eq("note_id", note.noteId);
    expect(links!.map((l) => l.tag_id)).not.toContain(gone!.id);
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

describe("extractNote — intent, complexity and language", () => {
  beforeEach(createTestUser);

  // Both fixtures are the NON-default value on purpose: "statement"/"simple" are what the
  // defaults below produce, so feeding them here would pass against a hardcoded return and pin
  // nothing. The omitted-field defaults are covered separately.
  it("returns the intent the model classified", async () => {
    const note = await seedNote("bao giờ tôi viết về chuyện này?");
    const ai = aiReturning({
      intent: "question", complexity: "complex", domain: null, domain_meta: {}, tags: [],
    });
    const out = await extractNote({ db, ai }, note);

    expect(out.intent).toBe("question");
    expect(out.complexity).toBe("complex");
  });

  it("asks for one JSON object carrying all four decisions, not four calls", async () => {
    const schemas: Record<string, unknown>[] = [];
    const ai = createFakeAi({
      generateJson: async (args) => {
        schemas.push(args.schema);
        return {
          value: { intent: "statement", complexity: "simple", domain: null, domain_meta: {}, tags: [] },
          inputTokens: 1, outputTokens: 1, model: "fake-classify",
        };
      },
    });
    await extractNote({ db, ai }, await seedNote("hôm nay tôi chạy bộ"));

    expect(schemas).toHaveLength(1);
    const props = (schemas[0]!.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props).sort())
      .toEqual(["complexity", "domain", "domain_meta", "intent", "tags"]);
  });

  // Cortex's users write Vietnamese. A prompt that says nothing about language gets tags back
  // in whichever language the model felt like, which fragments the vocabulary that
  // TAG_VOCABULARY_LIMIT exists to keep stable.
  it("instructs the model to work in the language the note was written in", async () => {
    const note = await seedNote("tôi ngủ không đủ giấc");
    const { seen, ai } = aiCapturingPrompt({
      intent: "statement", complexity: "simple", domain: null, domain_meta: {}, tags: [],
    });
    await extractNote({ db, ai }, note);

    expect(seen[0]!).toMatch(/same language/i);
  });

  it("defaults to statement when the model omits intent, rather than throwing", async () => {
    const note = await seedNote("ghi chú");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [] });
    const out = await extractNote({ db, ai }, note);

    expect(out.intent).toBe("statement");
    expect(out.complexity).toBe("simple");
  });

  // The names, not just the count: the box has to say which tags it attached, and reading them
  // back out of note_tags would be a second round trip for data this call already held.
  it("names the tags it attached, not only how many", async () => {
    const note = await seedNote("thoughts on pricing psychology");
    const ai = aiReturning({
      intent: "statement", complexity: "simple", domain: null, domain_meta: {},
      tags: [{ name: "pricing", confidence: 0.8 }],
    });
    const out = await extractNote({ db, ai }, note);

    expect(out.tags).toBe(1);
    expect(out.tagNames).toEqual(["pricing"]);
  });

  // The spelling the box shows must not depend on where a tag sits relative to
  // TAG_VOCABULARY_LIMIT. A tag stored as "Pricing" resolves through the capped vocabulary when
  // it is recent and through the ilike fallback when it is not -- and the fallback used to store
  // the lowercased LOOKUP KEY, so the same tag rendered "Pricing" or "pricing" by cap position.
  it("reports the stored spelling of a tag resolved outside the capped vocabulary", async () => {
    // Older than every tag seedTags writes (base 2020-01-01), so `created_at desc` cuts it from
    // the vocabulary the model is shown and resolution has to take the fallback path.
    const { error } = await db.from("tags")
      .insert({ user_id: userId, name: "Pricing", created_at: "2019-01-01T00:00:00.000Z" });
    if (error) throw error;
    await seedTags(TAG_VOCABULARY_LIMIT, "cap");

    const note = await seedNote("more on pricing");
    const { seen, ai } = aiCapturingPrompt({
      intent: "statement", complexity: "simple", domain: null, domain_meta: {},
      tags: [{ name: "pricing", confidence: 0.9 }],
    });
    const out = await extractNote({ db, ai }, note);

    // The test is worthless unless the tag really did fall outside the cap.
    expect(vocabularyIn(seen[0]!)).not.toContain("Pricing");
    expect(out.tagNames).toEqual(["Pricing"]);
    // ...and it resolved rather than duplicated: one tag, not "Pricing" plus a new "pricing".
    const { data: sameName } = await db.from("tags")
      .select("id").eq("user_id", userId).ilike("name", "pricing");
    expect(sameName).toHaveLength(1);
  });
});
