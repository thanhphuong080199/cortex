import { expect, test } from "@playwright/test";

/**
 * Mục 3 — "capture 1 note → xuất hiện ngay", the web half.
 *
 * quick-capture.tsx does NOT insert optimistically; its comment says so outright -- "the
 * Realtime echo adds the row and dedupes by id". So "appears" has two separable halves, and
 * they are two tests here on purpose: the note reaching the corpus, and the open page learning
 * about it. The first is unconditional; the second is currently unproven (see below).
 */
test("a captured note reaches the corpus", async ({ page }) => {
  const body = `web capture ${Date.now()}`;

  await page.goto("/");
  await page.getByLabel("Quick capture").fill(body);
  // There is no Save button: ⌘/Ctrl+Enter is the only submit path.
  await page.getByLabel("Quick capture").press("Control+Enter");

  // The box is cleared ONLY on success, so an empty textarea is the acknowledgement.
  await expect(page.getByLabel("Quick capture")).toHaveValue("", { timeout: 15_000 });

  // Reload rather than waiting for the live echo: this asserts the WRITE, and the SSR read in
  // page.tsx is the independent confirmation that the row is really there.
  await page.reload();
  await expect(page.getByRole("link", { name: body })).toBeVisible({ timeout: 15_000 });
});

/**
 * The regression test for the Realtime subscription being unauthenticated.
 *
 * It failed for a real reason, reproduced by hand in two browser tabs signed in through Google:
 * the channel joined, but the postgres_changes subscription was rejected with
 *
 *   ERROR P0001 (raise_exception) invalid column for filter user_id
 *
 * which is misleading -- the column exists. `realtime.subscription_check_filters()` builds its
 * list of filterable columns from `has_column_privilege(new.claims ->> 'role', ...)`, so it is
 * asking what the JWT's ROLE can select. The socket had no user token, so the role was `anon`,
 * and `anon` has SELECT on zero columns of `public.notes` (correctly -- 00009 revoked the
 * defaults). Zero columns means every filter is "invalid". No events were ever sent.
 *
 * If this starts failing again, capture the websocket frames before theorising: the join reply
 * says `status: ok` and the rejection arrives afterwards as a separate `system` message, so
 * nothing in the client's own logs looks wrong.
 */
test("the open page learns about the capture without a reload", async ({ page }) => {
  const body = `web live capture ${Date.now()}`;

  await page.goto("/");
  await page.getByLabel("Quick capture").fill(body);
  await page.getByLabel("Quick capture").press("Control+Enter");

  await expect(page.getByLabel("Quick capture")).toHaveValue("", { timeout: 15_000 });
  await expect(page.getByRole("link", { name: body })).toBeVisible({ timeout: 15_000 });
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

  await page.getByLabel("Quick capture").fill(body);
  await page.getByLabel("Quick capture").press("Control+Enter");

  // "A capture box must never lose a thought" -- the text stays put and the error names a retry.
  //
  // Scoped to the component's own error node rather than `getByRole("alert")`: Next.js injects
  // <div id="__next-route-announcer__" role="alert"> into every page, so the bare role matcher
  // resolves to two elements and fails on strict mode rather than on anything about capture.
  const error = page.locator("p.error[role=alert]");
  await expect(error).toContainText("Couldn't save", { timeout: 15_000 });
  await expect(error.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByLabel("Quick capture")).toHaveValue(body);
});

test("capture is disabled with no connection", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByLabel("Quick capture")).toBeVisible();

  await context.setOffline(true);
  // The component listens for the browser's offline event; it does not poll.
  await expect(
    page.getByText("Offline — capture is disabled until the connection returns."),
  ).toBeVisible({ timeout: 15_000 });

  await context.setOffline(false);
});
