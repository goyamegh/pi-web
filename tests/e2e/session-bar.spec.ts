import { expect, test } from "@playwright/test";

async function seedServerPinned(page: import("@playwright/test").Page, ...sessions: Array<{ id: string; label: string; cwd?: string }>) {
  await page.request.patch("/api/session-ui-state", { data: { pinnedSessions: sessions } });
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test.describe("session quick bar", () => {
  test("shows the current session as an unpinned tab when none are pinned", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeVisible();
    await expect(page.locator(".sessionBarTab.temporary")).toContainText("Current mock session");
  });

  test("pinning the current session from the header makes the tab pinned", async ({ page }) => {
    await page.goto("/");

    await page.locator(".sessionBarTab.temporary .sessionBarTabAction").click();

    await expect(page.locator("#sessionBar")).toBeVisible();
    await expect(page.locator(".sessionBarTab.pinned")).toHaveCount(1);
    await expect(page.locator(".sessionBarTab.pinned").nth(0)).toContainText("Current mock session");
  });

  test("unpinning the last pinned session leaves it as the current unpinned tab", async ({ page }) => {
    await seedServerPinned(page, { id: "mock-current", label: "Current mock session" });

    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeVisible();

    page.on("dialog", (dialog) => dialog.accept());
    await page.locator(".sessionBarTab.pinned .sessionBarTabAction").click();

    await expect(page.locator("#sessionBar")).toBeVisible();
    await expect(page.locator(".sessionBarTab.temporary")).toContainText("Current mock session");
  });

  test("bar is restored from server storage on load without opening the drawer", async ({ page }) => {
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
    );

    await page.goto("/");
    // Drawer never opened — bar should still render from server-stored labels
    await expect(page.locator("#sessionBar")).toBeVisible();
    await expect(page.locator(".sessionBarTab")).toHaveCount(2);
  });

  test("current session tab is marked active", async ({ page }) => {
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
    );

    await page.goto("/");
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Current mock session" })).toHaveClass(/\bactive\b/);
    await expect(page.locator(".sessionBarTab").filter({ hasText: "Older mock session" })).not.toHaveClass(/\bactive\b/);
  });

  test("clicking a tab switches sessions and moves the active marker", async ({ page }) => {
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
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

  test("session drawer uses selected marker colors and one-line marker actions", async ({ page }) => {
    await page.goto("/");
    await page.locator("#sessionButton").click();

    await expect(page.locator(".sessionMarkerColorButton.selected")).toContainText("Blue");

    const olderItem = page.locator(".sessionItem").filter({ hasText: "Older mock session" });
    const markerButton = olderItem.locator(".sessionItemMarkerBtn");

    await markerButton.click();
    await expect(olderItem).toHaveClass(/\bmarked\b/);
    await expect(olderItem).toHaveClass(/marker-blue/);
    await expect(olderItem.locator(".sessionMarkerChip")).toHaveCount(0);

    await markerButton.click();
    await expect(olderItem).not.toHaveClass(/\bmarked\b/);

    await page.locator(".sessionMarkerColorButton.marker-green").click();
    await expect(page.locator(".sessionMarkerColorButton.selected")).toContainText("Green");
    await markerButton.click();

    await expect(olderItem).toHaveClass(/marker-green/);
    await expect(olderItem.locator(".sessionMarkerChip")).toHaveCount(0);

    await olderItem.locator(".sessionItemActionsBtn").click();
    await expect(page.locator(".sessionActionsMarkerRow")).toBeVisible();
    await expect(page.locator(".sessionActionsMarkerRow")).toContainText("Marker");
    await expect(page.locator(".sessionActionsMarkerButton")).toHaveCount(6);
    await page.locator(".sessionActionsMarkerButton.marker-red").click();
    await expect(olderItem).toHaveClass(/marker-red/);

    await page.locator(".sessionDrawerFilterSelect").selectOption("red");
    await expect(page.locator(".sessionItem")).toHaveCount(1);
    await expect(page.locator(".sessionItem")).toContainText("Older mock session");
  });

  test("clicking a tab switches sessions without needing to open the drawer first", async ({ page }) => {
    // Regression test: pinned session tabs must work even if the drawer was never opened.
    // Previously cachedSessions was empty until the drawer was opened, so click handlers
    // were never attached.
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
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
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
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
    await seedServerPinned(page, { id: "mock-current", label: "Current mock session" });

    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeVisible();

    // Start a slow task so the session is running while we can check.
    await page.locator("#prompt").fill("slow background task");
    await page.locator("#primaryButton").click();

    // The running tab should get the .running class without needing to open the
    // drawer — session_runtime_changed events now drive the bar directly.
    const tab = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });
    await expect(tab).toHaveClass(/\brunning\b/, { timeout: 3000 });

    // After the task completes, the running class should be cleared.
    await expect(tab).not.toHaveClass(/\brunning\b/, { timeout: 5000 });
  });

  test("running class appears on a background session without opening the drawer", async ({ page }) => {
    // Regression: running state for any pinned session must appear via
    // session_runtime_changed WebSocket events, not just when refreshSessions() fires.
    await seedServerPinned(
      page,
      { id: "mock-current", label: "Current mock session" },
      { id: "mock-older", label: "Older mock session" },
    );

    await page.goto("/");
    // Switch to the older session so mock-current is a background tab.
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await page.locator(".sessionItem").filter({ hasText: "Older mock session" }).locator(".sessionItemNavBtn").click();
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    // Drawer auto-closes on narrow viewports after a session switch; only close manually if still open.
    if (await page.locator("#sessionDrawer").isVisible()) {
      await page.locator("#sessionCloseButton").click();
      await expect(page.locator("#sessionDrawer")).toBeHidden();
    }

    // Send a message to the background session (mock-current is still live).
    // Use the sessions/open API directly to prompt without switching the UI.
    await page.evaluate(async () => {
      const token = document.querySelector<HTMLInputElement>("#tokenInput")?.value || "";
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers["authorization"] = `Bearer ${token}`;
      // Open mock-current session in background then fire a prompt at it.
      const openRes = await fetch("/api/sessions/open", { method: "POST", headers, body: JSON.stringify({ sessionId: "mock-current", cwd: "." }) });
      await openRes.json();
      await fetch("/api/prompt", { method: "POST", headers, body: JSON.stringify({ sessionId: "mock-current", message: "slow background task" }) });
    });

    const currentTab = page.locator(".sessionBarTab").filter({ hasText: "Current mock session" });
    await expect(currentTab).toHaveClass(/\brunning\b/, { timeout: 4000 });
    await expect(currentTab).not.toHaveClass(/\brunning\b/, { timeout: 6000 });
  });
});
