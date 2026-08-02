import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, bootstrapTestApp, makeUser, type TestUser } from "./harness";

let app: INestApplication;
let alice: TestUser;
let bob: TestUser;

const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  app = await bootstrapTestApp();
  alice = await makeUser("api-sync-alice@test.local");
  bob = await makeUser("api-sync-bob@test.local");
});
afterAll(async () => { await app.close(); });

const post = (token: string, body: object) =>
  request(app.getHttpServer()).post("/sync/upload").set(auth(token)).send(body);

describe("POST /sync/upload", () => {
  it("401s without a token", async () => {
    await request(app.getHttpServer()).post("/sync/upload").send({ ops: [] }).expect(401);
  });

  it("400s on an empty batch", async () => {
    await post(alice.token, { ops: [] }).expect(400);
  });

  it("400s on a table outside the allow-list", async () => {
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "usage_ledger", id: uuid(), data: {} }],
    }).expect(400);
  });

  it("inserts a note and reports it applied", async () => {
    const id = uuid();
    const res = await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "notes", id, data: { content: "from phone" } }],
    }).expect(201);
    expect(res.body.applied).toEqual(["1"]);
    expect(res.body.failed).toEqual([]);
  });

  it("rejects the whole batch when an op carries another user's user_id", async () => {
    const res = await post(alice.token, {
      ops: [{
        op_id: "1", op: "PUT", table: "notes", id: uuid(),
        data: { content: "smuggled", user_id: bob.id },
      }],
    }).expect(403);
    expect(res.body.message).toMatch(/user_id/i);
  });

  it("reports a conflict copy without failing the op, and link_failures stays empty", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "notes", id, data: { content: "original" } }],
    }).expect(201);
    // Web edits it, moving updated_at away from the phone's stale base.
    await post(alice.token, {
      ops: [{ op_id: "2", op: "PATCH", table: "notes", id, data: { content: "web edit" } }],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{
        op_id: "3", op: "PATCH", table: "notes", id, data: { content: "phone edit" },
        base_updated_at: "2020-01-01T00:00:00.000Z",
      }],
    }).expect(201);
    expect(res.body.applied).toEqual(["3"]);
    expect(res.body.conflict_copies).toHaveLength(1);
    expect(res.body.conflict_copies[0].op_id).toBe("3");
    // The link write is not sabotaged on the normal path -- it must not appear here.
    expect(res.body.link_failures).toEqual([]);
  });

  it("resolves an offline media note to a media_item", async () => {
    const id = uuid();
    const res = await post(alice.token, {
      ops: [{
        op_id: "1", op: "PUT", table: "notes", id,
        data: {
          content: "loved it", title: "Arrival", domain: "media",
          domain_meta: { status: "finished", pending_item: { kind: "movie", title: "Arrival" } },
        },
      }],
    }).expect(201);
    expect(res.body.applied).toEqual(["1"]);
    expect(res.body.resolved_media).toEqual([{ op_id: "1", note_id: id }]);
  });

  it("reports a single failed op without aborting the rest", async () => {
    const good = uuid();
    const res = await post(alice.token, {
      ops: [
        { op_id: "1", op: "PATCH", table: "notes", id: uuid(), data: { content: "ghost" } },
        { op_id: "2", op: "PUT", table: "notes", id: good, data: { content: "fine" } },
      ],
    }).expect(201);
    expect(res.body.applied).toEqual(["2"]);
    expect(res.body.failed).toEqual([{ op_id: "1", kind: "not_found" }]);
  });

  it("soft-deletes a checkin", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "checkins", id, data: { mood: 4 } }],
    }).expect(201);
    const res = await post(alice.token, {
      ops: [{ op_id: "2", op: "DELETE", table: "checkins", id }],
    }).expect(201);
    expect(res.body.applied).toEqual(["2"]);
  });
});
