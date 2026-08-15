import type { ThreadTurn } from "./context.js";
import type { Citation } from "./retrieve.js";

/**
 * Both clauses matter here, and the second one is the one written for this corpus: Cortex's
 * users write in Vietnamese, and a model that answers in Vietnamese but renders their own tag
 * "thể dục" as "exercise" has rewritten their notes back at them.
 */
const LANGUAGE_RULE =
  "Reply in the same language the user wrote in. Do not translate their words, their tags, " +
  "or their notes into another language.";

const renderHistory = (history: ThreadTurn[]) =>
  history.length === 0
    ? ""
    : `\n\nEarlier in this conversation:\n${history
        .map((t) => `${t.role === "user" ? "User" : "You"}: ${t.content}`)
        .join("\n")}`;

const renderCitations = (citations: Citation[]) =>
  citations.length === 0
    ? "\n\nThe user has no notes matching this."
    : `\n\nThe user's own notes:\n${citations
        .map((c, i) => `[${i + 1}] ${c.title ? `${c.title}: ` : ""}${c.snippet}`)
        .join("\n")}`;

/**
 * Answering never invents (life-domains spec §6.1): answer from the user's notes first, say so
 * when the notes cannot answer, and never present outside content as the user's own thinking.
 */
export function buildAnswerPrompt(a: {
  question: string;
  citations: Citation[];
  history: ThreadTurn[];
}): string {
  return [
    "You are the user's second brain. Answer their question using their own notes.",
    LANGUAGE_RULE,
    "Cite the notes you used by their bracketed number, like [1].",
    "If their notes do not answer the question, say so plainly and briefly. Do not fill the " +
      "gap with general knowledge presented as if it came from them.",
    renderCitations(a.citations),
    renderHistory(a.history),
    `\n\nTheir question: ${a.question}`,
  ].join("\n");
}

/**
 * The statement branch. It exists because an acknowledgement built from a template reads like
 * a UI rather than something talking back -- and that acknowledgement is what makes this feel
 * like an assistant rather than an inbox (parent spec §6, obligation 3).
 */
export function buildAcknowledgePrompt(a: {
  note: string;
  domain: string | null;
  tags: string[];
  related: Citation[];
  history: ThreadTurn[];
}): string {
  return [
    "The user just saved a note. Acknowledge it in one or two sentences.",
    LANGUAGE_RULE,
    // Named in words, never interpolated raw: `${a.domain}` on a null renders the string "null"
    // into the prompt, and an empty tag list renders a dangling "You tagged it: ." -- both are
    // things the model then has to interpret.
    `You filed it under: ${a.domain ?? "no domain"}. You tagged it: ${
      a.tags.length > 0 ? a.tags.join(", ") : "nothing"
    }.`,
    "Mention what you attached, briefly. If any of their earlier notes below are genuinely " +
      "related, say so and cite them like [1].",
    "The user did not ask a question. Do not answer one, and do not invent one to answer.",
    renderCitations(a.related),
    renderHistory(a.history),
    `\n\nTheir note: ${a.note}`,
  ].join("\n");
}
