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
    // Web edits it, moving the server body away from the one the phone started from.
    await post(alice.token, {
      ops: [{ op_id: "2", op: "PATCH", table: "notes", id, data: { content: "web edit" } }],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{
        op_id: "3", op: "PATCH", table: "notes", id, data: { content: "phone edit" },
        base_content: "original",
      }],
    }).expect(201);
    expect(res.body.applied).toEqual(["3"]);
    expect(res.body.conflict_copies).toHaveLength(1);
    expect(res.body.conflict_copies[0].op_id).toBe("3");
    // The link write is not sabotaged on the normal path -- it must not appear here.
    expect(res.body.link_failures).toEqual([]);
  });

  /**
   * PowerSync resends a batch whenever the response is lost, so the connector can replay the
   * exact same op -- same op_id, same base_content -- against a server row unchanged since the
   * first attempt. Before the conflict copy's id was derived from op_id (finding #4), each
   * replay minted a fresh random id and the inbox grew a duplicate note per retry.
   */
  it("a resent conflict PATCH does not duplicate the conflict copy", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "notes", id, data: { content: "original" } }],
    }).expect(201);
    await post(alice.token, {
      ops: [{ op_id: "2", op: "PATCH", table: "notes", id, data: { content: "web edit" } }],
    }).expect(201);

    const conflictOp = {
      op_id: "3", op: "PATCH", table: "notes", id, data: { content: "phone edit" },
      base_content: "original",
    };

    const first = await post(alice.token, { ops: [conflictOp] }).expect(201);
    expect(first.body.conflict_copies).toHaveLength(1);

    const resend = await post(alice.token, { ops: [conflictOp] }).expect(201);
    expect(resend.body.conflict_copies).toHaveLength(1);
    expect(resend.body.conflict_copies[0].note_id).toBe(first.body.conflict_copies[0].note_id);

    // Scoped to THIS note's links, not content -- other tests in this file also use "phone
    // edit" against the same shared `alice` fixture.
    const { data } = await createUserClient(alice.token).from("links")
      .select("from_note_id").eq("to_note_id", id).eq("kind", "conflict_copy");
    expect(data).toHaveLength(1);
  });

  /**
   * The case the device actually hit, and the one nothing covered: an ordinary edit, nobody
   * else touching the note, and a conflict copy every single time.
   *
   * `base_updated_at` could not have worked. `updated_at` is server-owned -- ignored on insert
   * (`default now()`) and overwritten by `notes_set_updated_at` on update -- so a note created
   * on a device holds a device clock the server has never issued, and even a downloaded one is
   * written by PowerSync as `...916374Z` where PostgREST returns `...916374+00:00`. The server
   * compared those strings, found the row "moved" every time, and copied every edit.
   *
   * Every existing test fed `note.updated_at` straight back from the response that produced it,
   * so the matching branch was only ever exercised with a byte-identical PostgREST string.
   */
  it("does NOT copy an edit that nobody raced", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "notes", id, data: { content: "original" } }],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{
        op_id: "2", op: "PATCH", table: "notes", id, data: { content: "phone edit" },
        base_content: "original",
      }],
    }).expect(201);

    expect(res.body.applied).toEqual(["2"]);
    expect(res.body.conflict_copies).toEqual([]);
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
  /**
   * The rule mobile's undo has to respect, and nothing pinned it before.
   *
   * PowerSync turns a local `UPDATE checkins SET deleted_at = ...` into a PATCH, which lands
   * here. The op is reported in `failed` while the response is still 200, so the connector
   * completes the batch and the undo is discarded -- the check-in stays on the server forever
   * while the phone shows it gone. Mobile therefore issues a local DELETE instead.
   */
  it("rejects a PATCH on checkins rather than applying it", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "checkins", id, data: { mood: 4 } }],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{ op_id: "2", op: "PATCH", table: "checkins", id,
              data: { deleted_at: "2026-08-03T10:00:00.000Z" } }],
    }).expect(201);

    expect(res.body.applied).toEqual([]);
    expect(res.body.failed).toEqual([{
      op_id: "2", kind: "validation", message: "checkins are insert-or-delete only",
    }]);

    // And the row is untouched -- the PATCH did not half-apply on its way to being reported.
    const client = createUserClient(alice.token);
    const { data } = await client.from("checkins").select("deleted_at").eq("id", id).single();
    expect(data!.deleted_at).toBeNull();
  });

  /**
   * The notes half of the same rule, which had no coverage at all -- and unlike checkins, the
   * notes PATCH branch did not reject `deleted_at`, it silently ignored it.
   *
   * Mobile trashes with `UPDATE notes SET deleted_at = ...` (TRASH_NOTE_SQL), so trash reaches
   * the server as a PATCH, never as a DELETE op. The patch was built from content/title/
   * lifecycle/domain only, so `deleted_at` was dropped: the server row stayed live, replication
   * delivered it back, and the note the user trashed reappeared on the phone with nothing
   * reported anywhere.
   */
  it("soft-deletes on a notes PATCH carrying deleted_at, which is how mobile trashes", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "notes", id, data: { content: "to be trashed" } }],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{ op_id: "2", op: "PATCH", table: "notes", id,
              data: { deleted_at: "2026-08-03T10:00:00.000Z",
                      updated_at: "2026-08-03T10:00:00.000Z" } }],
    }).expect(201);

    expect(res.body.applied).toEqual(["2"]);
    const client = createUserClient(alice.token);
    const { data } = await client.from("notes").select("deleted_at, content").eq("id", id).single();
    // The assertion that matters: the SERVER row is tombstoned. Asserting only `applied` would
    // have passed against the broken version, which reported success while changing nothing.
    expect(data!.deleted_at).not.toBeNull();
    expect(data!.content).toBe("to be trashed");
  });

  it("restores on a notes PATCH carrying deleted_at: null", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "notes", id, data: { content: "there and back" } }],
    }).expect(201);
    await post(alice.token, {
      ops: [{ op_id: "2", op: "PATCH", table: "notes", id,
              data: { deleted_at: "2026-08-03T10:00:00.000Z" } }],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{ op_id: "3", op: "PATCH", table: "notes", id, data: { deleted_at: null } }],
    }).expect(201);

    expect(res.body.applied).toEqual(["3"]);
    const client = createUserClient(alice.token);
    const { data } = await client.from("notes").select("deleted_at").eq("id", id).single();
    // `null` has to mean restore rather than "field absent" -- treating the two alike leaves a
    // note the user pulled out of the trash still deleted on every other device.
    expect(data!.deleted_at).toBeNull();
  });

  it("applies a PATCH that carries deleted_at alongside a body edit", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "notes", id, data: { content: "before" } }],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{ op_id: "2", op: "PATCH", table: "notes", id,
              data: { deleted_at: "2026-08-03T10:00:00.000Z", content: "after" } }],
    }).expect(201);

    // Neither half may swallow the other: the early return that skips an empty patch must not
    // skip a real one, and the content update must not undo the soft delete.
    expect(res.body.applied).toEqual(["2"]);
    const client = createUserClient(alice.token);
    const { data } = await client.from("notes").select("deleted_at, content").eq("id", id).single();
    expect(data!.deleted_at).not.toBeNull();
    expect(data!.content).toBe("after");
  });

  /**
   * Round 2, finding #3. The router never forwarded `created_at`, so both notes and checkins
   * default it to `now()` -- a mood logged offline on a plane becomes a row timestamped at
   * reconnect time, silently wrong on the timeline and every chart over it. Mobile's local
   * schema already carries the real capture time (`NOW_ISO` in capture.ts/checkins.ts), so
   * PowerSync includes it on every PUT; the fix is to stop dropping it.
   *
   * Compared via `new Date(...).toISOString()`, not string equality: PostgREST returns
   * timestamptz as `...+00:00` while the captured value here is `...Z` -- same instant,
   * different serialisation, and a `!==` on the raw strings would fail for the wrong reason.
   */
  it("honors an offline note's captured created_at instead of the reconnect time", async () => {
    const id = uuid();
    const capturedAt = "2020-01-01T00:00:00.000Z";
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "notes", id,
              data: { content: "captured offline", created_at: capturedAt } }],
    }).expect(201);

    const { data } = await createUserClient(alice.token).from("notes")
      .select("created_at").eq("id", id).single();
    expect(new Date(data!.created_at).toISOString()).toBe(capturedAt);
  });

  it("honors an offline checkin's captured created_at instead of the reconnect time", async () => {
    const id = uuid();
    const capturedAt = "2020-01-01T00:00:00.000Z";
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "checkins", id,
              data: { mood: 3, created_at: capturedAt } }],
    }).expect(201);

    const { data } = await createUserClient(alice.token).from("checkins")
      .select("created_at").eq("id", id).single();
    expect(new Date(data!.created_at).toISOString()).toBe(capturedAt);
  });

  it("accepts the DELETE that mobile's undo actually sends", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "checkins", id, data: { mood: 2 } }],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{ op_id: "2", op: "DELETE", table: "checkins", id }],
    }).expect(201);

    expect(res.body.applied).toEqual(["2"]);
    const client = createUserClient(alice.token);
    const { data } = await client.from("checkins").select("deleted_at").eq("id", id).single();
    // Soft on the server even though the device deleted the row outright: every synced table
    // needs its tombstone.
    expect(data!.deleted_at).not.toBeNull();
  });

  /**
   * `failed` is the ONLY surface that reveals a genuinely lost op -- the batch completes
   * either way, so an op reported there has left the device's queue for good. Filling it with
   * harmless replays is what makes a real loss easy to miss.
   *
   * PowerSync resends a batch whenever the response is lost, so a second DELETE for a row it
   * already tombstoned is ordinary traffic, not a client bug. The row is in exactly the state
   * the op asked for.
   *
   * checkins because that is the table mobile's undo really deletes; the notes DELETE branch
   * routes through the same softDelete and the same `is deleted_at null` guard.
   *
   * The FIRST delete succeeds with or without this fix; only the second one discriminates.
   */
  it("reports an already-tombstoned DELETE as applied, not failed", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "checkins", id, data: { mood: 2 } }],
    }).expect(201);

    const first = await post(alice.token, {
      ops: [{ op_id: "2", op: "DELETE", table: "checkins", id }],
    }).expect(201);
    expect(first.body.applied).toEqual(["2"]);

    // The replay. Same op, same row, response lost the first time round.
    const second = await post(alice.token, {
      ops: [{ op_id: "3", op: "DELETE", table: "checkins", id }],
    }).expect(201);
    expect(second.body.failed).toEqual([]);
    expect(second.body.applied).toEqual(["3"]);
  });

  /**
   * The checkins case above exercises applySyncOps' own DELETE branch. tags has no service of
   * its own -- it goes through applyGenericOp instead, a separate code path that reaches the
   * same `.eq(...).is("deleted_at", null).select("id").single()` guard and therefore the same
   * not_found on a replay. Same fix, different branch: this covers the other one, so the
   * generic writer's DELETE path (tags, note_tags, links, media_items) is not left untested.
   */
  it("reports an already-tombstoned tags DELETE (the generic writer path) as applied, not failed", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "tags", id, data: { name: `sync-tag-${id}` } }],
    }).expect(201);

    const first = await post(alice.token, {
      ops: [{ op_id: "2", op: "DELETE", table: "tags", id }],
    }).expect(201);
    expect(first.body.applied).toEqual(["2"]);

    // The replay. Same op, same row, response lost the first time round.
    const second = await post(alice.token, {
      ops: [{ op_id: "3", op: "DELETE", table: "tags", id }],
    }).expect(201);
    expect(second.body.failed).toEqual([]);
    expect(second.body.applied).toEqual(["3"]);
  });

  /**
   * The device-shaped write the schema change exists to make possible. `source` and `status`
   * are present here because the local schema now declares them; before it did, a real device
   * could not have produced this row at all.
   *
   * This one does NOT discriminate on its own -- it sends `source` explicitly, so it passes
   * either way. It is the contract half; `declares every column note_tags requires` in
   * packages/sync/src/schema.test.ts is the half that fails without the fix.
   */
  it("accepts a note_tags PUT shaped the way the device schema declares it", async () => {
    const noteId = uuid();
    const tagId = uuid();
    await post(alice.token, {
      ops: [
        { op_id: "1", op: "PUT", table: "notes", id: noteId, data: { content: "tagged" } },
        { op_id: "2", op: "PUT", table: "tags", id: tagId, data: { name: `nt-${tagId}` } },
      ],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{
        op_id: "3", op: "PUT", table: "note_tags", id: uuid(),
        data: {
          note_id: noteId, tag_id: tagId,
          // `source` has a check constraint of ('user','ai') and NO default; `status` defaults
          // to 'accepted' but the device sends it too, because the column is declared.
          source: "user", status: "accepted", confidence: null,
        },
      }],
    }).expect(201);

    expect(res.body.failed).toEqual([]);
    expect(res.body.applied).toEqual(["3"]);
  });
});
