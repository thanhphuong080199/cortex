import { expect, test } from "@playwright/test";

/**
 * Mục 3 — "danh sách có ≥3 note, chuyển view, tìm 1 từ chỉ nằm trong 1 note".
 *
 * Search and view filtering are server-rendered from the URL (page.tsx reads searchParams
 * through parseNoteFilters), so these navigate rather than waiting on Realtime.
 */
test("the seeded list has at least three notes", async ({ page }) => {
  await page.goto("/");
  // A floor, not an exact count: the suite captures notes of its own and the count grows.
  expect(await page.locator("ul.notes > li").count()).toBeGreaterThanOrEqual(3);
});

test("search narrows to the single note containing the word", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search notes").fill("zarquon");
  await page.getByRole("button", { name: "Search" }).click();

  await expect(page.getByRole("link", { name: "Zarquon note" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Apostrophe note" })).toHaveCount(0);
  expect(await page.locator("ul.notes > li").count()).toBe(1);
});

/**
 * The mobile mirror of this asserts that searching "don't" FINDS the note containing it,
 * because there the risk is FTS5 syntax: a bare apostrophe is a quote character to MATCH, so
 * an unescaped query either errors or matches nothing.
 *
 * On web the same input must NOT be asserted to return a hit, and that is not a bug to fix.
 * Postgres's `english` configuration treats both halves of "don't" as stop words -- checked
 * directly: `to_tsvector('english', 'I don''t want …')` is
 * `'apostroph':11 'choke':8 'token':6 'want':4`, with no `don` at all, and
 * `websearch_to_tsquery('english', 'don''t')` raises "query contains only stop words" and
 * yields an empty query. An empty tsquery matching nothing is correct behaviour.
 *
 * What is worth asserting is that the page survives it: renders the empty state rather than
 * throwing into error.tsx, and that a real word in the same note still finds it.
 */
test("an apostrophe-only query yields the empty state, not an error", async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent("don't")}`);
  await expect(page.getByText("Nothing here yet.")).toBeVisible({ timeout: 15_000 });
  // error.tsx renders on a thrown query; make sure that is not what we are looking at.
  await expect(page.getByLabel("Quick capture")).toBeVisible();
});

test("a searchable word in the apostrophe note still finds it", async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent("tokenizer")}`);
  await expect(page.getByRole("link", { name: "Apostrophe note" })).toBeVisible({ timeout: 15_000 });
});

test("a search that matches nothing says so rather than showing everything", async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent("qwertyuiopnomatch")}`);
  // The failure this guards against is a dropped filter silently falling back to the whole
  // inbox, which is issue-log E5 -- and which looks like a working page.
  await expect(page.getByText("Nothing here yet.")).toBeVisible();
});

test("switching to a view the note is not in hides it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Zarquon note" })).toBeVisible();

  // Seeded notes are `inbox`; the archived view must not contain them.
  await page.goto("/?view=archived");
  await expect(page.getByRole("link", { name: "Zarquon note" })).toHaveCount(0);
});

test("the domain chip is its own toggle", async ({ page }) => {
  await page.goto("/");
  // "Zarquon note" was seeded with domain "learning" (e2e/scripts/seed.mjs).
  await page.getByRole("link", { name: "learning", exact: true }).click();
  await expect(page).toHaveURL(/domain=learning/);
  await expect(page.getByRole("link", { name: "Zarquon note" })).toBeVisible();

  // Clicking the active chip clears it -- page.tsx builds domainHref that way on purpose.
  await page.getByRole("link", { name: "learning", exact: true }).click();
  await expect(page).not.toHaveURL(/domain=learning/);
});
