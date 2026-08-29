import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ANSWER_MODEL, GROUNDING_USD_PER_QUERY, resolveTimeZone, type WebCitation,
} from "@cortex/shared";
import type { AiClient, GroundingResult } from "../ai/client.js";
import { isOverBudget, recordUsage } from "../enrich/budget.js";
import { extractNote } from "../enrich/extract.js";
import { errorMessage } from "../errors.js";
import { CheckinService } from "../checkins/service.js";
import { MediaService } from "../media/service.js";
import { NoteService } from "../notes/service.js";
import { resolveCurrentSession, selectContext, type ThreadTurn } from "./context.js";
import { detectEntityGap } from "./follow-up.js";
import { proposeOffer } from "./offer.js";
import { buildTurnPrompt } from "./prompts.js";
import { retrieve, type Citation } from "./retrieve.js";

export type AssistantEvent =
  | { type: "attached"; domain: string | null; domainMeta: Record<string, unknown>;
      tags: string[]; degraded?: boolean; mediaTitle?: string }
  | { type: "citations"; citations: Citation[]; degraded?: boolean }
  | { type: "web"; sources: WebCitation[]; queries: string[]; entryPoint?: string }
  | { type: "mood"; checkinId: string; mood: number }
  | { type: "token"; text: string }
  | { type: "offer"; statement: string; sourceUrl?: string }
  | { type: "declined"; reason: "budget" }
  | { type: "done"; messageId: string; sessionId: string }
  | { type: "error"; message: string };

/**
 * How long the turn will wait for classification before giving up on it and going degraded.
 *
 * 4000 until 2026-08-29, when the deadline sat IN FRONT of the reply: a hung Flash call would
 * otherwise have held the SSE connection open with nothing on screen at all. That is no longer
 * where it sits. Classification now runs beside the answer, so this bounds only how long the turn
 * holds `done` open AFTER the answer has already streamed -- and the answer's own duration
 * (3-15s) dominates it. At 4000 the deadline would routinely fire mid-answer and mark `attached`
 * degraded for no benefit whatsoever, because the connection was staying open regardless.
 *
 * 15000 is chosen so the deadline effectively never extends a turn -- the answer stream overtakes
 * it -- while making `degraded: true` rare instead of routine. Fewer degraded turns also means
 * fewer notes deferred to the 60-second sweep for enrichment that could have been instant. It is
 * an invented number and the stage spec §3 says so; it is not tuned against data.
 */
export const EXTRACT_DEADLINE_MS = 15000;

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

/** What `extractNote` returns, named so the annotation chain in `runTurn` can be typed without
 *  exporting extract.ts's internal interface. */
type Classification = Awaited<ReturnType<typeof extractNote>>;
/** A classification plus what resolving its media entity produced, which `attached` carries. */
type Annotation = Classification & { mediaTitle?: string; mediaItemId?: string };

/** The `attached` event's shape, in one place: it is emitted from two call sites (mid-stream and
 *  after the stream) and a degraded turn must produce the same event type as a successful one. */
const attachedEvent = (a: Annotation | null): AssistantEvent =>
  a
    ? { type: "attached", domain: a.domain, domainMeta: a.domainMeta, tags: a.tagNames,
        ...(a.mediaTitle !== undefined ? { mediaTitle: a.mediaTitle } : {}) }
    : { type: "attached", domain: null, domainMeta: {}, tags: [], degraded: true };

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

  // S2 §6/§7. `[0]`, NEVER `find()`. The query is `created_at desc` and it runs before this
  // turn's own message is written, so [0] is the message immediately before this one. Restricting
  // an answer to the very next turn is what makes "ask once, never nag" STRUCTURAL: a user who
  // says something else has ended it, with no counter to decrement and no timeout to expire.
  //
  // It is also the entire ceiling. One condition covers both halves of what the design asks for
  // -- never while a question is outstanding, and never two turns running -- with no invented
  // number in it.
  const previousMessage = ((historyRows ?? []) as {
    role: string;
    retrieval_meta: { asked?: { noteId: string; field: string } } | null;
  }[])[0];
  const pendingAsk = previousMessage?.role === "assistant"
    ? previousMessage.retrieval_meta?.asked ?? null
    : null;

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

  // NOT AWAITED. This is the change: classification is started here and read after the answer has
  // streamed (below), so a slow or hung extraction costs the user their tags and nothing else.
  // Until 2026-08-29 the turn awaited it before choosing a prompt, and a timeout therefore
  // misrouted a real question into "note filed" -- twice.
  const classifyStarted = Date.now();
  // The REAL content hash, not a placeholder. extractNote stamps note_enrichment.extracted_hash
  // with whatever it is given; an empty string would never equal md5(content_text), so the sweep
  // would re-extract this note 60 seconds later and pay for the same call twice.
  const contentHash = createHash("md5").update(text, "utf8").digest("hex");
  const timed = <T,>(label: string, p: Promise<T>): Promise<T> =>
    p.finally(() => mark(`${label} settled`));

  // Set by the chain below the instant it settles. `undefined` means still running, `null` means
  // it failed or timed out, an object means it worked -- three states, because the token loop has
  // to tell "not yet" from "never" without awaiting anything.
  let annotation: Annotation | null | undefined;
  // Both failure branches are logged, and they are logged DIFFERENTLY on purpose: a rejection and
  // a timeout give different diagnostics, and a run of degraded `attached` events has to be
  // traceable rather than silent.
  const classifyOnce = async (): Promise<Classification | null> => {
    try {
      const e = await withDeadline(
        extractNote({ db: serviceDb, ai }, {
          noteId: args.noteId, userId: args.userId, contentText: text, contentHash,
          // This call is the assistant's own classification spend, not the 60-second sweep's.
          source: "assistant", requestId,
          // buildPrompt takes the last CLASSIFIER_HISTORY_TURNS. Without this the classifier sees
          // "ok còn gì khác không" as an isolated sentence.
          history,
        }),
        EXTRACT_DEADLINE_MS,
      );
      if (e === null) {
        console.error(`[assistant] extraction timed out after ${EXTRACT_DEADLINE_MS}ms (request ${requestId})`);
      }
      return e;
    } catch (err) {
      console.error(`[assistant] extraction failed (request ${requestId}): ${errorMessage(err)}`);
      return null;
    }
  };

  // The media resolve is chained here rather than awaited later so that `attached` can carry
  // `mediaTitle` in ONE event -- a second, later event for the title would be a new wire concept
  // for a receipt that already works. It is deliberately OUTSIDE withDeadline (which wraps only
  // extractNote, above): a slow findOrCreate inside the deadline would trade the whole
  // classification for a link. A throw is logged and swallowed; the note and its tags are already
  // the deliverable, and media_unresolved exists for the sync path, not for this one.
  const classification: Promise<Annotation | null> = timed("classify", classifyOnce())
    .then(async (e) => {
      if (e === null) return null;
      let mediaTitle: string | undefined;
      let mediaItemId: string | undefined;
      if (e.domain === "media") {
        try {
          const item = await new MediaService(userDb, args.userId)
            .resolveNoteMediaLink(args.noteId, e.domainMeta);
          if (item) { mediaTitle = item.title; mediaItemId = item.id; }
        } catch (err) {
          console.error(`[assistant] media link failed (request ${requestId}): ${errorMessage(err)}`);
        }
        mark("media link resolved");
      }
      return { ...e, mediaTitle, mediaItemId };
    })
    .then((a) => (annotation = a));

  // AWAITED, and now the only thing between the user pressing send and the model being called.
  // Retrieval stays on the critical path because the merged prompt needs citations for RECALL_RULE
  // to have anything to recall, and one embed call plus one RPC is not the long pole that a JSON
  // classification call racing a clock was.
  //
  // A rejected retrieval must not be reported to the model as an empty corpus: "no notes matched"
  // and "the search failed" are different facts, and only the first is safe to answer around.
  let citations: Citation[] = [];
  let citationsForPrompt: Citation[] | "failed" = [];
  try {
    citations = await timed("retrieve", retrieve({ db: serviceDb, ai }, {
      userId: args.userId, text, requestId,
    }));
    citationsForPrompt = citations;
    yield { type: "citations", citations };
  } catch (err) {
    console.error(`[assistant] retrieval failed (request ${requestId}): ${errorMessage(err)}`);
    citationsForPrompt = "failed";
    yield { type: "citations", citations: [], degraded: true };
  }
  mark("retrieve settled");

  // `yield*`-delegated so the normal path and the budget-declined early return emit exactly the
  // same events from one place. The check-in write is HERE and not in extractNote, and the
  // distinction matters: the 60-second sweep runs extractNote too, and a sweep that wrote
  // check-ins would manufacture mood history for old notes at arbitrary times, with no screen to
  // undo it on.
  async function* annotationEvents(
    a: Annotation | null,
    alreadySentAttached = false,
  ): AsyncGenerator<AssistantEvent> {
    if (!alreadySentAttached) yield attachedEvent(a);
    if (a?.mood != null) {
      const checkinId = randomUUID();
      try {
        await new CheckinService(userDb, args.userId).createWithId(checkinId, {
          mood: a.mood,
          // The note's timestamp, not now(): offline, the thought can be hours older than the
          // turn that finally reached the server.
          createdAt: noteCreatedAt,
        });
        yield { type: "mood", checkinId, mood: a.mood };
      } catch (err) {
        // A failed check-in must not cost the user their answer.
        console.error(`[assistant] check-in write failed (request ${requestId}): ${errorMessage(err)}`);
      }
    }
  }

  // A circuit breaker, not a budget: it bounds a runaway, and it never costs the user the note or
  // the context around it. The classification's outputs are not the thing being rationed, so they
  // are awaited and emitted here rather than skipped.
  if (await isOverBudget(serviceDb, args.userId, args.budgetUsd, "assistant")) {
    yield* annotationEvents(await classification);
    yield { type: "declined", reason: "budget" };
    return;
  }

  // NO ORDERED CHAIN, and its absence is the change. `wantsAnswer`, `isChitchat` and `verifies`
  // used to select one of three prompts and one of two models from `extracted.intent`, with a
  // deterministic keyword fallback for when classification never ran. That gate misrouted a real
  // question into the acknowledge branch twice -- "Cung điện ký ức là gì?" (2026-08-24) and "Bơi
  // lội có giúp phát triển cơ bắp không" (2026-08-29) -- both times because extraction timed out,
  // and both times on a message the live classifier reads correctly every time it actually runs.
  // One prompt and one model remove the branch rather than widening the fallback again.
  //
  // Resolved once per turn, not per prompt: two calls could not disagree today, but the point
  // of a single resolution is that they cannot start to.
  const timeZone = resolveTimeZone(args.timeZone);
  const now = new Date();
  const prompt = buildTurnPrompt({
    text, citations: citationsForPrompt, history, timeZone, now,
    // Read from chat_messages history at the top of this turn, NOT from the classification --
    // which is what lets S2 §7's ceiling survive the gate's removal intact. See
    // NO_SECOND_QUESTION_RULE in prompts.ts.
    justAsked: pendingAsk !== null,
  });
  const model = ANSWER_MODEL;

  let answer = "";
  let sentAttached = false;
  let incomplete = false;
  // The reason, kept. Until 2026-08-23 the catch below yielded this as an SSE event and let it
  // go: both clients ignore `error` by design, this file's own catch logged nothing (alone among
  // its failure branches -- extraction, retrieval, the check-in write and both ledger writes all
  // console.error with the requestId), and the row it writes carried only `{ requestId,
  // incomplete }`. So the single user-visible failure in the system was the only one that left
  // no evidence anywhere, which is why the "Hello hello" report could be narrowed to "the model
  // stream threw" and no further.
  let streamError: string | null = null;
  let streamUsage: { inputTokens: number; outputTokens: number; model: string } | null = null;
  let grounding: GroundingResult | null = null;
  // Unconditional. The cost of that decision, and the prompt rule that is now the only thing
  // controlling it, are both in the stage spec §7 -- grounding is billed per query at roughly
  // four times a turn's whole token cost, so GROUNDING_RULE is doing real work here.
  mark(`model stream requested (${model}, grounding=true)`);
  try {
    const stream = await ai.generateStream({
      prompt, model, signal: args.signal,
      grounding: true,
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
        // §2. The receipt lands DURING the answer rather than after it, which is what keeps the
        // instant-attachment UX at roughly the wall-clock moment it had before the decoupling.
        // A plain flag read, never an await: awaiting here would stall the token loop.
        if (!sentAttached && annotation !== undefined) {
          sentAttached = true;
          mark("attached emitted mid-stream");
          yield attachedEvent(annotation);
        }
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
    // Capped at 200 for the same reason the event is: a provider can return a long body, and
    // this string is both logged and written to a jsonb column. The message itself is safe to
    // record -- it is the AI client's own error text ("gemini 429", an AbortError), never the
    // prompt or the answer, which §15.6 rule 1 forbids reaching a log.
    streamError = errorMessage(err).slice(0, 200);
    console.error(`[assistant] model stream failed (request ${requestId}): ${streamError}`);
    yield { type: "error", message: streamError };
  }

  // The classification is read HERE, and this is the only point at which this design can add
  // latency to a turn -- bounded by EXTRACT_DEADLINE_MS, and in practice already overtaken by the
  // answer that just finished streaming.
  const extracted = await classification;
  yield* annotationEvents(extracted, sentAttached);
  mark("classification read");

  // These two survive as ANNOTATION only. Neither picks a prompt or a model; they decide what the
  // note is stamped as, which is a different question and one the classifier answers well.
  const isPureQuestion = extracted?.intent === "question";
  const isChitchat = extracted?.intent === "chitchat";

  // A note that already exists, restamped after classification -- the shape 'chat' has used
  // since C1. An ordinary statement is the default branch and writes nothing: every plain
  // capture keeps the 'quick' the row was created with.
  //
  // `intent === "question"`, NOT a reply-routing flag -- and the difference is a recorded
  // thought. A statement the classifier also flagged as asking something -- the eye-strain turn,
  // "Các loại thực phẩm nào tốt cho mắt, dạo này hơi mỏi mắt" -- carries a fact the user recorded,
  // and 00039 makes 'chat' unrecallable, so stamping it here would delete the eye strain from
  // their second brain as a side effect of the sentence also ending in a question mark. `intent`
  // stays "statement" for that turn on purpose: it still drives tagging, domain and the filing
  // tone correctly, and only the reply used to be routed wrong.
  if (isPureQuestion || isChitchat) {
    await userDb.from("notes")
      .update({ source_type: isPureQuestion ? "chat" : "chitchat" })
      .eq("id", args.noteId);
  }

  // S2 §2/§4. Now gates only the RECORDING of `asked`, never a prompt rule -- nothing instructs
  // the model to ask, so there is nothing to exclude. `pendingAsk === null` survives because it is
  // the ceiling on the recording: two chained asks would let a backfill walk backwards through the
  // thread. `extracted &&` survives because a degraded extraction knows of no domain and no gap.
  const gap = extracted && pendingAsk === null
    ? detectEntityGap(extracted.domain, extracted.domainMeta)
    : null;

  // S2 §6. THE BACKFILL. The note the question was about gets the entity link the answer just
  // produced -- and nothing else. Not domain_meta, not content_text: the original note said
  // nothing about a rating, and writing one into it would be putting words in the user's mouth.
  // `userDb`, so RLS proves ownership: pendingAsk.noteId comes out of a jsonb column and is
  // validated nowhere else. Failure is logged and swallowed -- the answer has already streamed.
  let backfilled = false;
  if (pendingAsk !== null && extracted?.mediaItemId !== undefined && pendingAsk.noteId !== args.noteId) {
    const { data, error } = await userDb.from("notes")
      .update({ media_item_id: extracted.mediaItemId })
      .eq("id", pendingAsk.noteId)
      .is("deleted_at", null)      // a note trashed mid-conversation must not be linked
      .is("media_item_id", null)   // and an existing link is never overwritten
      .select("id").maybeSingle();
    if (error) {
      console.error(`[assistant] follow-up backfill failed (request ${requestId}): ${error.message}`);
    } else if (data !== null) {
      backfilled = true;
    }
    mark("follow-up backfilled");
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

  // C5 §11. Gated on `searched`, which is the cost ceiling: a turn that answered from the
  // user's own notes contributed nothing external and makes no extra model call at all.
  // `incomplete` is checked too -- offering to save a fact out of an answer that was cut off
  // mid-sentence proposes a statement nobody, including this process, ever saw whole.
  //
  // `answersAQuestion`, not `searched`. proposeOffer's prompt is hardcoded to "The assistant just
  // answered a question", and Finding 4 of the whole-branch review recorded that `searched` alone
  // is not that -- a turn can ground without having answered anything. This is the same derivation
  // `wantsAnswer` was, read from the classification purely to gate the offer, never to pick a
  // prompt. A degraded extraction produces no offer, which is the safe direction.
  const answersAQuestion = extracted !== null
    && (extracted.intent === "question" || extracted.alsoWantsAnswer === true);
  if (answersAQuestion && searched && !incomplete && answer !== "") {
    const offer = await proposeOffer({ db: serviceDb, ai }, {
      userId: args.userId, question: text, answer,
      ...(webCitations[0]?.url !== undefined ? { sourceUrl: webCitations[0].url } : {}),
      requestId,
    });
    if (offer) {
      yield {
        type: "offer",
        statement: offer.statement,
        ...(offer.sourceUrl !== undefined ? { sourceUrl: offer.sourceUrl } : {}),
      };
    }
    mark("offer resolved");
  }

  const { data: message } = await userDb.from("chat_messages").insert({
    user_id: args.userId, session_id: sessionId, role: "assistant", content: answer,
    // `citations` already carries `type: "note"` from retrieve.ts, so no mapping happens here.
    citations: [...citations, ...webCitations],
    // Spread-if, so a turn that completed carries no `error` key at all rather than an explicit
    // null. A row with an `error` field on it is read by a human as evidence something went
    // wrong, and "went wrong: nothing" is a worse thing to write down than silence.
    retrieval_meta: {
      requestId, incomplete,
      ...(streamError !== null ? { error: streamError } : {}),
      // S2 §5. `asked` records an INSTRUCTION, not an observation: we told the model to ask, and
      // whether it did is only knowable from the text. The `?` test is the honest approximation,
      // and both of its failure directions are harmless -- a rhetorical `?` records a question
      // nobody was asked (the next turn simply finds nothing to backfill), and a question with no
      // `?` goes unrecorded (no backfill, nothing broken).
      //
      // `!incomplete`: an answer that was cut off mid-sentence may have been cut off before the
      // question, so it must not leave one outstanding.
      ...(gap !== null && !incomplete && answer.includes("?")
        ? { asked: { noteId: args.noteId, field: gap.field } }
        : {}),
      // S2 §8. The other half of the pair, and mutually exclusive with `asked`: a turn either
      // asks a question or answers one. One boolean is what turns "how often does a question get
      // answered" into a query instead of a guess -- the thing S1.5 found it had no way to know
      // about offers.
      ...(backfilled ? { answeredAsk: true } : {}),
    },
  }).select("id").single();
  mark("assistant message written");

  if (!incomplete) {
    yield { type: "done", messageId: (message as { id: string } | null)?.id ?? "", sessionId };
  }
  mark("turn complete");
}
