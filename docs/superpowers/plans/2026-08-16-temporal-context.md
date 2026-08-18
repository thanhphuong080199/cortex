# Temporal Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant knows what today is and when each note it cites was written, so a note saying "sáng mai" written on 12-08 is read as 13-08 and reported as already past — not as tomorrow.

**Architecture:** `search_notes` returns `created_at`; it rides through `Citation` to `renderCitations`, which prints it beside each snippet. The prompt opens with today's date and one rule tying relative words inside a note to that note's own date. Dates are formatted in the caller's IANA time zone, sent per turn on the `/assistant` body and validated before it reaches `Intl`.

**Tech Stack:** TypeScript, pnpm/Turborepo, NestJS (`apps/api`), Next.js App Router (`apps/web`), Expo/React Native (`apps/mobile`), Supabase Postgres, Vitest.

**Spec:** none — this plan is the design. It comes from a defect observed on 2026-08-16, recorded in full under "The defect" below. There is no stage spec for it, and it does not belong to one: it is a correctness fix to the assistant's prompt layer that stages C1–C5 all silently assumed was already there.

---

## The defect

Asked *"Bộ phim siêu anh hùng gần đây nhất của Marvel là gì"* on 2026-08-16, the assistant answered correctly from the web and then added:

> Rất có thể đây chính là phần phim Người Nhện mới nhất mà bạn có hẹn đi xem vào **8h sáng mai** đó!

The note it read said *"Ngày mai có hẹn đi xem spiderman lúc 8h sáng"* — and it was written on **12-08**, four days earlier. The appointment was on 13-08 and had passed. The model did not hallucinate; it was never told anything about time:

| | |
|---|---|
| `search_notes` return columns | `note_id, title, snippet, score, matched_by` — no date (`00026:73`) |
| `Citation` (`retrieve.ts:6-14`, `dto/assistant.ts:44-56`) | no date field |
| `renderCitations` (`prompts.ts:25-33`) | renders `[1] title: snippet` |
| `renderHistory` (`prompts.ts:13-18`) | **has** `createdAt` on every `ThreadTurn` and drops it |
| `buildAnswerPrompt`, `buildAcknowledgePrompt` | no "today is" anchor anywhere |

Every relative expression a user writes — "mai", "hôm qua", "tuần sau", "thứ 3 tới" — is anchored to the moment it was written, and the model was given neither anchor nor clock.

---

## Global Constraints

- **Run package tests through turbo, never through the package directly.** `pnpm turbo run test --filter=@cortex/core` — not `pnpm --filter @cortex/core test`. `@cortex/shared` and `@cortex/core` resolve as compiled `dist/`, so the direct form tests stale output.
- **No test may ever call the real Gemini API.** Use `createFakeAi` (`packages/core/src/ai/fake.ts`).
- **No note content, chat text, or model output in any log line or error message.** Master spec §15.6 rule 1. A rejected time zone is logged as the *fact* of a rejection, never with the note it arrived alongside.
- **`supabase db push` targets the HOSTED project by default.** Use `pnpm supabase db push --local` while developing.
- **A cached turbo run is not a run.** Read the `Cached:` line. With Docker down the database-backed suites replay a previous green without executing.
- **RUN THIS PLAN AFTER STAGE C4** (`2026-08-16-stage-c4-transcript-chitchat.md`). C4's Task 6 rewrites `search_notes`'s whole body as migration `00031`; this plan rewrites it again as `00032`. Running them in the other order means editing C4's SQL by hand. **Task 1's SQL below starts from `00031`, not from `00026`** — if `00031` is not yet in `supabase/migrations/`, stop and run C4 first.
- **Migration number: `00032`.** It must **DROP and CREATE**, not `create or replace`: Postgres refuses to change an existing function's `RETURNS TABLE` and answers `cannot change return type of existing function`. A drop discards the ACL, so the `revoke`/`grant` pair is load-bearing rather than ceremonial — `00026`'s own footer predicted this exact change.
- `DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh"` — the fallback when a client sends nothing or sends something invalid. Cortex's users write in Vietnamese; a UTC fallback would push every note written after 5pm local onto the following day, which is precisely the window in which people write "mai".
- **Never render a date you are not sure of.** A citation with no `createdAt` (every `chat_messages.citations` entry written before this plan) renders with no date at all. A missing date costs the model an inference; a wrong one makes it confidently wrong.

---

## File Structure

**Created:**
- `supabase/migrations/00032_search_notes_created_at.sql` — `search_notes` returns `created_at` (Task 1).
- `packages/shared/src/time.ts` — `DEFAULT_TIME_ZONE`, `resolveTimeZone`, `formatNoteDate`, `formatToday` (Task 2).
- `packages/shared/src/time.test.ts` — its tests, including the one that proves the time zone matters (Task 2).

**Modified:**
- `packages/shared/src/index.ts` — exports `./time.js` (Task 2).
- `packages/shared/src/dto/assistant.ts` — `assistantInput` gains `timeZone`; `Citation` gains `createdAt`; `readCitation` reads it (Tasks 2, 3).
- `packages/shared/src/dto/assistant.test.ts` — the backward-compatibility case (Task 3).
- `packages/core/src/assistant/retrieve.ts` — `Citation` gains `createdAt`, mapped off the new column (Task 3).
- `packages/core/src/assistant/retrieve.test.ts` — the mapping test (Task 3).
- `packages/core/src/assistant/prompts.ts` — the date header, the relative-time rule, dated citations, dated history (Task 4).
- `packages/core/src/assistant/prompts.test.ts` — the prompt tests (Task 4).
- `packages/core/src/assistant/turn.ts` — `timeZone` threaded from the request into both prompt builders (Task 4).
- `packages/core/src/assistant/turn.test.ts` — the threading test (Task 4).
- `apps/api/src/assistant.controller.ts` — passes `body.timeZone` through (Task 4).
- `apps/web/src/app/assistant-box.tsx` — sends the browser's time zone; renders the date on each citation (Task 5).
- `apps/web/src/app/provenance.tsx` — the date beside each note citation (Task 5).
- `apps/mobile/src/lib/assistant/stream.ts:44-52` — sends the device's time zone (Task 5).
- `packages/db/src/test/search-notes.test.ts` — the new column is returned (Task 1).

---

### Task 1: `search_notes` returns the note's date

**Files:**
- Create: `supabase/migrations/00032_search_notes_created_at.sql`
- Test: `packages/db/src/test/search-notes.test.ts`

**Interfaces:**
- Consumes: migration `00031` (stage C4) — this body is that one plus a column.
- Produces: `search_notes` returns `(note_id, title, snippet, created_at, score, matched_by)`.

- [ ] **Step 1: Write the failing test**

Add to `packages/db/src/test/search-notes.test.ts`. The file's `search()` helper types its rows inline — widen that type to include `created_at: string`, then:

```ts
// The whole point of this migration. A note's own date is the anchor every relative word
// inside it ("mai", "tuần sau") is measured from, and without it reaching the prompt the model
// resolves those against today -- which is how a note written on 12-08 saying "sáng mai" was
// reported as an appointment for tomorrow, four days after it happened.
it("returns each note's created_at", async () => {
  const id = await seed(bob, "cái ghi chú có ngày tháng đàng hoàng", {
    createdAt: "2026-08-12T03:00:00.000Z",
  });
  const rows = await search(bob, "ngày tháng", vec(11));
  const row = rows.find((r) => r.note_id === id);
  expect(row, "the seeded note did not come back at all").toBeDefined();
  expect(new Date(row!.created_at).toISOString()).toBe("2026-08-12T03:00:00.000Z");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
docker ps
pnpm turbo run test --filter=@cortex/db --force -- search-notes
```

Expected: FAIL — `row.created_at` is `undefined`; the RPC does not return the column.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/00032_search_notes_created_at.sql`. Take `00031_search_notes_exclude_chitchat.sql`'s body and make exactly two changes: add `created_at timestamptz` to the `returns table` list, and add `n.created_at` to the final select in the same position.

```sql
-- search_notes returns the note's own created_at, so the assistant can anchor relative time.
--
-- WHY THIS DROPS INSTEAD OF REPLACING. `create or replace function` cannot change a function's
-- return type -- Postgres answers `cannot change return type of existing function` -- and this
-- adds a column to `returns table`. Every prior change to this function (00024, 00026, 00031)
-- could use replace because none of them touched the signature; this one cannot.
--
-- DROPPING DISCARDS THE ACL. 00026's footer called this exact case: "a future change that has
-- to DROP and recreate it would otherwise silently ship a function granted to public." The
-- revoke/grant pair at the bottom is therefore load-bearing here in a way it was not there --
-- without it this function is executable by `anon`, and it is SECURITY DEFINER over note_chunks.
--
-- The body is 00031 verbatim apart from the two added lines. See 00022's header for why this is
-- SECURITY DEFINER and why the parameter type stays written as `extensions.vector(1536)`;
-- 00024's for the recency clamp; 00031's for the chitchat exclusion.
drop function if exists public.search_notes(uuid, text, extensions.vector(1536), int);

create function public.search_notes(
  p_user_id uuid,
  p_query text,
  p_embedding extensions.vector(1536),
  p_limit int
)
returns table (
  note_id uuid, title text, snippet text, created_at timestamptz, score real, matched_by text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with vector_arm as (
    select c.note_id,
           row_number() over (order by c.embedding <=> p_embedding) as rank
    from public.note_chunks c
    join public.notes n on n.id = c.note_id
    where c.user_id = p_user_id
      and n.deleted_at is null
      and n.source_type <> 'chitchat'
      and c.embedding is not null
    order by c.embedding <=> p_embedding
    limit 40
  ),
  -- One row per note: a long note with three matching chunks must not out-rank a short one
  -- three times over.
  vector_best as (
    select note_id, min(rank) as rank from vector_arm group by note_id
  ),
  -- Postgres evaluates window functions before the statement's own ORDER BY/LIMIT, so an
  -- unordered `limit 40` over a row_number() column takes an ARBITRARY 40 rows, not the
  -- top 40 by rank. Rank first, then limit.
  fts_ranked as (
    select n.id as note_id,
           row_number() over (
             order by ts_rank(to_tsvector('simple', public.immutable_unaccent(n.content_text)),
                              websearch_to_tsquery('simple', public.immutable_unaccent(p_query))) desc
           ) as rank
    from public.notes n
    where n.user_id = p_user_id
      and n.deleted_at is null
      and n.source_type <> 'chitchat'
      and to_tsvector('simple', public.immutable_unaccent(n.content_text))
          @@ websearch_to_tsquery('simple', public.immutable_unaccent(p_query))
  ),
  fts_arm as (
    select note_id, rank from fts_ranked order by rank limit 40
  ),
  fused as (
    select coalesce(v.note_id, f.note_id) as note_id,
           -- Reciprocal Rank Fusion, k = 60. RRF needs no score normalisation between the two
           -- arms, which is the point: cosine distance and ts_rank are not comparable
           -- quantities. The SUM is the whole claim: two arms agreeing at rank 2 beats one arm
           -- alone at rank 1, and because every rank here is <= 40 that holds for EVERY
           -- combination of ranks (2/100 > 1/61).
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + f.rank), 0) as base,
           case
             when v.note_id is not null and f.note_id is not null then 'both'
             when v.note_id is not null then 'vector'
             else 'fts'
           end as matched_by
    from vector_best v
    full outer join fts_arm f on f.note_id = v.note_id
  )
  select n.id,
         n.title,
         left(n.content_text, 240) as snippet,
         -- The addition. Aliased to nothing: the column name in `returns table` is what the
         -- RPC's JSON keys off, and `n.created_at` already matches it.
         n.created_at,
         (
           fused.base
           -- Recency. tau = 180 days for search (parent §6.8), clamped to [0 days, 100 years]
           -- because created_at comes from the device; see 00024's header.
           * exp(
               -least(greatest(extract(epoch from (now() - n.created_at)) / 86400.0, 0), 36525.0)
               / 180.0
             )
           -- Provenance. A saved answer is not the user's own thinking, so it ranks below an
           -- own note of equal relevance rather than being hidden. 'chat' is EXCLUDED: a
           -- question the user typed is their own words. 'chitchat' never reaches this select.
           * case when n.source_type in ('assistant', 'web_search') then 0.8 else 1.0 end
         )::real as score,
         fused.matched_by
  from fused
  join public.notes n on n.id = fused.note_id
  -- Redundant with the per-arm filters above, and nearly free. p_user_id is the ONLY thing
  -- separating two users' corpora -- a redundant predicate here turns a future missing filter
  -- in just ONE arm into a no-op instead of a cross-user leak.
  where n.user_id = p_user_id
    and n.deleted_at is null
    and n.source_type <> 'chitchat'
  order by score desc, n.created_at desc, n.id
  limit p_limit;
$$;

-- NOT a no-op this time. `drop function` above took the ACL with it, so without these two lines
-- the function is recreated with PostgreSQL's default EXECUTE grant to public -- on a SECURITY
-- DEFINER function that reads note_chunks, a table with RLS enabled and no policies precisely
-- because nothing but this function should ever read it.
revoke execute on function public.search_notes(uuid, text, extensions.vector(1536), int) from public;
grant execute on function public.search_notes(uuid, text, extensions.vector(1536), int) to service_role;
```

- [ ] **Step 4: Apply it and run the suite**

```bash
pnpm supabase db push --local
pnpm turbo run test --filter=@cortex/db --force -- search-notes
```

Expected: PASS, the new case plus every pre-existing assertion — fusion ranks, the recency clamp, the 0.8 provenance weight, cross-user isolation, and C4's chitchat exclusion. The body is otherwise identical to `00031`, so any of those going red means a transcription error, not a design problem.

- [ ] **Step 5: Prove the grant actually landed**

The drop is the risk this migration introduces, and a broken grant is invisible in every test above — they all run as `service_role`.

```bash
pnpm turbo run test --filter=@cortex/db --force -- default-grants
```

Expected: PASS. `default-grants.test.ts` is the suite that asserts client roles cannot reach what they should not; if it does not currently cover `search_notes`, add the assertion here rather than assuming:

```ts
it("does not let a client role execute search_notes", async () => {
  const { rows } = await admin.rpc("exec_sql_returning", { /* the file's own helper */ });
  // Follow the shape default-grants.test.ts already uses to read privileges out of the
  // catalog; the claim is has_function_privilege('authenticated', <oid>, 'EXECUTE') = false,
  // and the same for 'anon'.
});
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00032_search_notes_created_at.sql packages/db/src/test/
git commit -m "feat(search): return each note's created_at from search_notes"
```

---

### Task 2: Formatting a date, in the right time zone

The formatting rules, as pure functions in `@cortex/shared`, before anything calls them. They land here rather than in `@cortex/core` for the reason `notes/filters.ts:14-19` records: `apps/web` depends on `@cortex/shared` only, and Task 5 renders dates in a `"use client"` component.

**Files:**
- Create: `packages/shared/src/time.ts`
- Create: `packages/shared/src/time.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/dto/assistant.ts:7-25` (`assistantInput` gains `timeZone`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh"`
  - `export function resolveTimeZone(candidate: string | undefined): string`
  - `export function formatNoteDate(iso: string, timeZone: string): string | null` → `"12-08-2026"`
  - `export function formatToday(now: Date, timeZone: string): string` → `"Chủ nhật, 16-08-2026"`
  - `assistantInput` gains `timeZone: z.string().max(64).optional()`

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, formatNoteDate, formatToday, resolveTimeZone } from "./time.js";

describe("resolveTimeZone", () => {
  it("keeps a real IANA zone", () => {
    expect(resolveTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("falls back when the client sent nothing", () => {
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone("")).toBe(DEFAULT_TIME_ZONE);
  });

  // THE ONE THAT PROTECTS THE TURN. `timeZone` arrives from a client and goes straight into
  // Intl.DateTimeFormat, which throws RangeError on an unknown zone. Unvalidated, one bad
  // string kills the whole answer -- and the failure mode is wildly out of proportion to the
  // input: a wrong zone costs a day of accuracy, a throw costs the reply.
  it("falls back on a zone Intl does not know, instead of throwing", () => {
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone("'; drop table notes; --")).toBe(DEFAULT_TIME_ZONE);
  });
});

describe("formatNoteDate", () => {
  // THE TEST THAT JUSTIFIES CARRYING A TIME ZONE AT ALL. 18:00 UTC is 01:00 the NEXT DAY in
  // Ho Chi Minh City. Rendering UTC would misdate every note written after 5pm local -- which
  // is exactly the part of the day people write "mai" in. Off by one day, on the sentences
  // where one day is the entire meaning.
  it("renders an evening note on the local day, not the UTC day", () => {
    expect(formatNoteDate("2026-08-12T18:00:00.000Z", "Asia/Ho_Chi_Minh")).toBe("13-08-2026");
    expect(formatNoteDate("2026-08-12T18:00:00.000Z", "UTC")).toBe("12-08-2026");
  });

  it("renders a plain daytime note", () => {
    expect(formatNoteDate("2026-08-12T03:00:00.000Z", "Asia/Ho_Chi_Minh")).toBe("12-08-2026");
  });

  // Every citation persisted before this plan has no createdAt, and PostgREST spells timestamps
  // two different ways depending on whether they land on a whole second. Anything unreadable
  // renders NO date rather than a wrong one -- a missing date costs the model an inference; a
  // wrong one makes it confidently wrong.
  it("returns null rather than a wrong date for anything it cannot read", () => {
    expect(formatNoteDate("", "Asia/Ho_Chi_Minh")).toBeNull();
    expect(formatNoteDate("not a date", "Asia/Ho_Chi_Minh")).toBeNull();
  });

  it("reads both spellings PostgREST emits", () => {
    expect(formatNoteDate("2026-08-12T03:00:00+00:00", "Asia/Ho_Chi_Minh")).toBe("12-08-2026");
    expect(formatNoteDate("2026-08-12T03:00:00.113Z", "Asia/Ho_Chi_Minh")).toBe("12-08-2026");
  });
});

describe("formatToday", () => {
  // The weekday is not decoration: "thứ 3 tới" is unresolvable without knowing what day it is
  // now, and that is a phrase this corpus's users write constantly.
  it("names the weekday and the date", () => {
    expect(formatToday(new Date("2026-08-16T04:00:00.000Z"), "Asia/Ho_Chi_Minh"))
      .toBe("Chủ Nhật, 16-08-2026");
  });

  it("uses the caller's zone for the day boundary too", () => {
    // 17:30 UTC on the 16th is 00:30 on the 17th in Ho Chi Minh City -- a Monday.
    expect(formatToday(new Date("2026-08-16T17:30:00.000Z"), "Asia/Ho_Chi_Minh"))
      .toBe("Thứ Hai, 17-08-2026");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/shared -- time`
Expected: FAIL — `./time.js` does not exist.

- [ ] **Step 3: Write the module**

Create `packages/shared/src/time.ts`:

```ts
/**
 * The fallback when a client sends no time zone or sends one Intl does not recognise.
 *
 * Not UTC, deliberately. Cortex's users write in Vietnamese, and UTC would push every note
 * written after 5pm local onto the following calendar day -- which is precisely the window in
 * which people write "mai". A fallback that is right for the actual corpus beats one that is
 * neutral.
 */
export const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";

/**
 * Narrows an untrusted time-zone string. Anything Intl cannot use becomes the default.
 *
 * The `try` is the whole function. `timeZone` comes off an HTTP body and goes into
 * `Intl.DateTimeFormat`, which throws `RangeError` on an unknown zone -- so an unvalidated
 * value turns one bad client into a dead turn. The asymmetry decides the behaviour: a wrong
 * zone costs a day of accuracy, a throw costs the user their answer.
 */
export function resolveTimeZone(candidate: string | undefined): string {
  if (!candidate) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * `dd-mm-yyyy` in the given zone, or null when the input is not a date.
 *
 * Null rather than a guess: citations persisted before this shipped carry no date at all, and
 * a date rendered from garbage is worse than no date -- the model treats whatever it is given
 * as fact, and the entire purpose of this field is to be the anchor it reasons from.
 *
 * `en-GB` produces `12/08/2026` (day first) in every runtime; the slashes are swapped rather
 * than the parts reassembled by hand, because `formatToParts` and locale-specific ordering are
 * two ways to get this subtly wrong.
 */
export function formatNoteDate(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, day: "2-digit", month: "2-digit", year: "numeric",
  }).format(d).replace(/\//g, "-");
}

/**
 * Today, with its weekday, in Vietnamese: "Chủ Nhật, 16-08-2026".
 *
 * The weekday is load-bearing, not ornament: "thứ 3 tới" and "cuối tuần này" cannot be resolved
 * against a bare date, and both are ordinary in this corpus. Vietnamese because the prompt it
 * goes into is read by a model that is instructed to answer in the user's language, and a
 * date rendered in English inside an otherwise Vietnamese prompt is a nudge toward English
 * output -- LANGUAGE_RULE exists because that nudge is real.
 */
export function formatToday(now: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat("vi-VN", { timeZone, weekday: "long" }).format(now);
  const capitalised = weekday.replace(/(^|\s)(\p{Ll})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase());
  return `${capitalised}, ${formatNoteDate(now.toISOString(), timeZone)}`;
}
```

Add to `packages/shared/src/index.ts`:

```ts
export * from "./time.js";
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/shared -- time`
Expected: PASS.

If `formatToday`'s two cases fail on capitalisation or on the exact Vietnamese weekday spelling, **fix the assertion to whatever ICU actually produces, not the implementation** — the requirement is that the weekday is present and in Vietnamese, and pinning ICU's exact casing is pinning a dependency's cosmetics. Leave a one-line comment saying so.

- [ ] **Step 5: Put `timeZone` on the wire**

In `packages/shared/src/dto/assistant.ts`, add to `assistantInput`:

```ts
    /**
     * The caller's IANA time zone, e.g. "Asia/Ho_Chi_Minh". Both clients read it from
     * `Intl.DateTimeFormat().resolvedOptions().timeZone`, which needs no permission and no
     * stored setting -- and which follows the user when they travel, unlike a column would.
     *
     * Optional, and never trusted: the server runs it through `resolveTimeZone` before it
     * reaches Intl. The cap is a sanity bound on an untrusted string, not a real limit -- the
     * longest IANA identifier is about 30 characters.
     */
    timeZone: z.string().max(64).optional(),
```

`assistantInput` is `.strict()`, so this must be added before either client can send it — a body carrying an undeclared `timeZone` is a 400, not a dropped field.

- [ ] **Step 6: Run the package**

Run: `pnpm turbo run test --filter=@cortex/shared`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/time.ts packages/shared/src/time.test.ts packages/shared/src/index.ts packages/shared/src/dto/assistant.ts
git commit -m "feat(shared): format dates in the caller's time zone"
```

---

### Task 3: The date rides on the citation

**Files:**
- Modify: `packages/core/src/assistant/retrieve.ts:6-23, 87-94`
- Modify: `packages/shared/src/dto/assistant.ts:44-56, 75-93`
- Test: `packages/core/src/assistant/retrieve.test.ts`
- Test: `packages/shared/src/dto/assistant.test.ts`

**Interfaces:**
- Consumes: `search_notes`'s `created_at` (Task 1).
- Produces: both `Citation` interfaces gain `createdAt: string | null`; `readCitation` reads it, defaulting a missing one to `null`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/assistant/retrieve.test.ts`, in the existing "maps search_notes rows into camelCase citations" area — extend the fixture row with `created_at` and assert:

```ts
it("carries each note's created_at onto the citation", async () => {
  // Follow the file's existing fake-rpc setup; the row shape is search_notes' return columns.
  const citations = await retrieve(deps, { userId: "u1", text: "phim", requestId: "r1" });
  expect(citations[0]).toMatchObject({ createdAt: "2026-08-12T03:00:00.000Z" });
});

// The RPC is `any` on the TypeScript side, so a mistyped key (`createdAt` read off a snake_case
// row) compiles clean and silently produces undefined -- which JSON drops from the wire
// entirely. This is the same class of bug search.controller.ts's exact-key-set assertion exists
// for.
it("does not invent a date when the row has none", async () => {
  const citations = await retrieve(depsWithRowMissingCreatedAt, { userId: "u1", text: "x", requestId: "r1" });
  expect(citations[0]!.createdAt).toBeNull();
});
```

And to `packages/shared/src/dto/assistant.test.ts`:

```ts
// THE BACKWARD-COMPATIBILITY GUARD, second edition. Stage C3 added `type` and defaulted its
// absence; this adds `createdAt` and defaults its absence to null. Every chat_messages row
// written before today has citations with no date, and there is no backfill -- the column is
// jsonb and rewriting a user's conversation history is not worth a migration. Rendering a
// missing date as anything but nothing is how a reloaded transcript starts asserting dates
// nobody wrote.
it("reads a citation with no createdAt as having no date", () => {
  expect(readCitation({
    type: "note", noteId: "n1", title: null, snippet: "s", score: 1, matchedBy: "fts",
  })).toMatchObject({ createdAt: null });
});

it("reads a createdAt when there is one", () => {
  expect(readCitation({
    type: "note", noteId: "n1", title: null, snippet: "s", score: 1, matchedBy: "fts",
    createdAt: "2026-08-12T03:00:00.000Z",
  })).toMatchObject({ createdAt: "2026-08-12T03:00:00.000Z" });
});

it("ignores a createdAt that is not a string", () => {
  expect(readCitation({
    type: "note", noteId: "n1", title: null, snippet: "s", score: 1, matchedBy: "fts",
    createdAt: 1_754_000_000,
  })).toMatchObject({ createdAt: null });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/shared --filter=@cortex/core -- assistant retrieve`
Expected: FAIL — `createdAt` is not a field on either `Citation`.

- [ ] **Step 3: Widen both `Citation`s**

In `packages/core/src/assistant/retrieve.ts`, add to `SearchRow`:

```ts
  created_at: string | null;
```

and to `Citation`, after `title`:

```ts
  /**
   * When the note was WRITTEN. The anchor every relative expression inside it is measured
   * from -- "mai" in a note from 12-08 means 13-08, and without this the model resolves it
   * against today. Nullable because a row that somehow arrives without one must render no
   * date rather than a wrong one.
   */
  createdAt: string | null;
```

and in the map at line 87:

```ts
    createdAt: r.created_at ?? null,
```

Make the same two additions to `packages/shared/src/dto/assistant.ts`'s `Citation` (its doc comment already explains why the two are deliberately not import-linked), and extend `readCitation`'s note branch:

```ts
    createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
```

`WebCitation` gains nothing: a web source has no "when the user wrote it" and inventing one would be a date the model could cite.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/shared --filter=@cortex/core -- assistant retrieve`
Expected: PASS.

- [ ] **Step 5: Run both packages**

Run: `pnpm turbo run test --filter=@cortex/shared --filter=@cortex/core`
Expected: PASS. `turn.ts` persists `[...citations, ...webCitations]` untouched, so the new field lands in `chat_messages.citations` with no change there.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/assistant/retrieve.ts packages/core/src/assistant/retrieve.test.ts packages/shared/src/dto/
git commit -m "feat(assistant): carry each cited note's date through to the client"
```

---

### Task 4: The prompt gets a clock

The task the whole plan exists for.

**Files:**
- Modify: `packages/core/src/assistant/prompts.ts`
- Modify: `packages/core/src/assistant/turn.ts:49-56, 238-243`
- Modify: `apps/api/src/assistant.controller.ts:66-78`
- Test: `packages/core/src/assistant/prompts.test.ts`
- Test: `packages/core/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: `Citation.createdAt` (Task 3); `formatNoteDate`, `formatToday`, `resolveTimeZone` (Task 2).
- Produces:
  - `buildAnswerPrompt` and `buildAcknowledgePrompt` each gain `timeZone: string` and `now: Date`
  - `runTurn`'s `args` gains `timeZone?: string`

- [ ] **Step 1: Write the failing prompt tests**

Add to `packages/core/src/assistant/prompts.test.ts`:

```ts
const NOW = new Date("2026-08-16T04:00:00.000Z");
const TZ = "Asia/Ho_Chi_Minh";
const dated = (createdAt: string | null): Citation => ({
  type: "note", noteId: "n1", title: null,
  snippet: "Ngày mai có hẹn đi xem spiderman lúc 8h sáng",
  score: 1, matchedBy: "fts", createdAt,
});

describe("temporal anchoring", () => {
  it("tells the answer prompt what today is", () => {
    const p = buildAnswerPrompt({
      question: "phim gì", citations: [], history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("16-08-2026");
  });

  it("tells the acknowledge prompt what today is", () => {
    const p = buildAcknowledgePrompt({
      note: "hôm nay mình chạy bộ", domain: null, tags: [], related: [],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("16-08-2026");
  });

  // THE DEFECT, PINNED. A note written on 12-08 saying "sáng mai" was reported as an
  // appointment for tomorrow, on 16-08. The date beside the snippet is what makes 13-08
  // derivable at all.
  it("dates each cited note", () => {
    const p = buildAnswerPrompt({
      question: "phim gì", citations: [dated("2026-08-12T03:00:00.000Z")],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("(12-08-2026)");
  });

  // Half the fix. The date alone still lets the model read "mai" as tomorrow -- it has to be
  // told which anchor to measure from, and told that a past moment must be reported as past.
  it("says relative time inside a note is measured from that note's date", () => {
    const p = buildAnswerPrompt({
      question: "phim gì", citations: [dated("2026-08-12T03:00:00.000Z")],
      history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toMatch(/ngày viết|written/i);
    expect(p).toMatch(/đã qua|already past/i);
  });

  // A pre-existing citation has no date, and the prompt must simply not date it. A rendered
  // "(null)" or a today-defaulted date would be an assertion the model then reasons from.
  it("renders an undated citation with no date at all", () => {
    const p = buildAnswerPrompt({
      question: "phim gì", citations: [dated(null)], history: [], timeZone: TZ, now: NOW,
    });
    expect(p).toContain("Ngày mai có hẹn");
    expect(p).not.toContain("(null)");
    expect(p).not.toContain("()");
  });

  // History has carried createdAt on every turn since C1 and renderHistory has always thrown
  // it away. "Mai" said three turns ago has the same problem as "mai" written in a note.
  it("dates each turn of the conversation", () => {
    const p = buildAnswerPrompt({
      question: "thế còn gì nữa", citations: [], timeZone: TZ, now: NOW,
      history: [{ role: "user", content: "mai đi xem phim nhé", createdAt: "2026-08-12T03:00:00.000Z" }],
    });
    expect(p).toContain("12-08-2026");
  });

  // Small talk needs no clock, and buildChitchatPrompt (stage C4) takes no timeZone at all.
  // Asserted so nobody "completes" the set later: every token in that prompt is paid for on
  // every "haha ok".
  it("leaves the chitchat prompt without a date header", () => {
    expect(buildChitchatPrompt({ text: "haha ok", history: [] })).not.toContain("16-08-2026");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts`
Expected: FAIL — the builders take no `timeZone`/`now`, and nothing renders a date.

- [ ] **Step 3: Date the citations and the history**

In `packages/core/src/assistant/prompts.ts`, import `formatNoteDate` and `formatToday` from `@cortex/shared`, then change the two renderers to take the zone:

```ts
const renderHistory = (history: ThreadTurn[], timeZone: string) =>
  history.length === 0
    ? ""
    : `\n\nEarlier in this conversation:\n${history
        .map((t) => {
          const on = formatNoteDate(t.createdAt, timeZone);
          // The date has been on every ThreadTurn since C1 and was dropped here. "Mai" said
          // three turns ago is anchored to the turn, not to now, exactly like a note's is.
          return `${on ? `(${on}) ` : ""}${t.role === "user" ? "User" : "You"}: ${t.content}`;
        })
        .join("\n")}`;

const renderCitations = (citations: Citation[] | "failed", timeZone: string) =>
  citations === "failed"
    ? "\n\nThe user's notes could not be searched right now (a technical failure, not an empty " +
      "corpus). Say so plainly. Do not claim they have no notes on this."
    : citations.length === 0
      ? "\n\nThe user has no notes matching this."
      : `\n\nThe user's own notes:\n${citations
          .map((c, i) => {
            // Spread-if in string form: a citation with no date renders with no parenthesis at
            // all, never "()" or "(null)". Everything in this prompt is read as fact.
            const on = c.createdAt ? formatNoteDate(c.createdAt, timeZone) : null;
            return `[${i + 1}] ${on ? `(${on}) ` : ""}${c.title ? `${c.title}: ` : ""}${c.snippet}`;
          })
          .join("\n")}`;
```

- [ ] **Step 4: Give both prompts the clock and the rule**

Add above the builders:

```ts
/**
 * The temporal anchor, on both prompts that read the user's own material.
 *
 * Two facts and one rule, and the rule is the part that fixes the observed defect: the date
 * beside a note makes "mai" RESOLVABLE, but the model still resolves it against today unless
 * it is told not to. The last sentence exists because "your appointment is tomorrow morning"
 * about an appointment four days gone is not a small error -- it is the assistant confidently
 * inventing a future.
 *
 * Vietnamese, matching LANGUAGE_RULE's reasoning: an English block inside an otherwise
 * Vietnamese prompt nudges the reply toward English.
 */
const temporalRule = (now: Date, timeZone: string) =>
  `Hôm nay là ${formatToday(now, timeZone)}.\n` +
  "Mỗi note và mỗi lượt hội thoại bên dưới có ngày trong ngoặc. Từ chỉ thời gian bên trong " +
  "chúng (\"mai\", \"hôm qua\", \"tuần tới\", \"thứ 3 tới\") tính từ NGÀY VIẾT của note hoặc " +
  "lượt đó, KHÔNG phải từ hôm nay. Nếu một mốc thời gian đã qua, nói rõ là đã qua — đừng nói " +
  "về nó như việc sắp xảy ra. Note không có ngày thì đừng đoán ngày cho nó.";
```

and thread it through both builders — `buildAnswerPrompt` gains `timeZone: string; now: Date` in its argument object and puts `temporalRule(a.now, a.timeZone)` immediately after `LANGUAGE_RULE`, passing `a.timeZone` to both renderers. `buildAcknowledgePrompt` does the same. `buildChitchatPrompt` is left alone.

The last sentence of the rule — *"Note không có ngày thì đừng đoán ngày cho nó"* — pairs with the undated-citation test: the renderer omits the date, and the prompt says what to do about the omission.

- [ ] **Step 5: Thread it from the request**

`packages/core/src/assistant/turn.ts` — add to `runTurn`'s `args`:

```ts
    /** The caller's IANA zone, validated here rather than trusted. See resolveTimeZone. */
    timeZone?: string;
```

and, where the prompt is built:

```ts
  // Resolved once per turn, not per prompt: two calls could not disagree today, but the point
  // of a single resolution is that they cannot start to.
  const timeZone = resolveTimeZone(args.timeZone);
  const now = new Date();
```

passing `timeZone, now` into `buildAnswerPrompt` and `buildAcknowledgePrompt`. Import `resolveTimeZone` from `@cortex/shared`.

In `apps/api/src/assistant.controller.ts`, add `timeZone: body.timeZone,` to the `runTurn` args object beside `createdAt`.

- [ ] **Step 6: Write the threading test**

Add to `packages/core/src/assistant/turn.test.ts`:

```ts
// Wiring, asserted on the prompt text: a zone accepted by the DTO and then dropped somewhere
// between the controller and the builder is invisible in every other assertion -- the turn
// still answers, just from the wrong day.
it("formats the turn's dates in the caller's time zone", async () => {
  const { client } = dbs();
  const prompts: string[] = [];
  const recordingAi = createFakeAi({
    generateJson: async () => ({
      value: { intent: "statement", complexity: "simple", domain: null,
               domain_meta: {}, tags: [], mood: null },
      inputTokens: 10, outputTokens: 5, model: "fake-classify",
    }),
    generateStream: async (args) => {
      prompts.push(args.prompt);
      return {
        chunks: (async function* () { yield { text: "ok" }; })(),
        usage: () => ({ inputTokens: 5, outputTokens: 2, model: "fake-answer" }),
      };
    },
  });

  await collect(runTurn({ userDb: client, serviceDb: client, ai: recordingAi },
    { userId: "u1", noteId: "n1", budgetUsd: 5, timeZone: "Pacific/Auckland" }));

  const today = formatToday(new Date(), "Pacific/Auckland");
  expect(prompts[0]).toContain(today);
});

// An invalid zone must cost accuracy, never the answer. Intl throws RangeError on an unknown
// zone, and this whole value arrives from an HTTP body.
it("still answers when the client sends a nonsense time zone", async () => {
  const { client } = dbs();
  const events = await collect(runTurn({ userDb: client, serviceDb: client, ai: ai() },
    { userId: "u1", noteId: "n1", budgetUsd: 5, timeZone: "Mars/Olympus_Mons" }));
  expect(events.some((e) => e.type === "done")).toBe(true);
});
```

Import `formatToday` from `@cortex/shared`.

- [ ] **Step 7: Run them to verify they pass**

Run: `pnpm turbo run test --filter=@cortex/core -- prompts assistant`
Expected: PASS.

- [ ] **Step 8: Run core and the API**

```bash
pnpm turbo run test --filter=@cortex/core
pnpm turbo run test --filter=@cortex/api --force
```

Expected: PASS. `timeZone` is optional everywhere, so every existing caller and every existing e2e body is unaffected.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/assistant/ apps/api/src/assistant.controller.ts
git commit -m "feat(assistant): anchor relative time to the note's own date"
```

---

### Task 5: The clients send their zone, and show the dates

**Files:**
- Modify: `apps/web/src/app/assistant-box.tsx`
- Modify: `apps/web/src/app/provenance.tsx`
- Modify: `apps/mobile/src/lib/assistant/stream.ts:44-52`
- Test: `apps/web/src/app/assistant-box.test.tsx`
- Test: `apps/mobile/src/lib/assistant/stream.test.ts`

**Interfaces:**
- Consumes: `assistantInput.timeZone` (Task 2); `Citation.createdAt` (Task 3); `formatNoteDate` (Task 2).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/app/assistant-box.test.tsx`:

```ts
it("sends the browser's time zone with the turn", async () => {
  const bodies: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/notes")) return new Response(JSON.stringify({ id: "n1" }), { status: 201 });
    bodies.push(String(init?.body ?? ""));
    return sse([["done", { messageId: "m1", sessionId: "s1" }]]);
  }) as typeof fetch;

  render(<AssistantBox token="t" initialTurns={[]} />);
  await userEvent.type(screen.getByLabelText(/what are you thinking/i), "chạy bộ");
  await userEvent.click(screen.getByRole("button", { name: /send/i }));

  await waitFor(() => expect(bodies).toHaveLength(1));
  // Whatever the test runner's zone is -- asserting a literal would pin the CI machine's
  // configuration, which is not the claim. The claim is that a real zone is sent.
  const sent = JSON.parse(bodies[0]!) as { timeZone?: string };
  expect(sent.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
});

// The same information the prompt gets, shown to the user -- so "why did it say that?" is
// answerable by looking. It also makes five citations from five different days legible as five
// different notes, which "Untitled" x5 never was.
it("shows each cited note's date", () => {
  render(<AssistantBox token="t" initialTurns={[{
    id: "a1", role: "assistant", content: "…", incomplete: false,
    citations: [{
      type: "note", noteId: "n1", title: null, snippet: "Ngày mai có hẹn đi xem spiderman",
      score: 1, matchedBy: "fts", createdAt: "2026-08-12T03:00:00.000Z",
    }],
  }]} />);
  expect(screen.getByText(/12-08-2026/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm turbo run test --filter=@cortex/web -- assistant-box`
Expected: FAIL — the body has no `timeZone` and no date is rendered.

- [ ] **Step 3: Send the zone**

In `apps/web/src/app/assistant-box.tsx`, change the `/assistant` body:

```tsx
        body: JSON.stringify({
          noteId: note.id,
          // Read per turn rather than captured once: it costs nothing and it is correct across
          // a DST change or a flight. The server validates it (resolveTimeZone) -- this value
          // comes from the browser, and the browser is not trusted input.
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
```

Mobile's body is built in `apps/mobile/src/lib/assistant/stream.ts:49`, not in the screen — the screen calls `streamTurn(...)`. Add the field there:

```ts
      body: JSON.stringify({
        noteId: args.noteId, content: args.content, createdAt: args.createdAt,
        // Read here rather than passed in from the screen: it is a property of the device at
        // send time, not of the capture. The server validates it (resolveTimeZone).
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
```

and pin it in `apps/mobile/src/lib/assistant/stream.test.ts`, which already drives `streamTurn` with a `fetchFn` double — assert the parsed body carries a `timeZone` equal to `Intl.DateTimeFormat().resolvedOptions().timeZone`, not a hard-coded zone.

**Verify this on a device or in the Hermes bundle before trusting it.** React Native ships `Intl` with Hermes, but a build without full ICU returns `"UTC"` for `resolvedOptions().timeZone` regardless of the device's actual setting. `"UTC"` is a *valid* zone, so `resolveTimeZone` would accept it and every mobile date would silently shift — worse than sending nothing, because nothing falls back to `Asia/Ho_Chi_Minh`. If the bundle returns `"UTC"`, omit the field on mobile and leave a comment recording which build produced it and when it was checked.

- [ ] **Step 4: Show the date**

In `apps/web/src/app/provenance.tsx`, extend `label` to lead with the date:

```tsx
const label = (c: { title: string | null; snippet: string; createdAt: string | null }) => {
  const text = c.title?.trim() || c.snippet.split("\n")[0]?.trim() || "";
  const body = text === "" ? "Untitled" : text.length > 80 ? `${text.slice(0, 80)}…` : text;
  // The same zone the prompt was rendered in, from the same function -- a UI that dated a note
  // one day off from the answer above it would be worse than showing nothing.
  const on = c.createdAt
    ? formatNoteDate(c.createdAt, Intl.DateTimeFormat().resolvedOptions().timeZone)
    : null;
  return on ? `${on} · ${body}` : body;
};
```

importing `formatNoteDate` from `@cortex/shared`.

- [ ] **Step 5: Run the web gates**

```bash
pnpm turbo run lint typecheck test --filter=@cortex/web --filter=@cortex/mobile
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/ apps/mobile/src/screens/assistant-box.tsx
git commit -m "feat(clients): send the caller's time zone and date each citation"
```

---

### Task 6: Verification and PR

**Files:** none.

- [ ] **Step 1: Run every gate**

```bash
pnpm turbo run lint typecheck test build
```

Expected: PASS. **Read the `Cached:` line.** A gate that did not run did not pass.

- [ ] **Step 2: Force the database suites**

```bash
docker ps
pnpm turbo run test --filter=@cortex/db --filter=@cortex/api --force
```

Expected: real execution, PASS — `search-notes` and `default-grants` in particular. `default-grants` is the one that catches a dropped ACL, and a dropped ACL is the one risk this plan introduces that nothing else would notice.

- [ ] **Step 3: Confirm no new suite is invisible to CI**

```bash
git diff --name-only --diff-filter=A main -- '*.test.ts' '*.test.tsx'
```

Expected: `packages/shared/src/time.test.ts` and nothing else. `@cortex/shared` is already named in `ci.yml`'s `checks` job.

- [ ] **Step 4: Reproduce the original defect, by hand**

This is the only check that tests the thing the plan is for.

1. `pnpm dev`. Capture a note that says something in the future: **"Ngày mai có hẹn đi xem phim lúc 8h sáng"**.
2. In the database, backdate it: `update notes set created_at = now() - interval '4 days' where id = '<id>';`
3. Ask **"tôi có hẹn gì không"**.

The answer must place the appointment on the day after the note's date and say it has **already passed**. If it says "sáng mai", the rule in Task 4 step 4 is not reaching the model — check that `timeZone`/`now` are actually threaded and that the citation carries a `createdAt`.

4. Then, an evening note: capture something at 23:00 local. Its citation date must be **today's** local date, not tomorrow's UTC one. That is the time-zone half, and `time.test.ts` covers the function but not the wiring.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "Temporal context: the assistant gets a clock" --body "…"
```

The body must state: the defect and its date; that migration `00032` **drops and recreates** `search_notes` and therefore restates the grants, and why that was unavoidable; that time zones arrive per request and are validated rather than trusted, defaulting to `Asia/Ho_Chi_Minh`; and that citations written before this ship carry no date and render without one by design, with no backfill.

- [ ] **Step 6: Watch CI, including the checks that block**

A required check is a **literal job name**. If every visible check is green and the PR still reads BLOCKED, branch protection is requiring a job name that no longer exists — see `docs/ci.md`.

---

## Self-Review

**Defect coverage.** Every row of the table under "The defect" has a task: `search_notes`'s missing column → Task 1; `Citation`'s missing field (both copies) → Task 3; `renderCitations` → Task 4 step 3; `renderHistory`'s dropped `createdAt` → Task 4 step 3; the absent "today is" anchor → Task 4 step 4. The rule that turns a resolvable date into a correct answer — *report a past moment as past* — is Task 4 step 4 and is asserted in Task 4 step 1.

**What this plan deliberately does not do.** It does not resolve dates at capture time. "Ngày mai có hẹn đi xem phim" could be parsed into a real timestamp on `domain_meta` when the note is written, which would survive re-reading and would not depend on the model doing arithmetic — that is strictly stronger and it is also the beginning of tasks and a calendar, which is a different product surface with its own storage, its own UI and its own spec. Nothing here forecloses it: a note dated in the prompt and a note carrying a resolved `event_at` compose fine.

**Placeholders.** Three remain, each naming the file to read: `retrieve.test.ts`'s existing fake-RPC setup (Task 3 step 1), `default-grants.test.ts`'s catalog-privilege helper (Task 1 step 5), and mobile's `/assistant` body construction (Task 5 step 3). Each is a case where this repo already has exactly one helper and inventing a second is the failure the step exists to prevent. Task 2 step 4 additionally instructs the executor to correct the *assertion* rather than the implementation if ICU's Vietnamese weekday casing differs — pinning a dependency's cosmetics is not the requirement.

**Type consistency.** `createdAt: string | null` is the name and type in `retrieve.ts`'s `Citation`, in `@cortex/shared`'s `Citation`, in `readCitation`'s output, in `renderCitations`, and in `provenance.tsx`'s `label`. The SQL column is `created_at` and is mapped once, in `retrieve.ts`. `formatNoteDate(iso, timeZone)` returns `string | null` and every call site handles the null by omitting the date. `formatToday(now, timeZone)` returns a plain `string` and is called in `temporalRule` and in Task 4 step 6's assertion. `resolveTimeZone` is called exactly once per turn, in `turn.ts`; neither prompt builder calls it, and both take an already-resolved `timeZone: string`.
