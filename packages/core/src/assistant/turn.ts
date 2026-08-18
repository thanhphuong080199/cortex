import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ANSWER_MODEL, CLASSIFY_MODEL, GROUNDING_USD_PER_QUERY, resolveTimeZone, type WebCitation,
} from "@cortex/shared";
import type { AiClient, GroundingResult } from "../ai/client.js";
import { isOverBudget, recordUsage } from "../enrich/budget.js";
import { extractNote } from "../enrich/extract.js";
import { errorMessage } from "../errors.js";
import { CheckinService } from "../checkins/service.js";
import { MediaService } from "../media/service.js";
import { NoteService } from "../notes/service.js";
import { resolveCurrentSession, selectContext, type ThreadTurn } from "./context.js";
import { buildAcknowledgePrompt, buildAnswerPrompt, buildChitchatPrompt } from "./prompts.js";
import { retrieve, type Citation } from "./retrieve.js";

export type AssistantEvent =
  | { type: "attached"; domain: string | null; domainMeta: Record<string, unknown>;
      tags: string[]; degraded?: boolean; mediaTitle?: string }
  | { type: "citations"; citations: Citation[]; degraded?: boolean }
  | { type: "web"; sources: WebCitation[]; queries: string[]; entryPoint?: string }
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
    /** The caller's IANA zone, validated here rather than trusted. See resolveTimeZone. */
    timeZone?: string;
    budgetUsd: number; signal?: AbortSignal;
  },
): AsyncGenerator<AssistantEvent> {
  const { userDb, serviceDb, ai } = deps;
  const requestId = randomUUID();
  // Diagnostic only, temporary: one line per milestone, all relative to the same t0, so a slow
  // turn can be read off the server log as a timeline instead of guessed at. Every mark carries
  // requestId so concurrent turns interleave in the log without being ambiguous.
  const t0 = Date.now();
  const mark = (label: string) => console.log(`[assistant:timing] ${requestId} ${label} +${Date.now() - t0}ms`);

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
  mark("note ready");

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
  // The SAME call the web pane makes (page.tsx). A client-supplied id is honoured only while
  // the thread it names is still live: past the idle gap this turn starts a new session
  // whatever the client asked for, which is what the two lines this replaced already did.
  const live = resolveCurrentSession(lastRow ?? null, new Date());
  sessionId = live === null ? undefined : (sessionId ?? live);
  if (!sessionId) {
    const { data: created } = await userDb
      .from("chat_sessions").insert({ user_id: args.userId }).select("id").single();
    sessionId = (created as { id: string } | null)?.id ?? randomUUID();
  }
  // History is read BEFORE the current turn's own message is written, deliberately: writing
  // first and reading back with no exclusion would make the just-inserted row indistinguishable
  // from real prior conversation, and renderHistory would then show the model its own current
  // note/question a second time, mislabeled as something that already happened.
  const { data: historyRows } = await userDb
    .from("chat_messages").select("role, content, created_at, retrieval_meta")
    .eq("session_id", sessionId).order("created_at", { ascending: false }).limit(40);
  mark("session+history resolved");

  await userDb.from("chat_messages")
    .insert({ user_id: args.userId, session_id: sessionId, role: "user", content: text });
  mark("user message written");
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
  // Individually timed, not just the pair via `mark` after the await below: the two race each
  // other, so knowing only their combined finish time hides which one is actually the long pole
  // (classification vs. retrieval's own embedding call and search_notes round trip).
  const timed = <T,>(label: string, p: Promise<T>): Promise<T> =>
    p.finally(() => mark(`${label} settled`));
  const [extraction, citationsResult] = await Promise.allSettled([
    timed("classify", withDeadline(
      extractNote({ db: serviceDb, ai }, {
        noteId: args.noteId, userId: args.userId, contentText: text, contentHash,
        // This call is the assistant's own classification spend, not the 60-second sweep's --
        // filing it under "sweep" (extractNote's default) would make a live turn's cost
        // indistinguishable from real sweep activity and unjoinable to this turn's requestId.
        source: "assistant", requestId,
        // Handed over whole; buildPrompt takes the last CLASSIFIER_HISTORY_TURNS. Without this
        // the classifier sees "ok còn gì khác không" as an isolated sentence, returns
        // `statement`, and the acknowledge prompt then refuses to answer -- observed
        // 2026-08-16 and the reason this field exists.
        history,
      }),
      EXTRACT_DEADLINE_MS,
    )),
    timed("retrieve", retrieve({ db: serviceDb, ai }, { userId: args.userId, text, requestId })),
  ]);
  mark("classify+retrieve both settled");

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
    mark("media link resolved");
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

  // AN ORDERED CHAIN, not a set of independent booleans, and the order is the decision.
  //
  // `wantsAnswer` covers two shapes that behave identically from here on: a pure question, and
  // a statement the classifier flagged as also asking something (design doc §1). The second is
  // the eye-fatigue turn -- "Các loại thực phẩm nào tốt cho mắt, dạo này hơi mỏi mắt" -- which
  // was classified `statement`, routed to buildAcknowledgePrompt, and had its question dropped
  // by that prompt's "The user did not ask a question" rule.
  //
  // `intent` stays "statement" for that turn on purpose: it still drives tagging, domain and
  // the filing tone correctly. Only the reply branch was ever wrong.
  //
  // Chitchat is checked SECOND and can never be reached by the flag: grounding "haha ok"
  // against Google is the most wasteful thing this system can be told to do, and
  // `alsoWantsAnswer` is a value a model produced, not trusted input.
  const wantsAnswer = extracted?.intent === "question"
    || (extracted?.intent === "statement" && extracted?.alsoWantsAnswer === true);
  const isChitchat = extracted?.intent === "chitchat";
  // THE THIRD LINK, and its position in the chain is the decision (design doc §1.1). Read only
  // when `wantsAnswer` is already false: a turn that asks a question gets ANSWERED, and the
  // correction rides inside that answer rather than replacing it. Written as `!wantsAnswer &&`
  // rather than as a separate `if` further down, because two booleans that can both be true and
  // are read in different places is exactly how this collision was created.
  const verifies = !wantsAnswer && !isChitchat && extracted?.checkableClaim === true;

  // A note that already exists, restamped after classification -- the shape 'chat' has used
  // since C1. An ordinary statement is the default branch and writes nothing: every plain
  // capture keeps the 'quick' the row was created with.
  if (wantsAnswer || isChitchat) {
    await userDb.from("notes")
      .update({ source_type: wantsAnswer ? "chat" : "chitchat" })
      .eq("id", args.noteId);
  }
  // Resolved once per turn, not per prompt: two calls could not disagree today, but the point
  // of a single resolution is that they cannot start to.
  const timeZone = resolveTimeZone(args.timeZone);
  const now = new Date();
  const prompt = wantsAnswer
    // The FULL turn text, both shapes. "Các loại thực phẩm nào tốt cho mắt, dạo này hơi mỏi
    // mắt" answers better with the eye strain still in it than with the question carved out,
    // and carving it out would need a second model call to decide where the seam is.
    ? buildAnswerPrompt({ question: text, citations: citationsForPrompt, history, timeZone, now })
    : isChitchat
      ? buildChitchatPrompt({ text, history })
      : buildAcknowledgePrompt({
          note: text, domain: extracted?.domain ?? null, tags: extracted?.tagNames ?? [],
          related: citationsForPrompt, history, timeZone, now,
        });
  // Two ways onto the reasoning model and no third. `verifies` is capped by the classifier's
  // own threshold ("only when you have real reason to doubt"), so an ordinary capture is
  // untouched -- see turn.test.ts's cheap-model assertion.
  const model = wantsAnswer || verifies ? ANSWER_MODEL : CLASSIFY_MODEL;

  let answer = "";
  let incomplete = false;
  let streamUsage: { inputTokens: number; outputTokens: number; model: string } | null = null;
  let grounding: GroundingResult | null = null;
  // A verification checks against a second source rather than the model's own memory alone
  // (C5 §9.3). Where grounding is unavailable it degrades to that memory, which the prompt
  // does not need to know about.
  const grounds = wantsAnswer || verifies;
  mark(`model stream requested (${model}, grounding=${grounds})`);
  try {
    const stream = await ai.generateStream({
      prompt, model, signal: args.signal,
      // The whole enablement decision. Never unconditional: see the acknowledge-path test.
      grounding: grounds,
    });
    mark("model stream opened");
    try {
      // Split out because this is usually THE number: the gap between "opened" above and
      // "first token" below is the silent stretch the loading indicator's "Đang tìm câu trả
      // lời…" phase exists to cover, and it is dominated by grounding (a web search the model
      // runs before it says anything) far more often than by the model's own latency.
      let sawFirstToken = false;
      for await (const chunk of stream.chunks) {
        if (!sawFirstToken) { sawFirstToken = true; mark("first token"); }
        answer += chunk.text;
        yield { type: "token", text: chunk.text };
      }
      mark("stream exhausted");
    } finally {
      // Both reads live in the `finally` for the same reason: an aborted answer has still been
      // billed and has still been searched, and neither fact survives if it is only read on the
      // success path.
      streamUsage = stream.usage();
      grounding = stream.grounding?.() ?? null;
    }
  } catch (err) {
    incomplete = true;
    mark("model stream threw");
    yield { type: "error", message: errorMessage(err).slice(0, 200) };
  }

  // `searched` and "has sources" are different facts and are used for different things. Google
  // billed the turn the moment the model issued a query, even if every chunk came back
  // unusable -- and it billed the turn just as surely if a source came back with no query
  // attached, which extractGrounding's degrade-to-`[]` on a malformed webSearchQueries (and a
  // chunk split across handleEvent's last-one-wins capture) can both produce. Sources are
  // therefore equally good evidence a search happened, so `searched` is true on EITHER being
  // non-empty -- keying it on `queries` alone would let that state through with a full "Từ web"
  // block on screen and no ledger row behind it, so isOverBudget never sees the spend. The EVENT
  // keys off having something to show: emitting `sources: []` would force every client to
  // re-check a length, when "a web event arrived" is otherwise exactly "the box searched".
  const searched = grounding !== null
    && (grounding.queries.length > 0 || grounding.sources.length > 0);
  // The wire shape, not `grounding.sources` (WebSource[], no `type` key): both clients declare
  // the `web` event's `sources` as WebCitation[] and reach it through an unchecked cast, and
  // `chat_messages.citations` below already gets this exact shape. One concept, one shape, on
  // both channels -- emitting the AI client's internal WebSource[] here would make the clients'
  // declared type a lie that only an unchecked cast was hiding.
  const webCitations: WebCitation[] = (grounding?.sources ?? [])
    .map((s) => ({ type: "web" as const, url: s.url, title: s.title }));

  // Keyed off the same array this yields, not off `grounding` directly -- `webCitations` is
  // exactly `[]` when there is nothing to show, whatever shape `grounding` itself is in.
  if (webCitations.length > 0) {
    yield {
      type: "web",
      sources: webCitations,
      queries: grounding?.queries ?? [],
      ...(grounding?.entryPoint !== undefined ? { entryPoint: grounding.entryPoint } : {}),
    };
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

  // A SECOND row, not a field on the chat row. Grounding is priced per query while the answer
  // is priced per token, and folding a per-query charge into a per-token row makes both
  // unreadable. `source: 'assistant'` is what puts it inside the existing circuit breaker --
  // isOverBudget sums by source, so no new budget is introduced.
  if (searched) {
    try {
      await recordUsage(serviceDb, {
        userId: args.userId, kind: "grounding", model,
        inputTokens: 0, outputTokens: 0,
        costUsd: GROUNDING_USD_PER_QUERY,
        source: "assistant", noteId: args.noteId, requestId,
        latencyMs: Date.now() - classifyStarted, contentChars: text.length,
      });
    } catch (err) {
      console.error(`[assistant] grounding usage_ledger write failed: ${errorMessage(err)}`);
    }
  }

  const { data: message } = await userDb.from("chat_messages").insert({
    user_id: args.userId, session_id: sessionId, role: "assistant", content: answer,
    // `citations` already carries `type: "note"` from retrieve.ts, so no mapping happens here.
    citations: [...citations, ...webCitations],
    retrieval_meta: { requestId, incomplete },
  }).select("id").single();
  mark("assistant message written");

  if (!incomplete) {
    yield { type: "done", messageId: (message as { id: string } | null)?.id ?? "", sessionId };
  }
  mark("turn complete");
}
