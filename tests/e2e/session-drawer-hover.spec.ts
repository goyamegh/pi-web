import { expect, test, type Page } from "@playwright/test";

// Fork: resting the mouse on the hamburger peeks the sessions drawer (Chrome-style
// side panel); leaving closes it again; clicking or working inside pins it.

async function openApp(page: Page) {
  await page.request.post("/api/mock/reset");
  await page.goto("/");
  await expect(page.locator("#connectionStatus")).toBeHidden();
  await expect(page.locator("#sessionDrawer")).toBeHidden();
}

async function hoverTrigger(page: Page) {
  const box = await page.locator("#sessionButton").boundingBox();
  if (!box) throw new Error("sessions button has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function moveAway(page: Page) {
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width - 20, viewport.height / 2);
}

test.describe("sessions drawer hover peek", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test("hovering the hamburger peeks the drawer and leaving closes it", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "hover peeks only apply to split-pane desktop layouts");
    const drawer = page.locator("#sessionDrawer");
    await hoverTrigger(page);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Current mock session")).toBeVisible();
    // A peek is transient: no history entry, and the prompt keeps focus.
    await expect(page.locator("#sessionButton")).toHaveAttribute("aria-expanded", "true");
    const historyLength = await page.evaluate(() => history.length);

    await moveAway(page);
    await expect(drawer).toBeHidden();
    expect(await page.evaluate(() => history.length)).toBe(historyLength);

    // Moving from the trigger into the drawer keeps it open.
    await hoverTrigger(page);
    await expect(drawer).toBeVisible();
    const drawerBox = (await drawer.boundingBox())!;
    await page.mouse.move(drawerBox.x + drawerBox.width / 2, drawerBox.y + drawerBox.height / 2);
    await page.waitForTimeout(600);
    await expect(drawer).toBeVisible();
    await moveAway(page);
    await expect(drawer).toBeHidden();
  });

  test("clicking the hamburger during a peek pins the drawer open", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "hover peeks only apply to split-pane desktop layouts");
    const drawer = page.locator("#sessionDrawer");
    await hoverTrigger(page);
    await expect(drawer).toBeVisible();
    await page.locator("#sessionButton").click();
    await expect(drawer).toBeVisible();
    await moveAway(page);
    await page.waitForTimeout(600);
    await expect(drawer).toBeVisible();
    // Once pinned, the hamburger toggles normally again.
    await page.locator("#sessionButton").click();
    await expect(drawer).toBeHidden();
  });

  test("working inside a peeked drawer pins it", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "hover peeks only apply to split-pane desktop layouts");
    const drawer = page.locator("#sessionDrawer");
    await hoverTrigger(page);
    await expect(drawer).toBeVisible();
    await drawer.locator(".sessionDrawerSearch").click();
    await drawer.locator(".sessionDrawerSearch").fill("older");
    await moveAway(page);
    await page.waitForTimeout(600);
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".sessionItem")).toContainText("Older mock session");
  });

  test("touch pointers and narrow (overlay) layouts never peek", async ({ page }, testInfo) => {
    const drawer = page.locator("#sessionDrawer");
    await page.locator("#sessionButton").dispatchEvent("pointerenter", { pointerType: "touch" });
    await page.waitForTimeout(500);
    await expect(drawer).toBeHidden();
    if (testInfo.project.name !== "desktop") {
      // The drawer is an overlay below the split-pane breakpoint: a mouse passing
      // the corner must not pop it open.
      await hoverTrigger(page);
      await page.waitForTimeout(500);
      await expect(drawer).toBeHidden();
    }
    // A tap still opens it the normal way.
    await page.locator("#sessionButton").click();
    await expect(drawer).toBeVisible();
  });
});
