import { describe, expect, it } from "vitest";
import { createServiceClient } from "./supabase.js";

describe("createServiceClient", () => {
  it("reads note_enrichment, which authenticated cannot see at all", async () => {
    const client = createServiceClient();
    const { error } = await client.from("note_enrichment").select("note_id").limit(1);
    expect(error).toBeNull();
  });

  it("throws a named error when the key is absent, rather than building a broken client", () => {
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      expect(() => createServiceClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
    }
  });
});
