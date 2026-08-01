import { describe, expect, it } from "vitest";
import { createNoteInput, updateNoteInput } from "./notes.js";

describe("createNoteInput", () => {
  it("accepts content only", () => {
    expect(createNoteInput.safeParse({ content: "hi" }).success).toBe(true);
  });
  it("rejects content over 100k chars", () => {
    expect(createNoteInput.safeParse({ content: "x".repeat(100_001) }).success).toBe(false);
  });
});

describe("updateNoteInput", () => {
  it("rejects an empty object", () => {
    expect(updateNoteInput.safeParse({}).success).toBe(false);
  });
  it("accepts lifecycle-only patch", () => {
    expect(updateNoteInput.safeParse({ lifecycle: "archived" }).success).toBe(true);
  });
  it("accepts explicit null title (clear title)", () => {
    expect(updateNoteInput.safeParse({ title: null }).success).toBe(true);
  });
  it("rejects unknown lifecycle", () => {
    expect(updateNoteInput.safeParse({ lifecycle: "zombie" }).success).toBe(false);
  });
});
