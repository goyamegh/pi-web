import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("user scroll intent pauses stream following before the next streamed update", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#prompt")).toBeVisible();

  await page.locator("#messages").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  await page.locator("#prompt").fill("slow pending tool refresh");
  await page.locator("#primaryButton").click();
  await expect(page.locator("#stopButton")).toBeVisible();

  // Simulate the first user movement before the next streamed delta arrives.
  // This is the race we care about: follow must pause on intent, not only after
  // the browser has emitted a scroll event and moved the viewport.
  await page.locator("#messages").dispatchEvent("wheel", { deltaY: -320 });
  const scrollTopAfterIntent = await page.locator("#messages").evaluate((el) => el.scrollTop);

  await expect(page.locator(".jumpToLatestButton")).toBeVisible();
  await expect(page.locator(".message.assistant", { hasText: "Let me check that for you." })).toBeVisible({ timeout: 3000 });

  const scrollTopAfterDelta = await page.locator("#messages").evaluate((el) => el.scrollTop);
  expect(scrollTopAfterDelta).toBeLessThanOrEqual(scrollTopAfterIntent + 1);

  await expect(page.locator(".jumpToLatestButton")).toBeVisible();
});
