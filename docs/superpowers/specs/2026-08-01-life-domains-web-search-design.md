# Cortex — Life-Domain Expansion + Web Search: Design

**Status:** approved 2026-08-01 (sections reviewed and accepted in design session)
**Parent spec:** `docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md`
**Amends:** parent §4 (AI provider choices), §6 (schema), §9 (jobs), §13 (phases)
**Prerequisite state:** Phase 0 complete (schema v1 live, auth, API deployed); Phase 1a
specced and in flight; no AI subsystem built yet.

---

## 0. Summary and decisions log

Two extensions to the parent design, planned before the AI phases are built so they
land as revisions to unbuilt phases rather than retrofits:

1. **Life-domain expansion** — the system becomes a genuine whole-life second brain:
   media logging, sports/health, hobbies/daily life, learning + spaced repetition,
   reflection journaling, personal-finance decisions, and mood/energy check-ins.
2. **Web search in RAG chat** — the chat assistant can search the public internet and
   blend results with personal-note retrieval, with provenance kept visibly separate.

Decisions made in the design session:

| Decision | Choice |
| --- | --- |
| Roadmap integration | Interleave into the existing phases (not appended as new phases) |
| First-month domains (build order) | Mood/energy, media, sports/health, learning/reflection; hobbies + finance get data-model support with later UI |
| Data model | Typed notes + 3 structured tables (`media_items`, `checkins`, `flashcards`) |
| AI provider | **Full switch from Claude to Gemini** (supersedes parent §4 model table) |
| Web search mechanism | Gemini Grounding with Google Search (consequence of the provider switch) |
| Memory layer informed by web searches | No — rejected as scope creep (see §6.4) |
| `people` table | Deferred — relationships ride on `memory_facts` category `relationship` |

The one already-built thing this touches is schema v1 in production; every schema
change below is an additive migration (or a type change on a zero-row column).

---

## 1. Provider swap: Claude → Gemini (supersedes parent §4 model choices)

Nothing AI is implemented, so this is a spec revision with no code rework. The
`packages/ai` provider-interface design from the parent spec survives unchanged; only
the implementations behind the interfaces change.

| Workload | Parent spec | This spec |
| --- | --- | --- |
| Reasoning (chat, digests, memory ops, drafting) | Claude Opus 5 | Gemini 3 Pro |
| High-volume classification (tagging, task extraction, domain suggestion) | Opus 5 / Haiku lever | Gemini 3 Flash |
| Embeddings | Voyage `voyage-3.5` (1024-dim) | `gemini-embedding-001` at **1536-dim** (MRL truncation; same MTEB score as full 3072 at half the storage) |
| Voice transcription | Groq Whisper | Gemini native audio input (Flash) — **Groq dependency deleted** |
| Background jobs | Claude Batches API (−50%) | Gemini Batch API (−50%) — digests/memory sweeps stay batch |
| Prompt caching | Byte-stable profile preamble (Claude prompt cache) | Same principle — Gemini context caching is prefix-based; parent §10.5's byte-stable-preamble rule carries over verbatim |
| Structured outputs (memory ops) | Claude structured output | Gemini `responseSchema` |

Consequences:

- **Migration `00012_embedding_dims.sql`:** `note_chunks.embedding` and
  `memory_facts.embedding` are `vector(1024)` (sized for Voyage). Zero rows exist, so
  `alter column ... type vector(1536)` is trivial. HNSW supports 1536 dims. Record
  `embedding_model = 'gemini-embedding-001@1536'` per chunk as already designed.
- **Paid tier is mandatory** before any AI phase ships: Gemini free-tier prompts are
  used for training; paid-tier prompts are not. With health/mood/finance content
  flowing through the API this is the single most consequential privacy control in
  the system (§5). Verify the project is on paid tier as a phase-2 entry checklist item.
- Provider count drops from three (Claude + Voyage + Groq) to one.
- Exact model ID strings are pinned at implementation time; this spec names tiers.
- Grounding cost: 5,000 free grounded prompts/month across the Gemini 3 family, then
  $14 per 1,000 search queries — effectively free at 2-3 users.

---

## 2. Life-domain data model

Principle: **notes stay the universal container** — every domain log is a note and
inherits FTS, embeddings, tagging, linking, digests, export, and RLS with zero
pipeline duplication. Structured tables exist only where a note genuinely cannot do
the job: entity identity (`media_items`), high-frequency two-word timeseries
(`checkins`), and scheduled card review (`flashcards`).

Migrations A-C ship as one migration file (or B before A — A's `media_item_id`
foreign key requires `media_items` to exist first).

### 2.1 Migration A — typed notes

```sql
alter table public.notes
  add column domain text
    check (domain in ('media','health','life','learning','finance','reflection')),
  add column domain_meta jsonb not null default '{}',
  add column media_item_id uuid references public.media_items(id) on delete set null;
-- idx: (user_id, domain) where domain is not null
```

- `domain` is nullable — undomained notes are normal notes. Set by the user at
  capture (one-tap chip) or suggested by enrichment through the existing
  suggested-first + `feedback_events` machinery, same trust dial as tags.
- `domain_meta` is zod-validated per domain in `packages/shared` (`src/dto/domains.ts`):
  - media: `{ rating?: 1..5, consumed_at?: date, status?: 'finished'|'in_progress'|'abandoned' }`
  - health: `{ activity_type?: string, duration_min?: number, intensity?: 1..5 }`
  - finance: `{ amount?: number, currency?: string, decision_type?: 'purchase'|'investment'|'other' }`
  - learning: `{ language?: string, topic?: string }`
  - life / reflection: `{}` (freeform only)
- Enrichment fills `domain_meta` from the freeform text, suggested-first. **Freeform
  text remains the source of truth; structure is extracted, never required at
  capture** (capture in your own shorthand, parse afterwards — the pattern the
  workout-log research validates).
- Recipes and variations: `links.kind = 'variation_of'` (kind is already free text;
  documented value, no migration). No recipe table.
- People/relationships: **no table.** `memory_facts` already has category
  `relationship`; birthdays, preferences, and last-contact become facts with evidence
  links to the notes that mention them. A `people` table is deferred until facts
  prove insufficient.

### 2.2 Migration B — `media_items`

The media *item* is an entity; the *log* is a note (the Letterboxd model: deliberate
logging, rewatches as separate dated entries against one item).

```sql
create table public.media_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('movie','tv','book','game','podcast')),
  title text not null,
  year int,
  creator text,
  external_meta jsonb not null default '{}',   -- room for TMDB/OpenLibrary ids later
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index media_items_user_kind_title_uidx
  on public.media_items (user_id, kind, lower(title)) where deleted_at is null;
```

Rewatches = multiple notes pointing at one item, each carrying its own
rating/impression in `domain_meta`. "Media that inspired an idea" = ordinary `links`
rows between the log note and the idea note.

### 2.3 Migration C — `checkins` and `flashcards`

```sql
create table public.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mood smallint check (mood between 1 and 5),
  energy smallint check (energy between 1 and 5),
  label text,                                   -- the optional 1-2 words
  created_at timestamptz not null default now(),
  deleted_at timestamptz,                       -- tombstone: synced tables need it (parent §6), and mis-taps must be deletable
  check (mood is not null or energy is not null)
);
-- idx: (user_id, created_at desc)

create table public.flashcards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid references public.notes(id) on delete cascade,
  front text not null,
  back text not null,
  source text not null default 'ai',            -- user|ai
  status text not null default 'suggested',     -- suggested|active|suspended
  due_at timestamptz,
  interval_days real not null default 1,
  ease real not null default 2.0,
  lapses int not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
```

- Check-ins are deliberately **not notes** (the Daylio lesson): a two-word mood
  several times a day would flood the inbox, FTS, and the embedding pipeline with
  noise. They are a timeseries the synthesis layer reads.
- Flashcards reuse the SM-2-lite **functions** shared with `review_queue`
  (`packages/core/review`), not its table — one scheduling algorithm, two payloads.
  AI-extracted cards land as `suggested` with the standard accept/reject flow.
- All three tables: standard RLS (`user_id = auth.uid()`, default-deny), added to the
  `supabase_realtime` publication, added to PowerSync sync rules in phase 1b, added
  to the cross-user isolation test suite, and included in `GET /export`
  (`manifest.json` gains `media_items`, `checkins`, `flashcards` arrays).

---

## 3. Capture UX per domain

| Domain | Capture surface | Rationale |
| --- | --- | --- |
| Mood/energy | Dedicated 2-tap widget: web = persistent header strip (5 mood faces + optional energy row + optional 1-word label); mobile (1b+) = home-screen widget. Writes a `checkins` row, sub-second, no textarea. | Friction kills mood logging; Daylio's entire moat is two taps and no blank page. |
| Media | "Log media" mini-form: title autocomplete against the user's `media_items` (find-or-create), star rating, freeform impression box → note with `domain='media'` + `media_item_id`. | Needs the entity link and rating; the impression stays freeform because it is the part that links to ideas. |
| Sports/health | General capture + one-tap domain chip; enrichment auto-suggests `health` when the chip is skipped. | Freeform by explicit constraint ("not a fitness tracker"). |
| Hobbies/life, finance | Same: general capture + chip / auto-suggestion. | Same. |
| Learning/vocab | General capture; enrichment extracts flashcard candidates from vocab-shaped notes → `suggested` cards. | Cards created inside notes (RemNote's winning pattern) — zero card-creation friction. |
| Reflection | Pull, not push: the weekly digest includes 2-3 AI prompts generated from the memory layer + the week's logs; answering one creates a note with `domain='reflection'`. | Reflection responds to synthesis (Rosebud's loop, minus its amnesia — Cortex's memory layer is exactly the fix for its top complaint). |

---

## 4. Cross-domain synthesis

One principle added to the parent's digest design: **deterministic stats in SQL,
narrative in the LLM** — the model never asserts a correlation it cannot cite
provided numbers for.

- A `weekly_signals` step inside the existing `digest.weekly` job (not a new job)
  computes per-week aggregates in SQL: avg mood / avg energy and check-in count,
  health-note count, media logged, finance decisions, tag-frequency deltas
  (e.g. "work-stress" mentions), flashcard review stats.
- The digest prompt receives (a) note clusters as before, and (b) the signals table
  for the current week vs a trailing 4-week baseline, with the instruction to surface
  cross-domain observations **only when grounded in the provided numbers**, phrased
  as correlation, never causation ("3 workout logs vs your 7/week baseline; mood avg
  2.4 vs 3.6 — these moved together this week").
- Reflection prompts (§3) are generated in the same batch call from signals + memory
  facts. No new pipeline.
- This dependency is why check-ins ship in the earliest new phase (1c): phase-7
  pattern detection is only as good as the baseline accumulated by then.

---

## 5. Privacy: the line, drawn

Threat model for 2-3 invited friends on a shared deployment: (1) cross-user leakage,
(2) AI-provider data usage, (3) the operator being able to read testers' data,
(4) accidental leakage via logs/telemetry. Out of scope: cryptographic secrecy from
the operator — that is E2EE, already correctly rejected in parent §2.5 because
server-side AI must read plaintext.

**Warranted (all cheap, all in this plan):**

1. **Same tested RLS discipline for new tables** — the phase-0 cross-user isolation
   suite extends to `checkins`, `media_items`, `flashcards`. RLS *is* the primary
   real protection for health/mood/finance rows, and it is provable.
2. **Gemini paid tier only**, verified before phase 2 ships — paid-tier prompts are
   excluded from model training; free-tier prompts are not.
3. **No-content logging rule** — NestJS loggers and (phase 10) Sentry record IDs and
   counts, never note bodies, check-in values, or chat text. Convention in
   `packages/core`, checked in review.
4. **Tester disclosure doc** — one page shown at invite: no E2EE; the operator can
   technically read the database; content is processed by Google's API under
   paid-tier terms; full export and hard delete are available.
5. **Account-wipe endpoint** — `DELETE /me`: cascade purge of all rows + auth user
   deletion. Complements the existing per-note trash/purge.

**Rejected as overkill:** application-layer/column encryption for mood, health, or
finance content (breaks FTS, embeddings, and digest SQL, while the key necessarily
sits next to the data — E2EE's costs without its guarantee); per-user databases;
self-hosted LLM. Column encryption remains only where the parent put it:
`integrations.credentials` via Supabase Vault.

**Stated plainly:** for this project, sensitive-data protection = provable isolation
(RLS tests) + provider data-usage guarantees (paid tier) + operational hygiene
(no-content logs) + informed consent (disclosure). Half-measures that pretend to be
more would be worse than honesty about the model.

---

## 6. Web search in RAG chat (Gemini Grounding with Google Search)

### 6.1 Architecture

The phase-3 chat pipeline keeps the parent's shape — hybrid note retrieval runs
first and is injected as context (retrieval is *not* a model-called tool) — and the
request additionally declares Gemini's built-in `google_search` tool. The model
decides per turn whether to search. System-prompt policy: *answer from the user's
notes first; search when the notes cannot answer or the question is time-sensitive;
never present web content as the user's own thoughts.*

This sidesteps mixing function-calling with grounding (historically limited on
Gemini — verify current status at implementation; if mixing is supported, note
retrieval could later become a tool without schema changes).

### 6.2 Provenance and UI

- `chat_messages.citations` entries gain a discriminator:
  `{type:'note', note_id, chunk_index, quote}` | `{type:'web', url, title}` (web
  entries built from Gemini `groundingMetadata`).
- The UI renders the two kinds distinctly (note icon vs globe), and answers using
  both show a visible split: "From your notes / From the web".
- Google's ToS requires rendering the returned Search Suggestions entry point when
  grounding is used — a small mandatory UI element, budgeted into phase 3.

### 6.3 Saving results back into the corpus

A "save as note" action on any web-cited answer creates a note with
`source_type='web_search'`, `lifecycle='inbox'`, and the URL in `source_meta`.
Corpus pollution is handled by **provenance, not prohibition**:

- `search_notes()` down-weights externally-sourced notes (~0.8 multiplier, same
  mechanism as the recency multiplier);
- retrieval results carry the source type, so chat cites them as "a search result
  you saved", never as the user's own thinking;
- the note list gains a saved-external filter chip.

Auto-saving search results is rejected — saving is always a deliberate act.

### 6.4 Memory layer and web searches: no

Rejected as scope creep, and unnecessary: chat transcripts (including the user's
questions) already feed the nightly `memory.update`, so recurring searched topics
surface through the existing evidence pipeline, where the ≥2-independent-sources
rule filters out one-offs (gift research ≠ durable interest). A dedicated
search-signal pipeline would add a weak-evidence source to the most trust-sensitive
subsystem. Revisit only if memory quality is demonstrably missing interests.

---

## 7. Revised roadmap

Phase 0 (done) and the approved 1a spec are untouched. Deltas in **bold**; each
phase remains independently demoable. Phase 1c gets its own detailed phase spec
(like 1a's) before implementation.

| # | Phase | Delta from parent §13 | Demo |
| --- | --- | --- | --- |
| 1a | Web notes (in flight) | none | per 1a spec |
| **1c** | **Life-domain capture** (immediately after 1a; no AI required) | **Migrations A/B/C + `00012` embedding dims; mood/energy widget; media log form; domain chips + list filters; export gains new tables; RLS isolation tests extended** | Log mood in 2 taps; log a movie with stars + impression; filter notes by domain |
| 1b | Mobile + PowerSync | + new tables in sync rules; mobile mood widget | parent demo + offline check-in |
| 2 | AI enrichment v1 | **Gemini Flash + `gemini-embedding-001@1536`; + domain suggestion; + `domain_meta` extraction; + flashcard candidate extraction; paid-tier verification gate** | "bench 3x8 felt weak" → suggested `health` + structured meta |
| 3 | RAG chat | **+ `google_search` grounding; dual-provenance citations; Search-Suggestions UI; save-as-note with down-weighting** | "What did I think of Dune, and what are critics saying about part 3?" → answer visibly split notes/web |
| 4 | Capture everywhere | **Voice via Gemini native audio (Groq deleted)** | per parent |
| 5 | Auto-linking / organize v2 | + media↔idea link suggestions | per parent |
| 6 | Tasks + resurfacing | **+ flashcards mixed into the daily review queue (shared SM-2, capped mix)** | Morning review: 3 notes + 2 vocab cards |
| 7 | Synthesis | **+ `weekly_signals` SQL stats; cross-domain correlations; reflection prompts → reflection notes** | Digest: "workouts down, work-stress mentions up — moved together"; answering a prompt creates a note |
| 8 | Memory layer | unchanged (relationship facts gain richer domain evidence) | per parent |
| 9 | MCP + calendar | + `log_checkin`, `log_media` MCP tools | Claude Desktop logs a mood check-in |
| 10 | Hardening + beta | **+ tester disclosure doc; `DELETE /me` account wipe; no-content-logging audit** | per parent |

Sequencing rationale: 1c precedes 1b because it is pure CRUD on the 1a foundation
(days of work) and starts the mood/media baseline accumulating that phases 7-8 need
months of.

---

## 8. Research grounding (summary)

- **Daylio** — two-tap, no-blank-page mood capture; insights from minimal input →
  dedicated check-in widget, structured payload, never the general textarea.
- **Letterboxd vs Trakt** — deliberate logging beats scrobbling for a second brain;
  the media item is an entity separate from the dated log entry → `media_items` +
  log notes.
- **Workout logging research** — freeform capture in the user's own shorthand,
  structure parsed afterwards → enrichment fills `domain_meta`, capture stays text.
- **Rosebud / AI journaling** — personalized prompts from prior entries are loved;
  the top complaint is forgetting what it was told → reflection prompts generated
  from Cortex's auditable memory layer.
- **RemNote / SRS** — cards created inside notes with real scheduling → flashcards
  extracted from notes, SM-2-lite shared with `review_queue`.
- **ChatGPT memory + search (2026)** — layered, user-inspectable memory blended with
  search validates the parent design; no mainstream product cleanly separates
  "from your data" vs "from the web" in the UI → dual-provenance citations are a
  deliberate differentiator.
- **Pricing verified 2026-08:** Gemini 3 grounding 5,000 free prompts/month then
  $14/1K queries; `gemini-embedding-001` $0.15/1M tokens, 1536-dim MRL ≈ 3072-dim
  quality. (Claude native web search, the rejected alternative, is $10/1K.)

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Gemini grounding + function calling can't be mixed in one request | Design already avoids it (retrieval injected as context, not a tool); verify at phase-3 implementation |
| Domain enum too coarse or wrong | `domain` is one nullable column + jsonb; adding a value is a check-constraint migration, and undomained notes are always valid |
| Check-in habit doesn't stick → phase-7 correlations starve | Widget ships in 1c (earliest possible); digest degrades gracefully to note-cluster-only when signals are sparse |
| Gemini model/pricing churn between now and phase 2 | Tiers named, IDs pinned at implementation; `packages/ai` interface keeps a provider swap contained |
| `domain_meta` extraction quality poor | Suggested-first + feedback events from day one, same trust dial as tags; freeform text remains source of truth |
| Google grounding ToS UI requirements missed | Search Suggestions rendering is an explicit phase-3 checklist item |
