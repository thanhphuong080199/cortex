import { INestApplication } from "@nestjs/common";
import { createClient } from "@supabase/supabase-js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, bootstrapTestApp, makeUser, type TestUser } from "./harness";

let app: INestApplication;
let alice: TestUser;
let bob: TestUser;

// A dedicated admin client, built the same way search.e2e.test.ts's does, to read the note
// row back directly -- the HTTP response alone does not prove what landed in the columns
// search_notes actually ranks on.
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

beforeAll(async () => {
  app = await bootstrapTestApp();
  alice = await makeUser("api-notes-alice@test.local");
  bob = await makeUser("api-notes-bob@test.local");
});
afterAll(async () => { await app.close(); });

describe("POST /notes", () => {
  it("401 without token", async () => {
    await request(app.getHttpServer()).post("/notes").send({ content: "x" }).expect(401);
  });
  it("400 with field paths on empty body", async () => {
    const res = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({}).expect(400);
    expect(res.body.issues[0].path).toBe("content");
  });
  it("201 creates an inbox note", async () => {
    const res = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "from api" }).expect(201);
    expect(res.body.lifecycle).toBe("inbox");
  });
});

describe("note lifecycle over HTTP", () => {
  let noteId: string;
  beforeAll(async () => {
    const res = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "lifecycle" });
    noteId = res.body.id;
  });

  it("PATCH archives via lifecycle field", async () => {
    const res = await request(app.getHttpServer()).patch(`/notes/${noteId}`)
      .set(auth(alice.token)).send({ lifecycle: "archived" }).expect(200);
    expect(res.body.lifecycle).toBe("archived");
  });
  it("Bob PATCHing Alice's note is 404, not 403", async () => {
    await request(app.getHttpServer()).patch(`/notes/${noteId}`)
      .set(auth(bob.token)).send({ content: "steal" }).expect(404);
  });
  it("Bob DELETEing Alice's note is 404, not 403", async () => {
    await request(app.getHttpServer()).delete(`/notes/${noteId}`)
      .set(auth(bob.token)).expect(404);
  });
  it("a non-uuid id is 400, not 500", async () => {
    await request(app.getHttpServer()).patch("/notes/not-a-uuid")
      .set(auth(alice.token)).send({ content: "x" }).expect(400);
  });
  it("purge before delete is 404 (two-step)", async () => {
    await request(app.getHttpServer()).delete(`/notes/${noteId}/purge`)
      .set(auth(alice.token)).expect(404);
  });
  it("delete → restore → delete → purge", async () => {
    await request(app.getHttpServer()).delete(`/notes/${noteId}`).set(auth(alice.token)).expect(200);
    await request(app.getHttpServer()).post(`/notes/${noteId}/restore`).set(auth(alice.token)).expect(201);
    await request(app.getHttpServer()).delete(`/notes/${noteId}`).set(auth(alice.token)).expect(200);
    await request(app.getHttpServer()).delete(`/notes/${noteId}/purge`).set(auth(alice.token)).expect(200);
  });
  it("the purged note is really gone (404 on a second purge)", async () => {
    await request(app.getHttpServer()).delete(`/notes/${noteId}/purge`).set(auth(alice.token)).expect(404);
  });
});

describe("POST /notes/save-answer", () => {
  it("saves an answer as a down-weighted inbox note", async () => {
    const res = await request(app.getHttpServer())
      .post("/notes/save-answer")
      .set(auth(alice.token))
      .send({ statement: "Omega-3 có trong cá hồi.", sourceUrl: "https://e.com/a" })
      .expect(201);

    const { data } = await admin.from("notes")
      .select("lifecycle, source_type, source_meta").eq("id", res.body.id).single();
    expect(data).toMatchObject({
      lifecycle: "inbox", source_type: "web_search", source_meta: { url: "https://e.com/a" },
    });
  });

  // .strict() doing its job: a body naming a user must be rejected, not silently ignored.
  it("rejects a body that tries to name a user", async () => {
    await request(app.getHttpServer())
      .post("/notes/save-answer")
      .set(auth(alice.token))
      .send({ statement: "x", userId: "00000000-0000-4000-8000-000000000000" })
      .expect(400);
  });

  // The durable half of the save controls (S1.5 §4, reported 2026-08-24: the "already saved"
  // indicator forgot itself on every reload). Real Postgres, real RLS, real jsonb merge -- the
  // unit test's fake db proves the JS logic, this proves the actual read-modify-write survives
  // PostgREST.
  it("marks the source chat_messages row when forMessageId is given, merging into its retrieval_meta", async () => {
    const { data: session } = await admin
      .from("chat_sessions").insert({ user_id: alice.id }).select("id").single();
    const { data: message } = await admin
      .from("chat_messages")
      .insert({
        user_id: alice.id, session_id: (session as { id: string }).id,
        role: "assistant", content: "Cá hồi giàu omega-3.",
        retrieval_meta: { requestId: "r1" },
      })
      .select("id").single();

    const res = await request(app.getHttpServer())
      .post("/notes/save-answer")
      .set(auth(alice.token))
      .send({ statement: "Omega-3 có trong cá hồi.", forMessageId: (message as { id: string }).id })
      .expect(201);

    const { data: marked } = await admin
      .from("chat_messages").select("retrieval_meta")
      .eq("id", (message as { id: string }).id).single();
    expect((marked as { retrieval_meta: unknown }).retrieval_meta)
      .toEqual({ requestId: "r1", savedAnswerNoteId: res.body.id });
  });

  // Someone else's message id must not be markable through this endpoint -- RLS on
  // chat_messages, exercised through the caller's own client, is what proves that, not a body
  // check the server would have to remember to add.
  it("does not mark another user's message, and still saves the note", async () => {
    const { data: session } = await admin
      .from("chat_sessions").insert({ user_id: bob.id }).select("id").single();
    const { data: message } = await admin
      .from("chat_messages")
      .insert({
        user_id: bob.id, session_id: (session as { id: string }).id,
        role: "assistant", content: "Của Bob.", retrieval_meta: { requestId: "r2" },
      })
      .select("id").single();

    await request(app.getHttpServer())
      .post("/notes/save-answer")
      .set(auth(alice.token))
      .send({ statement: "Alice cố lưu vào tin nhắn của Bob.", forMessageId: (message as { id: string }).id })
      .expect(201);

    const { data: untouched } = await admin
      .from("chat_messages").select("retrieval_meta")
      .eq("id", (message as { id: string }).id).single();
    expect((untouched as { retrieval_meta: unknown }).retrieval_meta).toEqual({ requestId: "r2" });
  });
});
