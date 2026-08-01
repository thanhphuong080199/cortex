import { describe, expect, it } from "vitest";
import { admin, makeUser, TEST_PASSWORD } from "./clients.js";

describe("invite gate", () => {
  it("rejects signup for a non-allow-listed email", async () => {
    const { error } = await admin.auth.admin.createUser({
      email: "stranger@test.local", password: TEST_PASSWORD, email_confirm: true,
    });
    expect(error).not.toBeNull();
    // GoTrue does surface the trigger's real message over HTTP -- confirmed directly:
    //   curl .../auth/v1/admin/users -> 500 {"code":"P0001","message":"Signup not
    //   allowed for stranger@test.local"}
    // but auth-js 2.111's handleError() treats every 5xx as a "retryable fetch error"
    // and never reads the JSON body in that branch (see auth-js src/lib/fetch.ts,
    // NETWORK_ERROR_CODES), so error.message above is unconditionally the literal
    // string "{}", and error.status alone can't tell "the gate fired" apart from an
    // unrelated transient-infra 5xx (Kong 503, GoTrue restart mid-request, ...) --
    // those live in that same NETWORK_ERROR_CODES list, so a loose `>= 500` check
    // would false-pass even if the trigger were dropped, as long as *something* on
    // the stack independently hiccupped. Bypass auth-js and hit the same endpoint
    // directly (exactly as the curl repro above) for direct proof the trigger itself
    // raised the rejection (SQLSTATE P0001), not an inference from a status range.
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "stranger@test.local", password: TEST_PASSWORD, email_confirm: true }),
    });
    const body = (await res.json()) as { code?: string; message?: string };
    expect(res.status).toBe(500);
    expect(body.code).toBe("P0001");
    expect(String(body.message)).toMatch(/not allowed/i);

    // Belt-and-suspenders: prove no user record was created for the blocked email either.
    // listUsers() defaults to perPage=50, and GoTrue sorts by created_at desc, so a
    // wrongly-created user would land on page 1 -- true at this suite's current fixture
    // count (a handful of users), but revisit (add pagination or filter by email) if the
    // suite grows enough that a false-created user could get pushed past page 1.
    const { data: list } = await admin.auth.admin.listUsers();
    expect(list.users.some((u) => u.email === "stranger@test.local")).toBe(false);
  });

  it("allows signup for an allow-listed email", async () => {
    const { id } = await makeUser("invited@test.local");   // makeUser allow-lists first
    expect(id).toBeTruthy();
  });

  it("hides allowed_emails from clients", async () => {
    const { client } = await makeUser("invited@test.local");
    const { data, error } = await client.from("allowed_emails").select("email");
    // Server-only table: no grant to authenticated -> 42501 permission error, never rows.
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});
