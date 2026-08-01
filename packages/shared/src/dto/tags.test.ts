import { describe, expect, it } from "vitest";
import { attachTagInput, createTagInput } from "./tags.js";

describe("createTagInput", () => {
  it("trims and requires non-empty name", () => {
    expect(createTagInput.safeParse({ name: "  " }).success).toBe(false);
    expect(createTagInput.parse({ name: " ideas " }).name).toBe("ideas");
  });
  it("validates color as #rrggbb", () => {
    expect(createTagInput.safeParse({ name: "x", color: "#12abEF" }).success).toBe(true);
    expect(createTagInput.safeParse({ name: "x", color: "red" }).success).toBe(false);
  });
});

describe("attachTagInput", () => {
  it("requires a uuid tagId", () => {
    expect(attachTagInput.safeParse({ tagId: "not-a-uuid" }).success).toBe(false);
  });
});
