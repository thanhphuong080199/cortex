import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkText, EMBEDDING_MODEL } from "@cortex/shared";
import { createHash } from "node:crypto";
import type { AiClient } from "../ai/client.js";
import { recordUsage } from "./budget.js";

export interface EnrichTarget {
  noteId: string;
  userId: string;
  contentText: string;
  contentHash: string;
}

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

/**
 * Chunks, embeds only what changed, and stamps note_enrichment.embedded_hash.
 *
 * Editing one paragraph of a long note must not re-embed the others; note_chunks.content_hash
 * is what makes that possible, and it is why the chunker is deterministic. Rows are matched by
 * chunk_index (note_chunks has unique(note_id, chunk_index)), so a chunk that merely moved
 * position is re-embedded -- accepted, because tracking moves would need a content-addressed
 * key and the saving is small for the note sizes this system sees.
 */
export async function embedNote(
  deps: { db: SupabaseClient; ai: AiClient },
  note: EnrichTarget,
): Promise<{ embedded: number; reused: number }> {
  const { db, ai } = deps;
  const chunks = chunkText(note.contentText);

  const { data: existingRows, error: readErr } = await db
    .from("note_chunks")
    .select("chunk_index, content_hash")
    .eq("note_id", note.noteId);
  if (readErr) throw readErr;
  const existing = new Map((existingRows ?? []).map((r) => [r.chunk_index as number, r.content_hash as string]));

  const stale = chunks.filter((c) => existing.get(c.index) !== md5(c.content));
  const reused = chunks.length - stale.length;

  if (stale.length > 0) {
    const { vectors, inputTokens, model } = await ai.embed(stale.map((c) => c.content));
    const now = new Date().toISOString();
    const rows = stale.map((c, i) => ({
      user_id: note.userId,
      note_id: note.noteId,
      chunk_index: c.index,
      content: c.content,
      content_hash: md5(c.content),
      token_count: Math.ceil(c.content.length / 4),
      embedding: vectors[i],
      embedding_model: EMBEDDING_MODEL,
      embedded_at: now,
    }));
    const { error } = await db.from("note_chunks").upsert(rows, { onConflict: "note_id,chunk_index" });
    if (error) throw error;
    await recordUsage(db, { userId: note.userId, kind: "embed", model, inputTokens, outputTokens: 0 });
  }

  // A shortened note leaves orphans behind, and an orphan chunk keeps matching searches by
  // text the note no longer contains -- the same failure the phase 1b FTS trigger had to fix.
  const { error: pruneErr } = await db
    .from("note_chunks")
    .delete()
    .eq("note_id", note.noteId)
    .gte("chunk_index", chunks.length);
  if (pruneErr) throw pruneErr;

  const { error: markErr } = await db
    .from("note_enrichment")
    .upsert(
      { note_id: note.noteId, user_id: note.userId, embedded_hash: note.contentHash },
      { onConflict: "note_id" },
    );
  if (markErr) throw markErr;

  return { embedded: stale.length, reused };
}
