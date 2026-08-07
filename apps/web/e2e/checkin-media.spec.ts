import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * Mục 3 — "log tâm trạng, Logged ✓" and "log 1 phim đã có trong thư viện (khác hoa/thường) →
 * chỉ 1 media item, 2 note trỏ vào nó".
 *
 * The copy here is lower-case on web ("logged ✓", "undo") and title-case on mobile ("Logged ✓",
 * "Undo"). That is not a bug to fix in passing -- it is why these assertions are written against
 * what each app actually renders rather than against a shared constant.
 */

// Written by global-setup.ts beside the cookies, so the API-level assertion below needs no
// extra wiring from the workflow.
const token = () => readFileSync("e2e/.auth/token.txt", "utf8").trim();

test("a mood check-in is acknowledged and can be undone", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Mood 4 of 5 — good" }).click();
  await expect(page.getByRole("status")).toHaveText("logged ✓", { timeout: 15_000 });

  // Undo is the safety net instead of a confirm dialog, so it has to actually work.
  await page.getByRole("button", { name: "undo" }).click();
  await expect(page.getByText("logged ✓")).toHaveCount(0, { timeout: 15_000 });
});

test("energy alone is a valid check-in", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "more" }).click();
  await page.getByRole("group", { name: "Energy" }).getByRole("button", { name: "3" }).click();
  await page.getByRole("button", { name: "Log", exact: true }).click();

  // buildCheckinPayload accepts mood-only, energy-only or both; the DB constraint
  // checkins_mood_or_energy is what makes "label alone" the only invalid shape.
  await expect(page.getByRole("status")).toHaveText("logged ✓", { timeout: 15_000 });
  await page.getByRole("button", { name: "undo" }).click();
});

test("logging a title that differs only in case reuses the existing media item", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Log media" }).click();

  // The seed logged "Dune" as a movie. Find-or-create keys on (user_id, kind, lower(title)),
  // so this must land on that same row rather than creating a second one.
  await page.getByLabel("Media kind").selectOption("movie");
  await page.getByLabel("Title").fill("DUNE");
  await page.getByRole("radio", { name: "5 stars" }).click();
  await page.getByLabel("Impressions").fill("Second log of the same film, shouted.");
  await page.getByRole("button", { name: "Log", exact: true }).click();

  // The form closes via onDone() once the write succeeds.
  await expect(page.getByRole("button", { name: "Log media" })).toBeVisible({ timeout: 15_000 });

  // The rest is a server-side decision the page never shows, so it is checked through
  // PostgREST with the user's own token -- under RLS, exactly as the app's reads run.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const headers = { apikey: anon, Authorization: `Bearer ${token()}` };

  const items = await (
    await request.get(
      `${supabaseUrl}/rest/v1/media_items?select=id,title&kind=eq.movie&title=ilike.dune&deleted_at=is.null`,
      { headers },
    )
  ).json();
  expect(items, "one media item, not one per spelling").toHaveLength(1);
  // The seeded casing wins, because the row was matched rather than inserted.
  expect(items[0].title).toBe("Dune");

  const notes = await (
    await request.get(
      `${supabaseUrl}/rest/v1/notes?select=id&media_item_id=eq.${items[0].id}&deleted_at=is.null`,
      { headers },
    )
  ).json();
  expect(notes.length, "both logs point at the same item").toBeGreaterThanOrEqual(2);
});

test("export offers a download", async ({ page }) => {
  await page.goto("/");

  // GET /export needs a bearer header, so the button fetches a blob and clicks a synthetic
  // anchor -- there is no navigation to assert on, only the download event.
  const download = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "Export all" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
});
