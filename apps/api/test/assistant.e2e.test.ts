import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeAi } from "@cortex/core";
import { auth, bootstrapTestApp, makeUser, type TestUser } from "./harness";

let app: INestApplication;
let alice: TestUser;
let noteId: string;

// runTurn (packages/core/src/assistant/turn.ts) calls two AiClient methods on every request:
// generateJson (via extractNote, for the intent/tags/domain classification) and generateStream
// (for the answer or acknowledgement text). createFakeAi()'s default throws for both when
// unscripted (packages/core/src/ai/fake.ts:66-75), so both must be scripted here or a real
// POST /assistant request throws inside the turn instead of streaming a response. `embed` is
// left at its default -- retrieve() uses it and the default fake is deterministic and safe.
//
// intent: "question" is scripted so the turn takes the answer-prompt branch (buildAnswerPrompt),
// which is the branch that emits citations from real retrieval -- the acknowledge branch would
// exercise less of the turn for the same test.
const scriptedAi = createFakeAi({
  generateJson: async () => ({
    value: {
      intent: "question",
      complexity: "simple",
      domain: null,
      domain_meta: {},
      tags: [],
    },
    inputTokens: 10,
    outputTokens: 5,
    model: "fake-classify-model",
  }),
  generateStream: async () => ({
    chunks: (async function* () {
      yield { text: "The answer " };
      yield { text: "is here." };
    })(),
    usage: () => ({ inputTokens: 20, outputTokens: 10, model: "fake-answer-model" }),
  }),
});

beforeAll(async () => {
  app = await bootstrapTestApp({ ai: scriptedAi });
  alice = await makeUser("api-assistant-alice@test.local");
  // runTurn looks the note up through the CALLER's own RLS-scoped client (userDb), so there is
  // no way to fabricate a note id that passes -- a real note, owned by alice, is required.
  const res = await request(app.getHttpServer())
    .post("/notes")
    .set(auth(alice.token))
    .send({ content: "what did I decide about the pricing page last week" })
    .expect(201);
  noteId = res.body.id;
});
afterAll(async () => {
  await app.close();
});

describe("POST /assistant", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await request(app.getHttpServer())
      .post("/assistant")
      .send({ noteId: crypto.randomUUID() });
    expect(res.status).toBe(401);
  });

  // assistantInput is .strict(): a body-supplied userId must be a 400, not a value the server
  // quietly drops. p_user_id inside runTurn's retrieval always comes from the verified JWT.
  it("rejects a body carrying an extra field", async () => {
    const res = await request(app.getHttpServer())
      .post("/assistant")
      .set(auth(alice.token))
      .send({ noteId: crypto.randomUUID(), userId: "someone-else" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-uuid note id", async () => {
    const res = await request(app.getHttpServer())
      .post("/assistant")
      .set(auth(alice.token))
      .send({ noteId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("answers as an event stream", async () => {
    const res = await request(app.getHttpServer())
      .post("/assistant")
      .set(auth(alice.token))
      .send({ noteId });

    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    // attached and citations may arrive in either order (runTurn runs extraction and retrieval
    // concurrently), but both must appear, and the turn must end with `done` -- proving the
    // generator ran to completion rather than erroring out partway through.
    expect(res.text).toMatch(/event: attached/);
    expect(res.text).toMatch(/event: citations/);
    expect(res.text).toMatch(/event: token/);
    expect(res.text).toMatch(/event: done/);
  });
});
