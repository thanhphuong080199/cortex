import { z } from "zod";

// Each enum below is the source of truth for exactly the SQL check constraint(s)
// named next to it; `packages/db`'s enum-parity test (src/test/enum-parity.test.ts)
// reads the live constraint definition from pg_constraint and asserts the values match
// this list exactly, for these pairs only:
//   noteLifecycle    <-> notes.lifecycle_check
//   noteSourceType    <-> notes.source_type_check
//   paraCategory      <-> notes.para_category_check
//   suggestionStatus  <-> note_tags.status_check
//   taskStatus        <-> tasks.status_check
//   memoryCategory    <-> memory_facts.category_check
//   memoryStatus      <-> memory_facts.status_check
//   noteDomain        <-> notes.domain_check
//   mediaKind         <-> media_items.kind_check
//   flashcardStatus   <-> flashcards.status_check
//   usageLedgerKind   <-> usage_ledger.kind_check
//
// links.status ('suggested'|'accepted'|'dismissed') and notes.para_status
// ('none'|'suggested'|'accepted') are DELIBERATELY distinct vocabularies (design spec
// §6.2 / §6.1), not instances of suggestionStatus, despite the superficial
// 'suggested'/'accepted' overlap. Do not "fix" that overlap by pointing them at
// suggestionStatus -- they mean different things (a link's acceptance state vs. a
// note's PARA-categorization state) and are allowed to diverge.
export const noteLifecycle = z.enum(["inbox", "active", "evergreen", "archived"]);
// Mirrors NoteDomain in dto/domains.ts. Mobile's editor writes this column directly into the
// local replica, so it needs the union rather than a bare string -- an unchecked value there
// fails the server's CHECK constraint only after it has synced.
export type NoteLifecycle = z.infer<typeof noteLifecycle>;
// 'chat'      -- a question you typed into the box. Stored as a note so "what was I
//                researching last month" works through search_notes with no second store.
// 'assistant' -- an answer you chose to save. Down-weighted in retrieval (see search_notes)
//                and cited as something you saved, never as your own thinking.
// 'web_search'-- the same, for an answer carrying web citations. Required by the
//                life-domains spec §6.3 since 2026-08-01 and never added until now.
// 'chitchat'  -- small talk with nothing to file. Saved like everything else, but excluded
//                from the note lists AND from search_notes, so banter never becomes a
//                citation the model then answers around (stage C4 spec §5.3).
export const noteSourceType = z.enum([
  "quick", "web_clip", "voice", "email", "telegram", "import",
  "chat", "assistant", "web_search", "chitchat",
]);
export const paraCategory = z.enum(["project", "area", "resource", "archive"]);
export const suggestionStatus = z.enum(["suggested", "accepted", "rejected"]);
export const taskStatus = z.enum(["suggested", "todo", "doing", "done", "dropped"]);
// 'assistant_offer' -- NOT a fact about the person. A statement the assistant offered to save
//                      and the user declined, kept only so the same offer is not made twice
//                      (stage C5 §12). Excluded from the nightly memory update by category;
//                      see 00033's header for why this is a category and not a jsonb marker.
export const memoryCategory = z.enum([
  "identity", "preference", "interest", "project",
  "habit", "opinion", "skill", "relationship", "assistant_offer",
]);
export const memoryStatus = z.enum(["proposed", "active", "archived", "rejected"]);

// Life-domain vocabulary (life-domains spec §2.1). `domain` is nullable on notes --
// these are the values a domained note may carry, not a requirement that it have one.
export const noteDomain = z.enum(["media", "health", "life", "learning", "finance", "reflection"]);
export const mediaKind = z.enum(["movie", "tv", "book", "game", "podcast"]);
// Where a media log sits in its lifecycle. Written out three times before this existed --
// logMediaInput, domainMetaSchemas.media, and mobile's form -- which is the same parallel-list
// trap the comment above mediaKind's own usage warns about. A drifted copy is not a type error
// anywhere: it reaches the server, fails `.strict()` validation, and the op is reported in
// `failed` inside a 200 response, so the log is silently dropped.
export const mediaStatus = z.enum(["finished", "in_progress", "abandoned"]);
// Mobile's media form holds both as component state and writes them into domain_meta, so it
// needs the unions rather than bare strings -- an unchecked value fails the server's `.strict()`
// validation only after it has synced.
export type MediaKind = z.infer<typeof mediaKind>;
export type MediaStatus = z.infer<typeof mediaStatus>;
// Deliberately NOT suggestionStatus: a card's lifecycle ends in 'suspended' (stop
// scheduling it), which is not the same act as rejecting a suggestion.
export const flashcardStatus = z.enum(["suggested", "active", "suspended"]);

// usage_ledger.kind's full SQL vocabulary (00007_integrations_ops.sql), for the enum-parity
// pair only. This is deliberately WIDER than any TS call site: only 'embed', 'tag', 'chat' and
// 'grounding' are written today (packages/core/src/enrich/budget.ts's recordUsage narrows its
// own `kind` parameter to that quartet), while 'digest', 'memory' and 'transcribe' anticipate
// workloads later phases add. A narrow union assigning into this wider vocabulary is fine;
// what must not happen again is a TS union value the SQL CHECK constraint does not accept --
// recordUsage briefly had "extract" here, which does not appear in the constraint below, and
// nothing caught it before the first real insert. Existing to close exactly that gap.
export const usageLedgerKind = z.enum([
  "embed", "chat", "tag", "digest", "memory", "transcribe", "grounding", "mood",
]);

// Pinned by 00012_embedding_dims_gemini.sql and asserted against the live column width
// by packages/db's embedding-dims test. Changing either side alone breaks that test.
export const EMBEDDING_DIM = 1536;
export const EMBEDDING_MODEL = "gemini-embedding-001";

// The life-domains spec §1 assigns workloads by model FAMILY ("Gemini 3 Flash"), which is not
// an API id. These are the ids, verified against ai.google.dev/gemini-api/docs/models on
// 2026-08-10. Prices are USD per million tokens; usage_ledger records the model with every
// row, so changing a price here never rewrites history.
export const CLASSIFY_MODEL = "gemini-3.5-flash-lite";
// Prices reverified directly against ai.google.dev/gemini-api/docs/pricing on 2026-08-10.
// The flash-lite figures the brief drafted ($0.10/$0.40) are stale -- they match the
// deprecated gemini-2.5-flash-lite tier. Current standard (non-batch) pricing: embedding is
// input-only (no output charge); flash-lite is $0.30 input / $2.50 output per 1M tokens.
// Reasoning: answering a question from the user's notes. Life-domains spec §1 says "Gemini 3
// Pro", which is a model FAMILY, not an API id -- verified against
// ai.google.dev/gemini-api/docs/models on 2026-08-15. The family has moved on since
// CLASSIFY_MODEL was pinned (2026-08-10): the current Pro-tier id is a 3.1 preview release,
// not a bare "gemini-3-pro" -- so treat any older doc in this repo spelling the id as
// "gemini-3-pro" the same way CLASSIFY_MODEL's header already treats "Gemini 3 Flash": a
// family name, never something to call the API with.
export const ANSWER_MODEL = "gemini-3.1-pro-preview";
// Reverified directly against ai.google.dev/gemini-api/docs/pricing on 2026-08-15, standard
// (non-batch) tier, prompts <= 200k tokens (Cortex notes and chat context never approach that):
// $2.00 input / $12.00 output per 1M tokens. The docs also list a > 200k-token tier ($4.00 /
// $18.00) that does not apply here and is deliberately not encoded -- MODEL_PRICES_USD_PER_MTOK
// has no room for a size-conditional rate, and adding one would be guessing at usage this
// codebase never sends.
export const MODEL_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gemini-embedding-001": { input: 0.15, output: 0 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
};

/**
 * Grounding with Google Search is priced per QUERY, not per token, so it cannot live in
 * MODEL_PRICES_USD_PER_MTOK. $14 per 1,000 queries, verified against Google's pricing page on
 * 2026-08-01 and recorded in the life-domains spec §8.
 *
 * The first 5,000 prompts per month are free and this constant does NOT model that: every
 * grounded turn is charged from the first one, so for a handful of testers the ledger reports
 * spend that was never billed. Wrong in the SAFE direction -- the circuit breaker trips early
 * rather than late -- and tracking a monthly allowance would be a second accounting system for a
 * discount that stops applying the moment this app has real users.
 */
export const GROUNDING_USD_PER_QUERY = 0.014;
