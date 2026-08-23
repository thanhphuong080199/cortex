# Stage B1 Implementation Plan — the eight defects found testing the merged chat shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the web app losing its session while it sits open, make both clients usable on a
phone, put the save-answer confirmation where the reply it belongs to is and mark it done, stop
the assistant recalling notes that have nothing to do with the question, make an interrupted turn
say why and offer a retry, and find out why the phone's download stream has never connected.

**Architecture:** One migration adds a relevance floor inside `search_notes`'s vector arm. One
line of `assistant.controller.ts` moves the abandon-detection from `req` to `res`. `turn.ts` logs
and persists the reason a stream died. Both clients get a composer rewrite, an inline save
confirmation, and a saved marker; the web additionally stops memoising its access token and
starts emitting a viewport.

**Tech Stack:** TypeScript, NestJS (apps/api), Next.js App Router (apps/web), Expo/React Native +
PowerSync (apps/mobile), Supabase/Postgres migrations, Vitest, Zod.

**Spec:** `docs/superpowers/specs/2026-08-23-post-merge-bugfix-design.md`

## Global Constraints

- **Run package tests through turbo**: `pnpm turbo run test --filter=<pkg>`. Never
  `pnpm --filter <pkg> test` — `@cortex/shared` and `@cortex/core` resolve as compiled `dist/`,
  and the direct form runs against stale output.
- **Read the `Cached:` line before claiming a gate passed.** Docker is down on this machine as of
  writing, so a turbo run that reports `N/N successful` may be entirely replays. A gate that did
  not execute did not pass.
- **Migrations must schema-qualify extension types**: `extensions.vector(1536)`, never bare
  `vector(1536)`. The unqualified form passes locally and fails against the hosted project.
- **`supabase db push` targets the HOSTED project by default.** Local application is
  `supabase db push --local`. Applying to hosted is a separate, deliberate step (Task 10).
- **Never print any line of `apps/api/.env`**, and never echo a connection string. If one must
  be shown, redact on the LAST `@`.
- **No new test suite names.** Every test below lands in a file an existing `checks` job already
  runs (`packages/db`, `packages/core`, `packages/shared`, `apps/api`, `apps/web`,
  `apps/mobile`). No `ci.yml` change is needed by this stage.
- **Vietnamese is the product language.** User-facing copy in both clients is Vietnamese.
- **Ask of every test: what one-line change to the implementation would turn this red?** If the
  answer is "none", the test is decoration. This repo has shipped one of those per stage.
- **Read the test file before writing into it.** Helper names below (`stubFetch`, `sse`,
  `stalling`, `renderWithTurns`) stand in for whatever the target file **already defines**.
  `apps/web/src/app/assistant-box.test.tsx` has `sse`, `stalling`, and a `stubFetch` local to
  `describe("the composer")`. Use what is there rather than adding a second way to arrange the
  same fixture.

---

### Task 1: The web box reads a live token, not a frozen prop

Design §1. The single highest-impact fix in the stage.

**Files:**
- Modify: `apps/web/src/app/assistant-box.tsx`
- Modify: `apps/web/src/app/assistant-box.test.tsx`

**Interfaces:**
- Produces: `AssistantBox` accepts an optional `getToken?: () => Promise<string>` prop, defaulting
  to a browser-client `getSession()` read that falls back to the SSR `token` prop. Every outbound
  request in the component awaits it.
- Consumes: nothing new. `page.tsx` is unchanged — the `token` prop stays as the first-render
  fallback, which is a real token and is correct until it expires.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/app/assistant-box.test.tsx`, inside `describe("AssistantBox", ...)`:

```tsx
  // The whole point of Task 1. `token` is captured server-side at SSR and is dead an hour later;
  // an open tab never navigates, so middleware never refreshes it. Asserting the header (not
  // just that getToken was called) is what makes this fail against a box that reads the fresh
  // token and then sends the stale prop anyway.
  it("sends the current access token, not the one it was rendered with", async () => {
    const auth: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      auth.push(String((init?.headers as Record<string, string>)?.authorization
        ?? (init?.headers as Record<string, string>)?.Authorization));
      return String(url).endsWith("/notes")
        ? new Response(JSON.stringify({ id: "n1" }), { status: 201 })
        : sse([["done", { messageId: "m1", sessionId: "s1" }]]);
    }) as typeof fetch;

    render(
      <AssistantBox token="stale" userId="u1" getToken={async () => "fresh"} />,
    );
    await userEvent.type(screen.getByLabelText(/what are you thinking/i), "vẫn còn phiên chứ");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(auth.length).toBeGreaterThanOrEqual(2));
    expect(auth).not.toContain("Bearer stale");
    expect(auth.every((h) => h === "Bearer fresh")).toBe(true);
  });
```

Run it. It fails: every header is `Bearer stale`.

- [ ] **Step 2: Implement**

Add the prop beside `fetchOlder`, with the same "overridable only for tests" reasoning already
written there — `createClient()` throws under jsdom because it checks
`NEXT_PUBLIC_SUPABASE_*` eagerly:

```tsx
    getToken = async () => {
      const { data: { session } } = await createClient().auth.getSession();
      return session?.access_token ?? token;
    },
```

Then replace every use of `token` in a request with `await getToken()`. There are five call
sites: `api.createNote` in `submit`, the `/assistant` fetch, `acceptOffer`, `declineOffer`,
`proposeSave`, `confirmSave`. Read each one — `declineOffer` is deliberately non-async and must
stay non-blocking, so it awaits the token inside the `void`-ed chain rather than becoming
`async` and delaying `setOffer(null)`.

`page.tsx` keeps passing `token`; it is the correct value on first render and the fallback when
`getSession()` returns nothing.

- [ ] **Step 3: Verify**

`pnpm turbo run test --filter=@cortex/web`. The new test passes; the existing suite still does
(every existing test renders with `token="t"` and no `getToken`, so the default path — which
calls `createClient()` — must never run in those tests: it does not, because nothing in them
reaches a request without the default being overridden… **check this**. If `createClient()`
throws in the existing tests, the default must be lazy enough that a test overriding `fetch` but
not `getToken` still passes. Prefer catching inside the default and falling back to `token`.)

---

### Task 2: The web app emits a viewport

Design §2. One export; without it every other web fix in this stage is measured against a 980px
viewport.

**Files:**
- Modify: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/layout.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { viewport } from "./layout";

describe("the document", () => {
  // Next's App Router emits <meta name="viewport"> from this export and from nothing else.
  // With no export there is no tag, and a phone lays the page out at 980px and scales it down --
  // which is the whole of the reported "web khi xài ở đt bị break UI".
  it("declares a device-width viewport", () => {
    expect(viewport.width).toBe("device-width");
    expect(viewport.initialScale).toBe(1);
  });
});
```

- [ ] **Step 2: Implement**

```tsx
import type { Viewport } from "next";

// `maximumScale` and `userScalable` are deliberately NOT set: capping zoom on a text app is an
// accessibility regression, and iOS ignores it anyway.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The composer sits on the bottom edge; `viewportFit: "cover"` is what makes
  // env(safe-area-inset-bottom) resolve to a real number on a notched device.
  viewportFit: "cover",
};
```

- [ ] **Step 3: Verify** — `pnpm turbo run test --filter=@cortex/web`.

---

### Task 3: The web chat is usable at 360px

Design §2. Task 2 makes the viewport honest; this makes the layout survive it.

**Files:**
- Modify: `apps/web/src/app/globals.css`

**Interfaces:** CSS only. No component changes.

- [ ] **Step 1: Read the stylesheet at a phone width**

There is no test for this and inventing one would be decoration. Verify by running the dev
server and using a 360×740 device emulation. The specific things to fix, all of which follow
from the file as written:

- `body { height: 100vh; height: 100dvh; }` — keep `100dvh`, it is now meaningful.
- `.chat-scroll` and `.chat-composer` both carry `padding: … 16px`. At 360px that is 32px of the
  screen; reduce to 12px below 480px.
- `.bubble { max-width: 78% }` — a user bubble at 78% of 360px is 280px, which is fine; leave it.
- `.chat-composer { padding: 12px 16px 20px }` — add `padding-bottom:
  calc(12px + env(safe-area-inset-bottom))` so the gesture bar does not sit on it.
- `.offer` and `.save-proposal` are `max-width: 78%` / flex-wrap; at 360px the buttons wrap under
  the text, which is correct — confirm rather than change.
- `.chat-header` is `position: sticky` inside a `overflow: hidden` flex body. Confirm it still
  pins.

- [ ] **Step 2: Verify** — dev server, device emulation at 360×740 and 390×844. Both the
  composer and the last message must be visible with the keyboard closed, and the page must not
  scroll horizontally.

---

### Task 4: One composer, on both clients

Design §5, and the reporter's "input box còn nhìn xấu quá, cả web và mobile". The user chose the
ChatGPT-style shape: one rounded bordered block, send control inside it, grows with the text,
pinned to the bottom.

**Files:**
- Modify: `apps/web/src/app/globals.css` (`.chat-composer` and its children)
- Modify: `apps/web/src/app/assistant-box.tsx` (the `<form>` markup only)
- Modify: `apps/mobile/src/screens/assistant-box.tsx` (the `TextInput` + `Pressable` block only)

**Interfaces:**
- The web send control keeps `type="submit"` and its disabled logic — Enter-to-send and
  Shift+Enter (`assistant-box.test.tsx:49,62`) must keep working, so nothing about `onKeyDown`
  moves.
- The mobile control keeps `testID="box-input"` and `testID="box-send"`. Maestro flows key on
  both; renaming either breaks `.maestro/` with a green unit suite.

- [ ] **Step 1: Web**

The `<form>` becomes the bordered block and the textarea loses its own border:

```
.chat-composer {
  display: flex; align-items: flex-end; gap: 8px;
  max-width: 720px; width: 100%; margin: 0 auto 0;
  padding: 8px 8px 8px 14px;
  border: 1px solid var(--line); border-radius: 24px; background: var(--panel);
}
```

with an outer wrapper carrying the page padding and the safe-area inset, the textarea set to
`border: none; background: none; padding: 8px 0; resize: none;` (the JS auto-grow at
`assistant-box.tsx:640` already owns the height, and `resize: vertical` fights it), and the send
button a 32px circle. `:focus-within` on the block, not `:focus` on the textarea — the outline
belongs to the composite control.

Keep `aria-label="What are you thinking?"` on the textarea: three tests select by it.

- [ ] **Step 2: Mobile**

Same shape in RN. Drop the hardcoded `#ccc` — it is the same light grey in dark mode — for
`theme.line`, and the `minHeight: 96` for a one-line height that grows via
`onContentSizeChange` up to a cap. The send control moves inside the block as a small round
`Pressable`.

- [ ] **Step 3: Verify**

`pnpm turbo run test --filter=@cortex/web --filter=@cortex/mobile`, then look at both. The
existing composer tests are the regression net for the web half; for mobile, confirm
`box-input` and `box-send` still resolve.

---

### Task 5: The keyboard and the nav bar stop covering the mobile composer

Design §3.

**Files:**
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/src/screens/chat.tsx`

**Interfaces:**
- Produces: a `SafeAreaProvider` at the root. Everything below it may call `useSafeAreaInsets()`.
- `react-native-safe-area-context@^5.7.0` is already a dependency and is currently imported
  nowhere. No install step.

- [ ] **Step 1: Root provider**

Wrap the tree in `_layout.tsx`. **Outside** `AppLockGate`, not inside: the gate renders its own
full-screen UI and that needs insets too.

- [ ] **Step 2: `chat.tsx`**

```tsx
behavior={Platform.OS === "ios" ? "padding" : "height"}
```

`"height"` is the Android-correct behaviour, and `undefined` — which is what it says today — is
`KeyboardAvoidingView` doing nothing at all. Add `keyboardVerticalOffset` for the Stack header's
height, and apply `insets.bottom` as bottom padding on the composer container so the gesture bar
does not overlap it.

- [ ] **Step 3: Verify**

On a device: tap the box, confirm the caret and the text being typed are both visible above the
keyboard, and that the send control is not under the nav bar with the keyboard closed. Note the
result in the stage's closeout — this is the one item in this stage that unit tests cannot cover.

---

### Task 6: The save confirmation appears under the reply it is for, and says when it is done

Design §4.

**Files:**
- Modify: `apps/web/src/app/assistant-box.tsx`
- Modify: `apps/web/src/app/assistant-box.test.tsx`
- Modify: `apps/mobile/src/screens/chat.tsx`

**Interfaces:**
- Produces: on both clients, the proposal box renders as a child of the turn whose id is
  `forId`; a `saved: Set<string>` of turn ids replaces the control's label with "Đã lưu" for
  turns in it.
- The live (not-yet-persisted) reply keeps its own `forId: "live"` slot, unchanged.

- [ ] **Step 1: Write the failing tests (web)**

Two, because they fail for different reasons and one of them would otherwise be implemented by
accident:

```tsx
  // Placement. The control has always been on every turn; the CONFIRMATION rendered at the
  // bottom of the scroll, so saving a reply from this morning popped a box under the newest
  // message with nothing tying the two together.
  it("shows the save confirmation inside the turn it belongs to", async () => {
    // ... render with two assistant turns, click the older one's "Lưu câu trả lời",
    // then assert the proposal text is `within(olderTurn)` and NOT within the newer one.
  });

  // Feedback. Nothing recorded a save, so the control kept offering the same save forever.
  it("marks a turn saved once its statement is kept", async () => {
    // ... click save, confirm, then assert the control for that turn reads "Đã lưu"
    // and that a DIFFERENT turn's control still reads "Lưu câu trả lời".
  });
```

The second assertion in each is what stops a lazy implementation (render it everywhere / mark
everything saved) passing.

- [ ] **Step 2: Implement (web)**

`proposal.forId` already exists and is already set correctly by `proposeSave`. Move the
`{proposal && …}` block from the bottom of `.chat-scroll` into the turn body, guarded by
`proposal.forId === t.id`, and repeat it under the live reply for `forId === "live"`. Add
`const [saved, setSaved] = useState<Set<string>>(new Set())`, add to it in `confirmSave`, and
branch the control's label on it. `confirmSave` needs the id, so give it one.

- [ ] **Step 3: Implement (mobile)**

`chat.tsx` holds `proposal` at screen level and renders it above `AssistantBox`. Give it a
`forId` the same way, pass `proposal` and `saved` down to `Row`, and render inside the row.

- [ ] **Step 4: Verify** — `pnpm turbo run test --filter=@cortex/web --filter=@cortex/mobile`.

---

### Task 7: An interrupted turn says why, and can be retried

Design §7. This does not name the transient failure behind `"Hello hello"`; it makes the next
occurrence leave evidence and gives the user a way out.

**Files:**
- Modify: `packages/core/src/assistant/turn.ts`
- Modify: `packages/core/src/assistant/turn.test.ts`
- Modify: `apps/web/src/app/assistant-box.tsx`
- Modify: `apps/web/src/app/assistant-box.test.tsx`

**Interfaces:**
- Produces: `retrieval_meta` on an interrupted assistant row gains `error: string` (the same
  200-char-capped message the `error` event already carries). The shape is additive; `page.tsx`
  reads only `incomplete` and needs no change.
- Produces: a `console.error` on the stream-threw branch, carrying `requestId`, matching every
  other failure branch in the file.
- The `error` SSE event is unchanged. The web client starts surfacing a retry when a turn ends
  interrupted with no text.

- [ ] **Step 1: Write the failing test (core)**

In `packages/core/src/assistant/turn.test.ts`, with an `ai` whose `generateStream` rejects:

```ts
  // turn.ts:355's catch is the ONLY place `incomplete` is set, and it threw the reason away --
  // so an interrupted turn was unattributable from the row, from the log, and from the client
  // all three. Asserting the persisted row, not the yielded event: the event was already there
  // and was already being ignored.
  it("records why a stream died on the row it writes", async () => {
    // ... run the turn, then assert the chat_messages insert carried
    // retrieval_meta.incomplete === true AND retrieval_meta.error containing the cause.
  });
```

- [ ] **Step 2: Implement (core)**

In the catch at `turn.ts:355`, capture the message into a variable, `console.error` it with
`requestId` (never the prompt or the answer — §15.6 rule 1), and spread it into
`retrieval_meta`.

- [ ] **Step 3: Write the failing test (web)**

```tsx
  // A stream that produces nothing and dies leaves the user with a bubble containing only
  // "Câu trả lời bị gián đoạn." -- no reason, and no way forward but retyping. The note IS
  // saved, so the retry must re-run the turn, not re-save the note.
  it("offers a retry when the turn is interrupted before any answer", async () => {
```

- [ ] **Step 4: Implement (web)**

`settleWithoutDone`'s empty branch already sets `status`. Give that path a retry control beside
it. The note exists — the retry re-opens the stream for `note.id`, it does not call
`createNote` again. Hoist what `submit` needs for that into a small `runTurn(noteId)` local so
the retry has something to call.

- [ ] **Step 5: Verify** —
`pnpm turbo run test --filter=@cortex/core --filter=@cortex/web`.

---

### Task 8: `POST /assistant` aborts the turn it is actually meant to abort

Design §8. Small, and it is real money.

**Files:**
- Modify: `apps/api/src/assistant.controller.ts`
- Modify: `apps/api/test/assistant.test.ts` (read it first — confirm the suite name and whether
  it already has an SSE harness to hang this off)

**Interfaces:** none. Behaviour only.

- [ ] **Step 1: Write the failing test**

The honest one is hard from supertest, because it needs a client that hangs up mid-stream.
If the existing suite cannot do that, assert the narrower fact that still fails today: after a
completed request the signal handed to `runTurn` was **never** aborted (proving `req`'s `close`
does not mean what the code thinks), and a `res`-based listener aborts only when the response
did not end. If neither is reachable from the existing harness, say so in the task's notes and
rely on the measurement recorded in the design doc rather than inventing a test that cannot
fail.

- [ ] **Step 2: Implement**

```ts
    // NOT `req`. Since Node 16 `http.IncomingMessage` emits 'close' when the request MESSAGE
    // completes -- express.json() reads the body to EOF and the event fires on the next tick,
    // before SupabaseAuthGuard's await returns and this handler gets to register a listener.
    // Measured (express 5.2.1): registered synchronously, the listener fires at ~2ms and would
    // abort every turn in the product; registered after one await -- which is this handler --
    // it never fires at all, which is what shipped. `res` closes when the response finishes or
    // the socket dies, and `writableEnded` tells those two apart.
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
```

- [ ] **Step 3: Verify** — `pnpm turbo run test --filter=@cortex/api`.

---

### Task 9: `search_notes` stops recalling the user's own questions

Design §6. **This task was re-scoped mid-stage by measurement.** It was planned as a cosine
distance floor; the reported strings were then embedded against the reported question with the
real model, and a false positive outscored a true positive (0.669 vs 0.648) — so no threshold
separates them and a floor cannot fix this. The false positives turned out to be, every one of
them, something the user typed **at** the assistant: `source_type = 'chat'`, which
`search_notes` has never excluded though it has excluded `'chitchat'` since 00031. The full
measurement is in the design doc and repeated in the migration's header.

It is still a migration, as chosen — a different predicate in the same place.

**Files:**
- Create: `supabase/migrations/00039_search_notes_exclude_chat.sql`
- Modify: `packages/db/src/test/search-notes.test.ts`
- Modify: `packages/core/src/assistant/turn.ts` and `turn.test.ts`

**Interfaces:**
- Produces: `search_notes` keeps its signature and its return shape **exactly** — no new column,
  no new parameter, so `retrieve.ts` and `search.controller.ts` are untouched. The change is a
  predicate, in all three places `'chitchat'` is already excluded.
- A `create or replace` is enough here **because the return type does not change**. 00032 and
  00035 had to drop; this must not, and dropping would discard the ACL for no reason.

- [x] **Step 1: `turn.ts` stops over-stamping `'chat'`** — and this must land WITH the
migration, not after it. `source_type = 'chat'` is written on `wantsAnswer`, which is also true
for a statement that happens to ask something ("Các loại thực phẩm nào tốt cho mắt, dạo này hơi
mỏi mắt"). That note records a fact about the user; with 00039 live, stamping it would make it
permanently unrecallable. Stamp on `intent === "question"` only.

Two existing tests assert `source_type: "chat"` for the dual-intent turn (`turn.test.ts`, the
"answers a statement that also asks something" and "answers rather than corrects…" cases). They
codified the behaviour being corrected — **update them with the reason, do not delete them**.

- [x] **Step 2: Write the failing tests (db)**

Mirror the two existing chitchat tests exactly — one per arm, because the full outer join makes
it easy to get half right — plus a third that stops the exclusion over-reaching:

```ts
  it("never returns a note the user typed as a question, matched by keyword", …)
  it("never returns a note the user typed as a question, matched by embedding", …)
  it("still returns an ordinary note of the same shape", …)  // same text, source_type 'quick'
```

The third is the one that matters most: without it, a predicate that swallowed `'quick'` too
would pass the first two and silently empty the corpus.

- [x] **Step 3: Implement**

00035's body carried across **verbatim** apart from `and n.source_type <> 'chitchat'` becoming
`and n.source_type not in ('chitchat', 'chat')` in all three places. Copy it; do not retype it.
This is tuned RRF SQL with a documented window-function ordering trap in it, and retyping is how
a transcription bug ships behind a green suite. Keep `extensions.vector(1536)` schema-qualified.

- [ ] **Step 4: Verify** —
`pnpm turbo run test --filter=@cortex/db` with the local stack up. **Docker would not start on
this machine, so the three new db tests are UNRUN.** This step is not done; the migration must
not be pushed to hosted (Task 10) until it is. `turn.test.ts` is green (53 passing).

---

### Task 10: Apply 00039 to the hosted project

**Files:** Modify `docs/deploy.md` (the migration log at the end).

- [ ] `supabase db push --local` first, and confirm the local suite is green against it.
- [ ] Then, deliberately: `supabase db push` (no flag = hosted; this is the documented trap).
- [ ] Confirm the hosted function's ACL: `search_notes` must be executable by `service_role`
      and by nobody else. `create or replace` preserves it, so this is a check, not a grant.
- [ ] Record the date and the migration in `docs/deploy.md`, matching how 00035 and 00038 are
      recorded there.

---

### Task 11: Why the phone has never connected its download stream

Design §9. An investigation with a written outcome, not a fix with a predetermined shape. Do not
start it until Tasks 1–10 are merged — it is the one item here that can run long.

**Files:** none up front. Outcome goes in `docs/phase-2-issue-log.md`.

- [ ] **Step 1: Get the evidence off the device**

`powersync.ts:119-128` already logs every status transition including `downloadError`. Build the
dev client, launch it signed in, and capture `adb logcat | grep powersync`. The single line that
matters is the first transition after `connect()`: `connecting=true` then back to
`connected=false` with a `downloadError`, versus never leaving `connecting=false` at all. Those
are different failures and they have different causes.

- [ ] **Step 2: Check the three things that produce exactly this symptom**

In this order, because the first is the cheapest and the most likely:

1. **`EXPO_PUBLIC_POWERSYNC_URL`.** `curl -sS -o /dev/null -w '%{http_code}\n' "$URL"` — any
   status means the URL is live; a resolution error means it is wrong. `docs/deploy.md:1532`
   already documents this check. Note that it is read at bundle time by Expo, so a value fixed in
   `.env` after the dev client was built is not the value in the binary.
2. **Token verification.** `docs/deploy.md:1493` records that this project issues **ES256**
   tokens and that PowerSync's JWT-secret field must therefore be left **empty**. A secret pasted
   in anyway fails every sync with a message that reads like a bad token rather than a wrong
   algorithm. Check the instance's client-auth settings against that section.
3. **The publication.** `sync-rules.yaml`'s header records that the Postgres publication is
   scoped to six tables by name. 00034 added `chat_messages` to it. If the hosted publication
   never got that migration's effect, replication has nothing to send for the one table the chat
   shell needs.

- [ ] **Step 3: Write down what it was**

In `docs/phase-2-issue-log.md`, in the style of the existing H-numbered entries. Then close the
still-open question in `powersync.ts:113-118` — that comment currently tells the next reader this
is unexplained, and leaving it there after explaining it is worse than never having written it.

- [ ] **Step 4: Only then decide whether the pill's copy needs to change.** It is honest today.
      If the stream connects after this, it will say so by itself.

---

## Sequencing

Tasks 1, 2 and 8 are independent and are the three highest value-per-line changes in the stage —
do them first and in that order. Task 3 depends on Task 2 (there is no point measuring a layout
against a viewport that does not exist yet). Task 4 depends on Task 3 for the web half only.
Tasks 5, 6, 7 and 9 are independent of everything above. Task 10 depends on Task 9. Task 11
depends on nothing and blocks nothing; run it last.
