"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import { dayKey, daySeparatorLabel, readEvents, type AnyCitation, type Citation, type Offer, type WebCitation } from "@cortex/shared";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { fetchOlderTurns, type TranscriptClient } from "@/lib/transcript";
import { Provenance } from "./provenance";
import { Markdown } from "./markdown";

type Attached = {
  domain: string | null;
  domainMeta: Record<string, unknown>;
  tags: string[];
  degraded?: boolean;
};

type Web = { sources: WebCitation[]; queries: string[]; entryPoint?: string };

/** The first web source on a reply, which is what turns a save into a 'web_search' note. */
const webUrlOf = (citations: AnyCitation[]): string | undefined =>
  citations.find((c): c is WebCitation => c.type === "web")?.url;

/**
 * Whether `id` is a real `chat_messages.id` (a Postgres `gen_random_uuid()`) rather than one of
 * this file's own placeholders -- `"live"` (saveControl's key for the still-streaming reply),
 * `pending-${t0}` (the optimistic user bubble), or `local-${Date.now()}` (settleWithoutDone's
 * flush of an interrupted stream with no `done` event, so no server id was ever issued). Only a
 * real id can be sent as `forMessageId`: the server would otherwise try to mark a row that does
 * not exist, harmlessly but pointlessly.
 */
const isRealMessageId = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * One row of chat_messages, ready to render. Built in page.tsx, where the jsonb `citations`
 * column is read through readCitation -- the single place a pre-C3 entry with no `type` key
 * becomes a note citation, and a malformed one is dropped rather than taking the transcript
 * down with it.
 */
export interface TranscriptTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: AnyCitation[];
  /** retrieval_meta.incomplete: the stream died mid-answer. Shown, never hidden. */
  incomplete: boolean;
  /**
   * retrieval_meta.savedAnswerNoteId is set. Seeds `saved` on load and after pagination -- see
   * this file's `saved` state doc -- so a reply already kept does not offer "Lưu câu trả lời"
   * again after a reload (reported 2026-08-24).
   */
  savedAsNote: boolean;
  /** ISO. Feeds the day separators (Task 4) and the pagination cursor (Task 5). */
  createdAt: string;
}

/**
 * The one chat box (see memory: Cortex's UI target is a single ChatGPT-style thread, not
 * the domain forms). Past captures render as user bubbles above the composer; mood, media
 * and domain/tag are attached by the assistant itself rather than picked in this UI --
 * the sidebar's widgets exist only as accelerators, never as the primary path.
 */
export function AssistantBox(
  {
    token, userId, initialTurns, hasMore,
    // Overridable only for tests: the real default calls createClient()
    // (apps/web/src/lib/supabase/client.ts), which throws in the jsdom test environment because
    // NEXT_PUBLIC_SUPABASE_URL/ANON_KEY are unset there -- createBrowserClient checks eagerly,
    // before ever making a request, so no amount of stubbing global fetch reaches it. Tests pass
    // a fake here instead; no caller outside a test ever does.
    //
    // Cast to TranscriptClient rather than left inferred: the real SupabaseClient's generics are
    // deep enough that structurally checking it against TranscriptClient's chained call shape
    // inline hits TS2589 ("Type instantiation is excessively deep and possibly infinite"). The
    // cast is where that structural match is asserted once, instead of on every call site.
    fetchOlder = (before: string) =>
      fetchOlderTurns(createClient() as unknown as TranscriptClient, userId, before),
    // THE TOKEN IS READ PER REQUEST, never once. `token` above comes from page.tsx, which reads
    // it server-side at render and cannot read it again -- a Supabase access token expires in an
    // hour, and an open chat tab performs no navigation, so middleware.ts's cookie refresh never
    // runs. The box therefore went on presenting a dead JWT until the user reloaded the page
    // (reported 2026-08-23: "web online nếu để yên đó 1 lát vô chat sẽ bị lỗi, phải refresh
    // page"). Mobile never had this bug because every call site there awaits getSession() first,
    // and getSession() refreshes an expired token before returning it -- this is that, on web.
    //
    // Overridable for the same reason fetchOlder is, and NOT because a caller outside a test
    // ever passes it: createClient() checks NEXT_PUBLIC_SUPABASE_URL/ANON_KEY eagerly and throws
    // under jsdom, where this component's tests run.
    getToken = async () => {
      const { data: { session } } = await createClient().auth.getSession();
      return session?.access_token ?? token;
    },
  }:
    {
      token: string;
      userId: string;
      initialTurns?: TranscriptTurn[];
      hasMore?: boolean;
      fetchOlder?: (before: string) => ReturnType<typeof fetchOlderTurns>;
      getToken?: () => Promise<string>;
    },
) {
  /**
   * The token for the request about to be made, with the SSR one as the floor.
   *
   * Both fallbacks are load-bearing and they cover different failures. An empty/absent session
   * is the ordinary one -- a client that has not read the cookie yet -- and `token` is a real,
   * valid token for the first hour, so falling back to it is what keeps the very first turn
   * after a page load working instead of sending `Bearer undefined`. A THROW is the other:
   * getSession() reaches storage and can fail, and a token read is not worth losing the note
   * over when a possibly-stale token is right there and the server will say so if it is dead.
   */
  const authToken = async (): Promise<string> => {
    try {
      return (await getToken()) || token;
    } catch {
      return token;
    }
  };
  const [turns, setTurns] = useState<TranscriptTurn[]>(initialTurns ?? []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Separate from `status`: `status` covers outcomes AFTER the note is saved (a dead stream,
  // a budget decline). `error` covers the save itself failing -- nothing was written, so it
  // reads differently ("Couldn't save") and, unlike `status`, the text must not be cleared.
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<Attached | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [web, setWeb] = useState<Web | null>(null);
  const [answer, setAnswer] = useState("");
  // NOT reset by flushLiveIntoTurns: unlike attached/citations/web/answer, the offer must
  // survive the hand-off into `turns` -- it is the whole point of the row, and it disappears
  // only when the user acts on it (accept/decline) or the next submit() starts.
  //
  // `messageId` is NOT part of the wire `Offer` -- the server emits the offer (turn.ts) before
  // it has written the chat_messages row the offer is about, so there is no id to send at that
  // point. It is patched in here once `done` supplies one (below), so acceptOffer can link the
  // save back to the reply it came from -- without it, accepting an offer left that reply's own
  // "Lưu câu trả lời" control still offering the same save (reported together with the reload
  // defect, 2026-08-24: same root cause, one control earlier).
  const [offer, setOffer] = useState<(Offer & { messageId?: string }) | null>(null);
  // The MANUAL save, distinct from `offer` above in both direction and meaning: `offer` is the
  // assistant proposing something unasked, this is the user asking. They can be on screen at the
  // same time, on the same reply, which is why the two boxes are labelled differently rather than
  // being two identically-named buttons.
  const [proposal, setProposal] = useState<
    { forId: string; statement: string; sourceUrl?: string } | null
  >(null);
  const [proposing, setProposing] = useState<string | null>(null);
  // Which turns the user has already kept an answer from, by turn id. Used to be client-side and
  // per-session ONLY, which forgot every save on reload (reported 2026-08-24) -- durable now via
  // retrieval_meta.savedAnswerNoteId (save-answer.ts's markMessageSaved), seeded below. This Set
  // still exists for the gap a durable flag cannot cover on its own: the instant BETWEEN a save
  // and the next reload, before the server round trip that would prove it even resolves.
  const [saved, setSaved] = useState<ReadonlySet<string>>(
    // Seeded from the server's own record of what was saved (retrieval_meta.savedAnswerNoteId,
    // set by save-answer.ts), not just the empty set a fresh session used to start from -- that
    // omission is exactly what made "Lưu câu trả lời" reappear on every reload (reported
    // 2026-08-24) for a reply that had, in fact, already been kept.
    () => new Set((initialTurns ?? []).filter((t) => t.savedAsNote).map((t) => t.id)),
  );
  // The note whose turn died before producing anything, so the hint can offer to run it again.
  // Null whenever there is nothing to retry, which is almost always.
  //
  // Why it holds a NOTE ID rather than a boolean: the note is already saved by the time a stream
  // can fail, so the retry must re-run the ANSWER only. A retry that went through submit() again
  // would call createNote a second time and leave the user with two copies of one message.
  const [retryNoteId, setRetryNoteId] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [more, setMore] = useState(hasMore ?? false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Mirrors `answer` without the stale-closure lag: the SSE event loop is one long-lived async
  // function whose closure captured `answer` at call time, so `setAnswer` updates the state the
  // NEXT render sees but the loop's own reads of `answer` never do. The `done` branch needs the
  // full text the instant it arrives, not next-render's copy of it.
  const answerRef = useRef("");
  // Same stale-closure problem as `answerRef`, for the other two pieces the `done` branch reads:
  // without these, `done` sees whatever `citations`/`web` were at the moment `submit()` was
  // called (always the pre-turn empty values), so every persisted turn silently lost its note
  // and web citations. Caught by the pre-existing "renders attached and citations whichever
  // order they arrive in" test, which asserts the citation survives past `done`.
  const citationsRef = useRef<Citation[]>([]);
  const webRef = useRef<Web | null>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  /**
   * What to tell the user while the turn is in flight, or null when nothing is.
   *
   * Three phases and no more, because three is how many the server actually reports. The long
   * silence users hit is the middle one -- the model is searching the web, and the `web` event
   * that would say so is emitted only AFTER the stream completes (turn.ts:295). So this says
   * "looking for an answer" and not "searching the web": the box does not know whether this
   * turn grounded, and printing a guess as a fact is worse than printing less.
   *
   * Once tokens arrive there is no label at all -- the tokens are the progress.
   */
  const phase: string | null =
    !busy || answer !== ""
      ? null
      : attached === null && citations.length === 0
        ? "Đang lưu…"
        : "Đang tìm câu trả lời…";

  // Keeps the newest turn in view -- the reply bubble, the loading indicator and errors all
  // land at the bottom of an ever-growing thread, exactly the case a chat UI has to autoscroll
  // for. Only the LIVE parts of the turn scroll the thread down. `turns` was in this list, and
  // with pagination it must not be: loading older messages prepends to the front, and an effect
  // that pins to the bottom on every `turns` change would undo the scroll-anchoring in
  // loadOlder() below instantly. Because `turns` leaves this list, a newly sent message needs
  // its own explicit scroll-to-bottom -- added at the end of the optimistic-bubble block in
  // submit().
  useEffect(() => {
    // `scrollTop =` rather than `.scrollTo(...)`: it's a plain property every DOM
    // implementation (including jsdom, where this component's tests run) supports, with
    // no smooth-scroll API surface to be missing.
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [attached, citations, web, answer, status, error, phase]);

  // Scroll-anchored, and this is the fiddly half. Prepending rows moves everything the user was
  // reading downward by the height of what arrived; capturing scrollHeight before the paint and
  // restoring the delta after it is what keeps their place. Without it the thread jumps to the
  // top on every page and the user cannot read backwards at all.
  async function loadOlder() {
    const el = scrollRef.current;
    const oldest = turns[0];
    if (!el || !oldest || loadingOlder || !more) return;
    setLoadingOlder(true);
    const heightBefore = el.scrollHeight;
    try {
      const { turns: older, hasMore: stillMore } = await fetchOlder(oldest.createdAt);
      setTurns((prev) => [...older, ...prev]);
      // Same seeding loadOlder's caller (initialTurns) already gets -- a page loaded further
      // back in the thread must carry the same "already saved" evidence, or scrolling up would
      // un-save every reply that scrolls into view.
      const nowSaved = older.filter((t) => t.savedAsNote).map((t) => t.id);
      if (nowSaved.length > 0) setSaved((prev) => new Set([...prev, ...nowSaved]));
      setMore(stillMore);
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - heightBefore; });
    } catch {
      // Leave `more` alone: a failed fetch is not proof the thread ended, and setting it false
      // would make one dropped request look permanently like the beginning of history.
    } finally {
      setLoadingOlder(false);
    }
  }

  /**
   * Everything a turn resets before it starts. Shared by submit() and by the retry, because the
   * retry is a second run of the same turn and must start from the same blank state -- leaving
   * `answer` or `citations` behind would append the second attempt to the first.
   */
  function resetLiveTurn() {
    setStatus(null);
    setError(null);
    setAttached(null);
    setCitations([]);
    setWeb(null);
    setAnswer("");
    setOffer(null);
    setRetryNoteId(null);
    answerRef.current = "";
    citationsRef.current = [];
    webRef.current = null;
  }

  async function submit() {
    if (!text.trim() || busy) return;
    // Diagnostic only, temporary: one line per milestone on this turn, all relative to t0, with
    // requestId correlating to the matching `[assistant:timing]` lines runTurn logs server-side.
    const t0 = Date.now();
    const requestId = Math.random().toString(36).slice(2, 8);
    const mark = (label: string) =>
      console.log(`[assistant-box:timing] ${requestId} ${label} +${Date.now() - t0}ms`);
    mark("submit");

    const pendingText = text;
    setBusy(true);
    resetLiveTurn();

    // Shown the INSTANT Send is pressed, before createNote is even awaited -- otherwise `busy`
    // (and therefore `phase`'s "Đang lưu…") goes true a whole network round trip before this
    // turn's own bubble exists, and the thread reads backwards: the assistant appears to be
    // thinking about a message the user cannot see yet (observed 2026-08-17). A temp id keeps
    // this reconcilable: swapped for the real note id on success below, removed entirely on
    // failure, which is what keeps "never a bubble for a message that was never actually saved"
    // true -- enforced by removal now instead of by delay.
    const tempId = `pending-${t0}`;
    setTurns((prev) => [...prev, {
      id: tempId, role: "user", content: pendingText, citations: [], incomplete: false,
      savedAsNote: false, createdAt: new Date().toISOString(),
    }]);
    setText("");
    // The user just pressed Send; their own bubble must be visible. Explicit now that `turns`
    // no longer drives the autoscroll effect.
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });

    let note: { id: string };
    try {
      // Awaited in its OWN try/catch. The note is the deliverable; the answer is a bonus.
      note = await api.createNote(await authToken(), { content: pendingText });
      mark("note saved");
    } catch {
      setTurns((prev) => prev.filter((t) => t.id !== tempId));
      setText(pendingText);
      setError("Couldn't save — your text is still here.");
      setBusy(false);
      mark("note save failed");
      return;
    }

    // Reconciled to the server's real id -- a reload replaces this turn with the persisted one
    // from chat_messages either way, so the id only has to be locally unique until then.
    setTurns((prev) => prev.map((t) => (t.id === tempId ? { ...t, id: note.id } : t)));

    await streamTurn(note.id, mark);
  }

  /**
   * The answer half of a turn, for a note that is ALREADY SAVED.
   *
   * Split out of submit() so the retry (below the "no answer" hint) can run it again without
   * calling createNote a second time -- a retry that re-saved would leave the user with two
   * copies of their own message for one thing they typed. `setBusy(false)` in the finally covers
   * both callers; `setBusy(true)` belongs to each caller, because submit() must go busy before
   * the note is even saved and the retry has nothing to save.
   */
  async function streamTurn(noteId: string, mark: (label: string) => void) {

    // THE HAND-OFF, generalized. Both the normal "done" event and an interrupted stream that
    // ends without one migrate the live state into `turns` through this one path, so there is
    // exactly one place that resets `attached`/`answer`/`citations`/`web`/`status` together.
    // Before this, `done` cleared everything EXCEPT `attached` -- nothing else ever reset it, so
    // a bare "Filed under: X" bubble (the live reply bubble with everything else empty) sat below
    // the transcript forever, until the next submit() overwrote it. `status` had the same bug on
    // the interrupted path specifically: once that path started migrating the answer into
    // `turns` too, the "Saved. No answer right now." hint set by the (now-removed) inline `error`
    // handler was never cleared alongside it, so a second, decoupled bubble containing only that
    // hint sat below the just-landed interrupted turn. Reads the *Ref mirrors, not the
    // `citations`/`web` state directly: this event loop is one long-lived async function whose
    // closure captured those at call time, so the state variables here are always their pre-turn
    // values (usually empty) -- same stale-closure trap `answerRef` exists for.
    const flushLiveIntoTurns = (id: string, incomplete: boolean) => {
      setTurns((prev) => [...prev, {
        id,
        role: "assistant",
        content: answerRef.current,
        citations: [...citationsRef.current, ...(webRef.current?.sources ?? [])],
        incomplete,
        // Never true here: this turn has no server-persisted retrieval_meta yet, so it cannot
        // yet be marked FROM the server. A save made while it was still "live" is carried across
        // through `saved` below instead, keyed on the real id from this point on.
        savedAsNote: false,
        createdAt: new Date().toISOString(),
      }]);
      // The reply just moved from being rendered under the "live" key (saveControl("live", ...))
      // to being rendered under its real id -- see the render below. Without this, a reply saved
      // WHILE STREAMING loses its "Đã lưu" the instant the stream finishes: `saved` still holds
      // "live", nothing holds `id`, and saveControl reads `saved.has(id)`. Reported together with
      // the reload defect (2026-08-24) -- same root cause, one turn earlier.
      setSaved((prev) => {
        if (!prev.has("live")) return prev;
        const next = new Set(prev);
        next.delete("live");
        next.add(id);
        return next;
      });
      setAttached(null);
      setAnswer("");
      setCitations([]);
      setWeb(null);
      setStatus(null);
    };

    // Set inside the `done` branch below. turn.ts:363 yields `done` only `if (!incomplete)` --
    // an interrupted turn (network drop, mid-stream model error) gets its row written to
    // chat_messages with `retrieval_meta.incomplete: true` but NO `done` event, so the stream
    // just ends. Without tracking this, that partial answer stayed solely in the ephemeral
    // `answer`/`citations` state: the next submit() resets them at the top of this function, and
    // the interrupted reply vanished from the screen entirely until a full reload re-read it
    // from chat_messages -- exactly backwards from the brief's "shown, never hidden" for
    // `incomplete`.
    let sawDone = false;
    // A DECLINED turn is NOT an interrupted one -- turn.ts:239-240 yields `citations` (so
    // `citationsRef.current` is routinely non-empty by then) and then `declined`, and returns
    // BEFORE ever inserting a chat_messages row at all. Flushing that into `turns` would invent
    // a phantom turn with no row behind it. `declined` and `error` both also end the stream
    // without `done`, so this flag is what tells the settle step apart from a genuine mid-answer
    // interruption.
    let declined = false;

    // Called once, after the stream has ended one way or another (loop exhausted, or the read
    // itself threw) without a `done` event. Decides between the two things a dead stream can
    // mean: something was already produced and belongs in the transcript as an interrupted turn
    // (the turn's own "interrupted" marker then carries the explanation, so a separate hint
    // would be redundant), or nothing was produced yet and the hint is the ONLY thing telling the
    // user their note is still safe. `declined` never reaches here with a message to show -- its
    // own branch above already set one, and it must not be overwritten.
    const settleWithoutDone = () => {
      if (sawDone || declined) return;
      if (answerRef.current !== "" || citationsRef.current.length > 0 || webRef.current) {
        flushLiveIntoTurns(`local-${Date.now()}`, true);
      } else {
        // Nothing was produced at all. The note is safe, and the turn is worth another go: the
        // failures that land here are transient by nature (a 429, a dropped stream, a provider
        // blip -- see turn.ts's stream catch). Until 2026-08-23 this was a dead end, and the
        // only way forward was to retype the message, which saved it a second time.
        setStatus("Đã lưu. Chưa trả lời được.");
        setRetryNoteId(noteId);
      }
    };

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await authToken()}` },
        body: JSON.stringify({
          noteId,
          // Read per turn rather than captured once: it costs nothing and it is correct across
          // a DST change or a flight. The server validates it (resolveTimeZone) -- this value
          // comes from the browser, and the browser is not trusted input.
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      mark(`fetch headers received (status ${res.status})`);
      if (!res.ok || !res.body) {
        // Same dead end as settleWithoutDone's empty branch, reached one step earlier -- a 5xx
        // or a 401 rather than a stream that opened and died. Offer the same way out.
        setStatus("Đã lưu. Chưa trả lời được.");
        setRetryNoteId(noteId);
        return;
      }
      let sawFirstToken = false;
      for await (const ev of readEvents(res.body)) {
        if (ev.type === "attached") { mark("event: attached"); setAttached(ev.data as unknown as Attached); }
        else if (ev.type === "citations") {
          mark("event: citations");
          const cs = (ev.data as unknown as { citations: Citation[] }).citations;
          citationsRef.current = cs;
          setCitations(cs);
        } else if (ev.type === "token") {
          // First token only -- one line per streamed chunk would flood the console on a long
          // answer and bury the milestone that actually matters (how long the silence was).
          if (!sawFirstToken) { sawFirstToken = true; mark("event: first token"); }
          const chunk = String((ev.data as { text?: unknown }).text ?? "");
          answerRef.current += chunk;
          setAnswer((a) => a + chunk);
        } else if (ev.type === "web") {
          mark("event: web");
          const d = ev.data as { sources?: unknown; queries?: unknown; entryPoint?: unknown };
          const w: Web = {
            sources: (Array.isArray(d.sources) ? d.sources : []) as WebCitation[],
            queries: (Array.isArray(d.queries) ? d.queries : []) as string[],
            ...(typeof d.entryPoint === "string" ? { entryPoint: d.entryPoint } : {}),
          };
          webRef.current = w;
          setWeb(w);
        } else if (ev.type === "offer") {
          mark("event: offer");
          const d = ev.data as { statement?: unknown; sourceUrl?: unknown };
          if (typeof d.statement === "string" && d.statement !== "") {
            setOffer({
              statement: d.statement,
              ...(typeof d.sourceUrl === "string" ? { sourceUrl: d.sourceUrl } : {}),
            });
          }
        } else if (ev.type === "declined") {
          mark("event: declined");
          declined = true;
          // No retry offered here, deliberately: the budget will still be spent a second later,
          // so a retry button would be a control that is guaranteed not to work.
          setStatus("Đã lưu. Chưa trả lời được (đã chạm giới hạn chi tiêu).");
        }
        // "error" is intentionally NOT handled here. It always means the stream will end without
        // a `done` -- but whether that deserves a status hint or an interrupted transcript row
        // depends on whether anything was produced before it, which is only knowable once the
        // stream has actually finished. settleWithoutDone(), below, makes that call once.
        else if (ev.type === "done") {
          mark("event: done");
          sawDone = true;
          const d = ev.data as { messageId?: unknown };
          const id = typeof d.messageId === "string" && d.messageId !== "" ? d.messageId : `local-${Date.now()}`;
          flushLiveIntoTurns(id, false);
          // See `offer`'s declaration: this is the first point a real id exists for the offer
          // (if any) to carry. A no-op when there is no offer on screen.
          setOffer((o) => (o ? { ...o, messageId: id } : o));
        }
      }

      mark("stream loop exited");
      settleWithoutDone();
    } catch {
      // The note was already saved above -- only the stream failed (the read itself threw,
      // rather than the server sending an orderly "error" event). Same rule: keep whatever was
      // accumulated before the connection died, marked incomplete, or fall back to the hint if
      // nothing was ever produced. `declined` can't be true here (its branch never throws), but
      // settleWithoutDone() checks it anyway rather than this call site relying on that.
      mark("stream threw");
      settleWithoutDone();
    } finally {
      setBusy(false);
      mark("submit finished");
    }
  }

  // Cleared immediately -- optimistic, same as the rest of this box's saves. A failed write
  // here costs the user one skipped note, not their answer or their transcript, so there is
  // nothing worth rolling the UI back to.
  async function acceptOffer(o: Offer & { messageId?: string }) {
    setOffer(null);
    // Marked the same way confirmSave marks a manual save: optimistically, before the write.
    // Without this, accepting an offer left the SAME reply's own "Lưu câu trả lời" control
    // still offering the identical save -- the offer row disappeared, but the button under the
    // reply it was about did not know anything had happened (reported 2026-08-24, alongside the
    // reload defect this shares a root cause with). No-op when `messageId` never arrived --
    // see `offer`'s declaration for when that happens.
    if (o.messageId !== undefined) {
      setSaved((prev) => new Set(prev).add(o.messageId!));
    }
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/notes/save-answer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await authToken()}` },
        body: JSON.stringify({
          statement: o.statement,
          ...(o.sourceUrl !== undefined ? { sourceUrl: o.sourceUrl } : {}),
          ...(o.messageId !== undefined ? { forMessageId: o.messageId } : {}),
        }),
      });
    } catch {
      // Best-effort: the offer is already off the screen, and re-showing it after a failed
      // save would be its own kind of nag. Nothing else to do here today.
    }
  }

  // §11: "declining costs nothing" -- a claim about LATENCY as much as about writes. setOffer(null)
  // runs FIRST, synchronously, and the fetch below is deliberately NOT awaited ahead of it: the
  // offer must be gone the instant the button is clicked, whether the network is slow, offline, or
  // the request fails outright. If the write never lands, the worst case is the same fact gets
  // offered again later -- fine, per §11 -- which is why the catch below does nothing at all.
  function declineOffer(o: Offer) {
    setOffer(null);
    // The token read is INSIDE the void-ed chain, and this function stays non-async, so
    // setOffer(null) above is still the first and only synchronous thing that happens. Making
    // this `async` to await the token would put a promise tick between the click and the state
    // update -- the exact latency §11 says declining must not have.
    void (async () => {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/assistant/decline`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await authToken()}` },
        body: JSON.stringify({ statement: o.statement }),
      });
    })().catch(() => {
      // Best-effort, same as acceptOffer: the offer is already off the screen.
    });
  }

  /**
   * Ask the server to condense a reply, then show it back for confirmation. Writes nothing.
   *
   * NEVER dead-ends: a null statement, a non-200, or a thrown fetch all fall through to the
   * verbatim reply. The user pressed a button and must get a box either way -- a silent no-op is
   * indistinguishable from a broken control.
   */
  async function proposeSave(forId: string, answerText: string, question?: string, sourceUrl?: string) {
    setProposal(null);
    setProposing(forId);
    let statement = answerText;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/assistant/distill`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await authToken()}` },
        body: JSON.stringify({ answer: answerText, ...(question ? { question } : {}) }),
      });
      if (res.ok) {
        const d = (await res.json()) as { statement: string | null };
        if (typeof d.statement === "string" && d.statement !== "") statement = d.statement;
      }
    } catch {
      // Fall through to the verbatim reply, deliberately silent: the box below IS the feedback.
    } finally {
      setProposing(null);
    }
    setProposal({ forId, statement, ...(sourceUrl !== undefined ? { sourceUrl } : {}) });
  }

  /**
   * The write. Same endpoint and same body shape the offer's accept uses, which is what makes the
   * two produce an identical row -- see save-answer.ts's buildSavedAnswerRow doc.
   *
   * Dismissing instead calls NOTHING. Not POST /assistant/decline: a decline records that the
   * ASSISTANT should stop offering a fact, and the user declining to keep an answer they asked
   * about is not that.
   */
  async function confirmSave(p: { forId: string; statement: string; sourceUrl?: string }) {
    setProposal(null);
    // Marked BEFORE the write, and optimistically, matching every other save in this box. A
    // failed write costs the user one skipped note; a control that keeps offering a save they
    // already made is a nag they cannot silence, and it was the second half of the 2026-08-23
    // report ("lưu xong nó vẫn hiện tiếp cái 'Lưu câu trả lời'").
    //
    // A NEW Set, never `prev.add(...)`: mutating the existing one returns the same reference,
    // React bails out of the re-render, and the label never changes on screen.
    setSaved((prev) => new Set(prev).add(p.forId));
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/notes/save-answer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await authToken()}` },
        body: JSON.stringify({
          statement: p.statement,
          ...(p.sourceUrl !== undefined ? { sourceUrl: p.sourceUrl } : {}),
          // Only when `forId` is a real chat_messages id -- see isRealMessageId's doc. "live" (a
          // reply saved while still streaming) has none yet; the save still succeeds, it just
          // cannot be marked durably until a reply exists to mark.
          ...(isRealMessageId(p.forId) ? { forMessageId: p.forId } : {}),
        }),
      });
    } catch {
      // Best-effort, same as acceptOffer: the box is already off screen.
    }
  }

  const hasReply =
    attached !== null || citations.length > 0 || web !== null || answer !== "" || status !== null;

  // Read once per render, not per row: Intl resolution is not free and the answer cannot change
  // between two rows of the same paint.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();

  /**
   * The save control for one reply, and its confirmation, TOGETHER.
   *
   * The two used to live apart: the button on every turn, the confirmation as the last child of
   * `.chat-scroll`. The control was therefore already on every reply -- the user's "lỡ tôi muốn
   * lưu của mấy cái chat trước thì sao?" (2026-08-23) was about the CONFIRMATION, which popped
   * up at the bottom of the thread with nothing tying it to the reply it came from. `forId` was
   * being tracked and never read. Rendering the pair from one place is what makes it impossible
   * for them to drift apart again.
   *
   * A function rather than a component: it closes over `proposal`/`proposing`/`saved` and is
   * called from exactly two sites in the same render.
   */
  const saveControl = (forId: string, answerText: string, question?: string, sourceUrl?: string) => (
    <>
      {saved.has(forId) ? (
        // Replaces the control rather than sitting beside it. Leaving a live "Lưu câu trả lời"
        // next to "đã lưu" is the same nag with a label attached.
        <p className="saved-answer" role="status">Đã lưu vào notes</p>
      ) : (
        <button
          type="button"
          className="save-answer"
          disabled={proposing === forId}
          onClick={() => void proposeSave(forId, answerText, question, sourceUrl)}
        >
          {proposing === forId ? "Đang rút gọn…" : "Lưu câu trả lời"}
        </button>
      )}
      {proposal?.forId === forId && (
        // Deliberately worded differently from the offer box. Both can be on screen at once, on
        // the same reply, and they mean different things: the offer's statement was chosen by
        // the assistant, this one by the user. Two buttons both saying "Lưu" would be a coin flip.
        <div className="save-proposal" role="group" aria-label="Lưu câu trả lời này?">
          <p>{proposal.statement}</p>
          <button type="button" onClick={() => void confirmSave(proposal)}>Lưu câu này</button>
          <button type="button" onClick={() => setProposal(null)}>Thôi</button>
        </div>
      )}
    </>
  );

  return (
    <div className="chat-pane">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => { if (e.currentTarget.scrollTop < 80) void loadOlder(); }}
      >
        {more && (
          <p className="chat-older" role="status">
            {loadingOlder ? "Đang tải…" : "Cuộn lên để xem thêm"}
          </p>
        )}

        {turns.length === 0 && !hasReply && (
          <p className="chat-empty">What are you thinking?</p>
        )}

        {turns.map((t, i) => {
          const prev = i > 0 ? turns[i - 1] : undefined;
          const key = dayKey(t.createdAt, timeZone);
          // A separator before the FIRST row too (prev === undefined): the top of a loaded page
          // is a day boundary as far as the reader is concerned, and without it the oldest
          // visible day is the only undated one on screen.
          const showSeparator = key !== "" && (prev === undefined || dayKey(prev.createdAt, timeZone) !== key);
          return (
            <Fragment key={t.id}>
              {showSeparator && (
                <p className="day-separator" role="separator">
                  {daySeparatorLabel(t.createdAt, now, timeZone)}
                </p>
              )}
              {t.role === "user" ? (
                <div className="bubble user"><p>{t.content}</p></div>
              ) : (
                <div className="bubble assistant">
                  <Provenance citations={t.citations} />
                  {t.content && <div className="answer"><Markdown>{t.content}</Markdown></div>}
                  {t.incomplete && (
                    // An interrupted answer and a short answer are the same string in `content`.
                    // Only retrieval_meta.incomplete tells them apart, and the user is the one who
                    // needs to know -- the model is already shielded from it at turn.ts:134.
                    <p className="interrupted" role="note">Câu trả lời bị gián đoạn (interrupted).</p>
                  )}
                  {t.content && saveControl(
                    t.id,
                    t.content,
                    turns[i - 1]?.role === "user" ? turns[i - 1]!.content : undefined,
                    webUrlOf(t.citations),
                  )}
                </div>
              )}
            </Fragment>
          );
        })}

        {hasReply && (
          <div className="bubble assistant">
            {/* attached and citations are separate pieces of state: the server emits them
                concurrently, and either can arrive first. */}
            {attached && (
              <p className="attached">
                {attached.domain ? `Filed under: ${attached.domain}` : "Not filed under a domain"}
                {attached.tags.length > 0 ? ` — tagged ${attached.tags.join(", ")}` : ""}
              </p>
            )}

            <Provenance
              citations={[...citations, ...(web?.sources ?? [])]}
              {...(web?.entryPoint !== undefined ? { entryPoint: web.entryPoint } : {})}
            />

            {answer && <div className="answer"><Markdown>{answer}</Markdown></div>}

            {answer && saveControl("live", answer, undefined, web?.sources[0]?.url)}

            {!error && status && (
              <p className="hint" role="status">
                {status}
                {retryNoteId && (
                  // Re-runs the ANSWER for a note that is already saved -- never submit(), which
                  // would createNote again and leave two copies of one message.
                  <>
                    {" "}
                    <button
                      type="button"
                      className="save-answer"
                      disabled={busy}
                      onClick={() => {
                        const id = retryNoteId;
                        setBusy(true);
                        resetLiveTurn();
                        void streamTurn(id, () => {});
                      }}
                    >
                      Thử lại
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
        )}

        {offer && (
          // One line, two buttons, easy to ignore (§11). Not a modal and not a blocking step:
          // an offer that interrupts is a nag, and a nag is what makes a user stop reading them.
          // Rendered OUTSIDE `hasReply`, deliberately: `hasReply` goes false the instant the
          // turn's live state is flushed into `turns` (done event), and the offer must still be
          // sitting on screen after that -- it is not part of the ephemeral reply, it is its own
          // standing prompt until the user acts on it.
          <div className="offer" role="group" aria-label="Lưu vào notes?">
            <p>{offer.statement}</p>
            <button type="button" onClick={() => void acceptOffer(offer)}>Lưu</button>
            <button type="button" onClick={() => void declineOffer(offer)}>Bỏ qua</button>
          </div>
        )}

        {/* The proposal used to render HERE, as the last child of the scroll, which is why
            saving a reply from this morning popped a box under the newest message with nothing
            connecting the two. It now renders inside the turn it names -- see saveControl. */}

        {phase && (
          // aria-live="polite" and not "assertive": this is progress, and it must not interrupt
          // a screen reader mid-sentence on a label that changes twice a turn.
          <div className="bubble assistant thinking" role="status" aria-live="polite">
            <p>{phase}<span className="dots" aria-hidden="true" /></p>
          </div>
        )}
      </div>

      {error && (
        <p className="error chat-error" role="alert">
          {error} <button type="button" onClick={() => void submit()}>Retry</button>
        </p>
      )}

      {!online && (
        <p className="chat-offline" role="status">
          Mất mạng — chưa gửi được. Hội thoại cũ vẫn xem được.
        </p>
      )}

      {/* The wrapper carries the page padding and the safe-area inset; the form is the bordered
          control itself. See globals.css -- putting the inset on the form would pad the text
          away from its own border rather than away from the bottom of the screen. */}
      <div className="chat-composer-wrap">
      <form
        className="chat-composer"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <textarea
          rows={1}
          value={text}
          placeholder="What are you thinking?"
          aria-label="What are you thinking?"
          disabled={busy || !online}
          onChange={(e) => {
            setText(e.target.value);
            // Reset before measuring: scrollHeight never shrinks on its own, so without the
            // first line the box grows and never comes back down after a delete.
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
          }}
          onKeyDown={(e) => {
            // Shift+Enter is a newline; the browser's default already does that, so the only
            // job here is to NOT intercept it. Cmd/Ctrl+Enter is kept as well -- it was the
            // only way to send until 2026-08-22 and muscle memory is cheap to honour.
            if (e.key !== "Enter") return;
            if (e.shiftKey) return;
            e.preventDefault();
            void submit();
          }}
        />
        {/* The visible glyph is an arrow, so the accessible name has to be supplied separately --
            and it must still match /send/i: three tests in assistant-box.test.tsx select this
            control by that name, and so does apps/web/e2e. */}
        <button type="submit" disabled={busy || !online} aria-label="Send" title="Send">
          <span aria-hidden="true">↑</span>
        </button>
      </form>
      </div>
    </div>
  );
}
