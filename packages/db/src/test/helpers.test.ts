import { describe, expect, it } from "vitest";
import { admin } from "./clients.js";

describe("strip_markdown", () => {
  it("strips markdown syntax to plain text", async () => {
    const { data, error } = await admin.rpc("strip_markdown", {
      md: "# Title\n\nSome **bold** and a [link](https://x.com).\n\n```js\ncode();\n```",
    });
    expect(error).toBeNull();
    expect(data).toBe("Title Some bold and a link.");
  });
  it("handles null/empty", async () => {
    const { data } = await admin.rpc("strip_markdown", { md: "" });
    expect(data).toBe("");
  });
});
