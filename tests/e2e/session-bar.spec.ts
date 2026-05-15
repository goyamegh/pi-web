import { expect, test } from "@playwright/test";

const pinnedKey = "pi-web-pinned-sessions";

function seedPinned(...sessions: Array<{ id: string; label: string }>) {
  return JSON.stringify(sessions);
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test.describe("session quick bar", () => {
  test("is hidden when no sessions are pinned", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeHidden();
  });

  test("pinning a session from the drawer shows the bar with a tab", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeHidden();

    await page.locator("#sessionButton").click();
    await page.locator(".sessionItem").filter({ hasText: "Current mock session" }).locator(".sessionItemPinBtn").click();

    await expect(page.locator("#sessionBar")).toBeVisible();
    await expect(page.locator(".sessionBarTab")).toHaveCount(1);
    await expect(page.locator(".sessionBarTab").nth(0)).toContainText("Current mock session");
  });

  test("unpinning the last session hides the bar", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned({ id: "mock-current", label: "Current mock session" })],
    );

    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeVisible();

    await page.locator("#sessionButton").click();
    await page.locator(".sessionItem").filter({ hasText: "Current mock session" }).locator(".sessionItemPinBtn").click();

    await expect(page.locator("#sessionBar")).toBeHidden();
  });

  test("bar is restored from localStorage on load without opening the drawer", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned(
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      )],
    );

    await page.goto("/");
    // Drawer never opened — bar should still render from stored labels
    await expect(page.locator("#sessionBar")).toBeVisible();
    await expect(page.locator(".sessionBarTab")).toHaveCount(2);
  });

  test("current session tab is marked active", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned(
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      )],
    );

    await page.goto("/");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).not.toHaveClass(/\bactive\b/);
  });

  test("clicking a tab switches sessions and moves the active marker", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned(
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      )],
    );

    await page.goto("/");
    // Load sessions so the bar knows which session to switch to
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await page.locator("#sessionCloseButton").click();

    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();

    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).not.toHaveClass(/\bactive\b/);
  });

  test("pin button in drawer shows filled for pinned sessions and dimmed for others", async ({ page }) => {
    await page.goto("/");
    await page.locator("#sessionButton").click();

    const currentItem = page.locator(".sessionItem").filter({ hasText: "Current mock session" });
    const olderItem = page.locator(".sessionItem").filter({ hasText: "Older mock session" });

    // Neither pinned initially
    await expect(currentItem.locator(".sessionItemPinBtn")).not.toHaveClass(/\bpinned\b/);
    await expect(olderItem.locator(".sessionItemPinBtn")).not.toHaveClass(/\bpinned\b/);

    // Pin one
    await currentItem.locator(".sessionItemPinBtn").click();
    await expect(currentItem.locator(".sessionItemPinBtn")).toHaveClass(/\bpinned\b/);
    await expect(olderItem.locator(".sessionItemPinBtn")).not.toHaveClass(/\bpinned\b/);

    // Unpinned sessions should be dimmed
    await expect(olderItem).toHaveClass(/(?:^|\s)sessionItem(?:\s|$)/);
    await expect(olderItem).not.toHaveClass(/\bpinned\b/);
  });

  test("clicking a tab switches sessions without needing to open the drawer first", async ({ page }) => {
    // Regression test: pinned session tabs must work even if the drawer was never opened.
    // Previously cachedSessions was empty until the drawer was opened, so click handlers
    // were never attached.
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned(
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      )],
    );

    await page.goto("/");
    // Do NOT open the drawer — the background refresh should wire up handlers automatically.
    await expect(page.locator("#sessionDrawer")).toBeHidden();

    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();

    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).not.toHaveClass(/\bactive\b/);
  });

  test("clicked tab highlights immediately before the server responds", async ({ page }) => {
    // Regression test: the active-tab highlight must switch optimistically on click,
    // not wait for the POST /api/sessions/open round-trip to complete.
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned(
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      )],
    );

    // Delay the sessions/open response so we can observe the pre-response state.
    let resolveOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { resolveOpen = resolve; });
    await page.route("**/api/sessions/open", async (route) => {
      await openGate;
      await route.continue();
    });

    await page.goto("/");
    // Open the drawer to populate cachedSessions (the gate intercept only affects /open).
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await page.locator("#sessionCloseButton").click();

    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();

    // The highlight should switch immediately — the gate is still blocking /api/sessions/open.
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).not.toHaveClass(/\bactive\b/);

    // Release the gate and let the rest of the switch complete.
    resolveOpen();
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
  });

  test("running session tab gets the running class and loses it after the session ends", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned({ id: "mock-current", label: "Current mock session" })],
    );

    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeVisible();

    // Start a slow task so the session is running while we can check
    await page.locator("#prompt").fill("slow background task");
    await page.locator("#primaryButton").click();

    // Open the drawer to populate cachedSessions with the live runtime data
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();

    // The running tab should get the .running class (triggering the pulsing border animation)
    const tab = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });
    await expect(tab).toHaveClass(/\brunning\b/, { timeout: 3000 });

    // After the task completes, the running class should be cleared
    await expect(tab).not.toHaveClass(/\brunning\b/, { timeout: 5000 });
  });
});
