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
 * nothing has persisted. Keyed by `noteId` because that is the id the DEVICE generated before
 * the turn started, which is what makes the dedup below possible at all.
 */
export interface LiveTurn {
  noteId: string; text: string; answer: string; createdAt: string;
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

/**
 * The rendered list, oldest first, with a day separator before the first message and at every
 * change of local calendar day.
 *
 * The live turn is appended LAST and dropped the moment a replicated row carries its noteId:
 * the server's rows land a second or two after the stream ends, and for that window both exist.
 * Without the drop the user watches their own message appear twice, which reads as a bug in
 * sending rather than in rendering.
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

  if (live && !rows.some((r) => r.id === live.noteId)) {
    const key = dayKey(live.createdAt, timeZone);
    if (key !== "" && key !== lastKey) {
      items.push({ kind: "separator", id: `sep-${key}`, label: daySeparatorLabel(live.createdAt, now, timeZone) });
    }
    items.push({ kind: "message", id: `live-${live.noteId}`, role: "user", content: live.text, incomplete: false });
    // Only once a token has arrived. An empty assistant row is a blank gap held open for the
    // whole silence, and the composer's own spinner already says a turn is in flight.
    if (live.answer !== "") {
      items.push({ kind: "message", id: `live-answer-${live.noteId}`, role: "assistant", content: live.answer, incomplete: false });
    }
  }

  return items;
}
