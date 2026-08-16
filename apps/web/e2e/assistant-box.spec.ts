import { expect, test } from "@playwright/test";

/**
 * Stage C3 Task 7: the server's `web` SSE event must render as its own block, visibly separate
 * from note citations (life-domains §6.2) -- never merged into one list. This is the regression
 * that split is meant to catch.
 *
 * Stubbed at the network layer, same pattern as capture.spec.ts's "a failed capture keeps the
 * text" case: matched on the full API origin so the page's other requests (CORS preflight, any
 * navigation) are untouched. /notes is fulfilled instead of real so the turn always reaches
 * /assistant, and /assistant is fulfilled with a hand-built SSE body -- the real API cannot be
 * made to ground an answer in a test environment (no live Google Search grounding), so this is
 * the only way to exercise the client's handling of the event.
 */
test("shows web sources in their own block, separate from note citations", async ({ page }) => {
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
        sources: [{ url: "https://a.example", title: "a" }],
        queries: ["Dune 3"],
      })}\n\n` +
      `event: done\ndata: ${JSON.stringify({ messageId: "m1", sessionId: "s1" })}\n\n`;
    return route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });

  const text = `e2e web grounding ${Date.now()}`;
  await page.goto("/");
  await page.getByLabel(/what are you thinking/i).fill(text);
  await page.getByRole("button", { name: /send/i }).click();

  await expect(page.getByRole("heading", { name: "Từ notes của bạn" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Từ web" })).toBeVisible();
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
