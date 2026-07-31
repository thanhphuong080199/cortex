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
    // NETWORK_ERROR_CODES), so error.message is unconditionally the literal string
    // "{}" here. Matching the brief's /not allowed|Database error/i regex against
    // error.message is therefore not observable through this client version. Assert
    // on what the client actually exposes instead: a 5xx status, plus direct proof
    // (via listUsers) that no user was created for the blocked email.
    expect((error as { status?: number }).status).toBeGreaterThanOrEqual(500);
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
