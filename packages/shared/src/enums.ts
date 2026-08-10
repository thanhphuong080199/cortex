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
export const noteSourceType = z.enum([
  "quick", "web_clip", "voice", "email", "telegram", "import",
  "chat", "assistant", "web_search",
]);
export const paraCategory = z.enum(["project", "area", "resource", "archive"]);
export const suggestionStatus = z.enum(["suggested", "accepted", "rejected"]);
export const taskStatus = z.enum(["suggested", "todo", "doing", "done", "dropped"]);
export const memoryCategory = z.enum([
  "identity", "preference", "interest", "project",
  "habit", "opinion", "skill", "relationship",
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

// Pinned by 00012_embedding_dims_gemini.sql and asserted against the live column width
// by packages/db's embedding-dims test. Changing either side alone breaks that test.
export const EMBEDDING_DIM = 1536;
export const EMBEDDING_MODEL = "gemini-embedding-001";
