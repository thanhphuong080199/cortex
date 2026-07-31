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
    expect(EMBEDDING_DIM).toBe(1024);
    expect(EMBEDDING_MODEL).toBe("voyage-3.5");
  });
});
