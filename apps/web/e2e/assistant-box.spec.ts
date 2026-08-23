import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

/**
 * Stage C3 Task 7: the server's `web` SSE event must render as its own block. Originally this
 * also asserted a "Từ notes của bạn" block rendered separately from it (life-domains §6.2) --
 * that box was removed on 2026-08-18 (provenance.tsx) because a matched note is usually the
 * user's own message echoed back one bubble higher. What's left worth pinning: the web block
 * still renders even when the SSE stream also carries a note citation, i.e. the note citation
 * must not leak into, or suppress, the web section.
 *
 * Stubbed at the network layer, same pattern as capture.spec.ts's "a failed capture keeps the
 * text" case: matched on the full API origin so the page's other requests (CORS preflight, any
 * navigation) are untouched. /notes is fulfilled instead of real so the turn always reaches
 * /assistant, and /assistant is fulfilled with a hand-built SSE body -- the real API cannot be
 * made to ground an answer in a test environment (no live Google Search grounding), so this is
 * the only way to exercise the client's handling of the event.
 */
test("shows web sources in their own block, and no notes block alongside them", async ({ page }) => {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001";

  await page.route(`${apiUrl}/notes`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "n1" }) })
      : route.continue(),
  );

  await page.route(`${apiUrl}/assistant`, (route) => {
    const body =
      `event: citations\ndata: ${JSON.stringify({
        citations: [{ type: "note", noteId: "n1", title: "Dune", snippet: "s", score: 1, matchedBy: "fts" }],
      })}\n\n` +
      `event: token\ndata: ${JSON.stringify({ text: "Đã lưu." })}\n\n` +
      `event: web\ndata: ${JSON.stringify({
        sources: [{ type: "web", url: "https://a.example", title: "a" }],
        queries: ["Dune 3"],
      })}\n\n` +
      `event: done\ndata: ${JSON.stringify({ messageId: "m1", sessionId: "s1" })}\n\n`;
    return route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });

  const text = `e2e web grounding ${Date.now()}`;
  await page.goto("/");
  await page.getByLabel(/what are you thinking/i).fill(text);
  await page.getByRole("button", { name: /send/i }).click();

  await expect(page.getByRole("heading", { name: "Từ web" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Từ notes của bạn" })).not.toBeVisible();
  // Scoped to the web block and matched exactly: a bare `{ name: "a" }` substring-matches the
  // sidebar's own nav links ("Active", "Archived", ...), which is a false pass, not a real one.
  const webSection = page.locator("section.provenance.web");
  await expect(webSection.getByRole("link", { name: "a", exact: true })).toHaveAttribute(
    "href",
    "https://a.example",
  );
});

test("a thought is saved even though the assistant cannot answer", async ({ page }) => {
  await page.goto("/");
  const text = `e2e capture ${Date.now()}`;

  await page.getByLabel(/what are you thinking/i).fill(text);
  await page.getByRole("button", { name: /send/i }).click();

  // The note is the deliverable. The API boots with a dummy Gemini key, so the turn fails --
  // and that is precisely the case worth pinning: capture must not depend on the AI path.
  await expect(page.getByText(text)).toBeVisible({ timeout: 15_000 });
  // Vietnamese since 2026-08-23: this hint was the last English string left in the box, and it
  // now matches the wording mobile has always used.
  await expect(page.getByText(/chưa trả lời được/i)).toBeVisible({ timeout: 15_000 });
});

/**
 * Stage C4: the pane and the sidebar used to read DIFFERENT TABLES, and this asserted both
 * halves of that split -- the seeded assistant reply appearing (proving the pane reads
 * chat_messages, not notes) and the seeded chitchat NOTE staying out of the sidebar's list.
 *
 * S1 (2026-08-22) removed the second half's subject entirely: `ul.notes`, `Sidebar` and
 * `AppShell` are gone from page.tsx (S1 §1 -- see that file's own comment). Kept trying to
 * assert "not in a list that no longer exists" would have been vacuously true regardless of
 * whether the underlying property still held, which is exactly this repo's own "test that
 * cannot fail" failure mode (see memory: sdd-tests-that-cannot-fail) -- so that half is dropped
 * rather than patched around. What remains is the half still worth pinning: the pane reads
 * chat_messages, proven by text that exists ONLY in that table.
 *
 * The seeded conversation is timestamped at seed time and the pane shows a rolling 4-hour
 * session; re-run `node e2e/scripts/seed.mjs` if this goes red with an empty pane.
 */
test("the transcript reads the conversation from chat_messages", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Hehe, seeded assistant reply.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("haha ok chitchat seeded turn")).toBeVisible();
});

/**
 * Task 5's pagination, exercised for real -- 35 messages, and the count is the test. PAGE_SIZE
 * is 30 (page.tsx and lib/transcript.ts), so a seed of 12 would sit entirely inside the first
 * page and the assertion below would pass with pagination deleted outright -- the "test that
 * cannot fail" this repo has shipped before (see memory: sdd-tests-that-cannot-fail). 35 puts
 * OLDESTMESSAGE strictly on the second page, reachable only by scrolling to the top and
 * triggering `loadOlder()`.
 */
test("scrolling to the top loads older messages", async ({ page }) => {
  const admin = createClient(
    process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const userId = process.env.E2E_USER_ID!;
  const { data: session } = await admin
    .from("chat_sessions").insert({ user_id: userId }).select("id").single();

  const base = Date.parse("2026-08-01T00:00:00.000Z");
  await admin.from("chat_messages").insert(
    Array.from({ length: 35 }, (_, i) => ({
      user_id: userId, session_id: session!.id, role: "user",
      content: i === 0 ? "OLDESTMESSAGE" : `seeded ${i}`,
      created_at: new Date(base + i * 60_000).toISOString(),
    })),
  );

  await page.goto("/");
  await expect(page.getByText("seeded 34")).toBeVisible();
  await expect(page.getByText("OLDESTMESSAGE")).toHaveCount(0);

  await page.locator(".chat-scroll").evaluate((el) => { el.scrollTop = 0; });
  await expect(page.getByText("OLDESTMESSAGE")).toBeVisible({ timeout: 15000 });
});
