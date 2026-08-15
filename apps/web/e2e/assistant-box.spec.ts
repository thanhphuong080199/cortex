import { expect, test } from "@playwright/test";

test("a thought is saved even though the assistant cannot answer", async ({ page }) => {
  await page.goto("/");
  const text = `e2e capture ${Date.now()}`;

  await page.getByLabel(/what are you thinking/i).fill(text);
  await page.getByRole("button", { name: /send/i }).click();

  // The note is the deliverable. The API boots with a dummy Gemini key, so the turn fails --
  // and that is precisely the case worth pinning: capture must not depend on the AI path.
  await expect(page.getByText(text)).toBeVisible();
  await expect(page.getByText(/no answer right now/i)).toBeVisible();
});
