import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

/** A deterministic unit-ish vector; only relative cosine distance matters here. */
const vec = (seed: number) => Array.from({ length: 1536 }, (_, i) => Math.sin(seed * (i + 1)) / 40);

/**
 * A single-component nudge off `v`, by `epsilon`. pgvector's cosine distance (`<=>`) is
 * scale-invariant -- multiplying a vector by a positive scalar leaves its distance to any
 * fixed target unchanged -- so shifting one coordinate is the cheap way to get a vector that
 * is DETERMINISTICALLY (not just usually) farther from `v` than `v` is from itself, without
 * relying on floating-point noise. Used to break vectors out of an exact-cosine-match tie so
 * their pgvector `row_number()` ranks are distinct, ordered ranks (1, 2, 3, ...) rather than
 * an unspecified tie order -- and, with two different epsilons, to order two DIFFERENT
 * nudged vectors relative to each other (a larger epsilon is a larger perturbation, hence a
 * strictly larger cosine distance from the unperturbed target, for the epsilons used here).
 */
const nudge = (v: number[], epsilon = 0.01) => v.map((x, i) => (i === 0 ? x + epsilon : x));

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
  // The fusion and recency-clamp tests below assert things about RRF *ranks*, and a rank is
  // computed over the whole of one user's corpus -- alice accumulates ~15 notes across this
  // file, so "rank 1" and "rank 2" there are only true because the other candidates happen to
  // be far away in cosine distance. These two users hold nothing but the three or four notes
  // their own test seeds, so the ranks the assertions depend on are the ranks that exist.
  let fusion: string;
  let clock: string;

  beforeAll(async () => {
    ({ id: alice } = await makeUser("search-alice@example.com"));
    ({ id: bob } = await makeUser("search-bob@example.com"));
    ({ id: fusion } = await makeUser("search-fusion@example.com"));
    ({ id: clock } = await makeUser("search-clock@example.com"));
    await admin.from("notes").delete().in("user_id", [alice, bob, fusion, clock]);
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

  // THE FUSION ITSELF. `matched_by` is computed in a `case` expression entirely separate from
  // the score, so every other test in this file survives deleting either term of
  // `coalesce(1/(60+v.rank),0) + coalesce(1/(60+f.rank),0)`: a row whose base collapsed to 0
  // still reports "fts" or "both", the recency and provenance tests all query
  // `zzz-no-fts-token-overlap-zzz` and are single-arm by construction, and the rest assert
  // containment or counts. Verified by mutation -- with the FTS term removed, all ten of the
  // other tests stay green.
  //
  // RRF's whole claim is that AGREEMENT between two weak signals beats one strong signal, so
  // the note in both arms is given the WORSE rank in each: it cannot win on membership, only
  // on the sum. `bothArms` is vector rank 2 (nudged) and FTS rank 2 (one query term);
  // `vectorOnly` is vector rank 1 (the exact target) and contains neither query token;
  // `ftsOnly` is FTS rank 1 (both query terms -- ts_rank combines matched operands, so two
  // beats one deterministically) and has no chunk at all. That catches both mutations, in
  // opposite directions:
  //   drop the FTS term    -> bothArms 1/62 = 0.01613 loses to vectorOnly 1/61 = 0.01639
  //   drop the vector term -> bothArms 1/62 = 0.01613 loses to ftsOnly    1/61 = 0.01639
  // while the intact sum gives bothArms 1/62 + 1/62 = 0.03226, ahead of both. The three notes
  // share one created_at and the default 'quick' source_type, so the recency and provenance
  // multipliers are identical across them and cannot be what orders the result.
  it("fuses both arms: agreement at rank 2 beats a single arm at rank 1", async () => {
    const target = vec(101);
    const at = new Date().toISOString();
    const bothArms = await seed(fusion, "quokka", { embedding: nudge(target), createdAt: at });
    const vectorOnly = await seed(fusion, "unrelated ledger body", { embedding: target, createdAt: at });
    const ftsOnly = await seed(fusion, "quokka wombat", { createdAt: at });

    const rows = await search(fusion, "quokka or wombat", target);
    const byId = new Map(rows.map((r) => [r.note_id, r]));
    const fused = byId.get(bothArms);
    const vectorRow = byId.get(vectorOnly);
    const ftsRow = byId.get(ftsOnly);
    expect(fused).toBeDefined();
    expect(vectorRow).toBeDefined();
    expect(ftsRow).toBeDefined();

    // The fixture is only meaningful if each note reached the arms it was built for; assert it
    // rather than let a mis-seeded row make the comparison below pass for some other reason.
    expect(fused!.matched_by).toBe("both");
    expect(vectorRow!.matched_by).toBe("vector");
    expect(ftsRow!.matched_by).toBe("fts");

    expect(fused!.score).toBeGreaterThan(vectorRow!.score);
    expect(fused!.score).toBeGreaterThan(ftsRow!.score);
  });

  // Same rank-tie hazard as the provenance tests below, same fix: `oldId` gets the exact
  // target (guaranteed rank 1 -- the better RAW rank), `newId` gets a nudged vector
  // (guaranteed rank 2). Without this, both were seeded with the identical `target` vector,
  // so their row_number() order was the same unspecified Postgres tie-break that made the
  // provenance tests vacuous -- this test happened to go red under mutation 1 on this
  // machine, but that only proved the tie landed on `old` first HERE, not that recency was
  // being tested. Now raw RRF deterministically favours `oldId`; only the recency factor
  // (exp(-400/180) ~= 0.108, which swamps the ~1.6% adjacent-rank gap) can flip the order
  // back to `newId`. The query has no token overlap with the seeded content so the FTS arm
  // can't reintroduce a second, uncontrolled tie.
  it("ranks a recent note above an old one of equal relevance", async () => {
    const target = vec(21);
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const oldId = await seed(alice, "identical relevance text", { embedding: target, createdAt: old });
    const newId = await seed(alice, "identical relevance text", { embedding: nudge(target) });
    const rows = await search(alice, "zzz-no-fts-token-overlap-zzz", target);
    const order = rows.map((r) => r.note_id);
    expect(order).toContain(oldId);
    expect(order).toContain(newId);
    expect(order.indexOf(newId)).toBeLessThan(order.indexOf(oldId));
  });

  // `created_at` arrives from the DEVICE (apps/api/src/sync/router.ts's notes PUT passes
  // `data.created_at` through), so the age fed to `exp(-age/180)` can be negative and the decay
  // becomes an amplifier: a note dated two years ahead scored exp(+4.05) ~= 57x and pinned
  // itself to rank 1 of every query that user ran.
  //
  // The direction matters. `future` is deliberately given the WORSE raw rank (nudged, rank 2)
  // and `present` the better one (exact target, rank 1), so an unclamped decay is the only
  // thing that can put `future` first -- seeded the other way round the test would pass with or
  // without the clamp. Both share content and source_type; the query has no token overlap, so
  // the FTS arm contributes nothing to either.
  it("does not let a future created_at amplify a note above a present-dated one", async () => {
    const target = vec(111);
    const ahead = new Date(Date.now() + 730 * 86_400_000).toISOString();
    const present = await seed(clock, "identical decay body", { embedding: target });
    const future = await seed(clock, "identical decay body", { embedding: nudge(target), createdAt: ahead });
    const order = (await search(clock, "zzz-no-fts-token-overlap-zzz", target)).map((r) => r.note_id);
    expect(order).toContain(present);
    expect(order).toContain(future);
    expect(order.indexOf(present)).toBeLessThan(order.indexOf(future));
  });

  // The same unbounded age, one bad import further along. `extract(epoch from interval)` is
  // NUMERIC in PG 14+, so the exponent goes to numeric_exp, which raises "value overflows
  // numeric format" above ~6000 -- and 9999-12-31, the sentinel a "no expiry" default or a
  // botched date parse writes, is ~16179. The error is raised while projecting the final
  // select, so ONE such row anywhere in a user's corpus turned every POST /search that user
  // made into a 500, for queries that had nothing to do with the note.
  //
  // Asserted as "the search still returns this row", not merely "does not throw": the helper
  // rethrows the RPC error, so a 500 fails here loudly, and requiring the row in the result
  // proves the clamp kept the note scoreable rather than filtering it out of existence.
  it("survives a far-future created_at instead of failing the whole search", async () => {
    const sentinel = await seed(clock, "sentinel dated import row", { createdAt: "9999-12-31T00:00:00Z" });
    const rows = await search(clock, "sentinel dated import", vec(121));
    expect(rows.map((r) => r.note_id)).toContain(sentinel);
  });

  // The provenance multiplier. Nothing produces these notes until stage C; the hook is built
  // now because stages B, C and phase 9 all call this function.
  //
  // "Equal relevance" is deliberately NOT built from identical embeddings: RRF's
  // row_number() gives every candidate a distinct integer rank even when their underlying
  // distance/ts_rank ties, so two literally-identical vectors don't produce two identical
  // scores -- they produce adjacent ranks (1/61 vs 1/62) whose ordering is an unspecified
  // Postgres tie-break, not something this test controls. That made this assertion pass
  // whether or not the 0.8 multiplier ran at all (confirmed by mutation-testing the
  // multiplier away and watching this test stay green). Instead, `saved` (assistant) gets
  // the exact target embedding (guaranteed rank 1: cosine distance 0 is the unique minimum),
  // `webSearch` gets a small nudge (guaranteed rank 2, still better than `own`), and `own`
  // gets a larger nudge (guaranteed rank 3, the worst raw rank of the three). Raw RRF now
  // deterministically favours BOTH down-weighted notes over `own`; only applying the 0.8
  // multiplier to both `assistant` and `web_search` can flip the order back to `own` on top
  // -- narrowing the multiplier's `in (...)` list to just one of them would leave the other
  // assertion red. The query string has no token overlap with the seeded content, so the FTS
  // arm contributes nothing to any row and can't reintroduce a second, uncontrolled tie.
  it("ranks a saved assistant answer below the user's own note of equal relevance", async () => {
    const target = vec(31);
    const own = await seed(alice, "duplicate relevance body", { embedding: nudge(target, 0.02) });
    const saved = await seed(alice, "duplicate relevance body", { embedding: target, sourceType: "assistant" });
    const webSearch = await seed(alice, "duplicate relevance body", { embedding: nudge(target, 0.005), sourceType: "web_search" });
    const rows = await search(alice, "zzz-no-fts-token-overlap-zzz", target);
    const order = rows.map((r) => r.note_id);
    expect(order).toContain(own);
    expect(order).toContain(saved);
    expect(order).toContain(webSearch);
    expect(order.indexOf(own)).toBeLessThan(order.indexOf(saved));
    expect(order.indexOf(own)).toBeLessThan(order.indexOf(webSearch));
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
    expect(order).toContain(chat);
    expect(order).toContain(assistant);
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

  // toBeLessThanOrEqual(3) would also pass if the vector arm returned zero rows, so a
  // totally broken vector arm would leave this green. By this point in the suite alice has
  // ~12 embedded notes from prior tests (never deleted -- only the beforeAll clears the
  // table), so the vector arm alone guarantees at least 3 candidates and toBe(3) is
  // deterministic. "the" is still an English stopword against websearch_to_tsquery, so this
  // stays a vector-arm-only exercise of the limit, not a fused-arm one (see report).
  it("honours the limit", async () => {
    expect((await search(alice, "the", vec(81), 3)).length).toBe(3);
  });

  // THE KEYWORD ARM IN THE LANGUAGE THE CORPUS IS ACTUALLY WRITTEN IN.
  //
  // Both of Cortex's real users write Vietnamese, and `to_tsvector('english', ...)` -- what
  // 00002's notes_fts_idx and 00024's search_notes both used -- breaks it three separate ways.
  // Every note below is seeded WITHOUT an embedding, so it owns no note_chunks row and the
  // vector arm cannot return it: whatever these assertions see came from the FTS arm alone.
  describe("Vietnamese", () => {
    let viet: string;
    beforeAll(async () => {
      ({ id: viet } = await makeUser("search-viet@example.com"));
      await admin.from("notes").delete().eq("user_id", viet);
    });

    // English STOPWORDS silently delete Vietnamese words. Measured against the old config:
    //   to_tsvector('english', 'an toàn do ta la no be') -> 'la' 'ta' 'toàn'
    // "an", "do", "no" and "be" are gone -- four of seven words.
    //
    // The damage is PRECISION, not recall, and the first version of this test missed that by
    // asserting only recall: the drop is applied symmetrically to the query too, so
    // "an toàn" still finds "an toàn lao động" -- both sides reduce to 'toàn' and match. What
    // is actually lost is the word "an" as a constraint, so the query silently degrades to a
    // one-word search and every note merely containing "toàn" becomes a hit. Hence the
    // negative half below, which is the half that was red.
    it("does not drop a word that happens to spell an English stopword", async () => {
      const wanted = await seed(viet, "an toàn lao động là ưu tiên số một");
      const unrelated = await seed(viet, "toàn bộ tài liệu đã được lưu lại");
      const rows = await search(viet, "an toàn", vec(41));
      expect(rows.map((r) => r.note_id)).toContain(wanted);
      expect(rows.map((r) => r.note_id)).not.toContain(unrelated);
    });

    // The English SNOWBALL STEMMER mangles Vietnamese tokens and collides distinct words:
    //   to_tsvector('english', 'bảy') -> 'bải'
    //   to_tsvector('english', 'bải') -> 'bải'
    // so searching "bải" returned a note about seven o'clock. Unaccenting is not stemming --
    // "bảy" folds to `bay` and "bải" to `bai`, which stay distinct -- so this is a false
    // positive the fix removes rather than one it has to tolerate.
    it("does not match a different word that only an English stemmer conflates", async () => {
      const id = await seed(viet, "tôi dậy lúc bảy giờ sáng");
      const rows = await search(viet, "bải", vec(42));
      expect(rows.map((r) => r.note_id)).not.toContain(id);
    });

    // Typing Vietnamese without diacritics is ordinary, not sloppy, and it is exactly where
    // the vector arm is weakest -- so the keyword arm has to carry it.
    it("finds a note typed with diacritics from a query typed without them", async () => {
      const id = await seed(viet, "hôm nay tôi chạy bộ ở công viên");
      const rows = await search(viet, "chay bo cong vien", vec(43));
      expect(rows.map((r) => r.note_id)).toContain(id);
    });

    // The reverse direction, because the fold has to be applied to BOTH sides of the match.
    // Applying it only to the indexed column leaves this one red.
    it("finds a note typed without diacritics from a query typed with them", async () => {
      const id = await seed(viet, "mua ca phe va banh mi buoi sang");
      const rows = await search(viet, "cà phê", vec(44));
      expect(rows.map((r) => r.note_id)).toContain(id);
    });
  });

  // Stage C4 §5.3. The FTS arm: a chitchat note whose text matches the query exactly must not
  // come back. Anchored against a control note with the same keyword, so a green result cannot
  // come from the query simply matching nothing.
  it("never returns a chitchat note matched by keyword", async () => {
    const control = await seed(bob, "the flibbertigibbet protocol, a real note");
    const chit = await seed(bob, "the flibbertigibbet protocol, haha ok", { sourceType: "chitchat" });
    const rows = await search(bob, "flibbertigibbet protocol", vec(7));
    expect(rows.map((r) => r.note_id)).toContain(control);
    expect(rows.map((r) => r.note_id)).not.toContain(chit);
  });

  // The VECTOR arm, separately: the two arms are joined with a full outer join, so a clause
  // present in one and absent from the other still returns the row. A near-identical embedding
  // is the strongest possible pull into the vector arm -- if the exclusion is missing there,
  // this is the assertion that says so.
  it("never returns a chitchat note matched by embedding", async () => {
    const target = vec(21);
    const chit = await seed(bob, "banter with a very close embedding", {
      sourceType: "chitchat", embedding: target,
    });
    const rows = await search(bob, "nothing-matches-this-keyword-zzz", target);
    expect(rows.map((r) => r.note_id)).not.toContain(chit);
  });
});
