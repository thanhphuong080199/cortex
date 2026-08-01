import { describe, expect, it } from "vitest";
import { anchoredIRegex } from "./like.js";

// Pure-function coverage for the lookup-pattern builder. The integration tests in
// media/service.test.ts and organize/service.test.ts prove end-to-end behaviour; these
// pin the escaping itself, because every character class below was (or would be) a
// silent wrong-row bug: LIKE wildcards were A3, and PostgREST's `*`->`%` mapping means
// even an escaped LIKE pattern wildcards on `*`.
describe("anchoredIRegex", () => {
  it("anchors the value so it can only match the whole string", () => {
    expect(anchoredIRegex("abc")).toBe("^abc$");
  });

  it("escapes regex metacharacters", () => {
    expect(anchoredIRegex("M*A*S*H")).toBe("^M\\*A\\*S\\*H$");
    expect(anchoredIRegex("what? (really)")).toBe("^what\\? \\(really\\)$");
    expect(anchoredIRegex("a.b+c|d")).toBe("^a\\.b\\+c\\|d$");
    expect(anchoredIRegex("50% Off_")).toBe("^50% Off_$"); // not regex metachars
    expect(anchoredIRegex("back\\slash")).toBe("^back\\\\slash$");
    expect(anchoredIRegex("[x]^y$z")).toBe("^\\[x\\]\\^y\\$z$");
  });
});
