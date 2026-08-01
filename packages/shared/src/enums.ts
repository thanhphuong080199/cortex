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
//
// links.status ('suggested'|'accepted'|'dismissed') and notes.para_status
// ('none'|'suggested'|'accepted') are DELIBERATELY distinct vocabularies (design spec
// §6.2 / §6.1), not instances of suggestionStatus, despite the superficial
// 'suggested'/'accepted' overlap. Do not "fix" that overlap by pointing them at
// suggestionStatus -- they mean different things (a link's acceptance state vs. a
// note's PARA-categorization state) and are allowed to diverge.
export const noteLifecycle = z.enum(["inbox", "active", "evergreen", "archived"]);
export const noteSourceType = z.enum(["quick", "web_clip", "voice", "email", "telegram", "import"]);
export const paraCategory = z.enum(["project", "area", "resource", "archive"]);
export const suggestionStatus = z.enum(["suggested", "accepted", "rejected"]);
export const taskStatus = z.enum(["suggested", "todo", "doing", "done", "dropped"]);
export const memoryCategory = z.enum([
  "identity", "preference", "interest", "project",
  "habit", "opinion", "skill", "relationship",
]);
export const memoryStatus = z.enum(["proposed", "active", "archived", "rejected"]);

export const EMBEDDING_DIM = 1024;
export const EMBEDDING_MODEL = "voyage-3.5";
