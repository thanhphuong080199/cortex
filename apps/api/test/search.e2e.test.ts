import { INestApplication } from "@nestjs/common";
import { createClient } from "@supabase/supabase-js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeAi } from "@cortex/core";
import { auth, bootstrapTestApp, makeUser, type TestUser } from "./harness";

let app: INestApplication;
let alice: TestUser;

// A dedicated admin client, built the same way app.e2e.test.ts's does, to seed a note directly
// under a SECOND user's id -- there is no HTTP route that lets one authenticated caller create
// a note under another user's id, by design.
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

beforeAll(async () => {
  // NO TEST MAY EVER CALL THE REAL GEMINI API (packages/core/src/ai/fake.ts). bootstrapTestApp's
  // `ai` override swaps out AppModule's real AI_CLIENT provider before the app boots, so the
  // embed() call SearchController makes on every request below never reaches Gemini's network.
  app = await bootstrapTestApp({ ai: createFakeAi() });
  alice = await makeUser("api-search-alice@test.local");
});
afterAll(async () => { await app.close(); });

describe("POST /search", () => {
  it("401s without a token", async () => {
    await request(app.getHttpServer()).post("/search").send({ q: "anything" }).expect(401);
  });

  it("400s on an empty query", async () => {
    await request(app.getHttpServer()).post("/search").set(auth(alice.token)).send({ q: "" }).expect(400);
  });

  // searchInput is .strict(): an unrecognised key fails validation loudly instead of being
  // dropped silently. Proven here as its own property, separate from the isolation test below
  // -- "a body-supplied userId is rejected" and "isolation holds with a clean body" are two
  // different claims and neither one implies the other.
  it("400s when the body carries a userId field, rather than silently ignoring it", async () => {
    const res = await request(app.getHttpServer()).post("/search")
      .set(auth(alice.token))
      .send({ q: "anything", userId: "11111111-1111-1111-1111-111111111111" })
      .expect(400);
    expect(res.body.issues).toBeDefined();
  });

  it("finds the caller's own note by keyword", async () => {
    await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "the marginal cost of a second cup" }).expect(201);

    const res = await request(app.getHttpServer()).post("/search")
      .set(auth(alice.token)).send({ q: "marginal cost" }).expect(201);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0]).toHaveProperty("snippet");
  });

  // The security property this endpoint exists to protect: the p_user_id passed to
  // search_notes comes only from the verified JWT (SupabaseAuthGuard + @CurrentUser()), never
  // from the body. Proven directly here (not just via the .strict() 400 above, which only shows
  // an explicit userId field is rejected -- it says nothing about whether a CLEAN body still
  // isolates correctly). A real matching row is seeded for the other user too, per issue-log
  // E3: an empty result for alice would be vacuous if bob's note didn't actually match the query.
  it("never returns another user's note, with a real matching row for that user", async () => {
    const bob = await makeUser("api-search-bob@test.local");
    const { data: bobNote, error } = await admin.from("notes")
      .insert({ user_id: bob.id, content: "quixotic zephyr pricing thoughts, bob's private version" })
      .select("id").single();
    if (error) throw error;

    await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token))
      .send({ content: "quixotic zephyr pricing thoughts, alice's own version" }).expect(201);

    const res = await request(app.getHttpServer()).post("/search")
      .set(auth(alice.token)).send({ q: "quixotic zephyr pricing thoughts" }).expect(201);

    const noteIds = res.body.results.map((r: { noteId: string }) => r.noteId);
    expect(noteIds.length).toBeGreaterThan(0); // alice's own note proves the query actually matches
    expect(noteIds).not.toContain(bobNote!.id);
  });
});
