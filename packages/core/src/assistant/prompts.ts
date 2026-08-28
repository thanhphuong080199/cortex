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
 * The second half USED to require the bracket, on the reasoning that dropping it takes every
 * link between a claim and the note behind it. That reasoning described an intent the product
 * never realised: nothing ever read `[2]` back out -- Provenance renders web sources only, mobile
 * has no note-citation UI, and the citations sent to either client come from retrieval directly,
 * never from numbers parsed out of the reply. So a WRONG `[2]` was invisible to everyone,
 * including the user. Reported as unreadable on 2026-08-22 ("[1, 2] nhìn không biết gì hết").
 *
 * A date is the replacement, and it is a strictly better link for this product: the user can
 * check it with no UI at all, and a wrong one is visible immediately. It also preserves what the
 * bracket was actually doing -- forcing the model to point at a specific retrieved row instead of
 * producing a vague "bạn từng nói...".
 *
 * Vietnamese examples, matching LANGUAGE_RULE's reasoning: the phrasings being ruled out are
 * Vietnamese phrasings, and an English paraphrase of them is not the thing to avoid.
 */
const RECALL_RULE =
  "When one of their past notes is relevant, bring it up the way a person would recall " +
  "something you told them -- \"bạn có nhắc chuyện này rồi\", \"lần trước bạn có hỏi...\" -- " +
  "inline, in the middle of what you are saying. Do not report a database match: never " +
  "\"Trong các ghi chú của bạn có nhắc đến...\", never \"Đã lưu ghi chú của bạn vào " +
  "mục...\", and never state that a match was found or that something is identical to an " +
  "earlier note. Anchor the recall so they can place it: say WHEN they wrote it (\"hôm 18/8 " +
  "bạn có nhắc...\"), or name the note's title if it has one. Never use a bracketed number. " +
  "If a note below shows no date and no title, do not invent an anchor for it -- recall it " +
  "with no anchor at all." +
  " Some notes below are marked as your own earlier answers that they chose to keep. Never " +
  "recall one of those as something they thought or wrote -- say it came from an answer you " +
  "gave them before.";

// FORMAT_RULE lived here -- "match reply shape/depth to the question's weight", exclusive to
// buildAnswerPrompt. Removed 2026-08-28 with that prompt's whole rule stack (see
// buildAnswerPrompt's doc comment); recoverable from git history.

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
 * Stage S2 §4. Rendered only when `detectEntityGap` found a gap whose answer would create an
 * entity -- never on a merely incomplete note.
 *
 * Three constraints, all load-bearing. ONE question, because an assistant that asks two has
 * started an interview. At the END, because a question in the middle of an acknowledgement
 * interrupts the filing confirmation it was supposed to deliver. And no promise to follow up,
 * because the code guarantees it will never be raised again -- a reply ending "nhớ nói cho mình
 * biết nhé" would be writing a cheque turn.ts refuses to honour.
 *
 * MUTUALLY EXCLUSIVE with VERIFY_RULE above, which forbids follow-ups outright. The guard is in
 * buildAcknowledgePrompt below; turn.ts also refuses to compute a gap on a verifying turn, so the
 * two agree by saying the same thing rather than by one trusting the other.
 */
/**
 * Reported 2026-08-24: an ordinary statement got back a flat "filed under X" and nothing else --
 * an inbox, not a conversation partner. This is the GENERAL case and stays out of the way of the
 * two more specific rules above: VERIFY_RULE already forbids a follow-up outright when correcting
 * a claim, and followUpRule already asks its own one entity-gap question. Rendering this
 * alongside either would give the model two or three follow-up instructions to reconcile in one
 * acknowledgement, so buildAcknowledgePrompt below renders it only when neither applies.
 */
const ENGAGE_RULE =
  "After that, add ONE brief, natural line that responds to what they actually wrote -- ask " +
  "something specific about it, react to it, or suggest something small and concrete that fits " +
  "it. Tie it to their note, never a generic \"cố lên nhé\". One line, then stop -- do not turn " +
  "it into an interview.";

const followUpRule = (wants: string) =>
  `One thing is missing from what they just told you: ${wants}. Ask for it -- ONE short, ` +
  "natural question at the very end, the way a friend would ask. Do not ask about anything " +
  "else, do not ask two things, and do not explain why you are asking. If they do not answer " +
  "it, it will never be raised again -- so do not promise to follow up and do not tell them to " +
  "let you know later.";

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

// locationRule lived here -- infer the user's region from their time zone/language so a
// web-grounded answer stops defaulting to US context. Exclusive to buildAnswerPrompt. Removed
// 2026-08-28 with that prompt's whole rule stack (see buildAnswerPrompt's doc comment);
// recoverable from git history.

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
//
// The gap-filling disclaimer lives HERE, in the populated branch, and not in buildAnswerPrompt's
// standing rule list. As a standing instruction it fired on every turn, including the majority
// where retrieval returned nothing -- and with no citations there is nothing for outside material
// to be confused with, so the user heard "Trong note của bạn không có, nhưng theo mình biết..."
// on turn after turn for no information (reported 2026-08-22). The empty branch now says the
// opposite: answer, and do not narrate the absence.
const renderCitations = (citations: Citation[] | "failed", timeZone: string) =>
  citations === "failed"
    ? "\n\nThe user's notes could not be searched right now (a technical failure, not an empty " +
      "corpus). Say so plainly. Do not claim they have no notes on this."
    : citations.length === 0
      ? "\n\nThey have no notes on this. Just answer -- from the web or from your own general " +
        "knowledge -- and do not announce that their notes had nothing. There is nothing of " +
        "theirs to attribute here, so there is nothing to distinguish your answer from."
      : `\n\nThe user's own notes:\n${citations
          .map((c) => {
            // Spread-if in string form: a citation with no date renders with no parenthesis at
            // all, never "()" or "(null)". Everything in this prompt is read as fact.
            const on = c.createdAt ? formatNoteDate(c.createdAt, timeZone) : null;
            // The label is a SUFFIX, after the snippet, so it reads as provenance rather than as
            // part of the note's content. "mình"/"họ" rather than "I"/"they": the surrounding
            // Vietnamese examples in RECALL_RULE set the register, and an English parenthetical
            // inside an otherwise Vietnamese recall nudges the reply toward English
            // (LANGUAGE_RULE's reasoning).
            const mine = c.authoredBy === "assistant" ? " (câu trả lời của mình mà họ đã lưu)" : "";
            // A bullet, not "[n]". Numbering the input while forbidding brackets in the output
            // is a prompt arguing with itself, and the model will occasionally echo the very
            // thing just banned.
            return `- ${on ? `(${on}) ` : ""}${c.title ? `${c.title}: ` : ""}${c.snippet}${mine}`;
          })
          .join("\n")}\n\nIf these do not fully answer the question, you may fill the gap -- from ` +
        "the web, or from your own general knowledge -- but say plainly which part is not from " +
        "their notes.";

/**
 * TEMPORARY (2026-08-28): stripped down to raw history + question, no rules and no citations,
 * while the reported "user gets no answer at all" bug is chased. The suspicion driving this is
 * that the full instruction stack below (language/format/temporal/location/recall + a rendered
 * notes block) is itself implicated -- unconfirmed; the closest prior incident of this shape
 * (docs/superpowers/specs/2026-08-23-post-merge-bugfix-design.md §7, "Hello hello" got no
 * reply) turned out to be an aborted response stream, nothing to do with prompt content. If
 * that turns out to be true again here, this change will not have fixed it.
 *
 * `citations` and `timeZone` stay in the signature (turn.ts passes them unconditionally, same
 * call site as before) but are UNUSED below -- deliberately not renamed to `_citations` etc.,
 * because the point of keeping the signature stable is that reverting is a one-function diff.
 * `google_search` grounding is still requested by turn.ts's `grounds` flag regardless of what
 * this prompt says, so the model may still ground -- it is just never told it may in words.
 *
 * The full version -- LANGUAGE_RULE, temporalRule, RECALL_RULE, renderCitations, the "may
 * search the web" / "never present web content as the user's own" lines, all with their own
 * regression tests and reported-bug provenance in the comments above -- is one `git log` away,
 * not deleted from history, just from this function. `FORMAT_RULE` and `locationRule` were
 * exclusive to this prompt (see their own doc comments) and are removed below rather than left
 * as dead consts an unused-vars lint rule would flag; they come back from history the same way.
 * See prompts.test.ts for which of the now-inapplicable tests are `it.skip`'d for the same reason.
 */
export function buildAnswerPrompt(a: {
  question: string;
  citations: Citation[] | "failed";
  history: ThreadTurn[];
  timeZone: string;
  now: Date;
}): string {
  return [renderHistory(a.history), `\n\nTheir question: ${a.question}`].join("\n");
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
  /**
   * What to ask for, from `detectEntityGap().wants`. Absent means there is nothing worth asking,
   * which is the ordinary case for almost every note.
   */
  askAbout?: string;
}): string {
  return [
    "The user just saved a note. Acknowledge it briefly -- this is an acknowledgement, not an " +
      "answer, so keep it to what is worth saying and no more.",
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
      "related, say so and say when they wrote it.",
    RECALL_RULE,
    "The user did not ask a question. Do not answer one, and do not invent one to answer.",
    // Spread-in rather than an empty string: an ordinary acknowledgement must carry no
    // instruction about verification at all, not a blank line where one used to be.
    ...(a.verify ? [VERIFY_RULE] : []),
    // `!a.verify` is the exclusion, not an oversight: see followUpRule's header. A turn that is
    // correcting a false factual claim never also asks a question.
    ...(a.askAbout !== undefined && !a.verify ? [followUpRule(a.askAbout)] : []),
    // The general case, rendered only when neither of the two more specific rules above already
    // claimed this turn's one follow-up line. See ENGAGE_RULE's header for why they exclude it.
    ...(!a.verify && a.askAbout === undefined ? [ENGAGE_RULE] : []),
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
    "The user said something conversational -- a greeting, a reaction, or noise. Reply " +
      "naturally and keep it light; this is small talk, not a topic. Do not ask a follow-up " +
      "question and do not start a topic.",
    LANGUAGE_RULE,
    renderHistory(a.history),
    `\n\nThey said: ${a.text}`,
  ].join("\n");
}
