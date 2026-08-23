import { describe, expect, it, vi } from "vitest";
import type { AiClient } from "../ai/client.js";
import {
  buildMoodPrompt, hasReadableContent, MIN_USER_MESSAGES, readSessionMood,
  type SessionMessage,
} from "./read.js";

const msg = (
  role: "user" | "assistant", content: string, id = crypto.randomUUID(),
): SessionMessage => ({ id, role, content });

/** A db stand-in that records the usage_ledger insert without a database. */
function fakeDb() {
  const inserted: Record<string, unknown>[] = [];
  return {
    inserted,
    from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }),
  } as never;
}

function fakeAi(value: unknown): AiClient {
  return {
    embed: vi.fn(),
    generateStream: vi.fn(),
    generateJson: vi.fn().mockResolvedValue({
      value, inputTokens: 400, outputTokens: 60, model: "gemini-2.5-flash",
    }),
  } as unknown as AiClient;
}

describe("hasReadableContent", () => {
  it("rejects a session with fewer than the floor of user messages", () => {
    expect(hasReadableContent([msg("user", "ok"), msg("assistant", "vâng")])).toBe(false);
  });

  it("accepts a session at the floor", () => {
    expect(hasReadableContent([msg("user", "mệt"), msg("assistant", "sao"), msg("user", "deadline")]))
      .toBe(true);
  });

  // The floor counts USER messages only. Red if it ever counts rows: a one-line session with a
  // long assistant reply would then buy a model call for nothing, on every such session forever.
  it("does not count assistant messages towards the floor", () => {
    const messages = [msg("user", "ok"), ...Array.from({ length: 9 }, () => msg("assistant", "…"))];
    expect(hasReadableContent(messages)).toBe(false);
    expect(MIN_USER_MESSAGES).toBe(2);
  });
});

describe("buildMoodPrompt", () => {
  it("labels the two roles differently so the model can tell them apart", () => {
    const prompt = buildMoodPrompt([msg("user", "hôm nay mệt"), msg("assistant", "sao vậy")]);
    expect(prompt).toContain("User: hôm nay mệt");
    expect(prompt).toContain("You: sao vậy");
  });

  // The rule that keeps the two mood readers in this system agreeing with each other. extract.ts:130
  // carries the same sentence; if one drifts, a note and its session disagree about what mood is.
  it("carries the difficult-topic guard verbatim from extract.ts", () => {
    expect(buildMoodPrompt([msg("user", "x")]))
      .toContain("A note about a difficult topic is not a bad mood");
  });

  it("says the assistant's own replies are context and not evidence", () => {
    expect(buildMoodPrompt([msg("user", "x")])).toContain("Score the USER's mood only");
  });

  it("asks for Vietnamese topics", () => {
    expect(buildMoodPrompt([msg("user", "x")])).toContain("Vietnamese");
  });
});

describe("readSessionMood", () => {
  it("returns the model's reading", async () => {
    const db = fakeDb();
    const ai = fakeAi({
      valence: 2, summary: "mệt vì deadline", topics: ["công việc"], confidence: 0.8,
    });

    const reading = await readSessionMood({ db, ai }, {
      userId: "u1", messages: [msg("user", "mệt quá"), msg("user", "deadline dí")],
    });

    expect(reading).toEqual({
      valence: 2, summary: "mệt vì deadline", topics: ["công việc"], confidence: 0.8,
    });
  });

  // The anti-fabrication path. Red if the code coerces a null valence into a number, or treats
  // it as an error -- both of which would manufacture the mood history the S3 spec forbids.
  it("passes a null valence through instead of inventing one", async () => {
    const db = fakeDb();
    const ai = fakeAi({ valence: null, summary: null, topics: [], confidence: 0.1 });

    const reading = await readSessionMood({ db, ai }, {
      userId: "u1", messages: [msg("user", "1111"), msg("user", "ok")],
    });

    expect(reading.valence).toBeNull();
  });

  it("clamps a valence the model returned outside 1..5 to null", async () => {
    const db = fakeDb();
    const ai = fakeAi({ valence: 9, summary: "x", topics: [], confidence: 0.5 });

    const reading = await readSessionMood({ db, ai }, {
      userId: "u1", messages: [msg("user", "a"), msg("user", "b")],
    });

    // Not clamped to 5: an out-of-range answer is an answer the model did not understand, and
    // the CHECK on mood_readings.valence would reject it anyway -- turning a bad reading into a
    // failed row rather than an absent one.
    expect(reading.valence).toBeNull();
  });

  it("caps topics at five", async () => {
    const db = fakeDb();
    const ai = fakeAi({
      valence: 3, summary: "x", confidence: 0.5,
      topics: ["a", "b", "c", "d", "e", "f", "g"],
    });

    const reading = await readSessionMood({ db, ai }, {
      userId: "u1", messages: [msg("user", "a"), msg("user", "b")],
    });

    expect(reading.topics).toHaveLength(5);
  });

  it("meters the call under the mood kind and the sweep source", async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      from: () => ({
        insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; },
      }),
    } as never;
    const ai = fakeAi({ valence: 3, summary: "x", topics: [], confidence: 0.5 });

    await readSessionMood({ db, ai }, {
      userId: "u1", messages: [msg("user", "a"), msg("user", "b")],
    });

    expect(inserted[0]).toMatchObject({
      user_id: "u1", kind: "mood", source: "sweep", input_tokens: 400, output_tokens: 60,
    });
  });
});
