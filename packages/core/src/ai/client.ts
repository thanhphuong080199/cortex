export interface EmbedResult {
  vectors: number[][];
  inputTokens: number;
  model: string;
}

export interface JsonResult<T> {
  value: T;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Parent spec §4 item 1: keep the embedding client behind an interface so the provider can be
 * swapped. The provider has already changed once (Voyage -> Gemini, 00012), which is why this
 * is an interface rather than a module of functions.
 */
export interface AiClient {
  embed(texts: string[]): Promise<EmbedResult>;
  generateJson<T>(args: { prompt: string; schema: Record<string, unknown> }): Promise<JsonResult<T>>;
  /**
   * `grounding` declares Gemini's built-in `google_search` tool for this call. Optional and
   * defaulting to off: an implementation that never grounds should not have to say so, and the
   * acknowledge path in turn.ts must never pass it (spec §2 -- searching the web to acknowledge
   * a private sentence spends money and privacy for nothing).
   */
  generateStream(args: {
    prompt: string; model: string; signal?: AbortSignal; grounding?: boolean;
  }): Promise<StreamResult>;
}

export interface StreamChunk {
  text: string;
}

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface WebSource {
  url: string;
  title: string;
}

/**
 * What Gemini reported about a grounded turn. `groundingSupports` -- the span-level mapping
 * from answer text back to individual chunks -- is deliberately NOT carried: spec §6.2 asks
 * for a visible notes/web split, not inline attribution, and the answer streams into a element
 * with no span structure to attach it to.
 */
export interface GroundingResult {
  sources: WebSource[];
  queries: string[];
  /** Google's Search Suggestions markup (HTML+CSS). Rendered by web, ignored by mobile. */
  entryPoint?: string;
}

export interface StreamResult {
  /**
   * SINGLE-CONSUMPTION. Backed by the underlying HTTP response body, which can only be read
   * once -- a second `for await (const c of res.chunks)` yields nothing at all, silently,
   * rather than replaying or throwing. Consume it exactly once.
   */
  chunks: AsyncIterable<StreamChunk>;
  /**
   * The token counts, or null if the stream never reported them.
   *
   * A FUNCTION, not a promise, and readable at any time. Streaming APIs report usage in the
   * FINAL chunk, so a caller that aborts mid-stream would never see a promise resolve -- and
   * an aborted answer is still money spent. Reading whatever was counted is the point.
   */
  usage: () => StreamUsage | null;
  /**
   * What the model searched, or null if it did not search (or the field was never reported).
   *
   * A FUNCTION for exactly the reason `usage` above is one: grounding metadata arrives in a
   * late chunk, so a caller that aborts mid-stream would never see a promise resolve -- and an
   * aborted answer has still been searched and still been billed.
   *
   * OPTIONAL, unlike `usage`: an AiClient implementation that never grounds should not have to
   * stub it, and every existing test fake predates it. `stream.grounding?.() ?? null` at the
   * call site reads the same either way.
   */
  grounding?: () => GroundingResult | null;
}
