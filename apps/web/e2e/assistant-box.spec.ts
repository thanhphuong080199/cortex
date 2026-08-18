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
  await expect(page.getByText(/no answer right now/i)).toBeVisible({ timeout: 15_000 });
});

/**
 * Stage C4: the pane and the sidebar read DIFFERENT TABLES, and this is the assertion that
 * says so. Both halves matter and neither implies the other:
 *
 *   - the seeded assistant reply exists only in chat_messages, so it can only appear if the
 *     pane reads that table (before C4 the pane was derived from `notes` and this text was
 *     nowhere on the page);
 *   - the seeded chitchat note exists only in `notes`, and must NOT be in the sidebar list --
 *     if applyNoteFilters loses its clause, this is where it shows.
 *
 * The seeded conversation is timestamped at seed time and the pane shows a rolling 4-hour
 * session; re-run `node e2e/scripts/seed.mjs` if this goes red with an empty pane.
 */
test("the transcript reads the conversation, and the list does not show chitchat", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Hehe, seeded assistant reply.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("haha ok chitchat seeded turn")).toBeVisible();

  // The sidebar's note list, scoped so the pane's copy of the same text cannot satisfy it.
  await expect(
    page.locator("ul.notes").getByText("Chitchat seed", { exact: false }),
  ).toHaveCount(0);
  // Not vacuous: the list is rendering other notes.
  await expect(page.locator("ul.notes li").first()).toBeVisible();
});
