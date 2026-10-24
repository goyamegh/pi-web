import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("opens an extension panel from chat and the FAB, then submits its form", async ({ page }) => {
  await page.route("**/api/messages**", (route) => route.fulfill({ json: {
    ok: true,
    messages: [
      { role: "assistant", isError: false, text: "[Missing panel](#panel:missing:note=ignored) · [Malformed panel](#panel::note=ignored)" },
      { role: "user", text: "[Open scanner task](#panel:notes:note=oncall%2Fw34&task=old&task=t-3f2a)" },
    ],
  } }));
  await page.request.post("/api/mock/state", { data: {
    webContributions: [
      { version: 1, key: "notes", slot: "panel", kind: "rendered", title: "Global notepad", label: "Notepad", icon: "notebook-pen" },
      { version: 1, key: "quiet", slot: "panel", kind: "rendered", title: "No launcher", label: "Quiet", icon: "notebook-pen" },
      { version: 1, key: "notes-launcher", slot: "fab", kind: "static", title: "Global notepad", label: "Notepad", icon: "notebook-pen", opens: "notes" },
      { version: 1, key: "open-notes", slot: "header-action", kind: "rendered", title: "Open notes", label: "Open notes", icon: "scroll-text" },
    ],
  } });

  const invocations: any[] = [];
  let revision = 1;
  await page.route("**/api/web-contributions/invoke", async (route) => {
    const input = route.request().postDataJSON();
    invocations.push(input);
    if (input.slot === "header-action") {
      await route.fulfill({ json: {
        ok: true,
        label: "Open notes",
        markdown: "Panel opened from the header.",
        effects: [{ type: "open-panel", key: "notes" }],
      } });
      return;
    }
    const value = input.event?.fields?.content || "Initial global note";
    const status = input.event?.action === "save" ? "Saved globally" : `Shared with every conversation · revision ${revision}`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        title: "Global notepad",
        html: `<form class="webPanelForm" data-web-action="save"><textarea class="webPanelTextarea" name="content" autofocus>${value}</textarea><div class="webPanelFormActions"><span role="status">${status}</span><button class="webPanelButton" type="submit" data-web-action="save">Save</button></div></form>`,
      }),
    });
  });

  const stateLoaded = page.waitForResponse((response) => response.url().includes("/api/state") && response.ok());
  await page.goto("/");
  await stateLoaded;
  // The response can complete before contributions have been applied to the UI.
  await expect(page.locator('.webHeaderActionButton[title="Open notes"]')).toBeVisible();
  await page.locator("#prompt").blur();

  const panel = page.locator("#webExtensionPanel");
  await page.getByRole("link", { name: "Missing panel" }).click();
  await page.getByRole("link", { name: "Malformed panel" }).click();
  await expect(panel).toBeHidden();
  expect(invocations).toEqual([]);

  await page.getByRole("link", { name: "Open scanner task" }).click();
  await expect(panel).toBeVisible();
  await expect.poll(() => invocations.length).toBe(1);
  expect(invocations[0]).toMatchObject({
    slot: "panel",
    key: "notes",
    event: { action: "deep-link", payload: { note: "oncall/w34", task: "t-3f2a" } },
  });
  await panel.getByRole("button", { name: "Close panel" }).click();

  await page.locator(".actionLauncherToggle").click();
  await expect(page.locator(".actionLauncherItem", { hasText: "Notepad" })).toBeVisible();
  await expect(page.locator(".actionLauncherItem", { hasText: "Quiet" })).toHaveCount(0);
  await page.locator(".actionLauncherItem", { hasText: "Notepad" }).click();

  await expect(panel).toBeVisible();  await expect(panel.locator("h2")).toHaveText("Global notepad");
  await expect(panel.locator("textarea")).toHaveValue("Initial global note");
  await expect(panel.getByRole("status")).toContainText("revision 1");

  // Clicking a control inside a <form data-web-action> is not an action: the form's
  // action fires on submit only. (Regression: a click used to submit "save".)
  const invokesBeforeClick = invocations.length;
  await panel.locator("textarea").click();
  await panel.locator("textarea").click();
  await page.waitForTimeout(150);
  expect(invocations.length).toBe(invokesBeforeClick);
  expect(invocations.some((input) => input.event?.action === "save")).toBe(false);

  const invokesBeforeUpdate = invocations.length;
  await panel.locator("textarea").fill("Unsubmitted draft");
  revision = 2;
  await page.request.post("/api/mock/event", { data: { type: "web_contribution_updated", sessionId: "mock-current", key: "notes" } });
  await page.waitForTimeout(100);
  await expect(panel.locator("textarea")).toHaveValue("Unsubmitted draft");
  expect(invocations.length).toBe(invokesBeforeUpdate);

  await page.locator("#prompt").focus();
  await expect(panel.getByRole("status")).toContainText("revision 2");
  expect(invocations.length).toBe(invokesBeforeUpdate + 1);

  await panel.locator("textarea").fill("Remember this everywhere");
  await panel.getByRole("button", { name: "Save" }).click();

  await expect(panel.getByRole("status")).toHaveText("Saved globally");
  expect(invocations.at(-1)).toMatchObject({
    slot: "panel",
    key: "notes",
    event: { action: "save", fields: { content: "Remember this everywhere" } },
  });

  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toBeHidden();
  await page.locator('.webHeaderActionButton[title="Open notes"]').click();
  await expect.poll(() => invocations.some((input) => input.slot === "header-action")).toBe(true);
  await expect(panel).toBeVisible();
  await expect(page.locator(".webHeaderActionPopoverBody")).toContainText("Panel opened from the header.");
});

test("a panel registered with chrome: \"none\" gets no host title bar and closes itself via data-web-action=\"close-panel\"; a default panel keeps the title bar", async ({ page }) => {
  await page.request.post("/api/mock/state", { data: {
    webContributions: [
      { version: 1, key: "bare", slot: "panel", kind: "rendered", title: "Bare panel", label: "Bare", icon: "notebook-pen", chrome: "none" },
      { version: 1, key: "plain", slot: "panel", kind: "rendered", title: "Plain panel", label: "Plain", icon: "notebook-pen" },
      { version: 1, key: "bare-launcher", slot: "fab", kind: "static", title: "Bare panel", label: "Bare", icon: "notebook-pen", opens: "bare" },
      { version: 1, key: "plain-launcher", slot: "fab", kind: "static", title: "Plain panel", label: "Plain", icon: "notebook-pen", opens: "plain" },
    ],
  } });
  const invocations: any[] = [];
  await page.route("**/api/web-contributions/invoke", async (route) => {
    const input = route.request().postDataJSON();
    invocations.push(input);
    const own = input.key === "bare";
    await route.fulfill({ json: {
      ok: true,
      title: own ? "Bare panel" : "Plain panel",
      html: own
        ? `<header class="ownBar" style="display:flex;justify-content:space-between"><span>My own header</span><button type="button" data-web-action="close-panel" aria-label="Close my panel">×</button></header><p>bare body</p>`
        : `<p>plain body</p>`,
    } });
  });

  const stateLoaded = page.waitForResponse((response) => response.url().includes("/api/state") && response.ok());
  await page.goto("/");
  await stateLoaded;
  await expect(page.locator(".actionLauncherToggle")).toBeVisible();
  const panel = page.locator("#webExtensionPanel");
  const hostHeader = panel.locator("header.webPanelHeader");

  // chrome: "none" — no host title bar, no host close button, no gap above the panel's own header.
  await page.locator(".actionLauncherToggle").click();
  await page.locator(".actionLauncherItem", { hasText: "Bare" }).click();
  await expect(panel).toBeVisible();
  await expect(panel.locator(".ownBar")).toHaveText(/My own header/);
  await expect(hostHeader).toBeHidden();
  await expect(panel.getByRole("button", { name: "Close panel" })).toHaveCount(0);
  await expect(panel.getByText("Bare panel")).toBeHidden();
  await expect(panel).toHaveClass(/webPanelChromeless/);
  const [panelBox, barBox] = await Promise.all([panel.boundingBox(), panel.locator(".ownBar").boundingBox()]);
  expect(barBox!.y - panelBox!.y).toBeLessThanOrEqual(2);
  // The reserved action closes the panel on the host side and never reaches the extension.
  const invokesBeforeClose = invocations.length;
  await panel.getByRole("button", { name: "Close my panel" }).click();
  await expect(panel).toBeHidden();
  expect(invocations.length).toBe(invokesBeforeClose);
  expect(invocations.some((input) => input.event?.action === "close-panel")).toBe(false);

  // A panel without the option is unchanged: host title bar with the title and its close button.
  await page.locator(".actionLauncherToggle").click();
  await page.locator(".actionLauncherItem", { hasText: "Plain" }).click();
  await expect(panel).toBeVisible();
  await expect(hostHeader).toBeVisible();
  await expect(panel.locator("h2")).toHaveText("Plain panel");
  await expect(panel).not.toHaveClass(/webPanelChromeless/);
  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toBeHidden();

  // Switching back to the chromeless panel hides the bar again.
  await page.locator(".actionLauncherToggle").click();
  await page.locator(".actionLauncherItem", { hasText: "Bare" }).click();
  await expect(panel).toBeVisible();
  await expect(hostHeader).toBeHidden();
});
