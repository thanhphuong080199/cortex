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

// Deliberately blunt, and two rules rather than one because scripts do not agree on how a
// sentence ends.
//
// Rule 1 -- space-separated scripts. Split after a ".", "!" or "?" that is followed by
// whitespace and then what looks like the start of a new sentence. "Looks like" is
// `\p{Lu}` (an uppercase letter in ANY script, not `A-Z`), `\p{Lo}` (a caseless letter --
// Han, kana, Hangul, Thai; how a CJK sentence looks when its author did use ASCII
// punctuation), a digit, or an opening quote/paren. `A-Z` was a claim that sentences begin
// with an ASCII capital, and Vietnamese quietly falsified it: Đ, Ă, Ô, Ư and every toned
// vowel are outside that range, so a Vietnamese note held no boundaries at all and fell
// through to the fixed-offset hard split -- which never resynchronises, so every edit
// re-embedded the whole note. `\p{Lu}` is a strict superset of `A-Z`, so ASCII notes chunk
// byte-identically to before and nothing already embedded needs re-embedding.
//
// Rule 2 -- CJK. The enders are the full-width 。！？, and nothing separates one sentence from
// the next, so rule 1's required `\s+` can never fire however far its lookahead is widened.
// This arm matches zero-width when there is no space. Chunks are still joined with " ", so a
// CJK chunk gains separators its source lacked; accepted, because chunk text is only ever fed
// to the embedding model and never rendered back to the user.
//
// What both get right: decimals and URLs, because neither arm matches ASCII punctuation
// without whitespace after it -- "3.14" and "example.com/a.b" never split. What rule 1 gets
// wrong: an abbreviation followed by a capitalized word ("Mr. Smith", "U.S. Government",
// "e.g. The point is") reads as two sentences, and a quoted sentence-ender ('"Stop!" Then')
// doesn't split at all because the quote sits between the punctuation and the whitespace. Both
// are accepted: an extra boundary only adds a harmless split point, not wrong data, and perfect
// segmentation is not the goal here -- see chunkText's own comment for why.
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[\p{Lu}\p{Lo}\p{Nd}"'(])|(?<=[。！？])\s*(?=\S)/u;

function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
  return out;
}

/**
 * Greedily packs `units` (already <= maxChars individually is NOT assumed -- an oversized unit
 * is handed to `onOversized`) into as few `joiner`-separated groups as fit under maxChars.
 *
 * The reason this resynchronises after an edit, and a fixed-offset hard split never does: each
 * group's packing decision depends only on the lengths of the units from that group's start
 * onward, never on any total accumulated so far (`current` resets to "" on every flush). So the
 * instant a flush point lines up on the same unit in an edited version as in the original --
 * which happens quickly whenever unit lengths vary, the ordinary case for real sentences -- every
 * group from there on is packed identically and its content (and therefore its md5) matches the
 * pre-edit run byte for byte. A raw character offset carries no such reset: it is a function of
 * everything before it, so one inserted character shifts every later chunk's window forever.
 */
function packUnits(
  units: string[],
  maxChars: number,
  joiner: string,
  onOversized: (unit: string) => string[],
): string[] {
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current !== "") out.push(current);
    current = "";
  };

  for (const unit of units) {
    if (unit.length > maxChars) {
      flush();
      out.push(...onOversized(unit));
      continue;
    }
    const candidate = current === "" ? unit : `${current}${joiner}${unit}`;
    if (candidate.length > maxChars) {
      flush();
      current = unit;
    } else {
      current = candidate;
    }
  }
  flush();

  return out;
}

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

  // A paragraph that doesn't fit whole is packed sentence-by-sentence rather than sliced at a
  // fixed character offset. This matters because notes.content_text (strip_markdown's output)
  // collapses every run of whitespace -- blank lines included -- to a single space, so a real
  // note is one giant "paragraph" from this function's point of view; blank-line splitting alone
  // would never fire and every edit would fall back to the old offset-based hard split, which
  // never resynchronises (see packUnits above). A "sentence" that is itself over budget --
  // a wall of text with no `. ! ?` in it -- still falls back to the same fixed-offset hard split
  // this function always had, because there is no smaller natural boundary left to lean on.
  const out = packUnits(paragraphs, maxChars, "\n\n", (para) =>
    packUnits(
      para.split(SENTENCE_BOUNDARY).map((s) => s.trim()).filter((s) => s !== ""),
      maxChars,
      " ",
      (sentence) => hardSplit(sentence, maxChars),
    ),
  );

  return out.map((content, index) => ({ index, content }));
}
