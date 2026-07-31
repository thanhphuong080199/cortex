# Cortex — AI Second Brain: Full Product & Architecture Design

**Date:** 2026-07-31
**Status:** Draft for review (planning only — no implementation yet)
**Author:** Claude (Fable 5), directed by Thanh Phuong Le

---

## 0. One-paragraph summary

Cortex is an offline-first, multi-user personal knowledge system: frictionless capture from mobile/web/Telegram/email/voice, automatic organization (AI tagging, semantic linking, PARA-ish structure), retrieval by meaning (hybrid semantic + keyword search, RAG chat with citations and temporal awareness), synthesis (weekly digests, contradiction detection, auto-drafting), task extraction with spaced-repetition resurfacing, and — the differentiator — a **curated, user-auditable long-term memory layer** that builds an evolving model of the user and personalizes every other subsystem over time. Stack: Expo + Next.js clients sharing TypeScript packages in a Turborepo monorepo; NestJS backend on Railway/Fly; Supabase (Postgres + pgvector + Auth + Storage) with RLS; PowerSync for offline-first sync; Claude API for reasoning; Voyage AI for embeddings; an MCP server exposing the same core services to Claude Desktop/Code.

---

## 1. Competitive research

| Product | What it nails | Where it falls short / common complaints | Memory / personalization layer? |
|---|---|---|---|
| **Obsidian + Smart Connections / Copilot** | Local-first, plugin ecosystem; Smart Connections does real embedding-based related-notes + vault RAG chat ([overview](https://wetheflywheel.com/en/radar/obsidian-ai-plugins/)) | Requires assembly and discipline; retrieval quality depends on vault structure; vector stores bloat sync; mobile plugin experience is weak; no server-side processing, so no background enrichment | No. Retrieval is stateless RAG over raw notes; nothing learns *about you* over time |
| **Notion AI** | Deeply integrated writing assistance, workspace Q&A, databases | Heavy/slow for quick capture; AI is generic ("summarize this page"), doesn't build understanding; offline support historically poor; per-seat AI pricing ([comparison](https://aitoolpick.org/blog/logseq-vs-notion-2026/)) | No. Workspace-scoped Q&A only |
| **Mem (2.0)** | Closest competitor in spirit: frictionless capture, auto-tagging, AI search/chat, email/voice/clipper ingestion ([reviews](https://blog.saner.ai/mem-ai-reviews/), [PH](https://www.producthunt.com/products/mem-2-0/reviews)) | Weak basic editing, no Android app, weak exact-keyword search, limited integrations/API, unresponsive support, restrictive free tier | Partial. "Self-organizing" and personalized surfacing, but the model of you is opaque — users can't see, correct, or steer it |
| **Reflect** | Fastest editor around; best-in-class Whisper transcription; E2E encryption; calendar-linked meeting notes; clean backlinking ([review](https://www.buildfastwithai.com/ai-tools/reflect)) | No automatic organization (manual backlinks), no offline access, no databases/tables, no free plan | No. AI is per-request (summarize, transcribe); nothing persistent |
| **Tana** | Supertags — genuinely novel structured-note paradigm; live queries; strong voice capture + meeting AI ([reviews](https://blog.saner.ai/tana-reviews/)) | Steep learning curve; mobile app poor (2.15/5 on Play Store — slow sync, crashes); lock-in; pricey | No. Structure is powerful but entirely user-built |
| **Rewind → Limitless (acquired by Meta, Dec 2025)** | Effortless total capture (screen/audio pendant); proved demand for "AI that remembers your life" ([guide](https://skywork.ai/skypage/en/Rewind-AI-&-Limitless:-The-Ultimate-Guide-to-Your-Digital-Memory/1976181260991655936)) | Capture-everything ≠ understanding; privacy anxiety; original Rewind app sunsetted post-acquisition — a warning about platform dependence | Closest attempt: builds a passive memory of events/conversations, but no user curation and no synthesis of *beliefs/patterns* |
| **Recall** | Save-and-summarize external content (videos, articles); auto-categorization; spaced-repetition review of saved knowledge ([compare](https://www.recall.it/compare)) | Oriented at consuming others' content, not your own thinking; weak as a notes editor | No |
| **Logseq** | Free, open-source, local-first outliner; great for daily journaling + linking | Unrefined mobile; poor long-form writing; DB version perpetually delayed; AI only via plugins ([alternatives](https://speakwiseapp.com/blog/logseq-alternatives/)) | No |
| **Roam Research** | Invented modern bidirectional linking | Stagnant development, no meaningful AI story, users migrated to Tana/Obsidian/Reflect | No |
| **Readwise** | The reference implementation of resurfacing: daily review, probability-half-life spaced repetition, tunable weighting ([docs](https://docs.readwise.io/readwise/docs/faqs/reviewing-highlights)) | Highlights only, not your own notes | No, but its resurfacing algorithm is the model to copy for §7 review scheduling |
| **Mem0 (infrastructure)** | Open-source (Apache-2.0) memory layer for agents: extracts facts/preferences from conversations, vector retrieval, self-improving ([repo](https://github.com/mem0ai)) | It's a library/API, not a product; generic fact extraction, no domain model of "notes" | Yes — validates the architecture (extract → store facts → retrieve at prompt time). We build our own domain-specific version rather than adopting it (see §10.6) |

### Takeaways

1. **Nobody ships a transparent, user-auditable memory layer.** Mem and Limitless personalize opaquely; everyone else doesn't personalize at all. A visible "what Cortex believes about me" page with accept/reject is both the differentiator and the trust mechanism.
2. **Mobile is where incumbents die.** Tana, Logseq, Mem (no Android) all bleed users on mobile. Offline-first + fast mobile capture is a real moat, not a checkbox.
3. **Auto-organization is promised everywhere, delivered nowhere** — either fully manual (Reflect, Obsidian) or fully opaque (Mem). The winning pattern is *suggested-first*: AI proposes, user confirms with one tap, system learns from the confirmations.
4. **Keyword search still matters.** Mem's weak exact-match search is a top complaint — semantic search complements, never replaces, FTS. Hybrid retrieval is mandatory.
5. **Resurfacing works when it's effortless** (Readwise's daily email). Push, don't pull.

---

## 2. Gaps to add to the feature set

Based on the research, these commonly-missing/commonly-requested capabilities are worth adding to your spec:

1. **Hybrid search (FTS + vector), not vector-only** — see takeaway 4. (Adopted in §6.)
2. **Full data export / no lock-in** — Tana's "difficulty leaving" and Rewind's sunset are recurring fears. Ship Markdown + JSON export from day one; it's cheap and builds trust with your testers.
3. **A daily push touchpoint** — Readwise-style daily review email/notification (on-this-day + due reviews + yesterday's extracted tasks). This is the habit loop every retention-successful tool has.
4. **Meeting/calendar-aware notes** (Reflect's most-loved feature) — you already planned calendar integration; make the specific UX "today's events appear as note stubs."
5. **End-to-end encryption** — Reflect's E2EE is loved, but it's **fundamentally incompatible with server-side AI enrichment** (the server must read plaintext to embed/tag/digest). Decision: *do not* attempt E2EE; be explicit about the privacy model instead (your Supabase project, your API keys, encryption at rest, no third-party analytics). Documented so testers know.
6. **Trust dial for automation** — start with everything "suggested", let the user graduate categories to auto-apply (per-tag, per-feature). Addresses the universal complaint that auto-organization is either annoying or opaque.
7. **Capture confirmation feedback** — sub-second "saved ✓" on quick capture even offline (trivially true with local-first, worth stating as an explicit UX requirement).

---

## 3. Additional features grounded in daily use

Suggested additions (all fit the existing architecture; none require new infrastructure):

1. **Daily digest notification** (see gap 3) — the single highest-retention feature.
2. **"Ask before I re-decide"** — when creating a note semantically close to an old one, surface it inline ("You wrote about this 3 months ago"). Same machinery as auto-linking, different UX moment; prevents the #1 second-brain failure (write-only memory).
3. **Note lifecycle states** — `inbox → active → evergreen / archived`. Auto-archive stale inbox items into the digest ("14 notes you never touched — archive?"). Keeps the system feeling curated instead of landfill.
4. **Templates for recurring note types** (meeting, book, decision, journal) — auto-suggested from content by the tagger, never forced.
5. **Weekly "open loops" section in the digest** — questions you asked in notes but never answered, decisions marked "pending". Falls out of task-extraction machinery.
6. **Share-to-Cortex on mobile** (OS share sheet) — cheapest capture surface there is; Expo supports share extensions.
7. **Streak-free review** — deliberately *no* gamified streaks (your testers are 2-3 friends, not Duolingo users); review queue caps at ~5 items/day to stay sustainable.

Explicitly deferred (YAGNI for a personal tool): real-time collaborative editing, publishing/sharing notes publicly, team workspaces, browser-history-style total capture.

---

## 4. Corrections to your stated decisions (flagged disagreements)

These are the places I think your spec is wrong or needs a decision changed. Everything else in your constraints is adopted as-is.

| # | Your assumption | Problem | Recommendation |
|---|---|---|---|
| 1 | "Anthropic Claude API for **embeddings**" | **Anthropic has no embeddings API** — never has. [Anthropic's own docs](https://platform.claude.com/docs/en/build-with-claude/embeddings) recommend **Voyage AI**. | Voyage `voyage-3.5` (1024-dim default; strong MTEB, cheap, 200M free tokens). Store as `vector(1024)` in pgvector. Keep the embedding client behind an interface so you can swap. |
| 2 | Claude for "voice transcription" | Claude does not accept audio input. | Add a transcription provider: **Groq-hosted Whisper** (fast, effectively free at your scale) or Deepgram. Behind the same provider-interface pattern. |
| 3 | "NestJS **or** Supabase Edge Functions" | Edge Functions have wall-clock limits and awkward local DX for long AI pipelines, and you also need somewhere to run the MCP server and job workers. Splitting logic across both creates the drift you're trying to avoid. | **One NestJS service** (API + MCP endpoint + job workers in one deployable) on Railway/Fly. Edge Functions only if you later want ultra-low-latency inbound webhooks — not in the base plan. |
| 4 | "Maybe hand-rolled CRDT sync (Yjs/Automerge)" | Full evaluation in §8. Short version: CRDTs solve concurrent *intra-document* editing, which is rare for a single author on two devices, and they make your data opaque binary blobs — hostile to SQL, RLS, FTS, embeddings, and every AI pipeline you're building. | **PowerSync** (managed, or self-host the open edition later). Row-level LWW + conflict-copy fallback for note bodies. |
| 5 | RLS as the only isolation mechanism | PowerSync replicates via logical replication, **bypassing RLS on reads**; isolation there comes from PowerSync **sync rules** (bucket per `user_id` from the JWT). RLS still governs all API-path access and client uploads. | Keep RLS everywhere *and* treat sync rules as a second, equally-audited isolation layer. Both are specified in §11. |
| 6 | "Auto-applied PARA/Zettelkasten" | Research shows fully-automatic organization is either wrong or opaque (Mem), and users hate both. | Suggested-first with a **trust dial** (§2 gap 6): AI proposes PARA placement/tags/links; one-tap accept; per-category auto-apply once precision is proven to you personally. |
| 7 | "Full completeness from the start" (implicitly: build everything) | Two features have poor cost/benefit **at the start**: contradiction detection (needs months of notes to be non-trivial) and codebase integration (you marked it nice-to-have). | Both stay in the plan (§13 phases 7 and 10) but late, where they have data to work with. Also added, because "complete" requires it: **cost controls and observability** for LLM spend (per-user budgets, dead-letter queue) — a real product has these. |
| 8 | Web offline as co-equal with mobile | PowerSync's web SDK (OPFS/wa-sqlite) works, but browsers evict storage, multiple tabs complicate things, and iOS Safari is hostile. | **Web is online-only** (decided in review, 2026-07-31): web reads/writes via Supabase client + API directly (RLS-enforced), with Supabase Realtime for live updates. PowerSync runs on **mobile only** — offline-first is a mobile capability. Cuts sync complexity roughly in half. |

Model choices for AI workloads (current lineup, verified against the Claude API reference):
- **Reasoning tasks** (RAG chat, digests, memory updates, auto-drafting): `claude-opus-5` ($5/$25 per MTok), adaptive thinking, effort tuned per task (`high` for chat/memory, `medium` for digests).
- **High-volume classification** (auto-tagging, task extraction): `claude-opus-5` by default; `claude-haiku-4-5` ($1/$5) is the cost lever if tagging volume ever matters — your call, at 2-3 users it likely never does.
- **Background jobs** (digests, memory sweeps, backfills): run through the **Batches API — 50% off** all token usage. Digests are the textbook batch workload.
- **Prompt caching**: the memory-profile preamble (§10) is designed to be byte-stable specifically so it caches (~90% cheaper on reads).

---

## 5. System architecture overview

```
┌─────────────┐   ┌─────────────┐   ┌──────────────┐  ┌──────────────┐
│ Expo mobile │   │ Next.js web │   │ Web clipper  │  │ Claude       │
│ (SQLite via │   │ (online-only│   │ (extension)  │  │ Desktop/Code │
│  PowerSync) │   │  supabase-js│   └──────┬───────┘  │ (OPTIONAL)   │
└──────┬──────┘   │  + Realtime)│          │ REST     └──────┬───────┘
       │          └──────┬──────┘          ▼                 │ MCP (HTTP)
       │  sync stream    │ RLS reads/writes + API            ▼
       ▼                 ▼          ┌─────────────────────────────────┐
┌─────────────────────────┐  writes │  NestJS service (Railway/Fly)   │
│  PowerSync Service      │────────▶│  • REST API  • MCP endpoint     │
│  (managed; sync rules   │ uploads │  • pg-boss workers (AI jobs)    │
│   scope by user_id)     │         │  • inbound: Telegram, email     │
└───────────┬─────────────┘         └───────┬─────────────┬───────────┘
            │ logical replication          │             │
            ▼                              ▼             ▼
┌──────────────────────────────┐   ┌─────────────┐ ┌───────────────┐
│ Supabase Postgres + pgvector │   │ Claude API  │ │ Voyage AI     │
│ (RLS on every table)         │   │ (Opus 5,    │ │ (embeddings)  │
│ + Supabase Auth (Google)     │   │  Batches)   │ │ Groq Whisper  │
│ + Supabase Storage (audio,   │   └─────────────┘ │ (transcribe)  │
│   clips, attachments)        │                   └───────────────┘
└──────────────────────────────┘
```

Data-flow principles:

1. **Mobile reads are local.** The mobile app queries its local SQLite replica — lists, note bodies, tags, tasks, review queue all offline-capable and instant. **Web is online-only**: it reads/writes via supabase-js (RLS) and the API, with Supabase Realtime subscriptions for live updates.
2. **Mobile writes are local, then uploaded.** PowerSync queues local mutations; its `uploadData` hook posts them to the NestJS API, which writes to Postgres **as the user** (Supabase client with the user's JWT → RLS enforced on the write path). Web writes hit the same path directly (supabase-js or API), no sync queue.
3. **AI is server-side and asynchronous.** Note commits enqueue enrichment jobs (embed → tag → link → extract tasks). Results sync back down as ordinary rows — the client never calls an LLM directly.
4. **Online-only features degrade gracefully.** Semantic search, RAG chat, and digest generation require the server; the UI falls back to local FTS when offline.
5. **One core, many faces.** REST API, MCP tools, Telegram bot, and job workers all call the same `packages/core` services. No reimplementation anywhere.

---

## 6. Database schema

All tables have `user_id uuid not null references auth.users(id)`, RLS enabled, and policy `user_id = auth.uid()` for all four operations unless noted. `id` is `uuid default gen_random_uuid()`. Timestamps are `timestamptz`. Soft-delete via `deleted_at` on synced tables (PowerSync needs tombstones).

### 6.1 Content

```sql
notes (
  id, user_id,
  title            text,                 -- nullable; quick captures are untitled
  content          text not null default '',   -- markdown source of truth
  content_text     text generated always as (strip_markdown(content)) stored, -- for FTS; strip_markdown = small IMMUTABLE plpgsql helper (regex-strips md syntax), shipped in migrations
  source_type      text not null default 'quick',  -- quick|web_clip|voice|email|telegram|import
  source_meta      jsonb not null default '{}',    -- url, sender, chat_id, highlights…
  lifecycle        text not null default 'inbox',  -- inbox|active|evergreen|archived
  para_category    text,                -- project|area|resource|archive (nullable = unfiled)
  para_status      text not null default 'none',   -- none|suggested|accepted  (trust dial)
  pinned           boolean not null default false,
  word_count       int,
  last_reviewed_at timestamptz, review_count int not null default 0,
  created_at, updated_at, deleted_at
)
-- idx: (user_id, updated_at desc), (user_id, lifecycle), GIN on to_tsvector(content_text)

note_chunks (            -- SERVER-ONLY (not synced): embedding store
  id, user_id, note_id fk,
  chunk_index int, content text, token_count int,
  embedding vector(1024),          -- voyage-3.5
  embedding_model text, embedded_at timestamptz,
  unique(note_id, chunk_index)
)
-- idx: HNSW (embedding vector_cosine_ops), (user_id, note_id)

attachments (
  id, user_id, note_id fk,
  storage_path text, mime text, size_bytes bigint,
  kind text,                       -- audio|image|file
  transcript_status text default 'none',  -- none|pending|done|failed
  created_at
)

ingest_inbox (           -- SERVER-ONLY: raw inbound payloads pre-note (idempotency + debugging)
  id, user_id, channel text,       -- telegram|email|clipper
  external_id text, payload jsonb, status text, note_id fk nullable, created_at,
  unique(channel, external_id)
)
```

Chunking: split on markdown headings, target ~500 tokens, 50-token overlap; notes < 600 tokens are a single chunk. Re-embed only chunks whose content hash changed.

### 6.2 Organization

```sql
tags (
  id, user_id, name text, color text,
  created_by text not null default 'user',   -- user|ai
  created_at, deleted_at,
  unique(user_id, lower(name))
)

note_tags (
  id, user_id, note_id fk, tag_id fk,
  source text not null,            -- user|ai
  status text not null default 'accepted',  -- suggested|accepted|rejected
  confidence real,                 -- for ai suggestions
  created_at, deleted_at,
  unique(note_id, tag_id)
)

links (
  id, user_id,
  from_note_id fk, to_note_id fk,
  kind text not null default 'semantic',    -- semantic|manual|reference
  status text not null default 'suggested', -- suggested|accepted|dismissed
  similarity real, rationale text,          -- one-line AI explanation ("both discuss X")
  created_at, deleted_at,
  unique(user_id, from_note_id, to_note_id)
)
```

Rejected suggestions are **kept** (status, not deletion) — they are training signal for the feedback loop and suppress re-suggestion.

### 6.3 Tasks & review

```sql
tasks (
  id, user_id, note_id fk nullable,
  title text not null, details text,
  status text not null default 'suggested', -- suggested|todo|doing|done|dropped
  source text not null default 'user',      -- user|ai
  source_span jsonb,               -- offsets into the note for highlight-on-open
  due_at timestamptz, completed_at timestamptz,
  created_at, updated_at, deleted_at
)

review_queue (           -- Readwise-style resurfacing (SM-2-lite)
  id, user_id, note_id fk unique,
  due_at timestamptz not null,
  interval_days real not null default 3,
  ease real not null default 2.0,
  last_result text,                -- kept|snoozed|archived
  created_at, updated_at
)
```

"On this day" needs no table — it's a query: `where user_id=? and (created_at::date has same month/day in a prior year)` plus top-N by word_count.

### 6.4 Memory layer (full design in §10)

```sql
memory_facts (
  id, user_id,
  category text not null,          -- identity|preference|interest|project|habit|opinion|skill|relationship
  statement text not null,         -- "Prefers TypeScript over Java for personal projects"
  rationale text,                  -- why the agent believes this
  confidence real not null,        -- 0..1
  salience real not null default 0.5,  -- how often it should be injected
  status text not null default 'proposed', -- proposed|active|archived|rejected
  evidence jsonb not null default '[]',    -- [{note_id|chat_id|feedback_id, quote}]
  embedding vector(1024),          -- for relevance-ranked injection
  first_observed_at timestamptz, last_confirmed_at timestamptz,
  superseded_by uuid fk nullable,  -- belief-change chain → "your view changed"
  created_at, updated_at, deleted_at
)
-- synced to clients READ-ONLY (review UI); mutations go through the API

memory_revisions (       -- SERVER-ONLY audit log
  id, user_id, fact_id fk,
  action text,                     -- propose|accept|reject|confirm|update|decay|archive
  actor text,                      -- agent|user
  diff jsonb, created_at
)

feedback_events (        -- the feedback loop's raw material
  id, user_id,
  subject_type text,               -- tag|link|task|digest_item|memory_fact|chat_answer|para
  subject_id uuid, action text,    -- accept|reject|edit|thumbs_up|thumbs_down
  payload jsonb, created_at
)
```

### 6.5 Synthesis & chat

```sql
digests (
  id, user_id,
  period text,                     -- weekly|monthly
  period_start date, period_end date,
  status text,                     -- pending|ready|failed
  content_md text,                 -- rendered digest
  clusters jsonb,                  -- [{label, note_ids[], summary, theme_novelty}]
  model_meta jsonb, created_at,
  unique(user_id, period, period_start)
)

chat_sessions ( id, user_id, title, created_at, updated_at, deleted_at )
chat_messages (
  id, user_id, session_id fk,
  role text, content text,
  citations jsonb,                 -- [{note_id, chunk_index, quote}]
  retrieval_meta jsonb,            -- what was retrieved, scores, memory facts injected (debuggability)
  created_at
)
```

### 6.6 Integrations & operations

```sql
integrations (
  id, user_id, provider text,      -- telegram|google_calendar|slack|email_alias
  external_id text,                -- telegram chat_id, calendar id, generated alias
  credentials jsonb,               -- encrypted via pgsodium / Supabase Vault
  status text, created_at, updated_at,
  unique(user_id, provider, external_id)
)

calendar_links ( id, user_id, note_id fk, event_id text, event_meta jsonb, event_start timestamptz )

usage_ledger (           -- SERVER-ONLY: cost control
  id, user_id, kind text,          -- embed|chat|tag|digest|memory|transcribe
  model text, input_tokens int, output_tokens int, cost_usd numeric, created_at
)
-- plus pg-boss's own schema for the job queue
```

### 6.7 Sync scope (PowerSync bucket definitions)

Synced to clients: `notes, tags, note_tags, links, tasks, review_queue, digests (ready only), memory_facts (read-only), chat_sessions, chat_messages, calendar_links, attachments (metadata)`.
Server-only: `note_chunks, ingest_inbox, memory_revisions, feedback_events (write-through API), usage_ledger, integrations (credentials never sync)`.

### 6.8 Retrieval query (hybrid)

Semantic search = Reciprocal Rank Fusion over (a) pgvector cosine top-40 on `note_chunks`, (b) Postgres FTS top-40 on `notes.content_text`, with a recency multiplier `exp(-age_days/τ)` (τ ≈ 180 for search, ≈ 90 for chat retrieval), then dedupe by note. Exposed as one SQL function `search_notes(user_id, query_text, query_embedding, limit)` so API, MCP, and jobs share it.

---

## 7. Capture subsystem

| Channel | Mechanism |
|---|---|
| Quick capture (mobile/web) | Local insert into `notes` (offline-safe), one text box, zero required fields. Mobile: home-screen widget + share sheet. Sub-second "saved ✓". |
| Web clipper | Browser extension (WXT or Plasmo): grabs URL, selection/highlights, readability-extracted article → `POST /capture` → note with `source_type='web_clip'`; enrichment job adds auto-summary. |
| Voice | Record in-app (expo-av) → upload to Supabase Storage → `attachments` row → transcription job (Groq Whisper) → transcript becomes note content, audio stays attached. Offline: recording queues locally, uploads on reconnect. |
| Telegram | One bot; users link via `/start <one-time-code>` (writes `integrations` row mapping chat_id→user). Every message/voice note/forward becomes a note. Webhook → NestJS. |
| Email | Per-user alias (e.g. `u_ab12cd@in.cortex.app`) via Postmark/Resend inbound webhook → NestJS → note. Subject = title, body = content, attachments stored. |
| Import | Markdown/JSON bulk import endpoint (also the migration path *into* Cortex from Obsidian/Notion exports). |

All inbound channels write to `ingest_inbox` first (idempotency by `(channel, external_id)`), then materialize a note — retries and duplicate webhooks are safe.

---

## 8. Offline-first sync: evaluation and design

### 8.1 Options considered

| Option | Verdict | Reasoning |
|---|---|---|
| **PowerSync** (chosen, **mobile only**) | ✅ | Purpose-built for Postgres/Supabase ([official partner](https://supabase.com/partners/powersync)); mature React Native/Expo SDK ([RN SDK](https://docs.powersync.com/client-sdks/reference/react-native-and-expo), actively released through mid-2026); local SQLite you can query with plain SQL (reactive queries for UI); sync rules give server-controlled per-user partitioning; upload hook routes writes through our API (RLS-enforced); free cloud tier + open-source self-host escape hatch. The local replica being *real SQLite rows* (not CRDT blobs) means offline FTS and simple UI queries come free. A web SDK exists if web offline is ever wanted later — but per review, web is online-only. |
| ElectricSQL | ❌ for this project | Strong and coherent, but read-path–centric (shapes) with write-path patterns you assemble yourself; React Native support is less proven than its web story. Best current fit is web apps ([2026 comparison](https://cssauthor.com/offline-first-tech-stack/)); we're mobile-first. |
| WatermelonDB / RxDB + custom backend | ❌ | Excellent client stores, but you hand-roll the entire sync protocol + backend (push/pull endpoints, changelogs, migrations of the protocol itself). That's the highest-maintenance quadrant: custom protocol *and* no CRDT guarantees. |
| Fully custom local-first (SQLite + sync queue + **Yjs/Automerge**) | ❌ | Evaluated seriously per your request — rejected on four grounds. (1) **The problem doesn't demand it**: CRDTs shine for *concurrent intra-document* editing; a single author editing the same note on two offline devices simultaneously is a rare edge, and "conflict copy" handles it acceptably. (2) **Data opacity**: Yjs docs are binary state vectors; Postgres can no longer FTS/embed/tag/RLS the content without a materialization pipeline — every AI feature gets harder. (3) **You'd still need everything else**: auth-aware partial sync, tombstones, migrations, backpressure, checkpointing — the CRDT solves only merge, ~15% of the sync problem. (4) **Opportunity cost**: weeks of infra work that produces zero portfolio-visible features. Revisit only if real-time *collaborative* editing ever becomes a goal — then run Yjs per-note *on top of* PowerSync (store update log as rows), don't replace it. |
| Supabase-only "offline support" | ❌ | Supabase has no first-party offline sync ([long-standing discussion](https://github.com/orgs/supabase/discussions/357)); supabase-js caching is not conflict-aware sync. |

### 8.2 Sync design

- **Topology**: Postgres is authoritative. PowerSync service tails logical replication → maintains per-user buckets (sync rules keyed on `request.user_id()` from the Supabase JWT) → streams to **mobile clients** (web is online-only, §4.8). Each mobile device holds a full replica of the user's synced tables (a personal corpus is small — even 50k notes of metadata is tens of MB; `note_chunks` excluded keeps it lean).
- **Writes**: client mutates local SQLite → PowerSync queues a CRUD batch → `uploadData` posts to `POST /sync/upload` on NestJS → server validates and writes via Supabase client **using the caller's JWT** (RLS is the enforcement, server code is not trusted with a service key on this path) → replication loops the authoritative row back to all the user's devices.
- **Conflict resolution** (two same-user devices edited offline):
  - *Column-level last-write-wins* for scalar fields (`title`, `pinned`, `lifecycle`, task status…) using per-column `updated_at` comparison in the upload handler — device A renaming and device B pinning both survive.
  - *Note body*: LWW **with conflict preservation** — if the incoming body's base revision (client sends `base_updated_at`) doesn't match the current row and both bodies differ non-trivially, the server keeps the newer body and appends the loser as a clearly-marked `> ⚠ conflicting edit from <device> at <time>` section (Dropbox "conflicted copy" semantics, but inside the note so it can't be lost). Expected frequency for one human: a few times a year.
  - *Deletes*: soft-delete tombstones win over concurrent edits; edit resurrects only via explicit user restore.
- **Offline AI semantics**: enrichment happens on the server after sync, so offline-created notes are simply enriched late. Client shows a subtle "pending enrichment" state driven by `note_chunks.embedded_at`-derived flag synced via a lightweight `notes.enriched_at` column.

---

## 9. Background jobs

**Queue: pg-boss** (Postgres-backed job queue inside the same Supabase DB — no Redis, no extra service, exactly-once-ish with retries, dead-letter after N attempts, cron support). Workers run inside the NestJS process (separate `worker` entrypoint if load ever requires splitting).

**Event-driven** (enqueued by the API at commit time, not by DB triggers — keeps logic in TypeScript):

| Job | Trigger | Debounce | What it does |
|---|---|---|---|
| `note.enrich` | note created/updated (content changed) | 90s after last edit | chunk → embed (Voyage) → auto-tag suggest → link suggest (cosine > 0.78 against existing chunks, max 5, with rationale) → task extraction. One job, sequential steps, per-step idempotency. |
| `attachment.transcribe` | audio attachment uploaded | — | Whisper → write transcript into note → chain `note.enrich`. |
| `clip.summarize` | web clip ingested | — | Claude summary + key-points prepended to clip note. |
| `feedback.apply` | feedback_event written | — | update suppression lists / few-shot exemplar pool (§10.4). |

**Cron** (pg-boss schedules):

| Job | Schedule | What it does |
|---|---|---|
| `digest.weekly` | Sun 06:00 user-tz | cluster the week's chunks (embedding k-means/HDBSCAN-lite) → Claude (Batches API) labels clusters, summarizes themes, compares against prior digests ("recurring vs new"), lists open loops → `digests` row → push notification. |
| `digest.monthly` | 1st 06:00 | same, coarser, plus trend-over-time section. |
| `memory.update` | nightly 03:00 (skip if <3 new notes and no feedback) | the memory pipeline, §10.3. |
| `review.schedule` | daily 05:00 | fill review queue (≤5 items: due SM-2 items, on-this-day, stale-inbox candidates). |
| `maintenance` | daily | re-embed drifted chunks, dead-letter report, usage-ledger rollup, budget alarms. |

**Why event-driven + cron rather than pure cron sweeps**: enrichment must feel near-real-time (tag suggestions appearing ~2 min after you stop typing is the product experience); synthesis is inherently periodic. Both run through the same queue for retries/observability. Why not DB-trigger-driven: business logic stays in one language/place (API enqueues), and debouncing is trivial in the app layer.

---

## 10. The memory / personalization layer

### 10.1 Principles

1. **Distilled, not raw** — facts are short declarative statements with evidence links, never note dumps.
2. **Auditable** — a "Memory" screen lists every fact with category, confidence, evidence; accept/reject/edit each. Nothing influences behavior while `proposed` (until the trust dial says otherwise).
3. **Versioned beliefs** — updates supersede (chain via `superseded_by`), never overwrite. This is what powers "your view on X has changed."
4. **Bounded** — hard cap (~200 active facts); the pipeline must archive to add beyond it. Forces distillation, keeps injection cheap.

### 10.2 What a fact looks like

```json
{
  "category": "opinion",
  "statement": "Skeptical of microservices for small teams; prefers modular monoliths",
  "confidence": 0.82, "salience": 0.6,
  "evidence": [{"note_id": "…", "quote": "again burned by premature service split…"}],
  "first_observed_at": "2026-03-02", "last_confirmed_at": "2026-07-14"
}
```

### 10.3 Update loop (nightly `memory.update`)

1. **Gather delta**: notes created/edited since last run, chat transcripts, feedback events, task completions.
2. **Load current state**: all `active` + `proposed` facts (full set — it's ≤200 by design).
3. **Propose operations**: one Claude call (Opus 5, structured output) with delta + current facts + operation rules → list of ops: `add | confirm | update(supersede) | archive`, each with statement, category, confidence, evidence quotes, and a `reason`. Rules baked into the prompt: ≥2 independent evidence sources to `add` at confidence >0.7; single mentions cap at 0.5; prefer `confirm`/`update` over near-duplicate `add`; never store credentials/PII beyond what notes already contain.
4. **Guardrails (code, not model)**: max 10 ops/run; dedupe by embedding similarity vs existing facts (>0.92 → forced into `update`/`confirm`); evidence quotes must actually appear in the cited note (string check); cap enforcement.
5. **Write**: new/changed facts land as `proposed`; `confirm` on an already-active fact auto-applies (updates `last_confirmed_at`, bumps confidence toward its ceiling). Every op → `memory_revisions`.
6. **Review**: facts sync to clients; Memory screen shows pending proposals; accept → `active`, reject → `rejected` (and the rejection itself becomes a feedback event the next run sees). Trust dial: after ≥90% of a category's proposals have been accepted historically, offer per-category auto-accept.

**Staleness/decay**: each category has a confidence half-life (identity 720d, preference 365d, opinion 240d, project 90d, habit 180d). A weekly pass decays `confidence *= 0.5^(Δt/halflife)` since `last_confirmed_at`; below 0.35 the fact is queued as "still true?" in the review UI; below 0.2 it auto-archives. Any retrieval hit or new evidence re-confirms and resets the clock.

### 10.4 Feedback loop (corrections change future behavior)

Three concrete mechanisms, all driven by `feedback_events`:

1. **Suppression lists** (deterministic, immediate): a rejected tag suggestion `(note-topic-embedding, tag)` enters a per-user suppression set; the tagger checks it before suggesting. Same for dismissed links (pair-level) and rejected PARA placements.
2. **Few-shot exemplars** (per-user prompt adaptation): the tagging/extraction prompts include the user's 10 most recent accepted *and* rejected examples ("you suggested X, user rejected"). This is how the tagger converges on *your* taxonomy without fine-tuning.
3. **Memory evidence**: repeated patterns in feedback are themselves input to §10.3 ("consistently rejects 'productivity' as a tag; treats it as noise" → a `preference` fact that then shapes prompts globally).

### 10.5 How memory makes Retrieve/Synthesize better

- **Chat**: system prompt = stable core + compiled **profile preamble** (top salience facts, rebuilt only when facts change → byte-stable → prompt-cache hit) + per-query relevant facts (vector match on fact embeddings). Answers cite facts they relied on ("based on your preference for X") so wrong personalization is visible and correctable — one tap opens the fact for rejection.
- **Retrieval bias**: active `project`/`interest` facts boost matching notes' scores mildly (≤15% — bias, never filter).
- **Temporal awareness**: when retrieved chunks for a topic span >90 days and the belief chain (`superseded_by`) or a quick stance comparison shows divergence, the chat answer appends "your view seems to have shifted: in March you wrote …, in July …" with both citations.
- **Digests**: written *against* the memory ("theme X is new for you"; "this contradicts your stated preference Y" — contradiction detection is memory-vs-notes, not just notes-vs-notes).
- **Tagging/extraction**: profile preamble included, so "ML" resolves to *your* meaning of ML.

### 10.6 Why not just use Mem0

[Mem0](https://github.com/mem0ai) validates this architecture but is generic conversation-memory middleware: it wouldn't know about notes/evidence/digests, its review-and-trust UX doesn't exist, and the memory layer *is* the product's differentiator — outsourcing it hollows the portfolio project. We copy its good ideas (extract → dedupe → supersede → retrieve) in ~2 tables and 1 pipeline we fully control.

---

## 11. Auth & multi-user isolation

- **Identity**: Supabase Auth with Google OAuth. Mobile uses native flow via `expo-auth-session` → Supabase; web uses Supabase's OAuth redirect. One identity, JWTs everywhere.
- **JWT flow**: clients hold the Supabase access token (auto-refresh). It authenticates (a) PowerSync (token exchange per PowerSync-Supabase integration; sync rules read `user_id` from it), (b) NestJS (verify via Supabase JWKS; a `@CurrentUser()` guard), (c) direct Supabase Storage access for attachment upload/download (Storage RLS policies on a per-user folder prefix).
- **RLS**: enabled on every table, default-deny; standard policy `using (user_id = auth.uid()) with check (user_id = auth.uid())`. Server-side jobs use the service role but **every core-service method takes an explicit `userId` and every query filters by it** — enforced by a repository-layer convention plus tests that assert cross-user reads return empty.
- **PowerSync layer**: sync rules define one bucket per user (`bucket: user_data[request.user_id()]`); reviewed alongside RLS in the same PR whenever a synced table changes.
- **MCP auth**: per-user long-lived Personal Access Tokens (hashed in DB, revocable in settings) sent as bearer tokens — Claude Desktop config friendliness beats full OAuth for 2-3 users. Token maps to `user_id`; MCP calls then flow through the same guarded services.
- **Tester onboarding**: invite-code gate on first login (single `allowed_emails`/invite table) so the Google OAuth app being public doesn't open registration.

---

## 12. API, MCP, and repo layout

### 12.1 API design (NestJS, REST + zod)

Local-first inverts the usual API: CRUD mostly rides the sync channel. The REST surface is for AI, ingestion, and memory mutations:

```
POST /sync/upload                 # PowerSync write path (batch CRUD, RLS-enforced)
POST /capture                     # clipper/import/share-target ingestion
POST /search                      # hybrid semantic search {query} → ranked notes+chunks
POST /chat/:sessionId/messages    # RAG chat (SSE streaming response, citations)
POST /notes/:id/draft             # auto-draft/outline from related notes
GET  /digests/:id                 # (also synced; endpoint for regenerate)
POST /digests/:id/regenerate
POST /memory/facts/:id/accept|reject   # review actions (writes feedback_events too)
POST /feedback                    # generic feedback event
GET  /integrations/…  POST /integrations/telegram/link  …
POST /webhooks/telegram  POST /webhooks/email            # inbound (secret-verified)
GET  /export                      # full markdown+json export (zip)
```

Contracts: zod schemas in `packages/shared`, used by NestJS pipes for validation and by clients for typed fetch — one source of truth, no codegen. (tRPC considered; rejected because non-TS consumers — clipper, webhooks, MCP hosts — keep showing up, and REST+zod is 90% of the benefit.)

### 12.2 MCP server

A **Streamable-HTTP MCP endpoint mounted inside the same NestJS app** (`/mcp`), using the official TypeScript MCP SDK — not a separate deployment, and definitionally the same core services as the app. PAT auth (§11). Tools (thin wrappers, ~10 lines each):

| Tool | Wraps |
|---|---|
| `search_notes(query, limit?)` | SearchService.hybrid |
| `get_note(id)` / `create_note(content, title?)` / `append_to_note(id, content)` | NoteService |
| `ask_brain(question)` | ChatService one-shot RAG (returns answer + citations) |
| `list_tasks(status?)` / `create_task(title, due?)` / `complete_task(id)` | TaskService |
| `get_memory_profile()` | active facts, compiled preamble form |
| `propose_memory_fact(statement, category, evidence?)` | lands as `proposed`, same review flow |
| `get_latest_digest()` / `on_this_day()` | SynthesisService / ReviewService |

Each core module *exports* its MCP tool definitions next to its service (see registry below), so adding a feature adds its tools in the same folder — the MCP surface grows without touching a central file.

### 12.3 Repo layout (Turborepo + pnpm)

```
cortex/
├─ apps/
│  ├─ mobile/            # Expo (expo-router). Screens only; logic from packages.
│  ├─ web/               # Next.js (app router). Screens only.
│  ├─ api/               # NestJS: REST + /mcp + pg-boss workers (worker.ts entrypoint)
│  └─ clipper/           # WXT browser extension
├─ packages/
│  ├─ core/              # ★ domain logic, framework-free. One folder per module:
│  │   ├─ notes/  organize/  retrieve/  synthesize/  tasks/  memory/  capture/  integrations/
│  │   │   └─ each: service.ts, jobs.ts, mcp-tools.ts, prompts/, index.ts (module manifest)
│  │   └─ registry.ts    # collects module manifests → routes, job handlers, MCP tools
│  ├─ db/                # Supabase migrations (SQL), typed query helpers, RLS tests
│  ├─ sync/              # PowerSync schema (client tables), sync-rule source, RN client init (mobile-only)
│  ├─ shared/            # zod schemas, DTOs, enums, constants
│  ├─ ai/                # provider clients (Claude, Voyage, Whisper) behind interfaces; prompt-cache-aware helpers
│  ├─ ui/                # cross-platform primitives where cheap (Tamagui or plain RN + react-native-web); no forced 100% sharing
│  └─ config/            # tsconfig, eslint, prettier bases
├─ supabase/             # config, seed, storage policies
├─ docs/
└─ turbo.json  pnpm-workspace.yaml
```

**Plugin-style growth**: a new capability = a new folder in `packages/core/<module>` exporting a manifest `{ services, jobHandlers, mcpTools, migrations }` that `registry.ts` composes into the API, worker, and MCP surfaces. Clients consume the module's zod types + synced tables. No cross-cutting refactor needed to add, e.g., a future "reading list" module.

**Logic-sharing stance**: share *all* domain logic, types, sync schema, and hooks (`packages/core`, `shared`, `sync`); share UI primitives opportunistically; do **not** chase pixel-identical shared screens — Expo-router and Next-app-router screens stay thin and separate. This is the pragmatic ceiling of RN/Next sharing.

---

## 13. Phased implementation plan

Each phase ends demoable (GIF-able) and shippable to your own daily use. Order optimizes for: (a) you dogfooding real data as early as possible, because the memory layer and digests are only impressive with months of accumulated notes; (b) risk retirement (sync first — it's the least reversible choice).

| # | Phase | Contents | Demo |
|---|---|---|---|
| 0 | **Foundations** (wk 1) | Monorepo, Supabase project, schema v1 + RLS, Google OAuth on web+mobile, invite gate, CI (typecheck/lint/RLS tests), deploy skeleton API | Log in on phone + web with the same Google account; cross-user read test provably empty |
| 1 | **Notes + offline sync** (wk 2-3) | PowerSync wired on mobile (local SQLite); web CRUD via supabase-js + Realtime (online-only); quick capture, edit/list/archive, tags (manual), local FTS on mobile, conflict handling, export endpoint | Airplane-mode capture on phone → edits on web → reconnect → merge; conflict-copy demo |
| 2 | **AI enrichment v1** (wk 4-5) | pg-boss + `note.enrich`: chunk/embed (Voyage), auto-tag suggestions UI (accept/reject → feedback_events **from day one**), hybrid semantic search, usage ledger | Type "that idea about pricing psychology" → finds the note that never says "pricing psychology" |
| 3 | **RAG chat** (wk 6-7) | Chat sessions, hybrid retrieval + recency weighting, streaming answers with tappable citations, offline fallback messaging | "What do I actually think about X?" answered with quotes from own notes |
| 4 | **Capture everywhere** (wk 8-9) | Web clipper + auto-summary, voice notes + Whisper, Telegram bot, email-in, share sheet | One thought captured 5 ways, all landing enriched in the same inbox |
| 5 | **Auto-linking + organize v2** (wk 10) | Semantic link suggestions with rationale, related-notes panel, "you wrote about this before" on create, PARA suggestions + trust dial | Create note → 3 relevant old notes surface unprompted |
| 6 | **Tasks + resurfacing** (wk 11-12) | Task extraction with source spans, task list UI, review queue (SM-2-lite), on-this-day, daily notification | "remind me to…" buried in a voice note becomes a task; morning daily review |
| 7 | **Synthesis** (wk 13-14) | Weekly/monthly digest job (clustering + Batches API), open-loops section, digest feedback (grouping corrections), first contradiction surfacing (memory-less version: stance comparison within clusters) | Sunday digest: "3 recurring themes, 1 new, 4 open questions" |
| 8 | **Memory layer** (wk 15-17) | `memory_facts` pipeline (§10.3), Memory review screen, decay pass, profile preamble injected into chat/tagging/digests, belief-change surfacing in chat, suppression + few-shot feedback mechanisms | The money demo: Memory screen fills itself from months of real notes; reject a fact; chat visibly personalizes and cites which facts it used |
| 9 | **MCP + calendar** (wk 18-19) | `/mcp` endpoint + PATs + the tool set; Google Calendar read integration (event note-stubs, meeting linking) | Claude Code session querying your second brain; today's meetings pre-materialized as notes |
| 10 | **Hardening + beta** (wk 20-21) | Onboard 2-3 testers: rate limits, per-user LLM budgets + alarms, dead-letter dashboard, Sentry, backup/restore drill, docs. Nice-to-have if time: codebase integration (repo/commit links on dev notes) | Second real user on their own data; cost dashboard |

Dependencies worth noting: feedback capture (phase 2) intentionally predates the memory layer (phase 8) so phase 8 starts with months of signal; digests (7) precede memory (8) so memory-aware digests are a cheap upgrade in 8, not a rewrite.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| PowerSync (managed) dependency | Open-source self-host edition exists; data is plain Postgres either way; sync layer isolated in `packages/sync` |
| LLM cost creep | usage_ledger + per-user budgets from phase 2; Batches for background work; prompt caching for stable prefixes; debounced enrichment |
| Memory layer proposes garbage | proposed-by-default + evidence-quote verification + caps; worst case it's an ignorable screen, not corrupted behavior |
| Two data-access paths (mobile local SQLite vs web network) | shared zod types + per-platform thin data hooks behind a common interface in `packages/core`; divergence contained to the hook layer |
| Whisper/Voyage/provider churn | all providers behind `packages/ai` interfaces; embedding model+dims recorded per chunk to support migration re-embeds |
| Solo-builder scope | phases are independently shippable; the plan survives stopping at any phase ≥3 with a coherent product |
