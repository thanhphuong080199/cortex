import { z } from "zod";

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
