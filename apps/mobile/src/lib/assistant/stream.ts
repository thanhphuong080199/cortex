import { readEvents, type Citation, type WebCitation } from "@cortex/shared";

/**
 * The turn could not be had. Distinct from a turn that ran and declined (`declined`) or one
 * that errored server-side (`error`) -- only this one means "fall back to the local index",
 * and conflating them is how an offline user gets told their notes are missing.
 */
export class StreamUnavailableError extends Error {
  override name = "StreamUnavailableError";
}

export type BoxEvent =
  | { type: "attached"; domain: string | null; domainMeta: Record<string, unknown>;
      tags: string[]; degraded?: boolean; mediaTitle?: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "web"; sources: WebCitation[]; queries: string[] }
  | { type: "token"; text: string }
  | { type: "mood"; checkinId: string; mood: number }
  | { type: "declined" }
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * One turn against POST /assistant, as typed events.
 *
 * `fetchFn` is injected for the same reason capture.ts exists: the test needs no network and no
 * React Native mock. The screen passes `expo/fetch`'s implementation, which is the one that
 * streams -- React Native's global fetch buffers the whole body (see Task 1's spike).
 *
 * `content` and `createdAt` ride along on every request, not just the first. The server ignores
 * them once the row exists, and the alternative -- tracking on-device whether this note has
 * been uploaded yet -- is a second source of truth about something PowerSync already owns.
 */
export async function* streamAssistantTurn(args: {
  noteId: string;
  content: string;
  createdAt: string;
  token: string;
  apiUrl: string;
  fetchFn?: typeof fetch;
}): AsyncGenerator<BoxEvent> {
  const doFetch = args.fetchFn ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${args.apiUrl}/assistant`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${args.token}` },
      body: JSON.stringify({
        noteId: args.noteId, content: args.content, createdAt: args.createdAt,
      }),
    });
  } catch {
    throw new StreamUnavailableError("the assistant could not be reached");
  }
  if (!res.ok || !res.body) {
    throw new StreamUnavailableError(`the assistant answered ${res.status}`);
  }

  for await (const ev of readEvents(res.body)) {
    const d = ev.data;
    switch (ev.type) {
      case "attached":
        yield {
          type: "attached",
          domain: (d.domain as string | null) ?? null,
          domainMeta: (d.domainMeta as Record<string, unknown>) ?? {},
          tags: (d.tags as string[]) ?? [],
          ...(d.degraded === true ? { degraded: true } : {}),
          ...(typeof d.mediaTitle === "string" ? { mediaTitle: d.mediaTitle } : {}),
        };
        break;
      case "citations":
        yield { type: "citations", citations: (d.citations as Citation[]) ?? [] };
        break;
      case "web":
        yield {
          type: "web",
          sources: (Array.isArray(d.sources) ? d.sources : []) as WebCitation[],
          // `entryPoint` is deliberately dropped: it is HTML+CSS and this app has no WebView
          // to render it in. Chips are rebuilt from `queries` in the screen -- C3 spec §7.2,
          // including the condition under which that decision gets revisited.
          queries: (Array.isArray(d.queries) ? d.queries : []) as string[],
        };
        break;
      case "token":
        yield { type: "token", text: String(d.text ?? "") };
        break;
      case "mood":
        yield { type: "mood", checkinId: String(d.checkinId), mood: Number(d.mood) };
        break;
      case "declined":
        yield { type: "declined" };
        break;
      case "done":
        yield { type: "done" };
        break;
      case "error":
        yield { type: "error", message: String(d.message ?? "") };
        break;
      // An event name this build does not know is DROPPED, not rendered. The server is
      // deployed independently of the APK, so it will grow events this client predates.
      default:
        break;
    }
  }
}
