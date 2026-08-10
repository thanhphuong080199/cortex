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
}
