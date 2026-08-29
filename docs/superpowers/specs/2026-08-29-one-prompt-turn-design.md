# One prompt, one model: removing the classify-gate from the chat turn

Status: designed 2026-08-29, not implemented.

Every chat turn today decides *how to reply* by first asking a separate model to classify the
message. This removes that decision. One prompt, one model, started immediately; classification
keeps running for its own outputs and is read afterwards.

Read `2026-08-16-stage-c4-c5-conversation-design.md` (chitchat, verification),
`2026-08-24-stage-s2-follow-up-design.md` (the entity gap and the backfill) and
`2026-08-22-citations-tone-and-saving-design.md` (the prompt rules and the save path) first.
This document overturns named decisions in all three, and says so at each site.

## Problem

A production bug on 2026-08-29: `"Bơi lội có giúp phát triển cơ bắp không"` — an unmistakable
question — came back as an acknowledgement of a filed note.

The mechanism is the classify-gate. `runTurn` races `extractNote` against
`EXTRACT_DEADLINE_MS = 4000`; on a timeout `extracted` is `null`, `wantsAnswer` falls through to a
deterministic keyword fallback (`looksLikeQuestion`), and that fallback had no entry for two
routine Vietnamese question shapes: a yes/no question ending on the bare particle `"không"` with no
`"?"`, and a bare `"nào"` interrogative. Both were confirmed against the live classifier to
classify as `question` **every time it actually runs**. The classifier's judgment was never the
problem. The gate was.

That is the second bug of this exact shape. `90a4ce5` (2026-08-24) fixed the first one —
`"Cung điện ký ức là gì?"`, same branch, same cause — by adding phrases to the same list. A fix
that consists of adding another entry to a keyword list, twice, is a fix for a symptom.

The wider question this raises: is a separate up-front classification call worth its cost — a
4-second deadline on the critical path, plus an entire class of *"what if extraction fails"*
bugs — when one capable model given one merged prompt can read the message and respond
appropriately without being told in advance what kind of message it is?

## Current architecture (verified against `90d7204`, 2026-08-29)

- **The reply is gated on classification AND on retrieval.** `turn.ts:230` is a
  `Promise.allSettled` over both, and nothing downstream runs until both settle. The critical path
  is therefore `max(classify, retrieve)`, and classify — one Gemini JSON call racing a 4s clock —
  is the long pole. Decoupling classification alone does not make the reply immediate.
- **Three prompts, selected by an ordered chain.** `turn.ts:377-402` derives `wantsAnswer`,
  `isChitchat`, `verifies` and `gap` in that order, and the order is load-bearing: each conjunct
  is an exclusion a prior spec named. `buildAnswerPrompt` → `ANSWER_MODEL` + grounding;
  `buildChitchatPrompt` and `buildAcknowledgePrompt` → `CLASSIFY_MODEL`, no grounding, except that
  a `verifies` turn promotes the acknowledge branch to `ANSWER_MODEL`.
- **`buildAnswerPrompt` is currently a stub.** `fd65f16` (2026-08-28) stripped its whole rule
  stack — `LANGUAGE_RULE`, `temporalRule`, `RECALL_RULE`, `renderCitations`, `FORMAT_RULE`,
  `locationRule`, the web-attribution lines — leaving `renderHistory` plus the question, while
  chasing a *"user gets no answer at all"* report. Its own doc comment records the suspicion as
  unconfirmed. **It was the classify-gate**: a misrouted question produces an acknowledgement of a
  filed note, which is exactly *"no answer at all"* as experienced. Confirmed with the user
  2026-08-29. The signature was deliberately kept stable so reverting is a one-function diff.
- **Classification drives five things besides the reply**, and four of them are written *after* the
  stream has finished: `source_type` stamping (`turn.ts:417`), the mood check-in
  (`turn.ts:320`), the media entity link and `mediaTitle` (`turn.ts:270`), the `asked` pointer
  (`turn.ts:615`) and the `attached` SSE event (`turn.ts:312`).
- **`pendingAsk` needs no classification.** `turn.ts:193-199` reads it out of `chat_messages`
  history at the top of the turn, before anything else runs. This matters in §4.
- **`attached` is ephemeral bubble text with no persisted home.** Web renders it in the live reply
  bubble and `flushLiveIntoTurns` clears it on `done` (`assistant-box.tsx:379`); `TranscriptTurn`
  has no field for it. Mobile renders it the same way. It exists only for the duration of the turn,
  on both clients.
- **Both clients ignore unknown SSE events.** Mobile's `stream.ts:128` drops them by design ("the
  server is deployed independently of the APK"); web's `if/else` chain has no fallthrough.
- **`generateJson` is hardcoded to `CLASSIFY_MODEL`** (`gemini.ts:328`). Flash-lite serves
  `extractNote` — which the 60-second sweep runs over the whole corpus — and `distill` /
  `proposeOffer`. Its role does not depend on anything here.
- **`MODEL_PRICES_USD_PER_MTOK` has three entries** (`enums.ts:115`) and `ANSWER_MODEL` is one of
  them. A model id absent from that map books $0 in `usage_ledger`.

## Decisions taken before this document

Four, agreed with the user on 2026-08-29 and not re-litigated below.

1. **`ANSWER_MODEL` moves to `gemini-3.5-flash`.** From a live 4-case benchmark against real
   prompt shapes: faster than `gemini-3.1-pro-preview` on all four tests, cheaper on three,
   comparable quality. `gemini-3.7-flash` is cheaper on paper but 503'd on half its calls and was
   the slowest of the three when it did answer — not viable on a user-facing path.
2. **`buildAnswerPrompt`'s rule stack is restored**, in this change, on the reasoning above.
3. **Grounding is offered on every turn**, with an explicit prompt rule scoping when *not* to
   search, plus a named measurement step. §7.
4. **This lands as one change, one test cycle.** The four pieces are entangled — the gate's removal
   is what makes the rule-stack restore safe, and the model swap is what makes always-answer
   affordable — so splitting means judging intermediate states that were never the design. The
   accepted cost is S1.5 §6.1's: a favourable verdict cannot be attributed to one of the four.

## 1. The shape: classification becomes a post-hoc annotator

Classification is not moved to a background job and nothing it produces is lost. It stops being
*upstream* of the reply and becomes something read *after* it.

| | before | after |
|---|---|---|
| critical path to first token | `max(classify, retrieve)` | `retrieve` |
| what picks the prompt | `extracted.intent` | nothing — there is one prompt |
| what picks the model | `extracted.intent` | nothing — there is one model |
| `source_type`, mood, media link, `asked`, offer gate | classification, read early | classification, read late |

The key observation is that **only one consumer was ever genuinely up-front**: injecting
`followUpRule` into the acknowledge prompt, which needs to know the missing field before the reply
is generated. Every other consumer already runs after the stream has finished, where the
classification will reliably have settled. So the decoupling costs one prompt rule, not five
features.

**Rejected: move classification to a background job entirely.** This was the framing that raised
the question, and it is more disruptive than the problem requires. It would break the same-turn
`asked` pointer (§4), delay `attached` past the end of the turn (§6), and force the entity backfill
to reconstruct which note a follow-up was about from conversational adjacency — inventing a session
window, a tie-break for two pending same-domain notes, and a wrong answer whenever the user changed
topic. None of that is necessary: the call still runs on this turn, concurrently, and finishes long
before the point at which its output is needed.

## 2. `attached` still arrives mid-answer

The instant attachment of mood, domain and tags is a stated core product feature, not a side
effect. Emitting `attached` only after the stream would push it from ~4s after send to 10-20s.

Chain the media resolve onto the classification promise, set a local when it settles, and let the
token loop emit the event the first time it sees one:

```ts
let annotation: Annotation | null | undefined;          // undefined = still running
const classification = withDeadline(extractNote(...), EXTRACT_DEADLINE_MS)
  .then(async (e) => (annotation = e && { ...e, media: await tryResolveMedia(e) }));
// ...inside the token loop:
if (!sentAttached && annotation !== undefined) { sentAttached = true; yield attachedEvent(annotation); }
```

No racing, no second promise, one flag. Classification is 1-3s and the answer streams for 3-15s,
so in practice `attached` lands at roughly the wall-clock moment it does today.

**The deadline stays on `extractNote` only, never on the media resolve.** `turn.ts:260` already
gives the reason and it is unchanged: a slow `findOrCreate` inside the deadline trades the whole
classification for a link.

If the stream ends first, the turn awaits `classification` before `done`. That is the only point
at which this design can add latency to a turn, and it is bounded by §3.

## 3. `EXTRACT_DEADLINE_MS`: 4000 → 15000

**This is the one invented number in the design.** It is invented, and the previous one no longer
has a justification.

4 seconds was chosen because the deadline sat *in front of the reply* — a hung Flash call would
otherwise hold the SSE connection open with nothing on screen. That is no longer where it sits.
The deadline now bounds only how long the turn holds `done` open *after the answer has already
streamed*, and the answer's own duration dominates it. At 4s the deadline would routinely fire
mid-answer and mark `attached` degraded with no benefit whatsoever — the connection was staying
open regardless.

15s is chosen so that the deadline effectively never extends a turn (it will have been overtaken
by the answer stream) while making `degraded: true` rare instead of routine. Fewer degraded turns
also means fewer notes deferred to the 60-second sweep for enrichment that could have been instant.

## 4. The S2 ceiling survives, structurally

S2 §7's guarantee — *"the turn after a question never asks another"* — reads as though it must be
lost: the code no longer decides whether to ask, so it cannot decide not to.

It is not lost. `pendingAsk` is read from `chat_messages` at the top of the turn and needs no
classification (`turn.ts:193-199`). So the merged prompt takes `justAsked: boolean` and renders a
rule when it is true: *you asked them something last turn and they have answered; do not ask
another question this turn.* The ceiling stays a code guarantee with no number in it, exactly as
S2 §7 designed it.

**What does change is `asked`, which becomes fully post-hoc.** It is written when a gap was
detected, the reply contains `?`, and `pendingAsk === null`. S2 §5 already concedes that `asked`
*"records an INSTRUCTION, not an observation"* and that the `?` test is *"the honest
approximation"*. Post-hoc it is an actual observation of text the turn is holding — strictly more
honest than what it replaces, and both of §5's stated failure directions are unchanged.

The three prompt-side exclusions in `turn.ts:400` (`!wantsAnswer`, `!isChitchat`, `!verifies`)
disappear with the values they were derived from. They existed to stop the prompt from *asking*;
nothing now instructs the model to ask at all, so there is nothing to exclude. `pendingAsk === null`
survives because it governs the *recording*, and recording two chained asks would let a backfill
walk backwards through the thread.

## 5. `prompts.ts`: one builder

`buildAnswerPrompt`, `buildAcknowledgePrompt` and `buildChitchatPrompt` collapse into one
`buildTurnPrompt`, built on the **restored** stack.

**Kept, restored from history where `fd65f16` removed it:** `LANGUAGE_RULE`, `temporalRule`,
`RECALL_RULE` (including the "your own earlier answers" clause from S1.5 §3.2), `renderCitations`
with all three of its branches — the `"failed"` branch is not negotiable, for the reason its own
comment gives — `FORMAT_RULE` in the two-axis form S1.5 §3.3 landed, `locationRule`, and the web
attribution lines.

**New or reworked:**

- **Engagement**, from `ENGAGE_RULE`, which already handles the general case: acknowledge, then one
  brief natural line tied to what they wrote. Live-tested that this is sufficient to draw out a
  missing entity without being told which field is missing — `"Tôi vừa mới đi xem phim"` with no
  special instruction produced a good single follow-up asking which film. `followUpRule`'s
  machinery was never what made the question good.
- **Correction**, unconditional but self-scoping (§8).
- **Grounding scope** (§7).
- **`justAsked` suppression** (§4).
- **Weight-matching**, absorbing what `buildChitchatPrompt` did: a greeting, a reaction or noise
  gets a light line, no topic started and no follow-up. This is the one thing the chitchat prompt
  contributed that the others did not, and it is an instruction rather than a branch.

**Deleted:** `followUpRule` — it needed a field only classification knew.
`buildAcknowledgePrompt`'s *"The user did not ask a question. Do not answer one, and do not invent
one to answer."* — now actively wrong, and the direct cause of the dual-intent bug `a3c3558`
already had to work around. `VERIFY_RULE` in its conditional form (§8).

### 5.1 The reply stops narrating its own filing

> **Overturns C4 / parent spec §6 obligation 3.**

`"You filed it under: X. You tagged it: Y."` and `"Mention what you attached, briefly."` cannot
survive: at prompt-build time the domain and tags do not exist yet. The reply can no longer say
what it filed the note under.

Accepted deliberately, and it is arguably an improvement. The `attached` receipt still carries the
information on both clients, on the same turn (§2). And the prose losing its bookkeeping register
is the direction two prior findings already pushed: `RECALL_RULE` exists to forbid the
database-match voice, and S1.5 finding 1 records the user's own complaint about
*"Đã lưu ghi chú của bạn vào mục không phân loại"*. Confirmed with the user 2026-08-29.

## 6. `turn.ts`: what goes

Deleted outright: `QUESTION_PHRASES`, `ENDS_WITH_KHONG`, `BARE_NAO`, `looksLikeQuestion`,
`wantsAnswer`, `isChitchat`, `verifies`, the model ternary (`turn.ts:445`), the prompt ternary
(`turn.ts:426`), and `grounds`.

`model = ANSWER_MODEL` and `grounding: true`, with no condition on either.

**The uncommitted working-tree fix is superseded, not shipped.** `ENDS_WITH_KHONG` and `BARE_NAO`
exist only to patch `looksLikeQuestion`, which this change deletes. Confirmed with the user
2026-08-29: it stays uncommitted and this supersedes it.

**The offer gate keeps its meaning, read late.** `turn.ts:581` requires `wantsAnswer` because
`proposeOffer`'s prompt is hardcoded to *"The assistant just answered a question"* and `searched`
alone is not that (recorded as Finding 4 in the whole-branch review). The same derivation —
`intent === "question" || alsoWantsAnswer` — is read from the settled classification at the point
the offer is considered, which is after the stream. A degraded extraction produces no offer, which
is the safe direction and matches every other default in `extract.ts`.

`source_type` stamping, the mood check-in and the backfill move below the stream unchanged. None
of them is read by the prompt, and nothing else observes their ordering.

## 7. Grounding on every turn

The gate's removal means the grounding tool is offered on turns that are plainly not questions —
`"hôm nay tôi chạy bộ ở công viên"`. **This, not the model tier, is the cost decision.**

| | today | after |
|---|---|---|
| statement / chitchat turn | `gemini-3.5-flash-lite`, no grounding | `gemini-3.5-flash`, grounding offered |
| tokens, ~1.5k in / 150 out | ~$0.0008 | ~$0.0036 |
| one grounding query | — | **$0.014** |

One unnecessary search costs roughly four times the entire token bill of the turn it rides on. The
tier change is ~$0.003 per statement turn and is not what needs controlling.

**There is no deterministic pre-filter available.** That is `looksLikeQuestion`, which is the thing
that just failed twice. And a tool cannot be attached to an already-streaming reply, so the settled
classification cannot be used either. The control has to be an instruction.

**The rule:** search when they are asking about facts you would need to look up; never for
something they are recording about their own life, and never for small talk.

**Measurement, named rather than assumed.** `recordUsage(kind: "grounding")` already writes one row
per query (`turn.ts:552`), so the grounded-turn rate is `kind='grounding'` over `kind='chat'`, and
a baseline exists in the ledger today. The existing `isOverBudget` circuit breaker is unchanged and
still caps a runaway. If the rate is unacceptable the instruction is the thing to tighten, from
data.

**`MODEL_PRICES_USD_PER_MTOK` gains a `gemini-3.5-flash` entry in the same commit as the
`ANSWER_MODEL` swap.** `priceUsd` returns 0 for a model absent from that map, and does so
deliberately — *"swapping a model id must never wedge the whole pipeline, and a zero row is visible
in the ledger as an obvious anomaly"* (`budget.ts:5-8`). That trade is right, and it is exactly why
this is easy to miss: nothing throws, nothing logs, every chat row books free, `monthToDateUsd`
sums to nothing, and `isOverBudget` never trips — the circuit breaker is disarmed and the only
evidence is an anomaly somebody has to go and look at. §10 gives this its own test so the swap
cannot land without its price.

## 8. Correction, unconditional and narrow

> **Overturns C5 §9.1.**

Today `VERIFY_RULE` reaches the prompt only when the classifier flagged `checkable_claim` *and* the
turn was promoted to the reasoning model. C5 §9.1's stated reason: asking flash-lite to adjudicate
truth is *"the weakest model in the system doing the task with the most asymmetric failure mode"*.
With no gate, the reply model never learns a claim was flagged.

The premise has partly moved. The reply tier is now `gemini-3.5-flash`, benchmarked as comparable
to pro — *"the weakest model in the system"* no longer describes it. But *"invited to correct on
every turn"* is still not the same thing as *"flagged, then corrected"*, so the rule has to carry
its own scope rather than inherit it from a gate.

**The permission**, worded to no-op where it should: only something they **stated** as fact about
the world; never their own life, plans or feelings; never your own earlier answers in this thread;
one short sentence, no elaboration, no follow-up. On a pure question there is no stated claim, so
the rule does not fire — the scoping is what replaces the gate, not a separate condition.

**The prohibition is unconditional and is the more important half.** C5 §9.1's *"silence is not
confirmation"* — never *"đúng rồi"*, *"chính xác"*, *"xác nhận"*, or anything implying the note was
checked and found correct — is a pure prohibition, cheap and safe on every branch including
questions and small talk. It applies everywhere.

**`checkable_claim` stays in the schema, recorded and no longer acted on**, joining `complexity`.
It costs a couple of output tokens on a call that is already happening and it keeps the flag rate
measurable, which is the only way C5 §15's open item — *whether the flagging is useful* — ever gets
answered.

**Rejected: condition the correction on having actually searched.** It speaks more directly to
§9.1's real worry (adjudicating truth unaided) but it is unverifiable from the prompt side, and it
suppresses corrections the model knew perfectly well without needing to look. The narrow wording
above is the simpler control and can be tightened this way later if it misfires.

## 9. SSE and the clients: nothing changes

The event set is identical and neither client needs a change.

- `citations` still arrives early — retrieval stays on the critical path — so web's `phase`
  indicator transitions exactly as today. It reads
  `attached === null && citations.length === 0` (`assistant-box.tsx:210`), which citations alone
  satisfies.
- `attached` still precedes `done`, so it still renders in the live bubble before
  `flushLiveIntoTurns` clears it.
- The SSE contract already declares `attached`/`citations` ordering non-deterministic
  (`turn.ts:216`), so no documented guarantee moves.

**Rejected: deliver domain and tags through PowerSync / Realtime instead of SSE.** The data would
arrive, but there is nothing to render it into: tags live in `note_tags`, not on the note, and
`attached` is ephemeral bubble text that `TranscriptTurn` has no field for. Taking this route means
building a new UI surface on **both** clients for a receipt that already works, over a channel that
is still open at the moment it is needed.

**Rejected: a second, later `attached` event.** Only necessary if `attached` were emitted before
classification settled, which §2 avoids. One event, one meaning.

## 10. Testing

Each item is followed by the one-line change that must turn it red. This project's recurring defect
is tests that cannot fail.

**`turn.test.ts`**

- **A turn whose extraction times out still produces a real answer.** *Red when:* an `await` on
  classification is reintroduced before the model call. This is the regression test for the
  reported bug and it is the most important line in the file.
- **The model call is issued while the classification promise is still pending.** *Red when:* the
  decoupling is undone in a way that still happens to answer — which the test above would not
  catch on a fast fake.
- **Every intent reaches `ANSWER_MODEL` with `grounding: true`.** Statement, chitchat and question,
  three cases. *Red when:* any cheap-model or no-grounding branch is reintroduced.
  **⚠️ This inverts five existing assertions** — `turn.test.ts:1036, 1131, 1158, 1595, 1630` assert
  `CLASSIFY_MODEL` on the acknowledge and chitchat paths. They must be rewritten with their new
  reasoning in the comment, never deleted quietly: the comments record why the cheap path existed.
- **`attached` is still emitted, and always before `done`.** *Red when:* the post-stream await is
  dropped and a slow classification silently loses the event.
- **`attached` carries `mediaTitle` when the note resolved to a media item.** *Red when:* the media
  resolve is chained after the event instead of before it.
- **`asked` is written only on gap + `?` + no `pendingAsk`.** Three cases. *Red when:* it is
  written unconditionally, which would let a backfill fire on a reply that asked nothing.
- **The turn after an ask does not ask again**, asserted on the *prompt* carrying the `justAsked`
  rule. *Red when:* §4's ceiling is dropped. Asserting only that `asked` was not re-recorded passes
  for the wrong reason — the model would still be nagging.
- **A degraded extraction produces no offer and no `asked`.** *Red when:* the late reads default to
  something other than the safe branch.
- **The offer still does not fire on a chitchat turn.** *Red when:* the late `wantsAnswer`
  derivation is replaced by `searched` alone, reintroducing Finding 4.

**`prompts.test.ts`**

- **One assertion per rule** in the merged prompt — the file's existing convention, and the reason
  it exists is that a later edit silently drops one rule out of a stack of ten. Language, temporal,
  recall, format (both halves separately, per S1.5 §3.3), citations (one test per branch), web
  attribution, engagement, correction, silence-is-not-confirmation, grounding scope,
  weight-matching.
- **The `justAsked` rule appears iff `justAsked` is true.** *Red when:* it is concatenated
  unconditionally.
- **No prompt claims to have filed anything.** *Red when:* §5.1 is partially reverted and the
  filing narration comes back without the data behind it.

**`enums` / pricing**

- **`MODEL_PRICES_USD_PER_MTOK` has an entry for `ANSWER_MODEL` and for `CLASSIFY_MODEL`.**
  *Red when:* a model constant is changed without its price. This is the parity trick
  `enum-parity.test.ts` already uses for SQL constraints, applied to the one map whose absence is
  silent rather than loud.

**Not assertable by any test, and named as manual steps rather than left to a green suite:**

- Whether the replies read better in Vietnamese. This is the whole point of the change and no test
  touches it.
- Whether flash's health-domain garble recurs — the benchmark produced one nonsense term,
  `"cơ bắp tay trinit"`, in a health answer. Health questions specifically need spot-checking.
- Whether a plain capture triggers a web search. Read the ledger after a day of real use (§7).

## 11. Consequences accepted

**11.1 A favourable verdict cannot be attributed.** Four changes land together (§"Decisions
taken"). If replies feel better, nothing distinguishes "the gate was the problem" from "the
restored rules helped" from "flash is a better model here". This is S1.5 §6.1 repeating, with the
user's explicit call again.

**11.2 Every turn now costs the answer tier.** Plain statements are the common case in a journaling
app, so the majority-share turn type moves off flash-lite. ~+$0.003 per turn in tokens, plus
whatever grounding rate §7's instruction actually produces — the second number is the unknown and
is the one being measured.

**11.3 The reply no longer confirms what it filed.** §5.1. The receipt does it instead.

**11.4 Verification is no longer gated on a flag.** §8. The narrow wording is doing work the code
used to do, and prompt-side scoping is softer than a branch. `checkable_claim` remains recorded, so
if this misfires the flag is still there to gate on again.

**11.5 Classification failure is now invisible in the reply, and that is the point.** A degraded
extraction previously changed what the user got back. Now it costs them tags and a domain — filled
in by the 60-second sweep — and nothing else. The failure mode moves from *"got the wrong kind of
reply"* to *"tags arrived late"*.

## 12. Out of scope

- **No migration.** Nothing here needs a schema change.
- **No client change**, web or mobile (§9).
- **No change to retrieval, ranking, embedding, the sweep, or the save path.**
- **No change to `CLASSIFY_MODEL`.** Flash-lite still serves `extractNote` on every note including
  the whole-corpus sweep, and `distill` / `proposeOffer`. `generateJson` is hardcoded to it
  (`gemini.ts:328`) and nothing here touches that.
- **`OFFER_DEDUP_THRESHOLD`, `OFFER_MAX_CHARS`** and the offer's own behaviour, beyond the gate's
  late read (§6).

## 13. Deferred, with reasons

- **`gemini-3.7-flash`**, when it leaves capacity-constrained preview. Cheapest on paper by a wide
  margin; 503'd on half its calls on 2026-08-29.
- **Decoupling retrieval too.** It stays on the critical path because the merged prompt needs
  citations for `RECALL_RULE` to have anything to recall. Worth revisiting only if it becomes the
  long pole, which one embed call and one RPC currently are not.
- **Tightening the grounding instruction**, from the rate §7 measures. Not pre-tuned.
- **Whether `checkable_claim`, `complexity` and `alsoWantsAnswer` still earn their output tokens.**
  Two of the three are now recorded-not-acted-on. A question for when there is data, not a cleanup
  to fold into this change.
- **`EntityGap.wants` is deleted** rather than deferred — it existed solely to feed `followUpRule`
  and nothing else reads it. Recoverable from history if a future rule needs it.
