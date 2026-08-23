import { describe, expect, it } from "vitest";
import { admin } from "./clients.js";
import { makeUser } from "./clients.js";

const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"];

describe("mood_readings (00036)", () => {
  // The load-bearing assertion of the whole stage. After 00025 §4 a new table is born with no
  // client grants on either stack, so this passes the day it is written -- its value is that it
  // turns red the day someone adds a grant block or a policy to a table the S3 spec §6 says
  // nothing may read.
  it.each(PRIVILEGES)("authenticated holds no %s on mood_readings", async (privilege) => {
    const { data, error } = await admin.rpc("_test_has_table_privilege", {
      p_role: "authenticated", p_table: "mood_readings", p_privilege: privilege,
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it.each(PRIVILEGES)("anon holds no %s on mood_readings", async (privilege) => {
    const { data, error } = await admin.rpc("_test_has_table_privilege", {
      p_role: "anon", p_table: "mood_readings", p_privilege: privilege,
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  // Positive control, in the shape default-grants.test.ts already uses: without it, a broken
  // privilege lookup that always returned false would make every assertion above false-pass.
  it("service_role does hold SELECT (positive control)", async () => {
    const { data, error } = await admin.rpc("_test_has_table_privilege", {
      p_role: "service_role", p_table: "mood_readings", p_privilege: "SELECT",
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  // A grant test alone cannot see a policy: a policy without a grant is inert, so adding one
  // would not turn the assertions above red. This is the half that does.
  it("has RLS enabled and exactly zero policies", async () => {
    const { data, error } = await admin.rpc("_test_policy_count", { p_table: "mood_readings" });
    expect(error).toBeNull();
    expect(data).toBe(0);
  });

  it("rejects a second reading for the same session", async () => {
    const { id: userId } = await makeUser("s3-unique@example.com");
    const sessionId = crypto.randomUUID();
    const row = {
      user_id: userId, session_id: sessionId, message_count: 4,
      session_start: new Date().toISOString(), session_end: new Date().toISOString(),
    };
    const first = await admin.from("mood_readings").insert(row);
    expect(first.error).toBeNull();
    const second = await admin.from("mood_readings").insert(row);
    // 23505 unique_violation. This constraint IS the idempotency mechanism (spec §1), so a
    // migration that dropped it would leave the job re-reading sessions forever with nothing
    // else to stop it.
    expect(second.error?.code).toBe("23505");
  });

  it.each([0, 6])("rejects valence %i", async (valence) => {
    const { id: userId } = await makeUser("s3-valence@example.com");
    const { error } = await admin.from("mood_readings").insert({
      user_id: userId, session_id: crypto.randomUUID(), message_count: 1,
      session_start: new Date().toISOString(), session_end: new Date().toISOString(),
      valence,
    });
    expect(error?.code).toBe("23514"); // check_violation
  });

  it("rejects an unknown status", async () => {
    const { id: userId } = await makeUser("s3-status@example.com");
    const { error } = await admin.from("mood_readings").insert({
      user_id: userId, session_id: crypto.randomUUID(), message_count: 1,
      session_start: new Date().toISOString(), session_end: new Date().toISOString(),
      status: "archived",
    });
    expect(error?.code).toBe("23514");
  });

  it("defaults status to pending and attempts to zero", async () => {
    const { id: userId } = await makeUser("s3-defaults@example.com");
    const { data, error } = await admin.from("mood_readings").insert({
      user_id: userId, session_id: crypto.randomUUID(), message_count: 1,
      session_start: new Date().toISOString(), session_end: new Date().toISOString(),
    }).select("status, attempts, topics").single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "pending", attempts: 0, topics: [] });
  });

  // Round-trips the exact object shapes mood.service.ts writes -- first the claim's pending
  // upsert, then the 'ok' resolve -- against the real schema. mood-sweep.test.ts only exercises
  // this against a scripted fake db, and the other tests in this file never send evidence,
  // summary, confidence, or a realistic topics array, so a renamed column or a type mismatch
  // (e.g. evidence in the wrong shape, confidence out of 0..1, topics not a plain string array)
  // would pass every existing test while breaking the service in production.
  it("accepts the pending-upsert and 'ok'-resolve shapes mood.service.ts writes", async () => {
    const { id: userId } = await makeUser("s3-roundtrip@example.com");
    const sessionId = crypto.randomUUID();
    const sessionStart = new Date(Date.now() - 60_000).toISOString();
    const sessionEnd = new Date().toISOString();

    // Step 1: the claim's pending upsert (runMoodSweep, mood.service.ts).
    const { data: row, error: insertErr } = await admin.from("mood_readings").upsert(
      {
        user_id: userId,
        session_id: sessionId,
        status: "pending",
        attempts: 1,
        message_count: 3,
        session_start: sessionStart,
        session_end: sessionEnd,
      },
      { onConflict: "session_id" },
    ).select("id").single();
    expect(insertErr).toBeNull();

    // Step 2: the 'ok'-path resolve (runMoodSweep, mood.service.ts).
    const { error: updateErr } = await admin.from("mood_readings").update({
      status: "ok",
      valence: 4,
      summary: "Người dùng vui vẻ khi bàn về kế hoạch cuối tuần.",
      topics: ["công việc", "gia đình", "cuối tuần"],
      confidence: 0.82,
      evidence: [crypto.randomUUID(), crypto.randomUUID()],
    }).eq("id", row!.id);
    expect(updateErr).toBeNull();
  });
});
