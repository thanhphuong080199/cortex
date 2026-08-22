import { dayKey, daySeparatorLabel } from "@cortex/shared";

/**
 * A chat_messages row exactly as PowerSync's local view returns it.
 *
 * `citations` and `retrieval_meta` are jsonb in Postgres and arrive here as JSON STRINGS --
 * the same treatment `notes.domain_meta` already gets. Parsing them is this module's job, and
 * doing it here rather than in the screen is what lets the failure modes be tested.
 */
export interface ChatRow {
  id: string; session_id: string; role: string; content: string;
  citations: string | null; retrieval_meta: string | null; created_at: string;
}

/**
 * The turn currently streaming. It exists in no table: the server writes both of its rows, and
 * only after the fact -- so while the answer is arriving the screen has to render a pair that
 * nothing has persisted. `noteId` names the `notes` row the device captured for this turn -- it
 * is NOT the id the replicated `chat_messages` row will carry (that id is a fresh
 * `gen_random_uuid()` the server assigns on insert; see `turn.ts` and migration 00006). `noteId`
 * is therefore only good for React keys and for telling turns apart from each other, never for
 * matching against a replicated row -- see the dedup note below.
 *
 * `settled` (final whole-branch review finding): true once `AssistantBox`'s `finally` has run --
 * no more tokens are coming, for better or worse (success, offline, or error). It is NOT a
 * signal to stop rendering the overlay; `chat.tsx` uses it only to know when it may START looking
 * for replication evidence (`liveHasReplicated`) before retiring `live` to `null`. Retiring on
 * `settled` alone, without that evidence, is the bug this field exists to prevent: the assistant's
 * row routinely replicates AFTER the SSE stream reports done, so clearing the overlay the instant
 * it settles makes a fully-written answer blink off screen and reappear a moment later.
 */
export interface LiveTurn {
  noteId: string; text: string; answer: string; createdAt: string; settled?: boolean;
}

export type Item =
  | { kind: "separator"; id: string; label: string }
  | { kind: "message"; id: string; role: "user" | "assistant"; content: string; incomplete: boolean };

/** Malformed or absent both mean "not interrupted". A parse error must not cost the transcript. */
function isIncomplete(meta: string | null): boolean {
  if (!meta) return false;
  try {
    return (JSON.parse(meta) as { incomplete?: unknown }).incomplete === true;
  } catch {
    return false;
  }
}

// How long after the live turn started a replicated row still counts as "that turn". Generous
// on purpose: the server writes the user's row early (right after session/history resolution,
// well before retrieval or generation), so it routinely lands before the SSE stream even
// finishes -- a tight window would miss the common case, not just the rare one.
const LIVE_MATCH_WINDOW_MS = 60_000;

/**
 * Whether `row` is the replicated copy of the live turn's OWN user message.
 *
 * There is no id to compare: `chat_messages.id` is a server-generated `gen_random_uuid()`
 * (migration 00006_synthesis_chat.sql), unrelated to `live.noteId`, which is the id of the
 * device-captured `notes` row. `turn.ts`'s insert never sets `chat_messages.id` to the note's
 * id, so `row.id === live.noteId` can only ever match by coincidence -- it is a comparison
 * across two different tables' primary keys. Content is what both sides actually agree on: the
 * server writes the same text the device sent, verbatim, as the `content` column. Role and a
 * time window narrow a same-text false positive (the user sending the identical line twice in
 * one session) without needing the server to round-trip an id the schema doesn't carry.
 *
 * Remaining risk, both small and survivable: a false positive (a coincidentally-identical
 * message from within the last minute retires the WRONG live turn) just makes the dedup fire a
 * little early for an unrelated turn -- the live overlay still shows the right text either way,
 * because it renders from `live`, not from the matched row. A false negative (no match found in
 * time) self-heals on the next render once `AssistantBox`'s `finally` clears `live` to `null`.
 *
 * Both sides are trimmed before comparing (final whole-branch review finding). `live.text`
 * comes from `assistant-box.tsx`'s `const asked = text` -- the raw, untrimmed textarea value --
 * while the persisted `row.content` is always trimmed (`capture.ts`'s `.trim()` on the way into
 * `notes`, and the server writes `chat_messages.content` from that same trimmed
 * `note.content_text`, turn.ts). A multiline capture with routine trailing whitespace would
 * otherwise never match, silently defeating the dedup for exactly the input shape this app
 * exists to take (a `multiline` TextInput).
 */
function matchesLive(row: ChatRow, live: LiveTurn): boolean {
  if (row.role !== "user" || row.content.trim() !== live.text.trim()) return false;
  const rowMs = Date.parse(row.created_at);
  const liveMs = Date.parse(live.createdAt);
  if (Number.isNaN(rowMs) || Number.isNaN(liveMs)) return false;
  return Math.abs(rowMs - liveMs) <= LIVE_MATCH_WINDOW_MS;
}

/**
 * The assistant-side twin of `matchesLive`, used only to decide when it is safe to retire a
 * SETTLED live turn (see `liveHasReplicated`). Same reasoning, same trim, same window: the
 * server writes `chat_messages.content` verbatim from the generated text, so an exact (trimmed)
 * match against `live.answer` is the only signal available -- there is no shared id here either.
 */
function matchesLiveAnswer(row: ChatRow, live: LiveTurn): boolean {
  if (row.role !== "assistant" || row.content.trim() !== live.answer.trim()) return false;
  const rowMs = Date.parse(row.created_at);
  const liveMs = Date.parse(live.createdAt);
  if (Number.isNaN(rowMs) || Number.isNaN(liveMs)) return false;
  return Math.abs(rowMs - liveMs) <= LIVE_MATCH_WINDOW_MS;
}

/**
 * Whether replication has produced evidence that `live` is safe to retire. Checks whichever
 * half is the last one written: if a token ever arrived, the assistant's row is the one that
 * settles last (it's a single insert of the final text, after generation finishes), so that's
 * the row worth waiting for; if no token ever arrived (an offline/error turn with nothing to
 * show), there is no assistant row to wait for at all -- the user's own row is the only evidence
 * that can ever exist, and for a genuinely offline turn even that will never arrive (see
 * `chat.tsx`'s timeout backstop for that case).
 */
export function liveHasReplicated(rows: ChatRow[], live: LiveTurn): boolean {
  return live.answer !== ""
    ? rows.some((r) => matchesLiveAnswer(r, live))
    : rows.some((r) => matchesLive(r, live));
}

/**
 * The rendered list, oldest first, with a day separator before the first message and at every
 * change of local calendar day.
 *
 * The live turn is appended LAST, and its two halves are dropped on TWO INDEPENDENT conditions,
 * not one -- see the two `if`s below for why. The server's rows land a second or two after the
 * stream ends, and for that window some of both exist. Without the drop the user watches their
 * own message appear twice, which reads as a bug in sending rather than in rendering.
 */
export function buildTranscript(
  rows: ChatRow[], live: LiveTurn | null, now: Date, timeZone: string,
): Item[] {
  const items: Item[] = [];
  let lastKey = "";

  for (const row of rows) {
    const key = dayKey(row.created_at, timeZone);
    if (key !== "" && key !== lastKey) {
      items.push({ kind: "separator", id: `sep-${key}`, label: daySeparatorLabel(row.created_at, now, timeZone) });
      lastKey = key;
    }
    items.push({
      kind: "message", id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      incomplete: isIncomplete(row.retrieval_meta),
    });
  }

  if (live) {
    // The user half drops once ITS OWN row has replicated (matchesLive). That row is written
    // very early in the turn -- right after session/history resolution, per turn.ts -- well
    // before the assistant's row exists at all, so this routinely goes true while the answer is
    // still streaming.
    const userReplicated = rows.some((r) => matchesLive(r, live));
    // The answer half has no such row to collide with: the assistant's chat_messages row is a
    // single insert of the FINAL text, written only once generation has finished -- and by the
    // time it could possibly replicate, the SSE loop has already ended and AssistantBox's
    // `finally` will already have called `onLive(null)`, clearing `live` (and this whole block)
    // before that row is ever seen here. Gating the answer on `userReplicated` -- as a single
    // shared condition used to -- suppressed the still-accumulating answer the instant the
    // user's row replicated mid-generation: a blank gap for the rest of most turns, which is
    // the opposite of "the answer streams in below".
    const showAnswer = live.answer !== "";
    if (!userReplicated || showAnswer) {
      const key = dayKey(live.createdAt, timeZone);
      if (key !== "" && key !== lastKey) {
        items.push({ kind: "separator", id: `sep-${key}`, label: daySeparatorLabel(live.createdAt, now, timeZone) });
      }
    }
    if (!userReplicated) {
      items.push({ kind: "message", id: `live-${live.noteId}`, role: "user", content: live.text, incomplete: false });
    }
    // Only once a token has arrived. An empty assistant row is a blank gap held open for the
    // whole silence, and the composer's own spinner already says a turn is in flight.
    if (showAnswer) {
      items.push({ kind: "message", id: `live-answer-${live.noteId}`, role: "assistant", content: live.answer, incomplete: false });
    }
  }

  return items;
}
