/**
 * Splits a note's content_text for embedding.
 *
 * Deliberately paragraph-based and character-budgeted rather than token-based: a tokenizer
 * would be a dependency in a package that has none, and the budget only needs to keep a chunk
 * comfortably inside the embedding model's input limit. Determinism matters more than
 * precision here, because note_chunks.content_hash is what lets the pipeline skip re-embedding
 * an unchanged chunk.
 */
export const CHUNK_MAX_CHARS = 1800;

export function chunkText(
  text: string,
  opts: { maxChars?: number } = {},
): { index: number; content: string }[] {
  const maxChars = opts.maxChars ?? CHUNK_MAX_CHARS;
  // A CRLF checkout would otherwise produce different chunks -- and different hashes -- for
  // the same note. This repo warns "LF will be replaced by CRLF" on every commit, and
  // phase 1b's sync-rules assertions were red on Windows for exactly this reason.
  const normalised = text.replace(/\r\n/g, "\n").trim();
  if (normalised === "") return [];

  const paragraphs = normalised.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== "");
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current !== "") out.push(current);
    current = "";
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // Cannot be packed whole. Emit what is buffered, then hard-split this one.
      flush();
      for (let i = 0; i < para.length; i += maxChars) out.push(para.slice(i, i + maxChars));
      continue;
    }
    const candidate = current === "" ? para : `${current}\n\n${para}`;
    if (candidate.length > maxChars) {
      flush();
      current = para;
    } else {
      current = candidate;
    }
  }
  flush();

  return out.map((content, index) => ({ index, content }));
}
