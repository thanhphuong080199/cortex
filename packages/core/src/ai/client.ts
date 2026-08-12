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
  generateStream(args: { prompt: string; model: string; signal?: AbortSignal }): Promise<StreamResult>;
}

export interface StreamChunk {
  text: string;
}

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
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
}
