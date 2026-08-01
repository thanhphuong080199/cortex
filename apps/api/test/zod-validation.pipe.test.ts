import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { createNoteInput } from "@cortex/shared";
import { ZodValidationPipe } from "../src/zod-validation.pipe";

describe("ZodValidationPipe", () => {
  const pipe = new ZodValidationPipe(createNoteInput);
  it("passes valid input through parsed", () => {
    expect(pipe.transform({ content: "ok", extra: "stripped" }))
      .toEqual({ content: "ok" });
  });
  it("throws 400 with field paths on invalid input", () => {
    try {
      pipe.transform({});
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const body = (e as BadRequestException).getResponse() as { issues: { path: string }[] };
      expect(body.issues[0]!.path).toBe("content");
    }
  });
});
