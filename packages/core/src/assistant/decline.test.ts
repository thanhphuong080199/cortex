import { describe, expect, it } from "vitest";
import { declineOffer } from "./decline.js";

const recordingDb = () => {
  const rows: Record<string, Record<string, unknown>[]> = {};
  const client = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        (rows[table] ??= []).push(row);
        return { data: null, error: null };
      },
    }),
  } as never;
  return { client, rows };
};

// C5 §14 asks for "a declined offer never reaches the nightly memory update". That job does not
// exist yet -- there is no packages/core/src/memory/ and nothing outside packages/db/src/test/
// reads memory_facts. A test for it here would mock a consumer that has never been written and
// would pass no matter what this file does.
//
// What IS asserted instead: the row is WRITTEN with the category and the evidence marker that
// consumer will filter on. The behavioural half is owed by whichever stage builds the nightly
// job, and 00033's header is where that requirement is recorded for it.
describe("declineOffer", () => {
  const args = { userId: "u1", statement: "Cá hồi giàu omega-3.", embedding: [0.1, 0.2] };

  it("records the fact as rejected so it is not offered again", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.memory_facts?.[0]).toMatchObject({
      user_id: "u1", statement: args.statement, status: "rejected",
    });
  });

  // THE FENCE (§12.2), and spec correction 3. Every existing category is a claim about the
  // USER; a declined offer is not one. Filing it as 'opinion' would write a false statement
  // about the person into the table the whole memory layer is built on.
  it("files it under assistant_offer, not under a claim about the user", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.memory_facts?.[0]?.category).toBe("assistant_offer");
  });

  // §12.2's named requirement, written BOTH ways. The category is what a query filters on; the
  // evidence marker is what the spec asked for and what survives if someone later widens the
  // category filter without reading 00033's header.
  it("marks the evidence as assistant-originated", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.memory_facts?.[0]?.evidence).toMatchObject({ source: "assistant_offer" });
  });

  // The embedding is what makes Task 14's dedup semantic rather than textual. A row written
  // without one is a row the next offer cannot be compared against -- the decline silently
  // fails to stick, and it looks like the dedup threshold being wrong.
  it("stores the embedding the dedup will compare against", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.memory_facts?.[0]?.embedding).toEqual(args.embedding);
  });

  // The ACT of declining, separate from the fact. feedback_events.subject_type already lists
  // 'chat_answer' (00005) -- no migration needed for this half.
  it("records the decline as a feedback event", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.feedback_events?.[0]).toMatchObject({
      user_id: "u1", subject_type: "chat_answer", action: "reject",
    });
  });

  // §11: "declining costs nothing". A decline must never write a note -- that is the accept
  // path, and reaching it here would save exactly the thing the user just refused.
  it("writes no note", async () => {
    const { client, rows } = recordingDb();
    await declineOffer(client, args);
    expect(rows.notes).toBeUndefined();
  });
});
