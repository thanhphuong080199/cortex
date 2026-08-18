import { describe, expect, it } from "vitest";
import { createFakeAi } from "../ai/fake.js";
import { proposeOffer } from "./offer.js";

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
