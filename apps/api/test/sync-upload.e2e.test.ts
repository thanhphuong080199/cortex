import { INestApplication } from "@nestjs/common";
import { createUserClient } from "@cortex/core";
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

  it("reports media_unresolved without failing the op, and a resend does not wedge (deadlock regression guard)", async () => {
    const title = `Solaris ${uuid()}`;
    // Establish the item with a fixed year -- the second log below contradicts it.
    await post(alice.token, {
      ops: [{
        op_id: "1", op: "PUT", table: "notes", id: uuid(),
        data: {
          content: "first watch", domain: "media",
          domain_meta: { status: "finished", pending_item: { kind: "movie", title, year: 1972 } },
        },
      }],
    }).expect(201);

    const secondNoteId = uuid();
    const conflictingOp = {
      op_id: "2", op: "PUT", table: "notes", id: secondNoteId,
      data: {
        content: "rewatch", domain: "media",
        domain_meta: { status: "finished", pending_item: { kind: "movie", title, year: 2002 } },
      },
    };

    const res = await post(alice.token, { ops: [conflictingOp] }).expect(201);
    // The note write itself succeeded -- the op is applied, never failed, even though its
    // media resolution could not complete.
    expect(res.body.applied).toEqual(["2"]);
    expect(res.body.failed).toEqual([]);
    expect(res.body.media_unresolved).toEqual([{ op_id: "2", note_id: secondNoteId, kind: "conflict" }]);

    // PowerSync resends the identical op whenever a response is lost. Before createWithId
    // was made idempotent, this resend hit the 23505 the first PUT created and threw
    // before ever reaching media resolution -- the deadlock the reviewer flagged. It must
    // not throw, and it must not silently disappear from `applied` either.
    const resend = await post(alice.token, { ops: [conflictingOp] }).expect(201);
    expect(resend.body.applied).toEqual(["2"]);
    expect(resend.body.failed).toEqual([]);
    expect(resend.body.media_unresolved).toEqual([{ op_id: "2", note_id: secondNoteId, kind: "conflict" }]);
  });

  it("a resent PUT does not create a duplicate note (idempotent createWithId)", async () => {
    const id = uuid();
    const op = { op_id: "1", op: "PUT", table: "notes", id, data: { content: "idempotent" } };

    const first = await post(alice.token, { ops: [op] }).expect(201);
    expect(first.body.applied).toEqual(["1"]);

    const second = await post(alice.token, { ops: [op] }).expect(201);
    expect(second.body.applied).toEqual(["1"]);

    const { data } = await createUserClient(alice.token).from("notes").select("id").eq("id", id);
    expect(data).toHaveLength(1);
  });

  it("routes tags through the generic writer, and a PATCH on a missing row fails not_found rather than silently applying", async () => {
    const id = uuid();
    const res = await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "tags", id, data: { name: `sync-tag-${id}` } }],
    }).expect(201);
    expect(res.body.applied).toEqual(["1"]);

    // Regression guard for Finding 2: without a `.select().single()` on the generic
    // writer's PATCH branch, a PATCH against a row that does not exist matches zero rows,
    // PostgREST reports no error, and the op would land in `applied` while nothing changed.
    const missing = uuid();
    const res2 = await post(alice.token, {
      ops: [{ op_id: "2", op: "PATCH", table: "tags", id: missing, data: { name: "ghost" } }],
    }).expect(201);
    expect(res2.body.applied).toEqual([]);
    expect(res2.body.failed).toEqual([{ op_id: "2", kind: "not_found" }]);
  });
  /**
   * Everything above sends `domain_meta` as an OBJECT, which is the API contract but not what
   * a phone sends. PowerSync's local schema has no jsonb type, so `domain_meta` is a TEXT
   * column and the device serialises it -- every real mobile op carries a string. That gap is
   * why the old `as Record<string, unknown>` cast survived: no test ever exercised the wire
   * format the mobile write path actually produces.
   */
  describe("domain_meta as the device really sends it (a JSON string)", () => {
    it("stores {} as an object, not as the JSON string \"{}\"", async () => {
      const id = uuid();
      const res = await post(alice.token, {
        ops: [{ op_id: "1", op: "PUT", table: "notes", id,
                data: { content: "captured offline", domain_meta: "{}" } }],
      }).expect(201);
      expect(res.body.applied).toEqual(["1"]);

      const client = createUserClient(alice.token);
      const { data } = await client.from("notes").select("domain_meta").eq("id", id).single();
      // A string here is silent corruption: the column accepts any JSON, so "{}" stores
      // happily as a jsonb STRING and every later reader has to cope with both shapes.
      expect(data!.domain_meta).toEqual({});
      expect(typeof data!.domain_meta).toBe("object");
    });

    it("applies a note that has BOTH a domain and a serialised meta", async () => {
      const id = uuid();
      const res = await post(alice.token, {
        ops: [{ op_id: "1", op: "PUT", table: "notes", id,
                data: { content: "read it", domain: "learning",
                        domain_meta: JSON.stringify({ topic: "type theory" }) } }],
      }).expect(201);

      // The worst case before the fix. validateDomainMeta parsed a string against an object
      // schema, threw `validation`, and the op landed in `failed` while the response stayed
      // 200 -- so the connector completed the batch and the note was dropped for good.
      expect(res.body.failed).toEqual([]);
      expect(res.body.applied).toEqual(["1"]);
    });

    it("resolves an offline media log whose pending_item arrived serialised", async () => {
      const id = uuid();
      const res = await post(alice.token, {
        ops: [{ op_id: "1", op: "PUT", table: "notes", id,
                data: { content: "watched", title: "Solaris", domain: "media",
                        domain_meta: JSON.stringify({
                          status: "finished",
                          pending_item: { kind: "movie", title: "Solaris", year: 1972 },
                        }) } }],
      }).expect(201);

      // `domainMeta.pending_item` on a string is undefined, so this whole branch was skipped
      // and spec 5.3's offline identity resolution silently never ran.
      expect(res.body.applied).toEqual(["1"]);
      expect(res.body.resolved_media).toEqual([{ op_id: "1", note_id: id }]);
    });

    it("fails the op rather than discarding metadata it cannot parse", async () => {
      const res = await post(alice.token, {
        ops: [{ op_id: "1", op: "PUT", table: "notes", id: uuid(),
                data: { content: "x", domain_meta: "{not json" } }],
      }).expect(201);

      // Defaulting to {} would save the note and drop the metadata with nothing to notice by.
      expect(res.body.applied).toEqual([]);
      expect(res.body.failed).toEqual([{
        op_id: "1", kind: "validation", message: "domain_meta is not valid JSON",
      }]);
    });

    it("rejects JSON that parses but is not an object", async () => {
      const res = await post(alice.token, {
        ops: [{ op_id: "1", op: "PUT", table: "notes", id: uuid(),
                data: { content: "x", domain_meta: "[]" } },
               { op_id: "2", op: "PUT", table: "notes", id: uuid(),
                 data: { content: "y", domain_meta: "null" } }],
      }).expect(201);

      // `typeof [] === "object"`, so an array slips past every check except Array.isArray --
      // and `JSON.parse("null")` is a valid parse of a value that has no properties at all.
      expect(res.body.applied).toEqual([]);
      expect(res.body.failed.map((f: { kind: string }) => f.kind)).toEqual([
        "validation", "validation",
      ]);
    });

    it("still accepts an object, so the API's own clients are unaffected", async () => {
      const id = uuid();
      const res = await post(alice.token, {
        ops: [{ op_id: "1", op: "PUT", table: "notes", id,
                data: { content: "from the web", domain: "health",
                        domain_meta: { intensity: 3 } } }],
      }).expect(201);
      expect(res.body.applied).toEqual(["1"]);
    });
  });
});
