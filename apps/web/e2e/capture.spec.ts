import { expect, test } from "@playwright/test";

/**
 * Mục 3 — "capture 1 note → xuất hiện ngay", the web half.
 *
 * Until 2026-08-22 "appears" had two separable halves, because quick-capture.tsx did NOT insert
 * optimistically ("the Realtime echo adds the row and dedupes by id") -- so there were two tests
 * here, one for the write and one for the open page learning about it live. AssistantBox's own
 * submit() now pushes the user's bubble into `turns` before the network call even starts (S1
 * §3), so that second test asserted a mechanism (an unauthenticated Realtime subscription no
 * longer in the render tree) that no longer exists, and there is nothing left in this file to
 * split it from.
 */
test("a captured note reaches the corpus", async ({ page }) => {
  const body = `web capture ${Date.now()}`;

  await page.goto("/");
  await page.getByLabel(/what are you thinking/i).fill(body);
  // There is no Save button: ⌘/Ctrl+Enter is the only submit path.
  await page.getByLabel(/what are you thinking/i).press("Control+Enter");

  // The box is cleared ONLY on success, so an empty textarea is the acknowledgement.
  await expect(page.getByLabel(/what are you thinking/i)).toHaveValue("", { timeout: 15_000 });
  // The bubble is optimistic -- rendered the instant submit() runs, well before the note is
  // even saved -- so this is the immediate half of "appears".
  await expect(page.locator(".bubble.user", { hasText: body })).toBeVisible();

  // Reload rather than trusting the optimistic bubble alone: this asserts the WRITE, and the
  // SSR read in page.tsx (now over chat_messages, not notes) is the independent confirmation
  // that the row is really there.
  await page.reload();
  await expect(page.locator(".bubble.user", { hasText: body })).toBeVisible({ timeout: 15_000 });
});

test("a failed capture keeps the text and offers a retry", async ({ page }) => {
  const body = `doomed capture ${Date.now()}`;

  await page.goto("/");
  // Fail the write at the network layer rather than by stopping the API: this leaves the rest
  // of the page working, which is the situation the error path is actually written for.
  //
  // Matched on the full API origin. `**/notes` alone also catches the CORS preflight and the
  // page's own /notes navigations, and aborting those produced a page that failed for a
  // different reason than the one under test.
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001";
  await page.route(`${apiUrl}/notes`, (route) =>
    route.request().method() === "POST" ? route.abort("failed") : route.continue(),
  );

  await page.getByLabel(/what are you thinking/i).fill(body);
  await page.getByLabel(/what are you thinking/i).press("Control+Enter");

  // "A capture box must never lose a thought" -- the text stays put and the error names a retry.
  //
  // Scoped to the component's own error node rather than `getByRole("alert")`: Next.js injects
  // <div id="__next-route-announcer__" role="alert"> into every page, so the bare role matcher
  // resolves to two elements and fails on strict mode rather than on anything about capture.
  const error = page.locator("p.error[role=alert]");
  await expect(error).toContainText("Couldn't save", { timeout: 15_000 });
  await expect(error.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByLabel(/what are you thinking/i)).toHaveValue(body);
});

/**
 * The Realtime-era banner ("Export needs a connection"'s composer-level sibling) is gone with
 * the note browser. Task 7 replaced it with a `navigator.onLine`-driven notice inside
 * AssistantBox itself (apps/web/src/app/assistant-box.tsx), which also disables the composer
 * outright rather than merely warning about it.
 */
test("capture is disabled with no connection", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByLabel(/what are you thinking/i)).toBeVisible();

  await context.setOffline(true);
  // The component listens for the browser's offline event; it does not poll.
  await expect(
    page.getByText("Mất mạng — chưa gửi được. Hội thoại cũ vẫn xem được."),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel(/what are you thinking/i)).toBeDisabled();

  await context.setOffline(false);
});
