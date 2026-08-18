import { beforeEach, describe, expect, it } from "vitest";
import { mediaKind } from "@cortex/shared";
import { createFakeAi } from "../ai/fake.js";
import { createServiceClient } from "../supabase.js";
import { CLASSIFIER_HISTORY_TURNS, INTENTS, buildPrompt, extractNote, TAG_VOCABULARY_LIMIT } from "./extract.js";
import type { ThreadTurn } from "../assistant/context.js";

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
 * Test helper: calls extractNote with a fake AI that returns the partial extraction value,
 * and returns the full result. Defaults fields the test doesn't specify (domain, domain_meta,
 * tags, mood) so callers can focus on the field they are testing.
 */
const runExtract = async (partial: Record<string, unknown>) => {
  const note = await seedNote("test content");
  const merged = {
    domain: null,
    domain_meta: {},
    tags: [],
    mood: null,
    ...partial,
  };
  const ai = aiReturning(merged);
  return extractNote({ db, ai }, note);
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

describe("the intent vocabulary", () => {
  // The schema enum is what the model is allowed to return; the prompt is the only place it
  // learns what the values MEAN. A value present in one and absent from the other is never a
  // type error -- it is a value the model never emits, or emits and cannot be parsed. Derived
  // from one constant here for the same reason the media-kind line is derived from mediaKind.
  it("names every intent in the classification prompt", () => {
    const prompt = buildPrompt("bất kỳ", []);
    for (const intent of INTENTS) {
      expect(prompt, `the prompt never mentions "${intent}"`).toContain(`"${intent}"`);
    }
  });

  it("offers exactly the three intents and no more", () => {
    expect([...INTENTS]).toEqual(["question", "statement", "chitchat"]);
  });

  // THE OBSERVED BUG (2026-08-16). Before this, buildPrompt said nothing about intent at all --
  // no definition, no examples -- and the model inferred the field's meaning from a schema key.
  // A short follow-up is the case that inference gets wrong, so the rule has to name it.
  it("tells the model a short follow-up is still a question", () => {
    expect(buildPrompt("bất kỳ", [])).toMatch(/follow-up|còn gì|tiếp/i);
  });
});

describe("the classification prompt's conversation window", () => {
  const history: ThreadTurn[] = [
    { role: "user", content: "RAG là gì", createdAt: "2026-08-16T10:00:00Z" },
    { role: "assistant", content: "RAG là retrieval augmented generation...", createdAt: "2026-08-16T10:00:05Z" },
  ];

  // Without this, "Hmmm, ok còn gì khác không" reaches the classifier as an isolated sentence
  // and comes back `statement` -- which routes it to the acknowledge prompt, whose first rule
  // is "The user did not ask a question. Do not answer one." The conversation then dies while
  // every other part of the system is working correctly.
  it("shows the model the turns being followed up on", () => {
    const prompt = buildPrompt("Hmmm, ok còn gì khác không", [], history);
    expect(prompt).toContain("RAG là gì");
    expect(prompt).toContain("retrieval augmented generation");
  });

  // The sweep calls extractNote too, and there is no conversation there. Absent history must
  // render NOTHING -- an empty "Earlier in this conversation:" header is a heading the model
  // then has to interpret, on every note in the corpus.
  it("renders no conversation section when there is none", () => {
    const prompt = buildPrompt("một ghi chú bình thường", []);
    expect(prompt).not.toMatch(/earlier|conversation|trước đó/i);
  });

  // A COST CEILING, not a preference. This prompt runs on EVERY capture, so history here is a
  // per-note tax forever. A follow-up depends on the exchange immediately before it, not on
  // turn 40 -- and the 2000-token window selectContext builds for the ANSWER prompt would
  // roughly double this call's input for nothing.
  it("keeps only the last two turns", () => {
    const long: ThreadTurn[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant", content: `turn-${i}`,
      createdAt: `2026-08-16T10:0${i}:00Z`,
    }));
    const prompt = buildPrompt("tiếp đi", [], long);
    expect(prompt).toContain("turn-9");
    expect(prompt).toContain("turn-8");
    expect(prompt).not.toContain("turn-7");
    expect(CLASSIFIER_HISTORY_TURNS).toBe(2);
  });
});

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

  // Finding 3 (Stage C1 review round 1): a live assistant turn calls extractNote too, and
  // without this its classification spend was indistinguishable from real 60-second-sweep
  // activity -- filed under "sweep" with no request_id, unjoinable to the turn that spent it.
  it("attributes classification spend to the caller's source and requestId when given one", async () => {
    const note = await seedNote("body");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [] });
    // usage_ledger.request_id is a uuid column -- a real one, not a human-readable stand-in.
    const requestId = "11111111-1111-4111-8111-111111111111";
    await extractNote({ db, ai }, { ...note, source: "assistant", requestId });

    const { data } = await db.from("usage_ledger")
      .select("source, request_id").eq("note_id", note.noteId).eq("kind", "tag").single();
    expect(data!.source).toBe("assistant");
    expect(data!.request_id).toBe(requestId);
  });

  // The sweep's own call site (apps/api's enrich.service.ts) never sets `source`/`requestId` on
  // the note it hands in -- this pins that omitting both still files the call under "sweep" with
  // no request_id, unchanged from before Finding 3's fix.
  it("defaults classification spend to source 'sweep' with no requestId", async () => {
    const note = await seedNote("body");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [] });
    await extractNote({ db, ai }, note);

    const { data } = await db.from("usage_ledger")
      .select("source, request_id").eq("note_id", note.noteId).eq("kind", "tag").single();
    expect(data!.source).toBe("sweep");
    expect(data!.request_id).toBeNull();
  });

  it("returns the mood the model reported", async () => {
    const note = await seedNote("hôm nay mệt quá");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [], mood: 2 });

    // Red the moment `mood` is dropped from the returned object while the schema still asks
    // for it: the model is paid for the token and nothing ever writes the check-in.
    expect((await extractNote({ db, ai }, note)).mood).toBe(2);
  });

  it("returns null when the model reports no mood", async () => {
    const note = await seedNote("giá vé máy bay tháng sau");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [], mood: null });

    expect((await extractNote({ db, ai }, note)).mood).toBeNull();
  });

  /**
   * checkins_mood_or_energy (00013) constrains mood to 1..5. A responseSchema is a request,
   * not a guarantee -- the same reason intent and complexity are defaulted -- and a mood of 0
   * would be rejected by the CHECK, failing an extraction that was otherwise fine. Red when
   * the clamp is removed.
   */
  it("drops a mood outside 1..5 rather than passing it on", async () => {
    for (const bad of [0, 6, 4.5, "good", null]) {
      const note = await seedNote(`body ${String(bad)}`);
      const ai = aiReturning({ domain: null, domain_meta: {}, tags: [], mood: bad });
      expect((await extractNote({ db, ai }, note)).mood).toBeNull();
    }
  });

  /**
   * The prompt is the only thing that makes mood appear at all, and a prompt regression is
   * otherwise invisible until a user notices their moods stopped being recorded.
   * `aiCapturingPrompt` hands back what the model was actually shown.
   */
  it("tells the model when it may fill mood", async () => {
    const note = await seedNote("body");
    const { seen, ai } = aiCapturingPrompt({ domain: null, domain_meta: {}, tags: [], mood: null });
    await extractNote({ db, ai }, note);

    expect(seen[0]).toContain("mood is 1 to 5");
  });

  /**
   * The prompt is the ONLY thing that makes pending_item appear. Without it the model returns
   * {rating, status}, resolveNoteMediaLink sees no pending_item and returns null, and the
   * library never learns the film exists -- silently.
   */
  it("tells the model to name the work when the domain is media", async () => {
    const note = await seedNote("vừa xem xong Inception, 8.5/10");
    const { seen, ai } = aiCapturingPrompt({ domain: null, domain_meta: {}, tags: [], mood: null });
    await extractNote({ db, ai }, note);

    expect(seen[0]).toContain("pending_item");
  });

  /**
   * domainMetaSchemas.media accepts pending_item, so a model that fills it must have it
   * STORED rather than dropped by the meta validation -- it is the only thing a resolver or a
   * retry can work from. Red if the meta parse is ever narrowed to strip it.
   */
  it("stores a pending_item the model supplied", async () => {
    const note = await seedNote("vừa xem xong Inception");
    const ai = aiReturning({
      domain: "media", tags: [], mood: null,
      // rating: 4, not 8.5 -- domainMetaSchemas.media.rating is an integer 1-5 (packages/shared/
      // src/dto/domains.ts). 8.5 would fail the whole object's .strict() parse and drop
      // pending_item along with it, passing this test for the wrong reason.
      domain_meta: { rating: 4, pending_item: { kind: "movie", title: "Inception", year: 2010 } },
    });
    const out = await extractNote({ db, ai }, note);

    expect((out.domainMeta as Record<string, unknown>).pending_item)
      .toMatchObject({ title: "Inception" });
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

  it("asks for one JSON object carrying all fields, not multiple calls", async () => {
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
      .toEqual(["alsoWantsAnswer", "complexity", "domain", "domain_meta", "intent", "mood", "tags"]);
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

  it("passes a chitchat classification through", async () => {
    const note = await seedNote("body");
    const ai = aiReturning({ intent: "chitchat", domain: null, domain_meta: {}, tags: [] });
    const out = await extractNote({ db, ai }, note);
    expect(out.intent).toBe("chitchat");
  });

  // THE DEFAULT, AND WHY IT IS A COMPARISON AND NOT A CAST. `required` in a responseSchema is a
  // request, not a guarantee. "statement" is the branch that never spends the reasoning model
  // and never grounds, so it is the only safe landing place for a value the model did not send
  // or sent wrong. Widening the return type with `value.intent as Intent` would compile, would
  // pass every other test in this file, and would let "chit chat" or "" through into turn.ts's
  // branch -- where it silently reads as "not a question", which is right by accident today and
  // wrong the moment a fourth intent exists.
  it("defaults a missing intent to statement", async () => {
    const note = await seedNote("body");
    const ai = aiReturning({ domain: null, domain_meta: {}, tags: [] });
    const out = await extractNote({ db, ai }, note);
    expect(out.intent).toBe("statement");
  });

  it("defaults an unrecognised intent to statement", async () => {
    const note = await seedNote("body");
    const ai = aiReturning({ intent: "chit chat", domain: null, domain_meta: {}, tags: [] });
    const out = await extractNote({ db, ai }, note);
    expect(out.intent).toBe("statement");
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

describe("the media prompt and the mediaKind enum", () => {
  // The prompt is the only place the model learns what kinds exist. Offering it a value the
  // strict parse then rejects silently costs the note its domain_meta AND its media link --
  // and the prompt and the enum are in different packages, so nothing else notices.
  it("offers exactly the kinds mediaKind accepts", () => {
    // The "pending_item is REQUIRED" sentence literally contains the substring "pending_item"
    // and would satisfy a naive `.includes("pending_item")` search without ever reaching the
    // `{"kind": ...}` shape line below it -- so this anchors on the shape fragment itself.
    const line = buildPrompt("bất kỳ", []).split("\n").find((l) => l.includes("\"kind\":"));
    expect(line, "the pending_item kind-shape line").toBeDefined();

    const offered = [...line!.matchAll(/"([a-z_]+)"(?=\s*[|,])/g)].map((m) => m[1]!);
    expect(offered.length, "no quoted kinds parsed out of the prompt line").toBeGreaterThan(0);
    expect(new Set(offered)).toEqual(new Set(mediaKind.options));
  });
});

describe("alsoWantsAnswer", () => {
  // THE OBSERVED BUG. A turn can be a fact to file AND a question in one sentence; `intent`
  // holds one value and therefore cannot say so. Without a rule naming that shape explicitly,
  // the model has no reason to set a flag it was never told the purpose of.
  it("tells the model a turn can be both a statement and a question", () => {
    const prompt = buildPrompt("bất kỳ", []);
    expect(prompt).toContain("alsoWantsAnswer");
    // The rule must survive as a rule, not as a bare schema key echoed back.
    expect(prompt).toMatch(/both|vừa|đồng thời/i);
  });

  describe("when a model response is evaluated", () => {
    beforeEach(createTestUser);

    // intent STAYS "statement". The flag is additive precisely so tagging, domain and filing
    // tone keep working the way they do for any other recorded note -- widening `intent` to a
    // fourth value would have meant re-deciding all three.
    it("keeps intent at statement while asking for an answer", async () => {
      const out = await runExtract({ intent: "statement", alsoWantsAnswer: true });
      expect(out.intent).toBe("statement");
      expect(out.alsoWantsAnswer).toBe(true);
    });

    // THE DEFAULT, AND WHY IT IS A COMPARISON. `required` in a responseSchema is a request, not
    // a guarantee. `false` is the branch that keeps the turn on CLASSIFY_MODEL and off Google,
    // so it is the only safe landing place for a value the model omitted or sent wrong.
    // `value.alsoWantsAnswer as boolean` compiles and lets the string "true" -- or "no" --
    // through into turn.ts, where every non-empty string is truthy.
    it("defaults a missing alsoWantsAnswer to false", async () => {
      expect((await runExtract({ intent: "statement" })).alsoWantsAnswer).toBe(false);
    });

    it("defaults a non-boolean alsoWantsAnswer to false", async () => {
      expect((await runExtract({ intent: "statement", alsoWantsAnswer: "yes" })).alsoWantsAnswer)
        .toBe(false);
    });

    // A pure question does not need the flag: `intent: "question"` already routes to the answer
    // prompt. Asserted so nobody later makes the flag REQUIRED for an answer and breaks the
    // path that was always working.
    it("leaves a pure question's flag false without changing its routing", async () => {
      const out = await runExtract({ intent: "question" });
      expect(out.intent).toBe("question");
      expect(out.alsoWantsAnswer).toBe(false);
    });
  });
});
