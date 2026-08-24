import type { AnyCitation } from "@cortex/shared";

/**
 * The two network calls behind "Lưu câu trả lời" (S1.5 §4), as a module rather than inline in the
 * screen -- mobile's vitest environment is `node` and there is no component-test harness, so a
 * contract that lives in a component is a contract with no test.
 *
 * Both functions swallow every failure by design. The user pressed a button; a thrown promise
 * inside a screen handler is an unhandled rejection and a control that appears to do nothing.
 */

/**
 * Condense a reply into one keepable sentence, falling back to the reply itself.
 *
 * NEVER dead-ends. A null statement, a non-200, or a dead network all return `answer` unchanged,
 * so the confirmation box always has something honest to show. That fallback is the contract the
 * screen depends on and the reason this is tested in five shapes.
 */
export async function proposeStatement(a: {
  apiUrl: string; token: string; answer: string; question?: string; fetchFn?: typeof fetch;
}): Promise<string> {
  const f = a.fetchFn ?? fetch;
  try {
    const res = await f(`${a.apiUrl}/assistant/distill`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      // Spread-if, not `question: a.question`: an undefined value serialises to an absent key
      // here and the endpoint is `.strict()`, so an explicit `"question": undefined` would be a
      // 400 on some serialisers and a silently dropped key on others.
      body: JSON.stringify({ answer: a.answer, ...(a.question ? { question: a.question } : {}) }),
    });
    if (!res.ok) return a.answer;
    const d = (await res.json()) as { statement?: unknown };
    return typeof d.statement === "string" && d.statement !== "" ? d.statement : a.answer;
  } catch {
    return a.answer;
  }
}

/**
 * Write the note. Same endpoint and body the web client's accept path uses, which is half of what
 * makes the two produce an identical row -- `buildSavedAnswerRow` is the other half.
 *
 * NOT queued through PowerSync. `chat_messages` is read-only on the device and a saved answer is
 * a `notes` row the SERVER writes under the caller's JWT; routing it through the upload path
 * would need a local insert this client has no id contract for. Offline, this simply fails, and
 * the button is a no-op until there is a network -- acceptable because the answer being saved
 * came from the network in the first place.
 */
export async function saveStatement(a: {
  apiUrl: string; token: string; statement: string; sourceUrl?: string;
  /**
   * The `chat_messages` row this save came from, when the caller has a real one -- lets the
   * server mark that message saved (save-answer.ts's markMessageSaved) so the control survives
   * an app restart. See chat.tsx's `isRealMessageId` for what counts as "real".
   */
  forMessageId?: string;
  fetchFn?: typeof fetch;
}): Promise<void> {
  const f = a.fetchFn ?? fetch;
  try {
    await f(`${a.apiUrl}/notes/save-answer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: JSON.stringify({
        statement: a.statement,
        ...(a.sourceUrl !== undefined ? { sourceUrl: a.sourceUrl } : {}),
        ...(a.forMessageId !== undefined ? { forMessageId: a.forMessageId } : {}),
      }),
    });
  } catch {
    // Best-effort, same as web's acceptOffer: the box is already off screen.
  }
}

/**
 * Record that the assistant should stop offering this fact (C5 §12). ONLY for the automatic
 * offer -- the manual save's "Thôi" must not call this. A decline says "do not raise this with me
 * again"; a user who asked to keep an answer and then changed their mind said no such thing, and
 * writing one would suppress future offers about a fact they never rejected.
 */
export async function declineStatement(a: {
  apiUrl: string; token: string; statement: string; fetchFn?: typeof fetch;
}): Promise<void> {
  const f = a.fetchFn ?? fetch;
  try {
    await f(`${a.apiUrl}/assistant/decline`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ statement: a.statement }),
    });
  } catch {
    // §11: "declining costs nothing" is a claim about latency as much as about writes. The box is
    // already gone; a failed decline means it may be offered again, which is fine.
  }
}

/**
 * The first web source on a replicated reply, which is what makes a save a 'web_search' note
 * rather than an 'assistant' one.
 *
 * Takes a STRING because that is what the device gets: `chat_messages.citations` is jsonb, and
 * PowerSync delivers jsonb as a JSON string exactly as `notes.domain_meta` arrives. A version
 * that expected an array would return undefined for every grounded reply and quietly relabel the
 * provenance of everything the user keeps.
 */
export function webUrlOf(citationsJson: string | null): string | undefined {
  if (!citationsJson) return undefined;
  try {
    const parsed = JSON.parse(citationsJson) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const web = (parsed as AnyCitation[]).find((c) => c && c.type === "web");
    return web && "url" in web && typeof web.url === "string" ? web.url : undefined;
  } catch {
    return undefined;
  }
}
