import { beforeAll, describe, expect, it } from "vitest";
import { admin, makeUser } from "./clients.js";

describe("usage_ledger attribution (00027)", () => {
  let user: string;
  beforeAll(async () => {
    ({ id: user } = await makeUser("ledger-attrib@example.com"));
  });

  it("stores every attribution column a cost question needs", async () => {
    const { data: note } = await admin.from("notes")
      .insert({ user_id: user, content: "a note to attribute spend to" })
      .select("id").single();
    const requestId = crypto.randomUUID();

    const { error } = await admin.from("usage_ledger").insert({
      user_id: user, kind: "chat", model: "test-model",
      input_tokens: 10, output_tokens: 5, cost_usd: 0.001,
      note_id: note!.id, source: "assistant", request_id: requestId,
      attempt: 2, latency_ms: 1234, content_chars: 40,
    });
    expect(error).toBeNull();

    const { data } = await admin.from("usage_ledger")
      .select("note_id, source, request_id, attempt, latency_ms, content_chars")
      .eq("request_id", requestId).single();
    expect(data).toMatchObject({
      note_id: note!.id, source: "assistant", request_id: requestId,
      attempt: 2, latency_ms: 1234, content_chars: 40,
    });
  });

  // The whole point of `source`: 'embed' is written by BOTH the sweep and a search, so
  // without it "cost per search" is unanswerable.
  it("separates a search embedding from a note embedding", async () => {
    const tag = crypto.randomUUID();
    await admin.from("usage_ledger").insert([
      { user_id: user, kind: "embed", model: tag, source: "sweep", cost_usd: 0.02 },
      { user_id: user, kind: "embed", model: tag, source: "search", cost_usd: 0.01 },
    ]);
    const { data } = await admin.from("usage_ledger")
      .select("source, cost_usd").eq("model", tag);
    const bySource = Object.fromEntries((data ?? []).map((r) => [r.source, Number(r.cost_usd)]));
    expect(bySource).toEqual({ sweep: 0.02, search: 0.01 });
  });

  it("rejects a source outside the vocabulary", async () => {
    const { error } = await admin.from("usage_ledger")
      .insert({ user_id: user, kind: "embed", source: "nonsense" });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514"); // check_violation
  });

  it("records the HTTP status a note's last enrichment failure carried", async () => {
    const { data: note } = await admin.from("notes")
      .insert({ user_id: user, content: "a note that failed enrichment" })
      .select("id").single();
    const { error } = await admin.from("note_enrichment").insert({
      note_id: note!.id, user_id: user, attempts: 1, last_error_status: 429,
    });
    expect(error).toBeNull();
  });

  // The 4-hour reset reads the user's newest message ACROSS sessions, so it needs
  // (user_id, created_at) -- chat_messages_session_idx leads on session_id and cannot serve
  // it. PostgREST does not expose pg_indexes, so this asserts the QUERY the reset issues,
  // which is what actually has to work.
  it("supports the newest-message-per-user query the 4-hour reset issues", async () => {
    const { data: session } = await admin.from("chat_sessions")
      .insert({ user_id: user }).select("id").single();
    await admin.from("chat_messages").insert([
      { user_id: user, session_id: session!.id, role: "user", content: "cũ" },
      { user_id: user, session_id: session!.id, role: "user", content: "mới" },
    ]);

    const { data, error } = await admin.from("chat_messages")
      .select("content, created_at").eq("user_id", user)
      .order("created_at", { ascending: false }).limit(1);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});
