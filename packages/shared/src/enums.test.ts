import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIM, EMBEDDING_MODEL,
  memoryCategory, noteLifecycle, noteSourceType, taskStatus,
} from "./enums.js";

describe("shared enums", () => {
  it("accepts valid values", () => {
    expect(noteLifecycle.parse("inbox")).toBe("inbox");
    expect(noteSourceType.parse("telegram")).toBe("telegram");
    expect(taskStatus.parse("suggested")).toBe("suggested");
    expect(memoryCategory.parse("opinion")).toBe("opinion");
  });
  it("rejects invalid values", () => {
    expect(() => noteLifecycle.parse("trash")).toThrow();
    expect(() => noteSourceType.parse("sms")).toThrow();
  });
  it("pins embedding contract", () => {
    expect(EMBEDDING_DIM).toBe(1536);
    expect(EMBEDDING_MODEL).toBe("gemini-embedding-001");
  });
  it("noteSourceType covers capture channels, chat, saved answers, and small talk", () => {
    expect(noteSourceType.options).toEqual([
      "quick", "web_clip", "voice", "email", "telegram", "import",
      "chat", "assistant", "web_search", "chitchat",
    ]);
  });
  it("memoryCategory covers what we know about a person, plus an assistant's own offer", () => {
    expect(memoryCategory.options).toEqual([
      "identity", "preference", "interest", "project",
      "habit", "opinion", "skill", "relationship", "assistant_offer",
    ]);
  });
});
