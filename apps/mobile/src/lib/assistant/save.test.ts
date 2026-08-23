import { describe, expect, it, vi } from "vitest";
import { proposeStatement, saveStatement, webUrlOf } from "./save";

const ok = (body: unknown) => vi.fn().mockResolvedValue({
  ok: true, json: async () => body,
} as unknown as Response);

describe("proposeStatement", () => {
  it("returns the condensed statement", async () => {
    const out = await proposeStatement({
      apiUrl: "http://api", token: "t", answer: "Cá hồi.", fetchFn: ok({ statement: "Cá hồi giàu omega-3." }),
    });
    expect(out).toBe("Cá hồi giàu omega-3.");
  });

  // NO DEAD END, and this is the whole reason this module exists as a testable unit: the screen
  // has no component-test harness, so this contract has to be provable here.
  it.each([
    ["a null statement", ok({ statement: null })],
    ["a non-200", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) } as unknown as Response)],
    ["a thrown fetch", vi.fn().mockRejectedValue(new Error("offline"))],
  ])("falls back to the verbatim answer on %s", async (_label, fetchFn) => {
    const out = await proposeStatement({
      apiUrl: "http://api", token: "t", answer: "Cá hồi.", fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(out).toBe("Cá hồi.");
  });

  it("omits the question key entirely when there is no question", async () => {
    const fetchFn = ok({ statement: "s" });
    await proposeStatement({ apiUrl: "http://api", token: "t", answer: "a", fetchFn });
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ answer: "a" });
  });
});

describe("saveStatement", () => {
  it("posts the statement and the source url", async () => {
    const fetchFn = ok({ id: "n1" });
    await saveStatement({
      apiUrl: "http://api", token: "t", statement: "s", sourceUrl: "https://e.com", fetchFn,
    });
    expect(fetchFn.mock.calls[0]![0]).toBe("http://api/notes/save-answer");
    expect(JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string))
      .toEqual({ statement: "s", sourceUrl: "https://e.com" });
  });

  it("does not throw when the write fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(saveStatement({
      apiUrl: "http://api", token: "t", statement: "s", fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBeUndefined();
  });
});

describe("webUrlOf", () => {
  // On the device, chat_messages.citations arrives as a JSON STRING -- jsonb replicates the same
  // way notes.domain_meta does. Parsing it is the whole job, and a version that treated it as an
  // array would silently return undefined for every grounded reply.
  it("reads the first web url out of the replicated JSON string", () => {
    const json = JSON.stringify([
      { type: "note", noteId: "n" },
      { type: "web", url: "https://e.com/a", title: "A" },
      { type: "web", url: "https://e.com/b", title: "B" },
    ]);
    expect(webUrlOf(json)).toBe("https://e.com/a");
  });

  it.each([[null], [""], ["not json"], ["[]"], [JSON.stringify([{ type: "note" }])]])(
    "returns undefined for %s", (input) => {
      expect(webUrlOf(input as string | null)).toBeUndefined();
    },
  );
});
