import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
});

test.describe("keyboard shortcuts", () => {
  test("ctrl/cmd+b toggles the session drawer", async ({ page }) => {
    await expect(page.locator("#sessionDrawer")).toBeHidden();

    await page.keyboard.press("Control+B");
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    await page.keyboard.press("Control+B");
    await expect(page.locator("#sessionDrawer")).toBeHidden();
  });

  test("escape in the prompt stops the running session", async ({ page }) => {
    const prompt = page.locator("#prompt");
    await prompt.fill("slow running task");
    await page.locator("#primaryButton").click();
    await expect(page.locator("#stopButton")).toBeVisible();

    await prompt.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#stopButton")).toBeHidden({ timeout: 3000 });
  });
});
