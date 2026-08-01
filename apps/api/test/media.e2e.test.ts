import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, bootstrapTestApp, makeUser, type TestUser } from "./harness";

let app: INestApplication;
let alice: TestUser;

beforeAll(async () => {
  app = await bootstrapTestApp();
  alice = await makeUser("api-media-alice@test.local");
});
afterAll(async () => { await app.close(); });

describe("POST /media-log", () => {
  it("401 without token", async () => {
    await request(app.getHttpServer()).post("/media-log")
      .send({ kind: "movie", title: "x" }).expect(401);
  });

  it("logs a movie and returns the item plus its note", async () => {
    const res = await request(app.getHttpServer()).post("/media-log")
      .set(auth(alice.token))
      .send({ kind: "movie", title: "Dune Part 3", rating: 4, impression: "spice" })
      .expect(201);
    expect(res.body.note.domain).toBe("media");
    expect(res.body.note.media_item_id).toBe(res.body.item.id);
    expect(res.body.note.domain_meta.rating).toBe(4);
    expect(res.body.note.content).toBe("spice");
  });

  it("logging the same title again reuses the item and adds a note", async () => {
    const first = await request(app.getHttpServer()).post("/media-log")
      .set(auth(alice.token)).send({ kind: "game", title: "Outer Wilds", rating: 5 }).expect(201);
    const second = await request(app.getHttpServer()).post("/media-log")
      .set(auth(alice.token)).send({ kind: "game", title: "outer wilds", impression: "again" }).expect(201);
    expect(second.body.item.id).toBe(first.body.item.id);
    expect(second.body.note.id).not.toBe(first.body.note.id);
  });

  it("rejects an unknown kind with a field path", async () => {
    const res = await request(app.getHttpServer()).post("/media-log")
      .set(auth(alice.token)).send({ kind: "vinyl", title: "x" }).expect(400);
    expect(res.body.issues[0].path).toBe("kind");
  });

  it("rejects an empty title", async () => {
    await request(app.getHttpServer()).post("/media-log")
      .set(auth(alice.token)).send({ kind: "book", title: "   " }).expect(400);
  });
});

describe("notes carry domain end to end", () => {
  it("POST /notes with domain=health persists it", async () => {
    const res = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "ran 5k, felt strong", domain: "health" }).expect(201);
    expect(res.body.domain).toBe("health");
  });

  it("POST /notes rejects an unknown domain", async () => {
    await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "x", domain: "astrology" }).expect(400);
  });

  it("PATCH can set and then clear a domain", async () => {
    const note = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "maybe finance?" }).expect(201);

    const set = await request(app.getHttpServer()).patch(`/notes/${note.body.id}`)
      .set(auth(alice.token)).send({ domain: "finance" }).expect(200);
    expect(set.body.domain).toBe("finance");

    // Clearing is the whole reason updateNoteInput.domain is nullable: a domain the user
    // or (from phase 2) enrichment got wrong has to be removable.
    const cleared = await request(app.getHttpServer()).patch(`/notes/${note.body.id}`)
      .set(auth(alice.token)).send({ domain: null }).expect(200);
    expect(cleared.body.domain).toBeNull();
  });

  it("a note created without a domain has none", async () => {
    const res = await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "undomained" }).expect(201);
    expect(res.body.domain).toBeNull();
  });
});
