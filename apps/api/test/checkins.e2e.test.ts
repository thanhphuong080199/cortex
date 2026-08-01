import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, bootstrapTestApp, makeUser, type TestUser } from "./harness";

let app: INestApplication;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  app = await bootstrapTestApp();
  alice = await makeUser("api-checkins-alice@test.local");
  bob = await makeUser("api-checkins-bob@test.local");
});
afterAll(async () => { await app.close(); });

describe("POST /checkins", () => {
  it("401 without token", async () => {
    await request(app.getHttpServer()).post("/checkins").send({ mood: 3 }).expect(401);
  });

  it("400 when neither mood nor energy is given", async () => {
    // The refine on createCheckinInput, not the 23514 -- a label alone is not a check-in.
    await request(app.getHttpServer()).post("/checkins")
      .set(auth(alice.token)).send({ label: "words only" }).expect(400);
  });

  it("400 with a field path on an out-of-range mood", async () => {
    const res = await request(app.getHttpServer()).post("/checkins")
      .set(auth(alice.token)).send({ mood: 6 }).expect(400);
    expect(res.body.issues[0].path).toBe("mood");
  });

  it("201 on a single mood tap -- the whole gesture", async () => {
    const res = await request(app.getHttpServer()).post("/checkins")
      .set(auth(alice.token)).send({ mood: 4 }).expect(201);
    expect(res.body.mood).toBe(4);
    expect(res.body.energy).toBeNull();
  });

  it("201 with mood, energy and a label together", async () => {
    const res = await request(app.getHttpServer()).post("/checkins")
      .set(auth(alice.token)).send({ mood: 4, energy: 3, label: "good" }).expect(201);
    expect(res.body.label).toBe("good");
  });
});

describe("DELETE /checkins/:id", () => {
  it("200 undoes the caller's own mis-tap", async () => {
    const created = await request(app.getHttpServer()).post("/checkins")
      .set(auth(alice.token)).send({ mood: 2 }).expect(201);
    await request(app.getHttpServer()).delete(`/checkins/${created.body.id}`)
      .set(auth(alice.token)).expect(200);
  });

  it("404 on a second delete of the same check-in", async () => {
    const created = await request(app.getHttpServer()).post("/checkins")
      .set(auth(alice.token)).send({ mood: 2 }).expect(201);
    await request(app.getHttpServer()).delete(`/checkins/${created.body.id}`)
      .set(auth(alice.token)).expect(200);
    await request(app.getHttpServer()).delete(`/checkins/${created.body.id}`)
      .set(auth(alice.token)).expect(404);
  });

  it("Bob deleting Alice's check-in is 404, not 403", async () => {
    const bobs = await request(app.getHttpServer()).post("/checkins")
      .set(auth(bob.token)).send({ mood: 2 }).expect(201);
    await request(app.getHttpServer()).delete(`/checkins/${bobs.body.id}`)
      .set(auth(alice.token)).expect(404);
  });

  it("a non-uuid id is 400, not 500", async () => {
    await request(app.getHttpServer()).delete("/checkins/not-a-uuid")
      .set(auth(alice.token)).expect(400);
  });
});
