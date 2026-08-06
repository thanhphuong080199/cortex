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
 * MEASURED, NOT ASSUMED, AND NOT YET EXPLAINED.
 *
 * Under the injected session this does not pass: the write lands (the box clears), the row is
 * in Postgres (a reload shows it), `notes` is in the `supabase_realtime` publication and the
 * realtime container is healthy -- but no postgres_changes event reaches the open page within
 * 5 seconds.
 *
 * Two candidate causes, not distinguished yet, and the difference matters:
 *
 *  - A product race. `createClient()` builds a NEW browser client on every call, and
 *    note-list.tsx calls it inside the effect and subscribes immediately. A fresh client
 *    hydrates its session from cookies asynchronously, so the channel can join before the
 *    access token is applied, and Realtime then evaluates RLS as anon and drops every row. If
 *    that is what is happening, live updates are broken for real users too.
 *  - An artifact of this harness. The session here is injected as cookies by global-setup
 *    rather than established through the OAuth callback, so a real browser session may hydrate
 *    differently.
 *
 * Deliberately `fixme` rather than deleted or quietly reloaded: skipping it silently would
 * remove the only signal that this question is open. Do not "fix" it by adding a reload --
 * that is the test above.
 */
test.fixme("the open page learns about the capture without a reload", async ({ page }) => {
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
