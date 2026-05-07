import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function sendPrompt(page: import("@playwright/test").Page, prompt: string) {
  await page.locator("#prompt").fill(prompt);
  await page.locator("#primaryButton").click();
}

async function scrollMessagesToBottom(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const messages = document.querySelector("#messages");
    if (messages) messages.scrollTop = messages.scrollHeight;
  });
}

async function startEmptySession(page: import("@playwright/test").Page) {
  await page.locator("#sessionButton").click();
  await page.locator("#sessionNewButton").click();
  await expect(page.locator("#statusTitle")).toHaveText("New session");
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  const artifactDir = join(process.cwd(), ".pi-web-uploads", "artifacts");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "e2e-test.png"), await readFile(join(process.cwd(), "tests", "fixtures", "showcase-artifact.png")));
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
  test("hero showcase", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");

    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 1000 });

    await page.goto("/");
    await expect(page.locator("#prompt")).toBeVisible();
    await startEmptySession(page);

    await sendPrompt(page, "showcase");
    await expect(page.locator(".message.assistant .markdownBody pre").last()).toBeVisible();
    await expect(page.locator(".toolCard.toolCard--success", { hasText: "read" })).toBeVisible();
    await expect(page.locator(".toolCard.toolCard--success", { hasText: "edit" })).toBeVisible();
    await expect(page.locator(".message.assistant .imageFrame")).toBeVisible();
    if (testInfo.project.name === "mobile") await scrollMessagesToBottom(page);

    await expect(page).toHaveScreenshot(`hero-showcase-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("sessions drawer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");

    await page.goto("/");
    await sendPrompt(page, "slow background task");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await expect(page.locator(".sessionSpinner")).toBeVisible();

    await expect(page).toHaveScreenshot(`sessions-drawer-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("diff review", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "tablet", "Covered by mobile and desktop visual snapshots");

    await page.goto("/");
    await sendPrompt(page, "edit diff");
    await expect(page.locator(".toolCard.toolCard--success", { hasText: "edit" })).toBeVisible();
    await scrollMessagesToBottom(page);

    await expect(page).toHaveScreenshot(`diff-review-${testInfo.project.name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });
});
