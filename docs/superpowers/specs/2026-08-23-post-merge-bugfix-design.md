# Stage B1 design — the eight defects found testing the merged chat shell

**Date:** 2026-08-23
**Status:** design
**Reported by:** the user, testing `main` at 740ff90 (stage S3 merged) on web (desktop + phone
browser) and on the Android dev client.

This is a defect stage, not a feature stage. Every item below is a reported symptom, traced to a
root cause in this repo, with the evidence that fixed the cause rather than the guess.

---

## 1. Web forgets it has a session (reported: "không có refresh token")

**Symptom.** Leave the web app open a while, come back, type into the chat box: it fails. A
page refresh fixes it. Mobile was unknown to the reporter.

**Root cause.** `apps/web/src/app/page.tsx:63` reads the access token once, server-side, and
passes it into a client component as a **prop**:

```tsx
<AssistantBox token={session.access_token} ... />
```

`AssistantBox` then sends that one string on every request it ever makes — `api.createNote`,
`POST /assistant`, `POST /assistant/distill`, `POST /notes/save-answer`,
`POST /assistant/decline`. A Supabase access token expires in an hour. The token in the prop
does not change, because nothing re-renders the server component: `middleware.ts:20` refreshes
the cookie, but only on a **navigation**, and an open chat tab performs none. So the box goes on
presenting a dead JWT until the user reloads.

**Mobile is not affected**, and this is worth stating because the reporter asked. Every mobile
call site reads `await supabase.auth.getSession()` immediately before use
(`assistant-box.tsx:97`, `chat.tsx:84`, `chat.tsx:100`, `connector.ts:59`, `connector.ts:99`),
and `supabase.ts:13` sets `autoRefreshToken: true`. `getSession()` refreshes an expired token
before returning it. Mobile re-reads; web memoised.

**Fix.** The web box reads the token the same way mobile does — per request, from the browser
client — with the SSR token as the first-render fallback. Injectable for tests, exactly as
`fetchOlder` already is in that file and for the same reason (`createClient()` throws under
jsdom).

---

## 2. Web is laid out for a 980px screen (reported: "web khi xài ở đt bị break UI")

**Root cause.** `apps/web/src/app/layout.tsx` exports `metadata` and **no `viewport`**. Next.js
App Router emits `<meta name="viewport">` only from a `viewport` export; without one there is no
tag at all, so mobile browsers fall back to a 980px layout viewport and scale the page down.
Everything sized in the stylesheet — the 720px column, the 78% bubbles, the composer — is being
laid out against a viewport twice the width of the device and then shrunk.

`globals.css:32`'s `height: 100dvh` is measured against that same wrong viewport, which is the
second half of the breakage: the composer does not sit where the visible bottom of the screen is.

**Fix.** Export a viewport. Then a responsive pass over `globals.css`, which has never been read
at a real phone width.

---

## 3. Mobile: the composer is under the keyboard and under the nav bar

**Root cause, two independent ones.**

`apps/mobile/src/screens/chat.tsx:113`:

```tsx
behavior={Platform.OS === "ios" ? "padding" : undefined}
```

`undefined` is not a default — it is `KeyboardAvoidingView` doing **nothing**. Android gets no
keyboard avoidance whatsoever, so the soft keyboard draws straight over the composer and the user
cannot see what they are typing.

Separately, nothing in the tree applies a bottom safe-area inset. `react-native-safe-area-context`
is already a dependency (`package.json`) and is not imported anywhere, and there is no
`SafeAreaProvider` in `app/_layout.tsx`. Under Android's gesture navigation the system bar is
drawn over the app's own bottom edge, which is the composer.

**Fix.** A `SafeAreaProvider` at the root, `behavior="padding"` on both platforms, and the bottom
inset applied as padding on the composer.

---

## 4. "Lưu câu trả lời" looks like it only saves the last reply

**Symptom, verbatim:** pressing it shows the summary at the bottom of the chat; what if the user
wants to save an earlier reply; and after saving, the button still says "Lưu câu trả lời" with
nothing marking it done.

**Root cause.** The button is genuinely on every assistant turn
(`apps/web/src/app/assistant-box.tsx:525-539`) — the reporter's first complaint is about
**placement, not capability**. The confirmation box renders at
`assistant-box.tsx:593`, as the last child of `.chat-scroll`, below the entire transcript. So
pressing the control on a turn from this morning pops a box at the bottom of the thread with no
visible connection to it. The component already carries `proposal.forId` and never reads it.

The second complaint has no mechanism at all: nothing records that a save happened, on either
client. `confirmSave` (web) and `onConfirm` (mobile) fire the POST and clear the box.

**Fix.** Render the proposal inline, directly under the turn `forId` names, on both clients; and
keep a per-turn saved set so the control reads "Đã lưu" afterwards. The set is client-side and
per-session — a durable "this answer was saved" flag would need a column and a link back from the
saved note to the message, which is a larger change than the reported defect.

---

## 5. The composer is ugly (both clients)

Not a bug with a root cause; a design gap. The web composer is a bare `<textarea>` plus a
`<button>` inheriting the generic `button` rule from `globals.css:45`. The mobile one is a
`TextInput` with a 96px `minHeight` and a hardcoded `#ccc` border that ignores
`themeFor()` entirely, so it is the same light grey in dark mode.

**Fix.** One rounded, bordered composer block with the send control inside it, growing with the
text, pinned to the bottom, matched across web and mobile.

---

## 6. Irrelevant notes are recalled (reported with a screenshot)

**Symptom.** Asked about a game, the reply worked in `"liet ke vai cach di"` and `"Tìm đi"` —
fragments from an unrelated conversation — and `"thông tin này có cập nhật mới nhất chưa vậy"`,
asked about food, as if all three were about the game.

**Root cause.** `search_notes` has **no relevance floor**. In migration 00035:

```sql
vector_arm as (
  select c.note_id, row_number() over (order by c.embedding <=> p_embedding) as rank
  ...
  order by c.embedding <=> p_embedding
  limit 40
)
```

Nearest forty, regardless of how far away the nearest forty are. RRF then fuses **ranks**, which
are relative by construction — `1.0 / (60 + rank)` never says "this match is bad", only "this
match is 40th". `retrieve.ts:98` asks for five and takes whatever comes back, so on a small
corpus the top five are **always full**, whatever the question. `prompts.ts:170` then presents
them to the model under "The user's own notes:", and `RECALL_RULE` instructs it to bring a
relevant one up the way a person would — so the model does.

The FTS arm needs no floor — `websearch_to_tsquery` already requires a lexical match, so it
filters itself. Only the vector arm admits everything.

**The obvious fix does not work, and this was measured rather than assumed.** A cosine floor in
the vector arm was the first plan. The three reported strings were embedded against the reported
question with the exact model, dimensionality and normalisation `gemini.ts` uses
(`gemini-embedding-001`, 1536, L2-normalised):

```
query: "Game này có hướng dẫn gì không"
  0.745  true positive   hỏi cách build nhân vật trong game
  0.669  FALSE POSITIVE  liet ke vai cach di
  0.648  FALSE POSITIVE  Tìm đi
  0.648  true positive   dạo này đang chơi game mobile, định tải Genshin Impact về chơi thử
  0.626  FALSE POSITIVE  thông tin này có cập nhật mới nhất chưa vậy
  0.598  unrelated       hôm nay trời đẹp quá
  0.488  unrelated       cá hồi giàu omega-3, tốt cho mắt
```

**A false positive outscores a true positive.** No threshold separates them: any floor that
drops `"liet ke vai cach di"` (0.669) also drops the genuinely relevant Genshin note (0.648).
Asymmetric `taskType` (`RETRIEVAL_QUERY`/`RETRIEVAL_DOCUMENT`, which this repo does not send and
which is the documented setting for question-vs-document retrieval) makes the ordering separable
by **0.001**, and `SEMANTIC_SIMILARITY` on both sides by **0.015** — margins that are noise on a
nine-string fixture, not a mechanism. Distance is not the signal here.

**The actual root cause.** Look at what the three false positives *are*, rather than how far away
they are. Every one of them is something the user said **to the assistant** — two commands and a
meta-question about a previous answer — and none is a recorded thought. The reply in the report
says so itself: *"bạn có nhắn mình 'liet ke vai cach di' và 'Tìm đi'"* — "you **messaged me**".
The model is not misjudging relevance. It is recalling the user's own chat turns as if they were
notes, because they are in the corpus as notes.

`turn.ts:291-295` puts them there:

```ts
if (wantsAnswer || isChitchat) {
  await userDb.from("notes")
    .update({ source_type: wantsAnswer ? "chat" : "chitchat" })
```

and `search_notes` excludes `'chitchat'` (00031) but **not** `'chat'`. So small talk was
recognised as unrecallable and questions were not, though a question the user asked is no more a
thing they recorded than "haha ok" is. The prompt already receives recent questions the right
way, as conversation history through `selectContext` — retrieval delivering them a second time,
undated and out of context, is the defect.

**Fix, in two parts, because `'chat'` is currently over-applied as well.**

1. `turn.ts` stamps `'chat'` on a **pure** question only. Today `wantsAnswer` is also true for a
   statement that happens to ask something — the eye-strain turn, *"Các loại thực phẩm nào tốt
   cho mắt, dạo này hơi mỏi mắt"* — and that note carries a recorded fact that must stay
   recallable. The dual-intent design says `intent` stays `"statement"` for that turn on purpose
   and that "only the reply branch was ever wrong"; the `source_type` stamp did not get the memo.
2. `search_notes` excludes `'chat'` beside `'chitchat'`, for the reason 00031 already wrote down
   for the other one.

A floor is deliberately **not** added. Adding one on a 0.001 margin would be encoding noise as a
constant and would look, to the next reader, like a measured threshold.

---

## 7. "Câu trả lời bị gián đoạn" on a chit-chat turn — and why we cannot say why

**Symptom.** `"Hello hello"` produced no reply and the interrupted marker.

**What was ruled out.** The chit-chat path itself works. The exact prompt `buildChitchatPrompt`
produces for `"Hello hello"`, sent to `CLASSIFY_MODEL` at the exact endpoint and body shape
`gemini.ts`'s `openStream` builds, returns `200` and streams `"Well hello there!"`.

**What that leaves.** `incomplete` is set in exactly one place, `turn.ts:355-359` — the model
stream threw. Which is transient, and **the reason is discarded at all three layers**:

- `turn.ts:358` yields `{ type: "error", message }` and never logs it. Every other failure
  branch in that file `console.error`s with the `requestId`; this one, the most expensive and the
  only user-visible one, does not.
- `assistant-box.tsx:354-357` explicitly does not handle the `error` event.
- `turn.ts:460` persists `retrieval_meta: { requestId, incomplete }` — the message is not in it.

So the turn is stored as an assistant row with `content: ""` and `incomplete: true`, and both
clients render that as a bubble containing nothing but "Câu trả lời bị gián đoạn." with no reason
and no way to retry. That is the defect this stage can actually fix: **an interrupted turn must
carry its cause and offer a retry.** Naming the specific transient failure needs the next
occurrence to leave a log line behind, which today it does not.

---

## 8. `POST /assistant` aborts nothing (found while investigating #7)

`assistant.controller.ts:75-76`:

```ts
const abort = new AbortController();
req.on("close", () => abort.abort());
```

The comment above it says "Closing the tab must actually stop the work. Without this the answer
streams to completion into a socket nobody is reading, and we pay for all of it." It has never
done that.

Since Node 16, `http.IncomingMessage` emits `close` when the **request message** completes — not
when the connection does. `express.json()` reads the body to EOF, and `close` is emitted on the
next tick. NestJS runs `SupabaseAuthGuard` (async) between that and the handler, so by the time
the handler registers its listener the event has already fired. Measured, express 5.2.1:

```
[bare]      listener registered synchronously -> close fired? true    (req.destroyed=true)
[guarded]   listener registered after 1 await -> close fired? false   (req.destroyed=true)
```

The handler is the `[guarded]` case. `abort.abort()` never runs, `args.signal` is never aborted,
and an abandoned turn streams and bills to completion.

The near miss matters as much as the bug: had that listener been registered synchronously it
would have aborted **every** turn at ~2ms, and every answer in the product would be
"interrupted". Verified end-to-end against the real model:

```
[server] about to open model stream, signal.aborted=true
[server] MODEL STREAM THREW: AbortError: This operation was aborted  -> incomplete=true
```

**Fix.** Listen on `res`, not `req`, and only treat it as an abandonment when the response has
not ended (`res.writableEnded`). `res`'s `close` fires when the response is done or the socket
dies, which is the fact the code wants.

---

## 9. Mobile always says "Ngoại tuyến" while the assistant answers

**Symptom.** The pill reads offline permanently, yet chat works.

**Both halves are true, and that is the finding.** The assistant does not go through PowerSync —
`assistant-box.tsx:99` streams from `EXPO_PUBLIC_API_URL` over plain HTTP, and uploads go to
`POST /sync/upload` through the Nest API (`connector.ts:103`). The **download** stream is the
only thing `useStatus().connected` reports, and it is the one thing that has never worked.
`powersync.ts:113-118` records it as a still-open question: `"connected":true` was never observed
on the one device this has run on, across four launches.

So the label is honest and the bug is real: rows written on the server — every
`chat_messages` row, every web edit, every enrichment — are not reaching the device. The app
looks fine because the live turn is rendered from local state and the local note write is its own
deliverable.

This is an investigation, not a known fix, and it is scoped as one. The status listener already
logs `downloadError` on every transition; the first job is to get that line off a device.

---

## Out of scope

- A durable server-side record that a given answer was saved (see §4).
- Anything about the offer/decline flow, which was not reported.
- Naming the specific transient Gemini failure behind §7 — the stage makes it observable and
  recoverable; identifying it requires the next occurrence.
