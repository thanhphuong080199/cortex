import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

/** A deterministic unit-ish vector; only relative cosine distance matters here. */
const vec = (seed: number) => Array.from({ length: 1536 }, (_, i) => Math.sin(seed * (i + 1)) / 40);

/**
 * A single-component nudge off `v`. pgvector's cosine distance (`<=>`) is scale-invariant
 * -- multiplying a vector by a positive scalar leaves its distance to any fixed target
 * unchanged -- so shifting one coordinate is the cheap way to get a vector that is
 * DETERMINISTICALLY (not just usually) farther from `v` than `v` is from itself, without
 * relying on floating-point noise. Used to break two vectors out of an exact-cosine-match
 * tie so their pgvector `row_number()` ranks are 1 and 2, not an unspecified tie order.
 */
const nudge = (v: number[]) => v.map((x, i) => (i === 0 ? x + 0.01 : x));

const search = async (userId: string, query: string, embedding: number[], limit = 10) => {
  const { data, error } = await admin.rpc("search_notes", {
    p_user_id: userId, p_query: query, p_embedding: embedding, p_limit: limit,
  });
  if (error) throw error;
  return data as { note_id: string; title: string | null; snippet: string; score: number; matched_by: string }[];
};

async function seed(userId: string, content: string, opts: { embedding?: number[]; sourceType?: string; createdAt?: string } = {}) {
  const { data } = await admin.from("notes").insert({
    user_id: userId, content,
    source_type: opts.sourceType ?? "quick",
    ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
  }).select("id").single();
  if (opts.embedding) {
    await admin.from("note_chunks").insert({
      user_id: userId, note_id: data!.id, chunk_index: 0, content,
      content_hash: "x", embedding: opts.embedding, embedding_model: "test", embedded_at: new Date().toISOString(),
    });
  }
  return data!.id as string;
}

describe("search_notes", () => {
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    ({ id: alice } = await makeUser("search-alice@example.com"));
    ({ id: bob } = await makeUser("search-bob@example.com"));
    await admin.from("notes").delete().in("user_id", [alice, bob]);
  });

  it("finds a note by keyword alone, with no useful embedding", async () => {
    const id = await seed(alice, "the marginal cost of a second cup");
    const rows = await search(alice, "marginal cost", vec(99));
    expect(rows.map((r) => r.note_id)).toContain(id);
    const row = rows.find((r) => r.note_id === id);
    expect(row).toBeDefined();
    expect(row!.matched_by).toMatch(/fts/);
  });

  // THE DEMO: a note that never contains the query's words.
  it("finds a note by meaning when the words never appear", async () => {
    const target = vec(7);
    const id = await seed(alice, "charging more made people trust it more", { embedding: target });
    await seed(alice, "grocery list: milk, eggs", { embedding: vec(500) });

    const rows = await search(alice, "pricing psychology", target);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.note_id).toBe(id);
    expect(rows[0]!.matched_by).toMatch(/vector/);
  });

  it("marks a note found by both arms", async () => {
    const target = vec(11);
    const id = await seed(alice, "kubernetes ingress notes", { embedding: target });
    const rows = await search(alice, "kubernetes ingress", target);
    const row = rows.find((r) => r.note_id === id);
    expect(row).toBeDefined();
    expect(row!.matched_by).toBe("both");
  });

  it("ranks a recent note above an old one of equal relevance", async () => {
    const target = vec(21);
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const oldId = await seed(alice, "identical relevance text", { embedding: target, createdAt: old });
    const newId = await seed(alice, "identical relevance text", { embedding: target });
    const rows = await search(alice, "identical relevance text", target);
    const order = rows.map((r) => r.note_id);
    expect(order.indexOf(newId)).toBeLessThan(order.indexOf(oldId));
  });

  // The provenance multiplier. Nothing produces these notes until stage C; the hook is built
  // now because stages B, C and phase 9 all call this function.
  //
  // "Equal relevance" is deliberately NOT built from two identical embeddings: RRF's
  // row_number() gives every candidate a distinct integer rank even when their underlying
  // distance/ts_rank ties, so two literally-identical vectors don't produce two identical
  // scores -- they produce adjacent ranks (1/61 vs 1/62) whose ordering is an unspecified
  // Postgres tie-break, not something this test controls. That made this assertion pass
  // whether or not the 0.8 multiplier ran at all (confirmed by mutation-testing the
  // multiplier away and watching this test stay green). Instead, `saved` gets the exact
  // target embedding (guaranteed rank 1: cosine distance 0 is the unique minimum) and `own`
  // gets a nudged one (guaranteed rank 2). Raw RRF now deterministically favours `saved`;
  // only the 0.8 multiplier can flip the order back to `own`. The query string is chosen to
  // have no token overlap with the seeded content, so the FTS arm contributes nothing to
  // either row and can't reintroduce a second, uncontrolled tie.
  it("ranks a saved assistant answer below the user's own note of equal relevance", async () => {
    const target = vec(31);
    const own = await seed(alice, "duplicate relevance body", { embedding: nudge(target) });
    const saved = await seed(alice, "duplicate relevance body", { embedding: target, sourceType: "assistant" });
    const rows = await search(alice, "zzz-no-fts-token-overlap-zzz", target);
    const order = rows.map((r) => r.note_id);
    expect(order.indexOf(own)).toBeLessThan(order.indexOf(saved));
  });

  // Same rank-tie hazard as above, same fix: `assistant` gets the exact target (rank 1,
  // would win outright without the multiplier), `chat` gets the nudged vector (rank 2).
  // 'chat' being excluded from the down-weight is the only thing that can put `chat` ahead.
  it("does not down-weight a chat note, which is the user's own question", async () => {
    const target = vec(41);
    const chat = await seed(alice, "what did I conclude about MCP", { embedding: nudge(target), sourceType: "chat" });
    const assistant = await seed(alice, "what did I conclude about MCP", { embedding: target, sourceType: "assistant" });
    const rows = await search(alice, "zzz-no-fts-token-overlap-zzz", target);
    const order = rows.map((r) => r.note_id);
    expect(order.indexOf(chat)).toBeLessThan(order.indexOf(assistant));
  });

  it("excludes trashed notes", async () => {
    const target = vec(51);
    const id = await seed(alice, "trashed but embedded", { embedding: target });
    await admin.from("notes").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    expect((await search(alice, "trashed but embedded", target)).map((r) => r.note_id)).not.toContain(id);
  });

  // §15.5 and issue-log E3: bob's empty result proves nothing unless ALICE has matching rows.
  it("never returns another user's note, with real rows present for that user", async () => {
    const target = vec(61);
    const aliceNote = await seed(alice, "alice private thinking", { embedding: target });
    const bobNote = await seed(bob, "bob private thinking", { embedding: target });

    const asBob = await search(bob, "private thinking", target);
    expect(asBob.map((r) => r.note_id)).toContain(bobNote);
    expect(asBob.map((r) => r.note_id)).not.toContain(aliceNote);

    const asAlice = await search(alice, "private thinking", target);
    expect(asAlice.map((r) => r.note_id)).toContain(aliceNote);
    expect(asAlice.map((r) => r.note_id)).not.toContain(bobNote);
  });

  it("returns one row per note even when several chunks match", async () => {
    const target = vec(71);
    const { data } = await admin.from("notes")
      .insert({ user_id: alice, content: "multi chunk note" }).select("id").single();
    for (const i of [0, 1, 2]) {
      await admin.from("note_chunks").insert({
        user_id: alice, note_id: data!.id, chunk_index: i, content: `chunk ${i}`,
        content_hash: `h${i}`, embedding: target, embedding_model: "test", embedded_at: new Date().toISOString(),
      });
    }
    const rows = await search(alice, "multi chunk note", target);
    expect(rows.filter((r) => r.note_id === data!.id)).toHaveLength(1);
  });

  it("honours the limit", async () => {
    expect((await search(alice, "the", vec(81), 3)).length).toBeLessThanOrEqual(3);
  });
});
