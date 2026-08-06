import { expect, test } from "@playwright/test";

/**
 * Mục 3 — an edit made in the editor survives leaving the page, which is the web mirror of the
 * mobile "type immediately, exit, reopen" case.
 *
 * The editor has no Save button: `createDebouncedSaver` writes 800ms after the last keystroke,
 * and `onBlur` flushes early. That debounce is the whole risk -- reloading inside the window is
 * how an edit gets lost -- so these wait for the acknowledged status rather than for a delay.
 */
test("an edit survives a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Edit target" }).click();

  const edited = `REPLACED BY PLAYWRIGHT ${Date.now()}`;
  await page.getByLabel("Note content").fill(edited);

  // STATUS_TEXT in editor.tsx: idle "" -> "Saving…" -> "Saved". Waiting on the final state
  // rather than sleeping is what makes this deterministic.
  await expect(page.getByRole("status")).toHaveText("Saved", { timeout: 15_000 });

  await page.reload();
  await expect(page.getByLabel("Note content")).toHaveValue(edited);
});

test("navigating away flushes an edit that is still inside the debounce window", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Edit target" }).click();

  const edited = `FLUSHED ON UNMOUNT ${Date.now()}`;
  await page.getByLabel("Note content").fill(edited);

  // Deliberately does NOT wait for "Saved". The editor flushes on unmount and on beforeunload
  // precisely so that leaving fast does not discard the last keystrokes; going straight back is
  // the case that proves it.
  await page.goBack();
  await expect(page.getByLabel("Quick capture")).toBeVisible();

  await page.getByRole("link", { name: "Edit target" }).click();
  await expect(page.getByLabel("Note content")).toHaveValue(edited, { timeout: 15_000 });
});

test("a title edit shows up as the list preview", async ({ page }) => {
  const title = `Renamed ${Date.now()}`;

  await page.goto("/");
  await page.getByRole("link", { name: "Zarquon note" }).click();
  await page.getByLabel("Title").fill(title);
  await expect(page.getByRole("status")).toHaveText("Saved", { timeout: 15_000 });

  await page.goto("/");
  // note-list.tsx's `preview` prefers the title over the first line of content, so renaming a
  // note is visible in the list without touching its body.
  await expect(page.getByRole("link", { name: title })).toBeVisible({ timeout: 15_000 });

  // Put it back, so a re-run of the suite still finds "Zarquon note" where the other specs and
  // the Maestro flows expect it.
  await page.getByRole("link", { name: title }).click();
  await page.getByLabel("Title").fill("Zarquon note");
  await expect(page.getByRole("status")).toHaveText("Saved", { timeout: 15_000 });
});
