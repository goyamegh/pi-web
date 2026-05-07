import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });
});

test.describe("visual regression", () => {
  test("main chat shell", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");

    await page.goto("/");
    await expect(page.locator("#prompt")).toBeVisible();

    await expect(page).toHaveScreenshot(`main-chat-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("sessions drawer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");

    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    await expect(page).toHaveScreenshot(`sessions-drawer-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("tool result transcript", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");

    await page.goto("/");
    await page.locator("#prompt").fill("use tool");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".toolCard.toolCard--success")).toBeVisible();

    await expect(page).toHaveScreenshot(`tool-result-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });
});
