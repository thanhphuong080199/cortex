import { beforeEach, describe, expect, it, vi } from "vitest";

// `connector.ts` imports `./supabase.js`, which runs `react-native-url-polyfill/auto` and
// `createClient` at module load. Under `environment: "node"` that reaches React Native source
// and dies with a Rollup Flow parse error rather than anything that names the problem.
let session: { access_token: string } | null = { access_token: "jwt" };
const getSession = vi.fn(async () => ({ data: { session } }));
vi.mock("./supabase.js", () => ({ supabase: { auth: { getSession } } }));

const { ApiConnector, crudEntryToSyncOp } = await import("./connector.js");
const { SYNC_UPLOAD_MAX_OPS } = await import("@cortex/shared");

const id = "11111111-1111-4111-8111-111111111111";
// A BODY, not a timestamp. `updated_at` is server-owned, so the value this used to carry was
// one the server had never issued, and every edit came back as a conflict copy.
const base = "the body this edit started from";

describe("crudEntryToSyncOp", () => {
  it("maps a PUT with its row data", () => {
    const op = crudEntryToSyncOp({
      clientId: 3,
      op: "PUT",
      table: "notes",
      id,
      opData: { content: "hi" },
    } as never);
    expect(op).toEqual({ op_id: "3", op: "PUT", table: "notes", id, data: { content: "hi" } });
  });

  it("omits data on a DELETE", () => {
    const op = crudEntryToSyncOp({ clientId: 4, op: "DELETE", table: "notes", id } as never);
    expect(op.data).toBeUndefined();
    // `undefined` and "absent" differ once this goes through JSON.stringify, and the server's
    // zod schema accepts both — so pin the key's absence, not just its value.
    expect(Object.hasOwn(op, "data")).toBe(false);
  });

  it("attaches base_content to a notes PATCH", () => {
    const op = crudEntryToSyncOp(
      { clientId: 5, op: "PATCH", table: "notes", id, opData: { content: "x" } } as never,
      base,
    );
    expect(op.base_content).toBe(base);
  });

  it("attaches an EMPTY base body rather than dropping it", () => {
    // A note edited down to nothing has "" as its base. Guarded on truthiness, the key would be
    // absent, the server would read "no base at all", and the edit would apply unconditionally --
    // last-write-wins on exactly the note whose previous content the user destroyed.
    const op = crudEntryToSyncOp(
      { clientId: 8, op: "PATCH", table: "notes", id, opData: { content: "x" } } as never,
      "",
    );
    expect(op.base_content).toBe("");
    expect(Object.hasOwn(op, "base_content")).toBe(true);
  });

  it("never attaches a base to a non-notes table", () => {
    const op = crudEntryToSyncOp(
      { clientId: 6, op: "PATCH", table: "checkins", id, opData: { mood: 2 } } as never,
      base,
    );
    expect(op.base_content).toBeUndefined();
  });

  /**
   * The plan's four cases leave the `op === "PATCH"` half of the guard unexercised: drop it and
   * all four still pass, because the only case carrying a base is already a PATCH. A base on a
   * PUT is not inert — the server reads it as "this full-row overwrite was based on that
   * revision" and manufactures a conflict copy for a create (spec §6.2).
   */
  it("never attaches a base to a notes PUT", () => {
    const op = crudEntryToSyncOp(
      { clientId: 7, op: "PUT", table: "notes", id, opData: { content: "x" } } as never,
      base,
    );
    expect(op.base_content).toBeUndefined();
  });

  /**
   * PowerSync leaves `opData` undefined on an entry with no changed columns. `data` is
   * `nullish()` server-side, so `undefined` would validate and then apply nothing — a silently
   * dropped write rather than a rejected one.
   */
  it("sends an empty object rather than nothing when a write carries no opData", () => {
    const op = crudEntryToSyncOp({ clientId: 8, op: "PATCH", table: "tags", id } as never);
    expect(op.data).toEqual({});
  });
});

/**
 * `uploadData` is where every consequence lives -- the batch limit, the conflict-copy base, and
 * which failures discard the user's offline writes -- and the plan gave it no test at all.
 */
describe("ApiConnector.uploadData", () => {
  const noteId = "22222222-2222-4222-8222-222222222222";

  let complete: ReturnType<typeof vi.fn>;
  let execute: ReturnType<typeof vi.fn>;
  let getOptional: ReturnType<typeof vi.fn>;
  let getCrudBatch: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  /**
   * `remainingAfterUpload` models what a peek at the queue finds once `complete()` has run --
   * default empty, i.e. nothing else was queued for any note in `crud`. Pass entries here to
   * simulate a keystroke that queued a fresh CRUD entry for the same note between the read and
   * the delete.
   */
  function database(
    crud: unknown[],
    { haveMore = false, remainingAfterUpload = [] as unknown[] } = {},
  ) {
    let completed = false;
    complete = vi.fn(async () => {
      completed = true;
    });
    execute = vi.fn(async () => {});
    getOptional = vi.fn(async () => null);
    getCrudBatch = vi.fn(async () => {
      const current = completed ? remainingAfterUpload : crud;
      return current.length ? { crud: current, haveMore, complete } : null;
    });
    return { getCrudBatch, getOptional, execute } as never;
  }

  const patch = { clientId: 1, op: "PATCH", table: "notes", id: noteId, opData: { content: "x" } };

  beforeEach(() => {
    session = { access_token: "jwt" };
    getSession.mockClear();
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ failed: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
  });

  /**
   * The load-bearing one. `getCrudBatch()` unbounded can return more ops than `syncUploadInput`
   * accepts; the server answers 400, and the 4xx branch below treats 400 as permanent and calls
   * `complete()` -- discarding writes the user made offline. `haveMore` is how the remainder
   * comes back, so the cap costs a round trip and never data.
   */
  it("never asks for more ops than the server will accept", async () => {
    const db = database([patch]);
    await new ApiConnector().uploadData(db);

    expect(getCrudBatch).toHaveBeenCalledWith(SYNC_UPLOAD_MAX_OPS);
    expect(SYNC_UPLOAD_MAX_OPS).toBeLessThanOrEqual(500);
  });

  it("does nothing at all when there is no batch", async () => {
    const db = database([]);
    await new ApiConnector().uploadData(db);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("attaches the recorded edit base to a notes PATCH and spends it on success", async () => {
    const db = database([patch]);
    getOptional.mockResolvedValueOnce({ base_content: "the body this edit started from" });

    await new ApiConnector().uploadData(db);

    const body = JSON.parse((fetchMock.mock.calls[0] as never[])[1]!["body"] as string);
    expect(body.ops[0].base_content).toBe("the body this edit started from");
    expect(complete).toHaveBeenCalledOnce();
    // A base that outlives the op it was checked against gets applied to the user's NEXT edit
    // and manufactures a conflict copy for a conflict that never happened.
    expect(execute).toHaveBeenCalledWith("DELETE FROM note_edit_base WHERE note_id = ?", [noteId]);
  });

  /**
   * Finding #6 (handoff, round 2): a keystroke landing between the base read and the delete
   * queues a fresh CRUD entry for the same note. If the delete runs anyway, that next upload
   * carries no base and silently last-write-wins over a concurrent web edit -- the exact
   * conflict-copy machinery in `updateWithConflictCopy` exists to prevent.
   */
  it("keeps the base when another edit for the same note is still queued", async () => {
    const db = database([patch], {
      remainingAfterUpload: [{ clientId: 2, op: "PATCH", table: "notes", id: noteId, opData: { content: "y" } }],
    });
    getOptional.mockResolvedValueOnce({ base_content: "the body this edit started from" });

    await new ApiConnector().uploadData(db);

    expect(complete).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("sends no base when none was recorded", async () => {
    const db = database([patch]);

    await new ApiConnector().uploadData(db);

    const body = JSON.parse((fetchMock.mock.calls[0] as never[])[1]!["body"] as string);
    expect(body.ops[0].base_content).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("sends no base for a row left behind by the base_updated_at build", async () => {
    // note_edit_base is local-only, so an upgrade does not migrate it: rows written before the
    // column was renamed read back with base_content null. Null is not a body anyone edited --
    // forwarding it would claim the user started from an empty note and conflict-copy every
    // edit, which is the bug this whole change exists to remove.
    const db = database([patch]);
    getOptional.mockResolvedValueOnce({ base_content: null });

    await new ApiConnector().uploadData(db);

    const body = JSON.parse((fetchMock.mock.calls[0] as never[])[1]!["body"] as string);
    expect(Object.hasOwn(body.ops[0], "base_content")).toBe(false);
  });

  it("discards the batch on a 400, because retrying it forever would wedge the queue", async () => {
    const db = database([patch]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });

    await expect(new ApiConnector().uploadData(db)).rejects.toThrow("malformed (400)");
    expect(complete).toHaveBeenCalledOnce();
  });

  /**
   * The opposite direction, and the one that loses data if it is wrong: a 500 or a dropped
   * connection is transient, so the batch must stay unacknowledged for PowerSync to retry.
   * Completing here would throw away writes the server never accepted.
   */
  it("keeps the batch on a 5xx so PowerSync retries it", async () => {
    const db = database([patch]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(new ApiConnector().uploadData(db)).rejects.toThrow("failed (503)");
    expect(complete).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps the batch when it is not signed in", async () => {
    const db = database([patch]);
    session = null;

    await expect(new ApiConnector().uploadData(db)).rejects.toThrow("not signed in");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns null credentials rather than a token when signed out", async () => {
    session = null;
    expect(await new ApiConnector().fetchCredentials()).toBeNull();
  });
  /**
   * A 200 is not "everything applied". The router applies ops independently and reports the
   * casualties in `failed`, and the batch completes regardless -- so a rejected op leaves the
   * queue while its note stays in local SQLite and never reaches the server.
   */
  it("surfaces ops the server rejected inside a 200", async () => {
    const db = database([patch]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ failed: [{ op_id: "1", kind: "validation" }] }),
    });

    await new ApiConnector().uploadData(db);

    expect(logged).toHaveBeenCalledWith(
      "sync upload: ops rejected by the server",
      [{ op_id: "1", kind: "validation" }],
    );
    logged.mockRestore();
  });

  /**
   * `complete()` DISCARDS the user's offline writes, so which statuses reach it is the highest
   * -consequence decision in this file. The whole 4xx range used to, which meant a batch too
   * large for the server's body limit, an access token that expired in flight, or a rate limit
   * each destroyed the queue -- and because PowerSync calls uploadData again straight away, one
   * global cause walked the entire backlog to zero in seconds.
   */
  describe("only a malformed batch may be discarded", () => {
    for (const status of [401, 403, 408, 413, 429]) {
      it(`retries rather than discarding on ${status}`, async () => {
        const db = database([patch]);
        fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => ({}) });

        await expect(new ApiConnector().uploadData(db)).rejects.toThrow(String(status));
        // Unacknowledged is what makes PowerSync retry with backoff. Anything else here is
        // the user's offline work, deleted.
        expect(complete).not.toHaveBeenCalled();
      });
    }

    for (const status of [400, 422]) {
      it(`discards on ${status}, because the same bytes will never be accepted`, async () => {
        const db = database([patch]);
        fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => ({}) });

        await expect(new ApiConnector().uploadData(db)).rejects.toThrow(String(status));
        // The other half of the trade: a genuinely malformed batch must leave the queue, or
        // every write behind it is stuck forever.
        expect(complete).toHaveBeenCalledOnce();
      });
    }

    it("leaves the batch alone on a 5xx", async () => {
      const db = database([patch]);
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

      await expect(new ApiConnector().uploadData(db)).rejects.toThrow("503");
      expect(complete).not.toHaveBeenCalled();
    });
  });

  it("still completes a batch whose response body cannot be read", async () => {
    const db = database([patch]);
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => { throw new Error("not json"); },
    });

    // An unreadable body is not a reason to strand the queue -- the server accepted the batch.
    await expect(new ApiConnector().uploadData(db)).resolves.toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
  });
});
