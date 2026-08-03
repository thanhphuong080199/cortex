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
const base = "2026-08-02T10:00:00.000Z";

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

  it("attaches base_updated_at to a notes PATCH", () => {
    const op = crudEntryToSyncOp(
      { clientId: 5, op: "PATCH", table: "notes", id, opData: { content: "x" } } as never,
      base,
    );
    expect(op.base_updated_at).toBe(base);
  });

  it("never attaches a base to a non-notes table", () => {
    const op = crudEntryToSyncOp(
      { clientId: 6, op: "PATCH", table: "checkins", id, opData: { mood: 2 } } as never,
      base,
    );
    expect(op.base_updated_at).toBeUndefined();
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
    expect(op.base_updated_at).toBeUndefined();
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

  function database(crud: unknown[], haveMore = false) {
    complete = vi.fn(async () => {});
    execute = vi.fn(async () => {});
    getOptional = vi.fn(async () => null);
    getCrudBatch = vi.fn(async () => (crud.length ? { crud, haveMore, complete } : null));
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
    getOptional.mockResolvedValueOnce({ base_updated_at: "2026-08-02T10:00:00.000Z" });

    await new ApiConnector().uploadData(db);

    const body = JSON.parse((fetchMock.mock.calls[0] as never[])[1]!["body"] as string);
    expect(body.ops[0].base_updated_at).toBe("2026-08-02T10:00:00.000Z");
    expect(complete).toHaveBeenCalledOnce();
    // A base that outlives the op it was checked against gets applied to the user's NEXT edit
    // and manufactures a conflict copy for a conflict that never happened.
    expect(execute).toHaveBeenCalledWith("DELETE FROM note_edit_base WHERE note_id = ?", [noteId]);
  });

  it("sends no base when none was recorded", async () => {
    const db = database([patch]);

    await new ApiConnector().uploadData(db);

    const body = JSON.parse((fetchMock.mock.calls[0] as never[])[1]!["body"] as string);
    expect(body.ops[0].base_updated_at).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("discards the batch on a 4xx, because retrying it forever would wedge the queue", async () => {
    const db = database([patch]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });

    await expect(new ApiConnector().uploadData(db)).rejects.toThrow("rejected (400)");
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
