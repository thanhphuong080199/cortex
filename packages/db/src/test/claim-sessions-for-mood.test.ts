import { beforeEach, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

const HOUR_MS = 60 * 60 * 1000;
const IDLE_MS = 4 * HOUR_MS;

/** Inserts one chat_messages row at an explicit time. The table is server-written, so admin is
 *  the honest client here -- this is exactly how turn.ts writes it.
 *
 *  chat_messages.session_id is a NOT NULL FK to chat_sessions(id) (00006_synthesis_chat.sql), so
 *  every session needs a parent row before its first message. upsert (not insert) because this
 *  helper is called multiple times per session in several tests below, and a second insert with
 *  the same id would collide on the chat_sessions primary key. */
async function seedMessage(
  userId: string, sessionId: string, role: "user" | "assistant", content: string, at: Date,
) {
  const { error: sessionErr } = await admin
    .from("chat_sessions")
    .upsert({ id: sessionId, user_id: userId }, { onConflict: "id" });
  if (sessionErr) throw sessionErr;

  const { error } = await admin.from("chat_messages").insert({
    user_id: userId, session_id: sessionId, role, content, created_at: at.toISOString(),
  });
  if (error) throw error;
}

async function claim(limit: number, exclude: string[] = []) {
  const { data, error } = await admin.rpc("claim_sessions_for_mood", {
    p_limit: limit, p_idle_ms: IDLE_MS, p_exclude_user_ids: exclude,
  });
  expect(error).toBeNull();
  return (data ?? []) as {
    user_id: string; session_id: string; session_start: string;
    session_end: string; message_count: number; prior_attempts: number;
  }[];
}

describe("claim_sessions_for_mood (00038)", () => {
  let userId: string;

  beforeEach(async () => {
    ({ id: userId } = await makeUser("s3-claim@example.com"));
    // Each test builds its own sessions; clear anything a previous one left so the assertions
    // below can be about counts rather than about "contains".
    await admin.from("mood_readings").delete().eq("user_id", userId);
    await admin.from("chat_messages").delete().eq("user_id", userId);
  });

  // BOTH sides of the boundary. A one-sided test passes against an implementation that claims
  // every session in the table, which is the failure that matters here.
  it("does not claim a session idle for less than the window", async () => {
    const sessionId = crypto.randomUUID();
    await seedMessage(userId, sessionId, "user", "chào", new Date(Date.now() - IDLE_MS - HOUR_MS));
    await seedMessage(userId, sessionId, "user", "ừ", new Date(Date.now() - IDLE_MS + 60_000));

    expect(await claim(10)).toHaveLength(0);
  });

  it("claims a session idle for longer than the window", async () => {
    const sessionId = crypto.randomUUID();
    const start = new Date(Date.now() - IDLE_MS - 2 * HOUR_MS);
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "hôm nay mệt", start);
    await seedMessage(userId, sessionId, "assistant", "sao vậy", end);

    const rows = await claim(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: userId, session_id: sessionId, message_count: 2, prior_attempts: 0,
    });
    expect(new Date(rows[0]!.session_start).getTime()).toBe(start.getTime());
    expect(new Date(rows[0]!.session_end).getTime()).toBe(end.getTime());
  });

  it("does not claim a session that already has a resolved reading", async () => {
    const sessionId = crypto.randomUUID();
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "xong rồi", end);
    const { error } = await admin.from("mood_readings").insert({
      user_id: userId, session_id: sessionId, status: "ok", valence: 4,
      message_count: 1, session_start: end.toISOString(), session_end: end.toISOString(),
    });
    expect(error).toBeNull();

    expect(await claim(10)).toHaveLength(0);
  });

  // The guard that stops the job re-reading a session forever for free. 'no_reading' is a
  // success (spec §1); this test is red if the claim ever treats a null valence as unfinished.
  it("does not claim a session whose reading is no_reading", async () => {
    const sessionId = crypto.randomUUID();
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "ok", end);
    await admin.from("mood_readings").insert({
      user_id: userId, session_id: sessionId, status: "no_reading",
      message_count: 1, session_start: end.toISOString(), session_end: end.toISOString(),
    });

    expect(await claim(10)).toHaveLength(0);
  });

  it("re-claims a pending row left stale by a crash, carrying its attempt count", async () => {
    const sessionId = crypto.randomUUID();
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "mệt quá", end);
    await admin.from("mood_readings").insert({
      user_id: userId, session_id: sessionId, status: "pending", attempts: 1,
      message_count: 1, session_start: end.toISOString(), session_end: end.toISOString(),
      // Backdated past the 10-minute staleness threshold. moddatetime only fires on UPDATE, so
      // an explicit updated_at on INSERT survives.
      updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    const rows = await claim(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prior_attempts).toBe(1);
  });

  it("does not re-claim a pending row that is still fresh", async () => {
    const sessionId = crypto.randomUUID();
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "mệt quá", end);
    await admin.from("mood_readings").insert({
      user_id: userId, session_id: sessionId, status: "pending", attempts: 1,
      message_count: 1, session_start: end.toISOString(), session_end: end.toISOString(),
    });

    expect(await claim(10)).toHaveLength(0);
  });

  it("gives up on a pending row that has already failed three times", async () => {
    const sessionId = crypto.randomUUID();
    const end = new Date(Date.now() - IDLE_MS - 60_000);
    await seedMessage(userId, sessionId, "user", "mệt quá", end);
    await admin.from("mood_readings").insert({
      user_id: userId, session_id: sessionId, status: "pending", attempts: 3,
      message_count: 1, session_start: end.toISOString(), session_end: end.toISOString(),
      updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });

    expect(await claim(10)).toHaveLength(0);
  });

  it("returns the oldest sessions first and respects the limit", async () => {
    const ends = [4, 3, 2].map((h) => new Date(Date.now() - IDLE_MS - h * HOUR_MS));
    const ids = ends.map(() => crypto.randomUUID());
    for (let i = 0; i < ids.length; i++) {
      await seedMessage(userId, ids[i]!, "user", `tin ${i}`, ends[i]!);
    }

    const rows = await claim(2);
    // Oldest first: the 4-hours-older session, then the 3-hours-older one. Backfill drains from
    // the far end (spec §3), and the order is what makes that testable at all.
    expect(rows.map((r) => r.session_id)).toEqual([ids[0], ids[1]]);
  });

  it("skips every session belonging to an excluded user", async () => {
    const sessionId = crypto.randomUUID();
    await seedMessage(userId, sessionId, "user", "mệt", new Date(Date.now() - IDLE_MS - HOUR_MS));

    expect(await claim(10, [userId])).toHaveLength(0);
    // And the exclusion is not simply "return nothing": the same session claims fine without it.
    expect(await claim(10, [])).toHaveLength(1);
  });

  it("treats a null exclusion array as no exclusions", async () => {
    const sessionId = crypto.randomUUID();
    await seedMessage(userId, sessionId, "user", "mệt", new Date(Date.now() - IDLE_MS - HOUR_MS));

    const { data, error } = await admin.rpc("claim_sessions_for_mood", {
      p_limit: 10, p_idle_ms: IDLE_MS, p_exclude_user_ids: null,
    });
    expect(error).toBeNull();
    // `x <> all (null)` is NULL, not true, so a bare `<> all` would filter out every row and the
    // job would silently claim nothing -- 00023 records the same trap on the enrichment claim.
    expect(data).toHaveLength(1);
  });
});
