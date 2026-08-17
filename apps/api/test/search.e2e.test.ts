import { INestApplication } from "@nestjs/common";
import { createClient } from "@supabase/supabase-js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeAi } from "@cortex/core";
import { auth, bootstrapTestApp, makeUser, type TestUser } from "./harness";

let app: INestApplication;
let alice: TestUser;

// A dedicated admin client, built the same way app.e2e.test.ts's does, to seed a note directly
// under a SECOND user's id -- there is no HTTP route that lets one authenticated caller create
// a note under another user's id, by design.
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

beforeAll(async () => {
  // NO TEST MAY EVER CALL THE REAL GEMINI API (packages/core/src/ai/fake.ts). bootstrapTestApp's
  // `ai` override swaps out AppModule's real AI_CLIENT provider before the app boots, so the
  // embed() call SearchController makes on every request below never reaches Gemini's network.
  app = await bootstrapTestApp({ ai: createFakeAi() });
  alice = await makeUser("api-search-alice@test.local");
});
afterAll(async () => { await app.close(); });

describe("POST /search", () => {
  it("401s without a token", async () => {
    await request(app.getHttpServer()).post("/search").send({ q: "anything" }).expect(401);
  });

  it("400s on an empty query", async () => {
    await request(app.getHttpServer()).post("/search").set(auth(alice.token)).send({ q: "" }).expect(400);
  });

  // searchInput is .strict(): an unrecognised key fails validation loudly instead of being
  // dropped silently. Proven here as its own property, separate from the isolation test below
  // -- "a body-supplied userId is rejected" and "isolation holds with a clean body" are two
  // different claims and neither one implies the other.
  it("400s when the body carries a userId field, rather than silently ignoring it", async () => {
    const res = await request(app.getHttpServer()).post("/search")
      .set(auth(alice.token))
      .send({ q: "anything", userId: "11111111-1111-1111-1111-111111111111" })
      .expect(400);
    expect(res.body.issues).toBeDefined();
  });

  it("finds the caller's own note by keyword, shaped exactly as noteId/title/snippet/score/matchedBy", async () => {
    await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: "the marginal cost of a second cup" }).expect(201);

    const res = await request(app.getHttpServer()).post("/search")
      .set(auth(alice.token)).send({ q: "marginal cost" }).expect(201);
    expect(res.body.results.length).toBeGreaterThan(0);

    // The controller's response map (search.controller.ts) is otherwise untypechecked --
    // db.rpc() returns `any`, so `r.matched_by` mistyped as e.g. `r.matchedby` would compile
    // clean and silently emit `undefined`, which JSON drops from the wire entirely (unlike
    // `null`). Asserting the exact key set, not just "has a snippet", is what would catch that:
    // a dropped key fails toEqual's key-set check even though every OTHER field still matches.
    const result = res.body.results[0];
    expect(Object.keys(result).sort()).toEqual(["matchedBy", "noteId", "score", "snippet", "title"]);
    expect(typeof result.noteId).toBe("string");
    expect(typeof result.snippet).toBe("string");
    expect(typeof result.score).toBe("number");
    expect(typeof result.matchedBy).toBe("string");
  });

  it("honours a caller-supplied limit", async () => {
    const marker = "kaleidoscope-ferret-invoice-marker";
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer()).post("/notes")
        .set(auth(alice.token)).send({ content: `${marker} note number ${i}` }).expect(201);
    }

    // Three notes exist that match `marker`; a limit of 1 over HTTP must come back as exactly
    // one result. This is the one thing packages/db's own search_notes.test.ts (Task 14) does
    // NOT cover: that body.limit -- not just p_limit at the RPC layer -- actually reaches the
    // RPC, rather than the controller silently ignoring it and always using its ?? 20 default.
    const res = await request(app.getHttpServer()).post("/search")
      .set(auth(alice.token)).send({ q: marker, limit: 1 }).expect(201);
    expect(res.body.results.length).toBe(1);
  });

  // The security property this endpoint exists to protect: the p_user_id passed to
  // search_notes comes only from the verified JWT (SupabaseAuthGuard + @CurrentUser()), never
  // from the body. Proven directly here (not just via the .strict() 400 above, which only shows
  // an explicit userId field is rejected -- it says nothing about whether a CLEAN body still
  // isolates correctly). A real matching row is seeded for the other user too, per issue-log
  // E3: an empty result for alice would be vacuous if bob's note didn't actually match the query.
  it("never returns another user's note, with a real matching row for that user", async () => {
    const bob = await makeUser("api-search-bob@test.local");
    const { data: bobNote, error } = await admin.from("notes")
      .insert({ user_id: bob.id, content: "quixotic zephyr pricing thoughts, bob's private version" })
      .select("id").single();
    if (error) throw error;

    await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token))
      .send({ content: "quixotic zephyr pricing thoughts, alice's own version" }).expect(201);

    const res = await request(app.getHttpServer()).post("/search")
      .set(auth(alice.token)).send({ q: "quixotic zephyr pricing thoughts" }).expect(201);

    const noteIds = res.body.results.map((r: { noteId: string }) => r.noteId);
    expect(noteIds.length).toBeGreaterThan(0); // alice's own note proves the query actually matches
    expect(noteIds).not.toContain(bobNote!.id);
  });

  // The same clause, asserted over the HTTP path -- a separate assertion because it is a
  // separate consumer: /search reaches search_notes through SearchController's service-role
  // client, while retrieval reaches it through retrieve.ts. A regression that dropped the
  // exclusion for one would drop it for both, and this is the half a user would notice.
  it("never returns a chitchat note", async () => {
    const marker = "quixotic-chitchat-marker";
    await request(app.getHttpServer()).post("/notes")
      .set(auth(alice.token)).send({ content: `${marker} a real note` }).expect(201);
    const { data: chit } = await admin.from("notes")
      .insert({ user_id: alice.id, content: `${marker} haha ok`, source_type: "chitchat" })
      .select("id").single();

    const res = await request(app.getHttpServer()).post("/search")
      .set(auth(alice.token)).send({ q: marker }).expect(201);
    // Not vacuous: the real note with the same marker must come back.
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results.map((r: { noteId: string }) => r.noteId)).not.toContain(chit!.id);
  });
});

// Search spends money on every request (one Gemini embedding of the query) and, until this
// suite, spent it invisibly: usage_ledger held nothing, so isOverBudget -- the query the whole
// spend cap is built on, and which fails CLOSED precisely so a broken read cannot become
// unlimited spend -- was blind to an entire billable path. The only place it showed up was
// Google's console. AppModule does not import EnrichModule (see its comment), so nothing else
// writes usage_ledger during these tests: every row a fixture user gains here is a search.
//
// Every assertion below is a DELTA, never an absolute count. makeUser tolerates "already been
// registered" and signs the existing user back in, so these fixtures are the SAME auth users on
// every run and their usage_ledger rows accumulate across runs -- an absolute `toHaveLength(1)`
// passes exactly once and then fails forever on a developer's machine while staying green on a
// fresh CI database. Same lesson the enrichment suites' backdating fix taught: never assume the
// local database starts empty.
describe("POST /search usage metering", () => {
  /** Newest first, so `[0]` is the row the request under test just wrote. */
  const ledgerRowsFor = async (userId: string) => {
    const { data, error } = await admin
      .from("usage_ledger")
      .select("kind, model, input_tokens, output_tokens, cost_usd, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  };

  it("writes one 'embed' row per search, attributed to the caller from the JWT", async () => {
    const carol = await makeUser("api-search-carol@test.local");
    const before = (await ledgerRowsFor(carol.id)).length;

    await request(app.getHttpServer()).post("/search")
      .set(auth(carol.token)).send({ q: "how much did metering cost" }).expect(201);

    const rows = await ledgerRowsFor(carol.id);
    expect(rows).toHaveLength(before + 1);
    // 'embed' is the kind usage_ledger's CHECK permits for an embedding call, and
    // monthToDateUsd sums cost_usd across kinds -- so a row written under the wrong kind would
    // still total correctly but stop being attributable to search. Pinning it here is what makes
    // "which path spent this" answerable later.
    expect(rows[0]!.kind).toBe("embed");
    expect(rows[0]!.output_tokens).toBe(0);
    expect(rows[0]!.input_tokens).toBeGreaterThan(0);

    // A second search must ADD a row, not overwrite or dedupe one. The failure this rules out is
    // an under-count that looks identical to correct metering on any single-request test.
    await request(app.getHttpServer()).post("/search")
      .set(auth(carol.token)).send({ q: "and again" }).expect(201);
    expect(await ledgerRowsFor(carol.id)).toHaveLength(before + 2);
  });

  // A request that never reaches the model must never be billed. The 400 below is rejected by
  // ZodValidationPipe before the controller body runs at all, which is exactly why it is worth
  // pinning: move the recordUsage call above the validation boundary (or into a filter) and this
  // is the test that notices.
  it("bills nothing for a request that never reached the model", async () => {
    const dave = await makeUser("api-search-dave@test.local");
    const before = (await ledgerRowsFor(dave.id)).length;
    await request(app.getHttpServer()).post("/search")
      .set(auth(dave.token)).send({ q: "" }).expect(400);
    expect(await ledgerRowsFor(dave.id)).toHaveLength(before);
  });

  // Metering must never be able to break the thing it meters. `input_tokens` is `int`
  // (00007_integrations_ops.sql:35), so a fractional value is rejected by Postgres -- a real
  // insert failure arriving as a PostgREST error object, the same shape a lost grant or a
  // constraint change would produce. The search still has to succeed: the alternative is a
  // ledger outage taking search down with it, which trades a silent under-count for an outage.
  describe("when the ledger write fails", () => {
    let brokenApp: INestApplication;

    beforeAll(async () => {
      const base = createFakeAi();
      brokenApp = await bootstrapTestApp({
        ai: createFakeAi({
          embed: async (texts) => ({ ...(await base.embed(texts)), inputTokens: 1.5 }),
        }),
      });
    });
    afterAll(async () => { await brokenApp.close(); });

    it("still returns the results instead of a 500", async () => {
      const erin = await makeUser("api-search-erin@test.local");
      const marker = "quarrelsome-abacus-ledger-marker";
      await request(brokenApp.getHttpServer()).post("/notes")
        .set(auth(erin.token)).send({ content: `${marker} still searchable` }).expect(201);
      const before = (await ledgerRowsFor(erin.id)).length;

      const res = await request(brokenApp.getHttpServer()).post("/search")
        .set(auth(erin.token)).send({ q: marker }).expect(201);
      expect(res.body.results.length).toBeGreaterThan(0);

      // ...and the write really did fail, so the assertion above is not passing vacuously
      // against a ledger that quietly accepted 1.5.
      expect(await ledgerRowsFor(erin.id)).toHaveLength(before);
    });
  });
});
