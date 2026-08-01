import { beforeAll, describe, expect, it } from "vitest";
import { createUserClient } from "../supabase.js";
import { makeUser, type TestUser } from "../test/harness.js";
import { CheckinService } from "./service.js";

let alice: TestUser;
let bob: TestUser;
let svc: CheckinService;

beforeAll(async () => {
  alice = await makeUser("core-checkins-alice@test.local");
  bob = await makeUser("core-checkins-bob@test.local");
  svc = new CheckinService(createUserClient(alice.token), alice.id);
});

describe("CheckinService.create", () => {
  it("creates a mood-only check-in, leaving energy null", async () => {
    const c = await svc.create({ mood: 4, label: "good" });
    expect(c.mood).toBe(4);
    expect(c.energy).toBeNull();
    expect(c.label).toBe("good");
    expect(c.deleted_at).toBeNull();
  });

  it("creates an energy-only check-in", async () => {
    const c = await svc.create({ energy: 2 });
    expect(c.energy).toBe(2);
    expect(c.mood).toBeNull();
  });
});

describe("CheckinService.softDelete", () => {
  it("soft-deletes the caller's own check-in (the mis-tap eraser)", async () => {
    const c = await svc.create({ energy: 2 });
    const deleted = await svc.softDelete(c.id);
    expect(deleted.id).toBe(c.id);

    const { data } = await alice.client.from("checkins")
      .select("deleted_at").eq("id", c.id).single();
    expect(data!.deleted_at).not.toBeNull();
  });

  it("deleting an already-deleted check-in is not_found (not a silent no-op)", async () => {
    const c = await svc.create({ mood: 3 });
    await svc.softDelete(c.id);
    await expect(svc.softDelete(c.id)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("deleting Bob's check-in is not_found, never 403", async () => {
    // A 403 would confirm the row exists (errors.ts / spec §6), so a foreign id must be
    // indistinguishable from a missing one.
    const bobs = await new CheckinService(createUserClient(bob.token), bob.id).create({ mood: 1 });
    await expect(svc.softDelete(bobs.id)).rejects.toMatchObject({ kind: "not_found" });

    const { data } = await bob.client.from("checkins").select("deleted_at").eq("id", bobs.id).single();
    expect(data!.deleted_at, "Bob's check-in is untouched").toBeNull();
  });

  it("deleting a nonexistent id is not_found", async () => {
    await expect(svc.softDelete("00000000-0000-0000-0000-000000000000"))
      .rejects.toMatchObject({ kind: "not_found" });
  });
});
