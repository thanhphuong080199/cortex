import type { SupabaseClient } from "@supabase/supabase-js";
import { domainMetaSchemas, noteDomain } from "@cortex/shared";
import type { AiClient } from "../ai/client.js";
import type { EnrichTarget } from "./embed.js";
import { recordUsage } from "./budget.js";

interface Extraction {
  intent?: "question" | "statement";
  complexity?: "simple" | "complex";
  domain: string | null;
  domain_meta: Record<string, unknown>;
  tags: { name: string; confidence: number }[];
  mood?: unknown;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    // The box branches on this. The sweep ignores it -- a few output tokens, against two
    // prompts that would have to be kept in step by discipline alone.
    intent: { type: "string", enum: ["question", "statement"] },
    // RECORDED, NOT ACTED ON. It costs a couple of output tokens and produces the dataset a
    // future model-routing decision needs: complexity x real cost x model. Nothing reads it.
    complexity: { type: "string", enum: ["simple", "complex"] },
    domain: { type: "string", nullable: true, enum: [...noteDomain.options] },
    domain_meta: { type: "object" },
    tags: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, confidence: { type: "number" } },
        required: ["name", "confidence"],
      },
    },
    // 1..5, matching the checkins_mood_or_energy CHECK (00013). Nullable and usually null:
    // the prompt below only allows it when the text SAYS how the person feels.
    mood: { type: "integer", nullable: true },
  },
  required: ["intent", "complexity", "domain", "domain_meta", "tags", "mood"],
};

/**
 * How many of a user's tags the model is shown, and therefore how many it can reuse directly.
 *
 * There has to be a number here. The read below had no `.limit()` and no pagination, which does
 * not mean "all of them" -- config.toml sets PostgREST's `max_rows = 1000`, which truncates a
 * response at 1000 rows with NO error and no signal short of reading Content-Range. That is the
 * same silent-truncation bug Task 12 already fixed once in monthToDateUsd; 00021's header
 * documents the mechanism at length. A user reaching 1000 tags is reachable, because the tag
 * creation below can add one per note per sweep. Past that point the vocabulary was an ARBITRARY
 * 1000-row slice, a tag outside it read as novel, and the model stopped being shown tags the user
 * actually has -- vocabulary drift, the exact failure the "reuse an existing tag" rule exists to
 * prevent, accelerating itself.
 *
 * 200, not 1000: this list is pasted into EVERY classification call, so it is a per-note cost
 * forever, and a wall of a thousand tags is also worse input -- "prefer an existing tag over
 * inventing one" degrades as the list stops being scannable. 200 tags is a few hundred tokens and
 * is far more personal vocabulary than a note plausibly needs to choose from.
 *
 * Ordered by created_at desc, because recency is the only usage-correlated signal the `tags`
 * table carries -- there is no use count on it, and ranking by one would mean an aggregate over
 * note_tags on every classification call. A personal tag vocabulary tracks what the person is
 * currently doing, so the newest 200 is a better bet than an arbitrary 200. The cost of being
 * wrong is bounded rather than permanent: a tag outside the slice is still RESOLVED correctly
 * when the model happens to name it (see the fallback lookup below), it just is not offered.
 */
export const TAG_VOCABULARY_LIMIT = 200;

function buildPrompt(contentText: string, vocabulary: string[]): string {
  return [
    "You organise one person's personal notes. Return JSON only.",
    "",
    "Their existing tags, which you must REUSE when one fits:",
    vocabulary.length > 0 ? vocabulary.join(", ") : "(none yet)",
    "",
    "Rules:",
    "- Prefer an existing tag over inventing one. Match on meaning, not spelling.",
    "- Propose at most ONE tag that is not in the list above.",
    "- 3 to 5 tags total. Lowercase, hyphenated, no '#'.",
    "- domain must be one of: " + noteDomain.options.join(", ") + ", or null when none fits.",
    "- domain_meta holds only what the text actually states. Omit anything you are guessing.",
    "- when domain is \"media\", domain_meta.pending_item is REQUIRED and looks like",
    "  {\"kind\": \"movie\"|\"book\"|\"show\"|\"game\"|\"album\", \"title\": \"...\", \"year\": 2010}.",
    "  Use the work's own title as the person wrote it. Omit year when the text does not say.",
    "- mood is 1 to 5, and ONLY when the note says how the writer feels — \"mệt\", \"vui\",",
    "  \"chán\". A note about a difficult topic is not a bad mood. Return null if you are",
    "  inferring rather than reading.",
    "",
    "Write tags in the SAME LANGUAGE the note is written in. Do not translate: a note in",
    "Vietnamese gets Vietnamese tags. Tag vocabularies that mix languages split one idea across two",
    "tags and stop being reusable. The `domain` value is the exception -- it is a fixed English",
    "identifier stored in the database, so return it exactly as listed above whatever the note's",
    "language.",
    "",
    "The note:",
    contentText,
  ].join("\n");
}

/**
 * Suggests a domain, fills domain_meta, and attaches tags -- all `suggested`, never applied.
 * The life-domains spec §2 is explicit that freeform text is the source of truth and structure
 * is extracted afterwards, never required at capture.
 */
export async function extractNote(
  deps: { db: SupabaseClient; ai: AiClient },
  note: EnrichTarget,
): Promise<{
  tags: number;
  tagNames: string[];
  domain: string | null;
  domainMeta: Record<string, unknown>;
  mood: number | null;
  intent: "question" | "statement";
  complexity: "simple" | "complex";
}> {
  const { db, ai } = deps;

  const { data: tagRows, error: tagErr } = await db.from("tags")
    .select("id, name")
    .eq("user_id", note.userId)
    // tags_user_name_uidx (00003) is PARTIAL -- `where deleted_at is null` -- so a soft-deleted
    // tag does not reserve its name and must not be treated as part of the vocabulary either.
    // Without this filter a tag the user deliberately deleted keeps being suggested back to them,
    // and linking a note to it would resurrect it in every tag list.
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(TAG_VOCABULARY_LIMIT);
  if (tagErr) throw tagErr;
  const vocabulary = (tagRows ?? []) as { id: string; name: string }[];
  // Case-insensitive, because "Pricing" and "pricing" must be one tag. This is the
  // findOrCreate precedent phase 1b set for media items.
  const byLowerName = new Map(vocabulary.map((t) => [t.name.toLowerCase(), t]));

  const { value, inputTokens, outputTokens, model } = await ai.generateJson<Extraction>({
    prompt: buildPrompt(note.contentText, vocabulary.map((t) => t.name)),
    schema: RESPONSE_SCHEMA,
  });
  // "tag": usage_ledger.kind's CHECK constraint (00007_integrations_ops.sql) is a fixed
  // vocabulary -- 'embed','chat','tag','digest','memory','transcribe' -- with no 'extract'
  // option. 'tag' is the closest fit even though this call also writes domain and domain_meta
  // from the same model output, not only tags.
  await recordUsage(db, {
    userId: note.userId, kind: "tag", model, inputTokens, outputTokens,
    // Defaults preserve the sweep's own call site unchanged: it never sets `source`/`requestId`
    // on the note it hands in, so this still lands as "sweep" with no request_id. A live
    // assistant turn (turn.ts) passes both explicitly.
    source: note.source ?? "sweep", noteId: note.noteId, requestId: note.requestId,
    contentChars: note.contentText.length,
  });

  // ---- tags ----
  const { data: linkedRows, error: linkedErr } = await db.from("note_tags").select("tag_id").eq("note_id", note.noteId);
  // A failed read here must not silently become an empty set: that would make a previously
  // REJECTED tag look unlinked and get re-suggested, exactly the failure Rule 3 exists to
  // prevent, just reached through a failed read instead of a missing filter.
  if (linkedErr) throw linkedErr;
  // Any status counts, including 'rejected'. That is what makes a rejection stick: reject sets
  // status rather than deleting the row precisely so this lookup can see it.
  const alreadyLinked = new Set((linkedRows ?? []).map((r) => r.tag_id as string));

  const proposed = (value.tags ?? []).filter((t) => typeof t.name === "string" && t.name.trim() !== "");
  const existingHits = proposed.filter((t) => byLowerName.has(t.name.trim().toLowerCase()));
  const novel = proposed
    .filter((t) => !byLowerName.has(t.name.trim().toLowerCase()))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 1); // at most one new tag per run

  // Names, not just a count: the caller has to be able to say WHICH tags were attached, and
  // reading them back out of note_tags afterwards would be a second round trip for data this
  // loop already holds. The count below is derived from it rather than tracked separately.
  const accepted: string[] = [];
  for (const candidate of [...existingHits, ...novel]) {
    const name = candidate.name.trim().toLowerCase();
    const known = byLowerName.get(name);
    let tagId = known?.id;
    // The tag's STORED name, tracked alongside the id rather than read back off `byLowerName`:
    // "pricing" resolves to a tag the user created as "Pricing", and that is the spelling the box
    // should show. Carried through BOTH resolution paths below, because the spelling a user sees
    // must not depend on whether their tag happened to fall inside TAG_VOCABULARY_LIMIT.
    let storedName = known?.name ?? name;
    if (!tagId) {
      // `byLowerName` is built from the CAPPED vocabulary, so "absent from it" means "not among
      // the tags we showed the model", NOT "does not exist". Inserting on that basis is wrong in
      // both directions: tags_user_name_uidx is unique on (user_id, lower(name)) where deleted_at
      // is null, so an exact or case-varied match RAISES rather than duplicating, and extract.ts
      // rethrows -- the note then fails, five times, and 00018's cap tombstones it. Capping the
      // vocabulary without this lookup would have turned that from a 1000-tag edge case into a
      // 200-tag routine one.
      //
      // ilike, not eq: the unique index is on lower(name), and tags created through other write
      // paths keep their original casing, so `eq` would miss "Pricing" for "pricing" and hit the
      // index anyway. ilike is a strict SUPERSET of the case-insensitive exact match for any
      // pattern (`%` matches zero characters, `_` matches the literal `_`), so the JS comparison
      // below is what actually decides -- the query only narrows. Bounded, for the same reason
      // the vocabulary read above is: an unbounded read here would be the third instance of the
      // max_rows bug rather than the second.
      const { data: matches, error: findErr } = await db.from("tags")
        .select("id, name").eq("user_id", note.userId).is("deleted_at", null)
        .ilike("name", name).limit(20);
      if (findErr) throw findErr;
      const hit = (matches ?? []).find((t) => (t.name as string).toLowerCase() === name);

      if (hit) {
        tagId = hit.id as string;
        // hit.name, not `name`: the row's real spelling is right here, and storing the lowercased
        // lookup key instead is what made one tag render two different ways.
        storedName = hit.name as string;
      } else {
        const { data: created, error } = await db.from("tags")
          .insert({ user_id: note.userId, name }).select("id").single();
        if (error) throw error;
        tagId = created!.id as string;
        storedName = name; // a tag this call created is stored lowercased, by construction
      }
      byLowerName.set(name, { id: tagId, name: storedName });
    }
    if (alreadyLinked.has(tagId)) continue;

    const { error } = await db.from("note_tags").insert({
      user_id: note.userId, note_id: note.noteId, tag_id: tagId,
      source: "ai", status: "suggested", confidence: candidate.confidence,
    });
    if (error) throw error;
    accepted.push(storedName);
  }

  // ---- domain + meta ----
  const { data: current, error: currentErr } = await db.from("notes").select("domain").eq("id", note.noteId).single();
  // A failed read here must not silently become `undefined`: `current?.domain` would then fall
  // through to the model's suggestion, overwriting a domain the user set by hand -- the exact
  // opposite of the invariant the comment below asserts.
  if (currentErr) throw currentErr;
  const parsedDomain = noteDomain.safeParse(value.domain);
  // A domain the user set by hand outranks a suggestion; and a value outside the enum must
  // never be written, or the CHECK constraint fails the whole update.
  const domain = current?.domain ?? (parsedDomain.success ? parsedDomain.data : null);

  let meta: Record<string, unknown> = {};
  if (domain) {
    const schema = domainMetaSchemas[domain as keyof typeof domainMetaSchemas];
    const parsedMeta = schema?.safeParse(value.domain_meta ?? {});
    // Dropped rather than written raw: domain_meta is jsonb and unconstrained at the database
    // level, so an invalid shape stored here surfaces much later as a validation failure the
    // user cannot explain.
    meta = parsedMeta?.success ? (parsedMeta.data as Record<string, unknown>) : {};
  }

  const { error: noteErr } = await db.from("notes")
    .update({ domain, domain_meta: meta, enriched_at: new Date().toISOString() })
    .eq("id", note.noteId)
    .is("deleted_at", null); // a note trashed mid-job must not be written back to life
  if (noteErr) throw noteErr;

  const { error: markErr } = await db.from("note_enrichment").upsert(
    { note_id: note.noteId, user_id: note.userId, extracted_hash: note.contentHash },
    { onConflict: "note_id" },
  );
  if (markErr) throw markErr;

  // The schema is a REQUEST, not a guarantee -- the same reason intent and complexity are
  // defaulted below. A mood outside 1..5 would be rejected by the checkins CHECK constraint
  // and fail an extraction that was otherwise fine, so it is dropped here instead.
  const rawMood = value.mood;
  const mood =
    typeof rawMood === "number" && Number.isInteger(rawMood) && rawMood >= 1 && rawMood <= 5
      ? rawMood
      : null;

  // intent and complexity are DEFAULTED rather than trusted. `required` in a responseSchema is a
  // request, not a guarantee, and an absent intent must not throw away an otherwise good
  // extraction: "statement" is the safe branch, because it never spends the reasoning model.
  return {
    tags: accepted.length,
    tagNames: accepted,
    domain,
    // The meta that was just written to the row. Returned rather than re-read: the box has to
    // be able to say WHAT it filed ("Inception (2010) · 8.5/10"), and turn.ts hardcoded `{}`
    // here, which made that impossible.
    domainMeta: meta,
    mood,
    intent: value.intent === "question" ? "question" : "statement",
    complexity: value.complexity === "complex" ? "complex" : "simple",
  };
}
