import type { SupabaseClient } from "@supabase/supabase-js";
import { domainMetaSchemas, noteDomain } from "@cortex/shared";
import type { AiClient } from "../ai/client.js";
import type { EnrichTarget } from "./embed.js";
import { recordUsage } from "./budget.js";

interface Extraction {
  domain: string | null;
  domain_meta: Record<string, unknown>;
  tags: { name: string; confidence: number }[];
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
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
  },
  required: ["domain", "domain_meta", "tags"],
};

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
): Promise<{ tags: number; domain: string | null }> {
  const { db, ai } = deps;

  const { data: tagRows, error: tagErr } = await db.from("tags").select("id, name").eq("user_id", note.userId);
  if (tagErr) throw tagErr;
  const vocabulary = (tagRows ?? []) as { id: string; name: string }[];
  // Case-insensitive, because "Pricing" and "pricing" must be one tag. This is the
  // findOrCreate precedent phase 1b set for media items.
  const byLowerName = new Map(vocabulary.map((t) => [t.name.toLowerCase(), t]));

  const { value, inputTokens, outputTokens, model } = await ai.generateJson<Extraction>({
    prompt: buildPrompt(note.contentText, vocabulary.map((t) => t.name)),
    schema: RESPONSE_SCHEMA,
  });
  // "extract", not the more specific "tag": budget.ts's usage kind is the two-step pipeline
  // stage ("embed" | "extract"), not a per-artifact label -- this step also writes domain and
  // domain_meta from the same model call, not only tags.
  await recordUsage(db, { userId: note.userId, kind: "extract", model, inputTokens, outputTokens });

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

  let attached = 0;
  for (const candidate of [...existingHits, ...novel]) {
    const name = candidate.name.trim().toLowerCase();
    let tagId = byLowerName.get(name)?.id;
    if (!tagId) {
      const { data: created, error } = await db.from("tags")
        .insert({ user_id: note.userId, name }).select("id").single();
      if (error) throw error;
      tagId = created!.id as string;
      byLowerName.set(name, { id: tagId, name });
    }
    if (alreadyLinked.has(tagId)) continue;

    const { error } = await db.from("note_tags").insert({
      user_id: note.userId, note_id: note.noteId, tag_id: tagId,
      source: "ai", status: "suggested", confidence: candidate.confidence,
    });
    if (error) throw error;
    attached += 1;
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

  return { tags: attached, domain };
}
