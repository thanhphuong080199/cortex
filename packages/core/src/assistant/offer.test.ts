import { describe, expect, it, vi } from "vitest";
import { createFakeAi } from "../ai/fake.js";
import { distill, MANUAL_SAVE_PROMPT, OFFER_MAX_CHARS, OFFER_PROMPT, proposeOffer } from "./offer.js";

// Both halves matter. `insert` is recordUsage's ledger write; the `select` chain is the dedup
// read Task 14 adds INSIDE this same function. Stub it now, returning no facts, so these tests
// keep exercising the real path once Task 14 lands -- a double missing `select` would throw into
// proposeOffer's dedup catch, and every test in this describe would pass through an error branch
// while still going green.
const db = () => ({
  from: () => ({
    insert: async () => ({ data: null, error: null }),
    select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }),
  }),
}) as never;

const ai = (statement: unknown) => createFakeAi({
  generateJson: async () => ({
    value: { statement },
    inputTokens: 10, outputTokens: 5, model: "fake-classify",
  }),
});

describe("proposeOffer", () => {
  it("proposes the statement the model condensed", async () => {
    const out = await proposeOffer({ db: db(), ai: ai("Omega-3 có trong cá hồi.") },
      { userId: "u1", question: "omega-3 ở đâu", answer: "...", sourceUrl: "https://e.com/a",
        requestId: "r1" });
    expect(out).toEqual({ statement: "Omega-3 có trong cá hồi.", sourceUrl: "https://e.com/a" });
  });

  // THE SILENT PATH, and the one that matters most. An offer on every turn is nagging, and
  // nagging is what makes a user stop reading offers -- at which point the mechanism is worse
  // than not having it. `null` must be a first-class outcome, not an error case.
  it("proposes nothing when the model returns nothing worth saving", async () => {
    for (const empty of [null, "", "   ", 42]) {
      const out = await proposeOffer({ db: db(), ai: ai(empty) },
        { userId: "u1", question: "q", answer: "a", requestId: "r1" });
      expect(out, `statement=${JSON.stringify(empty)}`).toBeNull();
    }
  });

  // An offer whose text is the whole answer is not an offer, it is a save button. The prompt
  // must ask for ONE statement, and the cap is what makes that assertable.
  it("declines a statement too long to be one statement", async () => {
    const out = await proposeOffer({ db: db(), ai: ai("x".repeat(1000)) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" });
    expect(out).toBeNull();
  });

  // A model failure must cost the user nothing. The answer has already streamed; an offer is a
  // bonus on top of it, and a thrown embed or a dead classify call must not turn a completed
  // turn into a failed one.
  it("returns null rather than throwing when the model fails", async () => {
    const failing = createFakeAi({ generateJson: async () => { throw new Error("boom"); } });
    await expect(proposeOffer({ db: db(), ai: failing },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" })).resolves.toBeNull();
  });
});

describe("distill", () => {
  // The manual path's prompt must NOT be the offer's. The offer's opens with "knowledge that was
  // NOT in the user's own notes", which is false on a path the user invoked deliberately -- they
  // may well want to keep an answer drawn from their own notes. And "Returning null is the normal
  // case" must not appear: on a path the user asked for, null is a failure, not modesty.
  it("uses a manual-save prompt that does not assume the answer came from outside their notes", () => {
    expect(MANUAL_SAVE_PROMPT).not.toMatch(/NOT in the user's own notes/i);
    expect(MANUAL_SAVE_PROMPT).not.toMatch(/null is the normal case/i);
    expect(OFFER_PROMPT).toMatch(/NOT in the user's own notes/i);
  });

  it("returns the condensed statement", async () => {
    const out = await distill({ db: db(), ai: ai("Cá hồi giàu omega-3.") },
      { userId: "u", prompt: MANUAL_SAVE_PROMPT, answer: "a long answer", requestId: "r" });
    expect(out).toBe("Cá hồi giàu omega-3.");
  });

  // The caller's fallback depends on this being null rather than a throw: the client shows the
  // verbatim reply instead, so a failed distillation must never dead-end the user's request.
  it("returns null rather than throwing when the model call fails", async () => {
    const failing = createFakeAi({ generateJson: async () => { throw new Error("gemini down"); } });
    const out = await distill({ db: db(), ai: failing },
      { userId: "u", prompt: MANUAL_SAVE_PROMPT, answer: "a", requestId: "r" });
    expect(out).toBeNull();
  });

  it("returns null when the model produced nothing usable", async () => {
    const out = await distill({ db: db(), ai: ai("   ") },
      { userId: "u", prompt: MANUAL_SAVE_PROMPT, answer: "a", requestId: "r" });
    expect(out).toBeNull();
  });

  // A statement over the cap means the model did not distil -- it echoed. Null, so the caller
  // falls back to the verbatim reply, which is at least honestly labelled as such.
  it("returns null when the statement exceeds OFFER_MAX_CHARS", async () => {
    const out = await distill({ db: db(), ai: ai("x".repeat(OFFER_MAX_CHARS + 1)) },
      { userId: "u", prompt: MANUAL_SAVE_PROMPT, answer: "a", requestId: "r" });
    expect(out).toBeNull();
  });

  // No dedup on this path, and the assertion is that a stored fact IDENTICAL to the statement
  // does not suppress it. Silence because the statement resembles something previously declined
  // would be indistinguishable from a broken button, with no way for the user to find out why.
  it("does not consult memory_facts", async () => {
    const from = vi.fn((_t: string) => ({
      insert: async () => ({ data: null, error: null }),
      select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }),
    }));
    await distill({ db: { from } as never, ai: ai("Cá hồi giàu omega-3.") },
      { userId: "u", prompt: MANUAL_SAVE_PROMPT, answer: "a", requestId: "r" });
    expect(from).not.toHaveBeenCalledWith("memory_facts");
  });
});

describe("dedup against declined facts", () => {
  // A db double whose memory_facts read returns whatever the test hands it, and an ai double
  // whose embed() returns a fixed vector -- the similarity is decided by the STORED row, which
  // is what the production code compares against.
  const dbWith = (facts: { statement: string; embedding: number[] }[]) => ({
    from: (t: string) => t === "memory_facts"
      ? { select: () => ({ eq: () => ({ in: async () => ({ data: facts, error: null }) }) }) }
      : { insert: async () => ({ data: null, error: null }) },
  }) as never;

  const aiWith = (statement: string, vector: number[]) => createFakeAi({
    generateJson: async () => ({
      value: { statement }, inputTokens: 10, outputTokens: 5, model: "fake-classify",
    }),
    embed: async () => ({ vectors: [vector], inputTokens: 5, model: "fake-embed" }),
  });

  // THE POINT OF THE WHOLE TASK. Same fact, different words -- a string comparison would miss
  // it entirely, and the user would be offered the thing they just refused, phrased slightly
  // differently. That is worse than never having built the decline path.
  it("does not re-offer a fact the user already declined", async () => {
    const out = await proposeOffer(
      { db: dbWith([{ statement: "Cá hồi giàu omega-3.", embedding: [1, 0] }]),
        ai: aiWith("Omega-3 có nhiều trong cá hồi.", [1, 0]) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" },
    );
    expect(out).toBeNull();
  });

  it("still offers an unrelated fact", async () => {
    const out = await proposeOffer(
      { db: dbWith([{ statement: "Cá hồi giàu omega-3.", embedding: [1, 0] }]),
        ai: aiWith("Vitamin A tốt cho mắt.", [0, 1]) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" },
    );
    expect(out?.statement).toBe("Vitamin A tốt cho mắt.");
  });

  // §12.3: "A string comparison here would not work." This is the test that turns red if
  // someone replaces the cosine with an equality check -- identical meaning, different string.
  it("compares meaning rather than text", async () => {
    const out = await proposeOffer(
      { db: dbWith([{ statement: "hoàn toàn khác về mặt chữ", embedding: [1, 0] }]),
        ai: aiWith("một câu không giống chút nào", [0.99, 0.14]) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" },
    );
    expect(out, "near-identical vectors, unrelated strings").toBeNull();
  });

  // FINDING 1 (final whole-branch review). PostgREST serializes a `vector` column as its
  // Postgres text output, e.g. "[1,0]", NOT a JSON array -- pgvector has no JSON cast. The
  // fixture above (`dbWith`) hands `embedding` as a real `number[]`, a shape the real database
  // never actually returns; this test hands it as the STRING the real database does, so that a
  // regression back to comparing it raw (`a[i] * b[i]` on a string index, silently NaN
  // everywhere) is caught here instead of only in production.
  it("still dedups when the stored embedding arrives as PostgREST's string encoding", async () => {
    const stringEmbeddingDb = {
      from: (t: string) => t === "memory_facts"
        ? { select: () => ({ eq: () => ({ in: async () => (
            { data: [{ statement: "Cá hồi giàu omega-3.", embedding: "[1,0]" }], error: null }
          ) }) }) }
        : { insert: async () => ({ data: null, error: null }) },
    } as never;
    const out = await proposeOffer(
      { db: stringEmbeddingDb, ai: aiWith("Omega-3 có nhiều trong cá hồi.", [1, 0]) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" },
    );
    expect(out).toBeNull();
  });

  // A dedup that fails must not cost the user the offer OR the turn. The read is a convenience;
  // the worst case of skipping it is being asked once more, which is far better than an error.
  it("still offers when the dedup read fails", async () => {
    const broken = {
      from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: "boom" } }) }) }) }),
    } as never;
    const out = await proposeOffer({ db: broken, ai: aiWith("Vitamin A tốt cho mắt.", [0, 1]) },
      { userId: "u1", question: "q", answer: "a", requestId: "r1" });
    expect(out?.statement).toBe("Vitamin A tốt cho mắt.");
  });
});
