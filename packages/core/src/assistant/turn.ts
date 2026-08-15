import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ANSWER_MODEL, CLASSIFY_MODEL } from "@cortex/shared";
import type { AiClient } from "../ai/client.js";
import { isOverBudget, recordUsage } from "../enrich/budget.js";
import { extractNote } from "../enrich/extract.js";
import { errorMessage } from "../errors.js";
import { isStale, selectContext, type ThreadTurn } from "./context.js";
import { buildAcknowledgePrompt, buildAnswerPrompt } from "./prompts.js";
import { retrieve, type Citation } from "./retrieve.js";

export type AssistantEvent =
  | { type: "attached"; domain: string | null; domainMeta: Record<string, unknown>;
      tags: string[]; degraded?: boolean }
  | { type: "citations"; citations: Citation[]; degraded?: boolean }
  | { type: "token"; text: string }
  | { type: "declined"; reason: "budget" }
  | { type: "done"; messageId: string; sessionId: string }
  | { type: "error"; message: string };

/**
 * Keeping extraction synchronous is right -- its result is on screen. Without a deadline a
 * hung Flash call holds the SSE connection open indefinitely, so the turn gives up on it and
 * proceeds degraded; the 60-second sweep enriches the note later through the path that always
 * existed.
 */
export const EXTRACT_DEADLINE_MS = 4000;

/**
 * `Promise.race` alone leaks: the loser is never cancelled, so when `p` wins, the timer set to
 * settle the race's OTHER branch keeps the event loop alive until it eventually fires and is
 * thrown away. `.finally` runs on whichever branch wins and clears it either way -- including
 * when the timeout itself is the winner, where `clearTimeout` on an already-fired timer is a
 * harmless no-op.
 */
const withDeadline = <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

export async function* runTurn(
  deps: { userDb: SupabaseClient; serviceDb: SupabaseClient; ai: AiClient },
  args: { userId: string; noteId: string; sessionId?: string; budgetUsd: number; signal?: AbortSignal },
): AsyncGenerator<AssistantEvent> {
  const { userDb, serviceDb, ai } = deps;
  const requestId = randomUUID();

  // The user's client, so RLS is what proves ownership -- and the note's text comes from the
  // database, never from the caller's copy of it.
  const { data: note, error: noteErr } = await userDb
    .from("notes").select("id, content_text").eq("id", args.noteId).maybeSingle();
  if (noteErr || !note) {
    yield { type: "error", message: "note not found" };
    return;
  }
  const text = (note as { content_text: string }).content_text;

  // Session resolution, then the user's turn is written BEFORE any generation: a failure
  // later still leaves a coherent thread.
  const { data: last } = await userDb
    .from("chat_messages").select("session_id, created_at")
    .eq("user_id", args.userId).order("created_at", { ascending: false }).limit(1);
  const lastRow = (last ?? [])[0] as { session_id: string; created_at: string } | undefined;
  let sessionId = args.sessionId ?? lastRow?.session_id;
  if (!sessionId || isStale(lastRow?.created_at ?? null, new Date())) {
    const { data: created } = await userDb
      .from("chat_sessions").insert({ user_id: args.userId }).select("id").single();
    sessionId = (created as { id: string } | null)?.id ?? sessionId ?? randomUUID();
  }
  await userDb.from("chat_messages")
    .insert({ user_id: args.userId, session_id: sessionId, role: "user", content: text });

  const { data: historyRows } = await userDb
    .from("chat_messages").select("role, content, created_at, retrieval_meta")
    .eq("session_id", sessionId).order("created_at", { ascending: false }).limit(40);
  // No trailing reverse: `selectContext` sorts its input by `createdAt` on its own copy before
  // filling the budget (Task 5), so the order these rows arrive in does not matter here -- only
  // the filter below does.
  const history = selectContext(
    ((historyRows ?? []) as { role: string; content: string; created_at: string;
      retrieval_meta: { incomplete?: boolean } | null }[])
      // An interrupted answer stays visible in the thread and is kept OUT of the prompt: the
      // model reads a truncated answer as a complete one.
      .filter((r) => r.retrieval_meta?.incomplete !== true)
      .map((r) => ({ role: r.role as ThreadTurn["role"], content: r.content, createdAt: r.created_at })),
  );

  // CONCURRENT, and this is the latency win: retrieval needs only the note text, not the
  // classification. `attached` and `citations` may therefore be emitted in either order, which
  // is why the SSE contract says so.
  const classifyStarted = Date.now();
  // The REAL content hash, not a placeholder. extractNote stamps note_enrichment.extracted_hash
  // with whatever it is given; an empty string would never equal md5(content_text), so the
  // sweep would re-extract this note 60 seconds later and pay for the same call twice. This is
  // the two-hash design working (spec §4.2) only if the hash is honest.
  const contentHash = createHash("md5").update(text, "utf8").digest("hex");
  const [extraction, citationsResult] = await Promise.allSettled([
    withDeadline(
      extractNote({ db: serviceDb, ai }, {
        noteId: args.noteId, userId: args.userId, contentText: text, contentHash,
      }),
      EXTRACT_DEADLINE_MS,
    ),
    retrieve({ db: serviceDb, ai }, { userId: args.userId, text, requestId }),
  ]);

  // `withDeadline` resolves to null on timeout, so a fulfilled-but-null result is a timeout
  // and must be treated exactly like a thrown one.
  const extracted = extraction.status === "fulfilled" ? extraction.value : null;
  yield extracted
    ? { type: "attached", domain: extracted.domain, domainMeta: {}, tags: extracted.tagNames }
    : { type: "attached", domain: null, domainMeta: {}, tags: [], degraded: true };

  const citations = citationsResult.status === "fulfilled" ? citationsResult.value : [];
  yield citationsResult.status === "fulfilled"
    ? { type: "citations", citations }
    : { type: "citations", citations: [], degraded: true };

  // A circuit breaker, not a budget: it bounds a runaway, and it never costs the user the
  // note or the context around it -- both are already emitted above.
  if (await isOverBudget(serviceDb, args.userId, args.budgetUsd)) {
    yield { type: "declined", reason: "budget" };
    return;
  }

  const isQuestion = extracted?.intent === "question";
  if (isQuestion) {
    await userDb.from("notes").update({ source_type: "chat" }).eq("id", args.noteId);
  }
  const prompt = isQuestion
    ? buildAnswerPrompt({ question: text, citations, history })
    : buildAcknowledgePrompt({
        note: text, domain: extracted?.domain ?? null, tags: extracted?.tagNames ?? [],
        related: citations, history,
      });
  const model = isQuestion ? ANSWER_MODEL : CLASSIFY_MODEL;

  let answer = "";
  let incomplete = false;
  let streamUsage: { inputTokens: number; outputTokens: number; model: string } | null = null;
  try {
    const stream = await ai.generateStream({ prompt, model, signal: args.signal });
    try {
      for await (const chunk of stream.chunks) {
        answer += chunk.text;
        yield { type: "token", text: chunk.text };
      }
    } finally {
      streamUsage = stream.usage();
    }
  } catch (err) {
    incomplete = true;
    yield { type: "error", message: errorMessage(err).slice(0, 200) };
  }

  // Billed whether or not it finished. An abandoned answer is still money spent, and this is
  // the largest line item in the system.
  if (streamUsage) {
    try {
      await recordUsage(serviceDb, {
        userId: args.userId, kind: "chat", model: streamUsage.model,
        inputTokens: streamUsage.inputTokens, outputTokens: streamUsage.outputTokens,
        source: "assistant", noteId: args.noteId, requestId,
        latencyMs: Date.now() - classifyStarted, contentChars: text.length,
      });
    } catch (err) {
      console.error(`[assistant] usage_ledger write failed: ${errorMessage(err)}`);
    }
  }

  const { data: message } = await userDb.from("chat_messages").insert({
    user_id: args.userId, session_id: sessionId, role: "assistant", content: answer,
    citations, retrieval_meta: { requestId, incomplete },
  }).select("id").single();

  if (!incomplete) {
    yield { type: "done", messageId: (message as { id: string } | null)?.id ?? "", sessionId };
  }
}
