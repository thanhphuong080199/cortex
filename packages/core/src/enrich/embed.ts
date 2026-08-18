import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkText, EMBEDDING_MODEL } from "@cortex/shared";
import { createHash } from "node:crypto";
import type { AiClient } from "../ai/client.js";
import type { ThreadTurn } from "../assistant/context.js";
import { recordUsage, type UsageSource } from "./budget.js";

export interface EnrichTarget {
  noteId: string;
  userId: string;
  contentText: string;
  contentHash: string;
  // Who is asking, and (when known) which turn -- both optional, and both default to today's
  // sweep behaviour (embedNote never reads them at all; extractNote defaults source to "sweep"
  // and omits requestId when unset). A live assistant turn passes "assistant" plus its own
  // requestId here so extractNote's ledger row can be attributed and joined back to that turn
  // instead of being filed under the 60-second sweep with no request_id (see 00027).
  source?: UsageSource;
  requestId?: string;
  /**
   * The conversation so far, for classification only. Optional and absent in the sweep, which
   * is the point: a note being re-extracted an hour later by the 60-second sweep has no
   * conversation around it, and inventing one would classify it against turns it was never
   * part of. `embedNote` never reads this, the same way it never reads `source`.
   *
   * Truncated by buildPrompt to CLASSIFIER_HISTORY_TURNS, so a caller may hand over as much
   * as it has without knowing the ceiling.
   */
  history?: ThreadTurn[];
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
    // gemini.ts's extractVectors already refuses a short response, and this repeats the check
    // because the two guards protect different things. That one protects the Gemini client; this
    // one protects the WRITE, and embedNote takes an AiClient -- an interface, satisfied today by
    // a fake, tomorrow by a cache layer or a second provider.
    //
    // What a short array does here is uniquely bad and completely silent. `embedding: vectors[i]`
    // is `undefined` on every row, UNIFORMLY, so JSON.stringify drops the key from all of them,
    // PostgREST accepts the batch (the keys match), recordUsage bills the call, embedded_hash is
    // stamped below, and the sweep logs a success. The chunks are then invisible to search_notes,
    // which filters on `c.embedding is not null` (00022:40), and the hash predicate guarantees
    // the note is never claimed again -- so they stay invisible permanently.
    //
    // The type checker cannot catch it: `SupabaseClient` is ungeneric, so `.upsert(rows)` takes
    // `any` and noUncheckedIndexedAccess has no typed destination to complain about. This is a
    // runtime check because there is nowhere else to put one.
    if (vectors.length !== stale.length) {
      throw new Error(`enrich: embed returned ${vectors.length} vectors for ${stale.length} chunks`);
    }
    const now = new Date().toISOString();
    const rows = stale.map((c, i) => {
      const embedding = vectors[i];
      if (!Array.isArray(embedding) || embedding.length === 0) {
        // A correct-length array with a hole in it lands on the same NULL embedding as a short
        // one, so the length check above is not on its own sufficient.
        throw new Error(`enrich: embed returned no vector for chunk ${c.index}`);
      }
      return {
        user_id: note.userId,
        note_id: note.noteId,
        chunk_index: c.index,
        content: c.content,
        content_hash: md5(c.content),
        token_count: Math.ceil(c.content.length / 4),
        embedding,
        embedding_model: EMBEDDING_MODEL,
        embedded_at: now,
      };
    });
    const { error } = await db.from("note_chunks").upsert(rows, { onConflict: "note_id,chunk_index" });
    if (error) throw error;
    await recordUsage(db, {
      userId: note.userId, kind: "embed", model, inputTokens, outputTokens: 0,
      source: "sweep", noteId: note.noteId,
      contentChars: stale.reduce((n, c) => n + c.content.length, 0),
    });
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
