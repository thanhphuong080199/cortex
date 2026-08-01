import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, bootstrapTestApp, makeUser, type TestUser } from "./harness";

let app: INestApplication;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  app = await bootstrapTestApp();
  alice = await makeUser("api-tags-alice@test.local");
  bob = await makeUser("api-tags-bob@test.local");
});
afterAll(async () => { await app.close(); });

describe("tags over HTTP", () => {
  it("POST /tags is find-or-create (same id for same name, case-insensitive)", async () => {
    const a = await request(app.getHttpServer()).post("/tags")
      .set(auth(alice.token)).send({ name: "Product" }).expect(201);
    const b = await request(app.getHttpServer()).post("/tags")
      .set(auth(alice.token)).send({ name: "product" }).expect(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it("400 on an empty tag name", async () => {
    await request(app.getHttpServer()).post("/tags")
      .set(auth(alice.token)).send({ name: "   " }).expect(400);
  });

  it("attach → detach → re-attach cycle over HTTP", async () => {
    const note = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "taggable via api" });
    const tag = await request(app.getHttpServer()).post("/tags")
      .set(auth(alice.token)).send({ name: "api-cycle" });
    await request(app.getHttpServer()).post(`/notes/${note.body.id}/tags`)
      .set(auth(alice.token)).send({ tagId: tag.body.id }).expect(201);
    await request(app.getHttpServer()).delete(`/notes/${note.body.id}/tags/${tag.body.id}`)
      .set(auth(alice.token)).expect(200);
    await request(app.getHttpServer()).post(`/notes/${note.body.id}/tags`)
      .set(auth(alice.token)).send({ tagId: tag.body.id }).expect(201);
  });

  it("attaching to Bob's note is 404", async () => {
    const bobNote = await request(app.getHttpServer()).post("/notes")
      .set(auth(bob.token)).send({ content: "bob's" });
    const tag = await request(app.getHttpServer()).post("/tags")
      .set(auth(alice.token)).send({ name: "trespass-api" });
    await request(app.getHttpServer()).post(`/notes/${bobNote.body.id}/tags`)
      .set(auth(alice.token)).send({ tagId: tag.body.id }).expect(404);
  });

  it("attaching an unknown tag id is 404", async () => {
    const note = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "no such tag" });
    await request(app.getHttpServer()).post(`/notes/${note.body.id}/tags`)
      .set(auth(alice.token)).send({ tagId: crypto.randomUUID() }).expect(404);
  });

  it("400 when tagId is not a uuid", async () => {
    const note = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "bad tag id" });
    await request(app.getHttpServer()).post(`/notes/${note.body.id}/tags`)
      .set(auth(alice.token)).send({ tagId: "nope" }).expect(400);
  });

  it("401 without a token", async () => {
    await request(app.getHttpServer()).post("/tags").send({ name: "anon" }).expect(401);
  });
});
