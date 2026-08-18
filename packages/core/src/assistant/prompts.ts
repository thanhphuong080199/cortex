import { formatNoteDate, formatToday } from "@cortex/shared";
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

/**
 * How a past note gets brought up. On BOTH prompts that read the user's own material, because
 * both produced the reported tone.
 *
 * The observed replies -- "Đã lưu ghi chú của bạn vào mục không phân loại... nó hoàn toàn
 * trùng khớp với ghi chú trước đó của bạn [1]" and "Trong các ghi chú của bạn [1, 3] có nhắc
 * đến việc bạn đang thắc mắc..." -- are not a template this file emits. Nothing here asked for
 * that shape; the prompts said "cite them like [1]" and nothing about phrasing, so the model
 * chose a match report. The fix is an instruction, not a template.
 *
 * The second half is load-bearing and is the half a later edit will drop: "do not sound
 * mechanical" on its own reads as "stop citing", and a model that stops emitting [1] takes
 * every link between a claim and the note behind it. The bracket is required in the same
 * sentence that forbids the framing.
 *
 * Vietnamese examples, matching LANGUAGE_RULE's reasoning: the phrasings being ruled out are
 * Vietnamese phrasings, and an English paraphrase of them is not the thing to avoid.
 */
const RECALL_RULE =
  "When one of their past notes is relevant, bring it up the way a person would recall " +
  "something you told them -- \"bạn có nhắc chuyện này rồi\", \"lần trước bạn có hỏi...\" -- " +
  "inline, in the middle of what you are saying. Do not report a database match: never " +
  "\"Trong các ghi chú của bạn [1, 3] có nhắc đến...\", never \"Đã lưu ghi chú của bạn vào " +
  "mục...\", and never state that a match was found or that something is identical to an " +
  "earlier note. Still carry the bracket, like [1], so they can trace it -- change how you " +
  "introduce the note, not whether you cite it.";

/**
 * How long a reply should be and what shape it takes. On buildAnswerPrompt ONLY.
 *
 * Observed: a casual "mỏi mắt ăn gì" came back as a multi-section writeup with bolded category
 * headers -- the same shape as a question that had explicitly asked to list things out. The
 * prompt carried no shape guidance at all, so that was the model's default, not a template.
 *
 * BOTH halves are load-bearing and the second is the one a later edit will drop. A bare "keep
 * it short, avoid lists" cap degrades the turn that genuinely asked to enumerate, so the
 * exception is written into the same constant as the default rather than left to judgment.
 * prompts.test.ts asserts each half separately for exactly that reason.
 *
 * It says nothing about markdown syntax. Both clients render markdown as of 2026-08-18, so
 * `**bold**` is no longer literal punctuation on screen -- and a rule phrased around syntax
 * would have to be rewritten the next time a client's rendering changes. The rule is about the
 * SHAPE of the answer, which is stable.
 *
 * Not on buildAcknowledgePrompt ("one or two sentences") or buildChitchatPrompt ("one short,
 * natural line"): both already cap themselves, and a second differently-worded length rule
 * gives the model two constraints to reconcile where it has one.
 */
const FORMAT_RULE =
  "Match the shape of the reply to the weight of the question. A short, casual question " +
  "gets a short, conversational answer -- two or three sentences of prose, no headings and " +
  "no list. Reach for headings or a numbered list only when the user actually asked to " +
  "enumerate or compare (\"liệt kê\", \"các bước\", \"so sánh\", \"list out\"), or when the " +
  "answer genuinely is a set of parallel items that prose would obscure. Structure is the " +
  "exception, not the default shape of an answer.";

/**
 * Stage C5 §9.3. Added to buildAcknowledgePrompt only when the classifier flagged the note as
 * carrying a factual claim it has real reason to doubt, and only on the reasoning model --
 * asking flash-lite to adjudicate truth is asking the weakest model in the system to do the
 * task with the most asymmetric failure mode.
 *
 * The first sentence is a CARVE-OUT of the acknowledge prompt's standing "do not answer a
 * question" rule, not a replacement for it. That rule stays on both paths: without it, an
 * acknowledgement becomes a conversation, and this branch would become a debate.
 *
 * The second half has no exception and is the more important of the two. The model looked only
 * at the claim it flagged, and the user cannot tell which claims those were -- so "đúng rồi" on
 * a sentence nothing examined is the system asserting a verification it never performed.
 * Silence has to mean "no basis to doubt", never "checked and confirmed". A system that
 * sometimes confirms is one whose silence starts reading as confirmation too.
 */
const VERIFY_RULE =
  "One exception to the rule above: if something they stated is factually wrong, say so once, " +
  "briefly, in the same breath as the acknowledgement. Name the discrepancy and stop -- do " +
  "not ask a follow-up, do not invite a reply, and do not explain at length. " +
  "Never do the opposite: do not say \"đúng rồi\", \"chính xác\", \"xác nhận\" or anything " +
  "else implying you checked their note and found it correct. You looked at one claim, and " +
  "they cannot tell which. Silence means you had no reason to doubt them, not that you " +
  "confirmed them.";

/**
 * The temporal anchor, on both prompts that read the user's own material.
 *
 * Two facts and one rule, and the rule is the part that fixes the observed defect: the date
 * beside a note makes "mai" RESOLVABLE, but the model still resolves it against today unless
 * it is told not to. The last sentence exists because "your appointment is tomorrow morning"
 * about an appointment four days gone is not a small error -- it is the assistant confidently
 * inventing a future.
 *
 * Vietnamese, matching LANGUAGE_RULE's reasoning: an English block inside an otherwise
 * Vietnamese prompt nudges the reply toward English.
 */
const temporalRule = (now: Date, timeZone: string) =>
  `Hôm nay là ${formatToday(now, timeZone)}.\n` +
  "Mỗi note và mỗi lượt hội thoại bên dưới có ngày trong ngoặc. Từ chỉ thời gian bên trong " +
  "chúng (\"mai\", \"hôm qua\", \"tuần tới\", \"thứ 3 tới\") tính từ NGÀY VIẾT của note hoặc " +
  "lượt đó, KHÔNG phải từ hôm nay. Nếu một mốc thời gian đã qua, nói rõ là đã qua — đừng nói " +
  "về nó như việc sắp xảy ra. Note không có ngày thì đừng đoán ngày cho nó. Riêng note hoặc " +
  "câu hỏi ở cuối cùng — cái người dùng vừa viết — là của HÔM NAY.";

// `timeZone` is optional here (not on the two answer/acknowledge builders) solely so
// buildChitchatPrompt -- which has no clock at all -- can keep calling this with one argument.
// Its own history renders with no dates, which is correct: small talk carries no temporal rule
// to anchor them against.
const renderHistory = (history: ThreadTurn[], timeZone?: string) =>
  history.length === 0
    ? ""
    : `\n\nEarlier in this conversation:\n${history
        .map((t) => {
          const on = timeZone ? formatNoteDate(t.createdAt, timeZone) : null;
          // The date has been on every ThreadTurn since C1 and was dropped here. "Mai" said
          // three turns ago is anchored to the turn, not to now, exactly like a note's is.
          return `${on ? `(${on}) ` : ""}${t.role === "user" ? "User" : "You"}: ${t.content}`;
        })
        .join("\n")}`;

// `"failed"` is a distinct third state from an empty array, and the distinction is the whole
// point: an empty array means retrieval RAN and genuinely found nothing, while `"failed"` means
// retrieval never ran to completion (the search RPC or the embed call threw). Collapsing the two
// into "no citations" makes the model assert "the user has no notes matching this" on a turn
// where the server never actually got to look -- a false claim, not a hedge.
const renderCitations = (citations: Citation[] | "failed", timeZone: string) =>
  citations === "failed"
    ? "\n\nThe user's notes could not be searched right now (a technical failure, not an empty " +
      "corpus). Say so plainly. Do not claim they have no notes on this."
    : citations.length === 0
      ? "\n\nThe user has no notes matching this."
      : `\n\nThe user's own notes:\n${citations
          .map((c, i) => {
            // Spread-if in string form: a citation with no date renders with no parenthesis at
            // all, never "()" or "(null)". Everything in this prompt is read as fact.
            const on = c.createdAt ? formatNoteDate(c.createdAt, timeZone) : null;
            return `[${i + 1}] ${on ? `(${on}) ` : ""}${c.title ? `${c.title}: ` : ""}${c.snippet}`;
          })
          .join("\n")}`;

/**
 * Stage C3 is life-domains spec §6: Gemini `google_search` grounding, with dual "from your
 * notes / from the web" citations. The model may fill a gap in the user's notes from the web or
 * from its own general knowledge -- either way it must say plainly that the material is not
 * from their notes, never blend it into "their own notes" the way a citation does. Web sources
 * are additionally carried as `WebCitation`s (turn.ts) so the UI can show the notes/web split.
 */
export function buildAnswerPrompt(a: {
  question: string;
  citations: Citation[] | "failed";
  history: ThreadTurn[];
  timeZone: string;
  now: Date;
}): string {
  return [
    "You are the user's second brain and conversational assistant. Answer their question using " +
      "their own notes first.",
    LANGUAGE_RULE,
    FORMAT_RULE,
    temporalRule(a.now, a.timeZone),
    "Cite the notes you used by their bracketed number, like [1].",
    RECALL_RULE,
    "If their notes do not fully answer the question, you may fill the gap -- from the web, or " +
      "from your own general knowledge -- but say plainly that it is not from their notes " +
      "(e.g. \"Trong note của bạn không có, nhưng theo mình biết...\").",
    // Life-domains spec §6.1. Grounding replaced the narrower rule this line used to carry: the
    // gap-filler is no longer only the model's own memory, so the disclosure rule has to name
    // the web explicitly rather than "outside knowledge" in general.
    "You may search the web when their notes cannot answer the question, or when the question " +
      "is time-sensitive. Answer from their notes first.",
    "Never present web content as the user's own thinking. Say where something came from.",
    renderCitations(a.citations, a.timeZone),
    renderHistory(a.history, a.timeZone),
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
  related: Citation[] | "failed";
  history: ThreadTurn[];
  timeZone: string;
  now: Date;
  /**
   * Required rather than optional, deliberately. An optional flag defaulting to false lets a
   * call site forget it, and the symptom -- verification silently never happening -- looks
   * exactly like a classifier that stopped setting the flag.
   */
  verify: boolean;
}): string {
  return [
    "The user just saved a note. Acknowledge it in one or two sentences.",
    LANGUAGE_RULE,
    temporalRule(a.now, a.timeZone),
    // Named in words, never interpolated raw: `${a.domain}` on a null renders the string "null"
    // into the prompt, and an empty tag list renders a dangling "You tagged it: ." -- both are
    // things the model then has to interpret.
    `You filed it under: ${a.domain ?? "no domain"}. You tagged it: ${
      a.tags.length > 0 ? a.tags.join(", ") : "nothing"
    }.`,
    // The filing confirmation STAYS. The complaint was about phrasing, not about the
    // acknowledgement telling the user what was attached -- that is the content this branch
    // exists to deliver (parent spec §6, obligation 3).
    "Mention what you attached, briefly. If any of their earlier notes below are genuinely " +
      "related, say so and cite them like [1].",
    RECALL_RULE,
    "The user did not ask a question. Do not answer one, and do not invent one to answer.",
    // Spread-in rather than an empty string: an ordinary acknowledgement must carry no
    // instruction about verification at all, not a blank line where one used to be.
    ...(a.verify ? [VERIFY_RULE] : []),
    renderCitations(a.related, a.timeZone),
    renderHistory(a.history, a.timeZone),
    `\n\nTheir note: ${a.note}`,
  ].join("\n");
}

/**
 * The third branch, stage C4 §4. "hello", "haha ok", "1111" -- a turn with no question in it
 * and nothing to file.
 *
 * Deliberately shorter than the other two and deliberately missing their framing. The
 * acknowledge prompt announces a filing ("You filed it under ...") and the answer prompt asks
 * for citations; applied to small talk, the first announces bookkeeping nobody asked about and
 * the second searches the user's corpus for an answer to "what?". The note is still saved --
 * that happens in assistant-box.tsx before this prompt exists -- so nothing here needs to
 * mention it.
 *
 * History is included: "haha ok" means nothing without the turn before it.
 */
export function buildChitchatPrompt(a: { text: string; history: ThreadTurn[] }): string {
  return [
    "The user said something conversational -- a greeting, a reaction, or noise. Reply in one " +
      "short, natural line. Do not ask a follow-up question and do not start a topic.",
    LANGUAGE_RULE,
    renderHistory(a.history),
    `\n\nThey said: ${a.text}`,
  ].join("\n");
}
