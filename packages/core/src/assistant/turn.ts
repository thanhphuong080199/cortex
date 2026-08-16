import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ANSWER_MODEL, CLASSIFY_MODEL } from "@cortex/shared";
import type { AiClient } from "../ai/client.js";
import { isOverBudget, recordUsage } from "../enrich/budget.js";
import { extractNote } from "../enrich/extract.js";
import { errorMessage } from "../errors.js";
import { CheckinService } from "../checkins/service.js";
import { MediaService } from "../media/service.js";
import { NoteService } from "../notes/service.js";
import { isStale, selectContext, type ThreadTurn } from "./context.js";
import { buildAcknowledgePrompt, buildAnswerPrompt } from "./prompts.js";
import { retrieve, type Citation } from "./retrieve.js";

export type AssistantEvent =
  | { type: "attached"; domain: string | null; domainMeta: Record<string, unknown>;
      tags: string[]; degraded?: boolean; mediaTitle?: string }
  | { type: "citations"; citations: Citation[]; degraded?: boolean }
  | { type: "mood"; checkinId: string; mood: number }
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
  args: {
    userId: string; noteId: string; sessionId?: string;
    content?: string; createdAt?: string;
    budgetUsd: number; signal?: AbortSignal;
  },
): AsyncGenerator<AssistantEvent> {
  const { userDb, serviceDb, ai } = deps;
  const requestId = randomUUID();

  // The user's client, so RLS is what proves ownership -- and the note's text comes from the
  // database, never from the caller's copy of it.
  const { data: existing, error: noteErr } = await userDb
    .from("notes").select("id, content_text, created_at").eq("id", args.noteId).maybeSingle();
  if (noteErr) {
    yield { type: "error", message: "note not found" };
    return;
  }

  // Mobile writes to local SQLite first and PowerSync uploads on its own schedule, so the
  // FIRST turn about a note always races the upload and would otherwise always lose. Creating
  // it here is safe against that upload precisely because createWithId is create-if-absent: a
  // 23505 returns the existing row rather than overwriting it, so whichever writer arrives
  // first wins and the second is a no-op.
  let note = existing as { content_text: string; created_at: string } | null;
  if (!note) {
    if (args.content === undefined) {
      yield { type: "error", message: "note not found" };
      return;
    }
    try {
      const created = await new NoteService(userDb, args.userId).createWithId(args.noteId, {
        content: args.content,
        ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
      });
      note = { content_text: created.content, created_at: created.created_at };
    } catch (err) {
      console.error(`[assistant] could not create note ${args.noteId}: ${errorMessage(err)}`);
      yield { type: "error", message: "note not found" };
      return;
    }
  }
  const text = note.content_text;
  const noteCreatedAt = note.created_at;

  // A client-supplied sessionId is UNVERIFIED input. Without this read the history query below
  // is scoped by session alone, so a guessed id would select another user's conversation into
  // this turn's prompt. C2 makes /assistant the only write path a mobile client has, which is
  // what makes the check worth its round trip.
  let sessionId: string | undefined;
  if (args.sessionId) {
    const { data: owned } = await userDb
      .from("chat_sessions").select("id")
      .eq("id", args.sessionId).eq("user_id", args.userId).maybeSingle();
    sessionId = (owned as { id: string } | null)?.id;
  }
  const { data: last } = await userDb
    .from("chat_messages").select("session_id, created_at")
    .eq("user_id", args.userId).order("created_at", { ascending: false }).limit(1);
  const lastRow = (last ?? [])[0] as { session_id: string; created_at: string } | undefined;
  sessionId = sessionId ?? lastRow?.session_id;
  if (!sessionId || isStale(lastRow?.created_at ?? null, new Date())) {
    const { data: created } = await userDb
      .from("chat_sessions").insert({ user_id: args.userId }).select("id").single();
    sessionId = (created as { id: string } | null)?.id ?? sessionId ?? randomUUID();
  }
  // History is read BEFORE the current turn's own message is written, deliberately: writing
  // first and reading back with no exclusion would make the just-inserted row indistinguishable
  // from real prior conversation, and renderHistory would then show the model its own current
  // note/question a second time, mislabeled as something that already happened.
  const { data: historyRows } = await userDb
    .from("chat_messages").select("role, content, created_at, retrieval_meta")
    .eq("session_id", sessionId).order("created_at", { ascending: false }).limit(40);

  await userDb.from("chat_messages")
    .insert({ user_id: args.userId, session_id: sessionId, role: "user", content: text });
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
        // This call is the assistant's own classification spend, not the 60-second sweep's --
        // filing it under "sweep" (extractNote's default) would make a live turn's cost
        // indistinguishable from real sweep activity and unjoinable to this turn's requestId.
        source: "assistant", requestId,
      }),
      EXTRACT_DEADLINE_MS,
    ),
    retrieve({ db: serviceDb, ai }, { userId: args.userId, text, requestId }),
  ]);

  // `withDeadline` resolves to null on timeout, so a fulfilled-but-null result is a timeout
  // and must be treated exactly like a thrown one. Both are logged (rejection and timeout give
  // different diagnostics) so a run of degraded "attached" events is traceable instead of silent.
  if (extraction.status === "rejected") {
    console.error(`[assistant] extraction failed (request ${requestId}): ${errorMessage(extraction.reason)}`);
  } else if (extraction.value === null) {
    console.error(`[assistant] extraction timed out after ${EXTRACT_DEADLINE_MS}ms (request ${requestId})`);
  }
  const extracted = extraction.status === "fulfilled" ? extraction.value : null;

  // Resolution runs AFTER extractNote returns, deliberately NOT inside it: in this file that
  // call is wrapped in withDeadline(..., EXTRACT_DEADLINE_MS), and a slow findOrCreate would
  // turn into `attached: degraded` -- trading the classification for a link.
  //
  // A throw is logged and swallowed. The note and its tags are already the deliverable, and
  // media_unresolved exists for the sync path, not for this one.
  let mediaTitle: string | undefined;
  if (extracted?.domain === "media") {
    try {
      const item = await new MediaService(userDb, args.userId)
        .resolveNoteMediaLink(args.noteId, extracted.domainMeta);
      if (item) mediaTitle = item.title;
    } catch (err) {
      console.error(`[assistant] media link failed (request ${requestId}): ${errorMessage(err)}`);
    }
  }

  yield extracted
    ? { type: "attached", domain: extracted.domain, domainMeta: extracted.domainMeta,
        tags: extracted.tagNames, ...(mediaTitle !== undefined ? { mediaTitle } : {}) }
    : { type: "attached", domain: null, domainMeta: {}, tags: [], degraded: true };

  // Written by the TURN, not by extractNote, and the distinction matters: the 60-second sweep
  // runs extractNote too, and a sweep that wrote check-ins would manufacture mood history for
  // old notes at arbitrary times, with no screen to undo it on.
  if (extracted?.mood != null) {
    const checkinId = randomUUID();
    try {
      await new CheckinService(userDb, args.userId).createWithId(checkinId, {
        mood: extracted.mood,
        // The note's timestamp, not now(): offline, the thought can be hours older than
        // the turn that finally reached the server.
        createdAt: noteCreatedAt,
      });
      yield { type: "mood", checkinId, mood: extracted.mood };
    } catch (err) {
      // A failed check-in must not cost the user their answer. Logged, not raised.
      console.error(`[assistant] check-in write failed (request ${requestId}): ${errorMessage(err)}`);
    }
  }

  // A rejected retrieval must not be reported to the model as an empty corpus (see prompts.ts's
  // renderCitations): "no notes matched" and "the search failed" are different facts, and only
  // the first one is safe to answer around. Logged here for the same reason extraction is above
  // -- a total search_notes outage must produce log lines, not a silent stream of confident,
  // note-free-but-not-actually-empty answers.
  if (citationsResult.status === "rejected") {
    console.error(`[assistant] retrieval failed (request ${requestId}): ${errorMessage(citationsResult.reason)}`);
  }
  const citations = citationsResult.status === "fulfilled" ? citationsResult.value : [];
  const citationsForPrompt: Citation[] | "failed" =
    citationsResult.status === "fulfilled" ? citations : "failed";
  yield citationsResult.status === "fulfilled"
    ? { type: "citations", citations }
    : { type: "citations", citations: [], degraded: true };

  // A circuit breaker, not a budget: it bounds a runaway, and it never costs the user the
  // note or the context around it -- both are already emitted above.
  if (await isOverBudget(serviceDb, args.userId, args.budgetUsd, "assistant")) {
    yield { type: "declined", reason: "budget" };
    return;
  }

  const isQuestion = extracted?.intent === "question";
  if (isQuestion) {
    await userDb.from("notes").update({ source_type: "chat" }).eq("id", args.noteId);
  }
  const prompt = isQuestion
    ? buildAnswerPrompt({ question: text, citations: citationsForPrompt, history })
    : buildAcknowledgePrompt({
        note: text, domain: extracted?.domain ?? null, tags: extracted?.tagNames ?? [],
        related: citationsForPrompt, history,
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
