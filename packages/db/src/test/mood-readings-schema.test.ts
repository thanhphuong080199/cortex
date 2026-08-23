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
});
