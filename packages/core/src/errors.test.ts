import { describe, expect, it } from "vitest";
import { mapPostgrestError } from "./errors.js";

const pgErr = (code: string) => ({ code, message: "m", details: "", hint: "" }) as never;

describe("mapPostgrestError", () => {
  it("maps PGRST116 (zero rows on .single()) to not_found", () => {
    expect(mapPostgrestError(pgErr("PGRST116")).kind).toBe("not_found");
  });
  it("maps 23505 to conflict", () => {
    expect(mapPostgrestError(pgErr("23505")).kind).toBe("conflict");
  });
  it("maps anything else to internal", () => {
    expect(mapPostgrestError(pgErr("XX000")).kind).toBe("internal");
  });
});
