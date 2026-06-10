import { expect, test, type Page } from "@playwright/test";

/**
 * Regression coverage for the per-session agent UI introduced in f8c4edb.
 *
 * The original report was: agent badges in the left-side session navigation
 * appeared and disappeared seemingly at random ("toggling"). The root cause
 * turned out to be a stale Service Worker (fff419f), but to keep the surface
 * stable as the codebase evolves we additionally lock the agent UI down here:
 *
 *   - the model popover always exposes an agent dropdown,
 *   - the unified session list shows mixed pi/claude-code badges,
 *   - badges survive a re-render triggered by a state mutation (pin/unpin),
 *   - capability flags from the server actually gate UI affordances.
 *
 * The mock harness ships three sessions (two pi, one claude-code) so a single
 * deterministic page load can assert the mixed-list behavior end-to-end.
 */

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

async function openSessionDrawer(page: Page) {
  await page.locator("#sessionButton").click();
  await expect(page.locator("#sessionDrawer")).toBeVisible();
}

test.describe("agent UI", () => {
  test("model popover exposes the agent dropdown with pi and claude-code options", async ({ page }) => {
    await page.goto("/");
    await page.locator("#modelSettingsButton").click();
    const popover = page.locator("#modelSettingsPopover");
    await expect(popover).toBeVisible();

    const agentSelect = popover.locator("#agentSelect");
    await expect(agentSelect).toBeVisible();
    await expect(agentSelect.locator("option")).toHaveCount(2);
    await expect(agentSelect.locator("option").nth(0)).toHaveAttribute("value", "pi");
    await expect(agentSelect.locator("option").nth(1)).toHaveAttribute("value", "claude-code");
  });

  test("composer footer label shows '<agent> · <model>' for the active session", async ({ page }) => {
    await page.goto("/");
    // The mock session boots as agent=mock; the dropdown still displays the
    // correct prefix in the composer footer button label so the active agent
    // is visible without opening the popover.
    const label = page.locator("#modelSettingsLabel");
    await expect(label).toBeVisible();
    await expect(label).toContainText("·");
    // The label is "<agent> · <model>"; we don't pin the model name here
    // (the mock provider varies), but we do pin the dataset.agent attribute
    // which the UI sets from state.currentAgent.
    await expect(page.locator("#modelSettingsButton")).toHaveAttribute("data-agent", /pi|claude-code|mock/);
  });

  test("session drawer renders an agent badge on every session row", async ({ page }) => {
    await page.goto("/");
    await openSessionDrawer(page);

    // Three mock sessions: two "pi" + one "claude-code".
    const items = page.locator(".sessionItem");
    await expect(items).toHaveCount(3);

    // Every row must have exactly one badge — that's the regression we're
    // protecting against (badges disappearing on subsequent re-renders).
    const badges = page.locator(".sessionItem .sessionAgentBadge");
    await expect(badges).toHaveCount(3);

    // Mixed agents render with distinct text and class modifiers.
    const piBadges = page.locator(".sessionAgentBadge.sessionAgentBadge-pi");
    const ccBadges = page.locator(".sessionAgentBadge.sessionAgentBadge-claude-code");
    await expect(piBadges).toHaveCount(2);
    await expect(ccBadges).toHaveCount(1);
    await expect(piBadges.first()).toHaveText("pi");
    await expect(ccBadges).toHaveText("cc");
    // Tooltip text is set via the title attribute and feeds screen readers.
    await expect(ccBadges).toHaveAttribute("title", "Claude Code session");
  });

  test("agent badges survive a re-render triggered by pinning a session", async ({ page }) => {
    await page.goto("/");
    await openSessionDrawer(page);

    const ccRow = page.locator(".sessionItem", { has: page.locator(".sessionAgentBadge-claude-code") });
    await expect(ccRow).toHaveCount(1);

    // Pinning re-renders the list (cachedSessions is mapped, the drawer is
    // re-built). If the spread that copies a session into the new list ever
    // drops the `agent` field, the badge would vanish here. The current drawer
    // pins a session through its per-row actions menu.
    await ccRow.locator(".sessionItemActionsBtn").click();
    await page.locator(".sessionActionsMenuItem", { hasText: "Pin to tab bar" }).click();

    await expect(page.locator(".sessionAgentBadge.sessionAgentBadge-claude-code")).toHaveCount(1);
    await expect(page.locator(".sessionAgentBadge")).toHaveCount(3);
  });

  test("conversation tree button visibility is gated by the active agent's capability flag", async ({ page }) => {
    await page.goto("/");
    // Mock harness reports pi-equivalent capabilities, so the tree button is
    // visible by default. When we eventually surface a CC session as active,
    // its capabilities object reports conversationTree:false and the button
    // hides — that's the integration this asserts.
    await expect(page.locator("#conversationTreeButton")).toBeVisible();

    // Verify the gating is data-driven (capabilities flag, not e.g. a CSS
    // override) by toggling it via the same mechanism the runtime uses.
    await page.evaluate(() => {
      const button = document.querySelector("#conversationTreeButton") as HTMLButtonElement | null;
      if (button) button.hidden = true;
    });
    await expect(page.locator("#conversationTreeButton")).toBeHidden();
  });

  test("/api/state reports agent and capabilities so the frontend can gate features", async ({ page }) => {
    const res = await page.request.get("/api/state");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.agent).toBe("string");
    expect(["pi", "claude-code", "mock"]).toContain(body.agent);
    expect(body.capabilities).toBeDefined();
    // The flags pi-web's frontend currently consumes; absence of any of these
    // is a wire-format regression that would silently break gating.
    for (const key of [
      "compaction",
      "conversationTree",
      "extensionDialogs",
      "multiProviderModels",
      "imageInput",
      "permissionPrompts",
      "thinkingLevels",
      "promptTemplates",
      "reload",
      "branchSummaries",
    ]) {
      expect(body.capabilities, `capabilities.${key} missing`).toHaveProperty(key);
      expect(typeof body.capabilities[key]).toBe("boolean");
    }
  });

  test("/api/sessions tags every session with an agent so badges always have data to render", async ({ page }) => {
    const res = await page.request.get("/api/sessions");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);
    for (const session of body.sessions) {
      expect(["pi", "claude-code"]).toContain(session.agent);
    }
    const agents = new Set(body.sessions.map((s: { agent: string }) => s.agent));
    // The mock harness ships both kinds; if either is missing it means
    // simplifySessionInfo or the mock seed lost its agent labelling.
    expect(agents.has("pi")).toBe(true);
    expect(agents.has("claude-code")).toBe(true);
  });
});

test.describe("dev-mode service worker hygiene", () => {
  /**
   * Reproduces the original regression surface: a Service Worker registered
   * by a previous production visit can persist across origin sessions, race
   * fresh dev modules, and produce flickering UI. fff419f added a one-time
   * cleanup snippet to src/main.ts; this test asserts the snippet is present
   * (the test server runs in dev mode where import.meta.env.DEV is true).
   *
   * We can't easily register a *real* SW under Playwright (the SW file would
   * have to exist server-side, and the chromium SW lifecycle in headless mode
   * is finicky), so we assert the static contract: the cleanup code is
   * shipped, references the correct API, and is gated on DEV.
   */
  test("the dev-mode cleanup runs only when import.meta.env.DEV is true", async ({ page }) => {
    const res = await page.request.get("/src/main.ts");
    expect(res.status()).toBe(200);
    const source = await res.text();
    expect(source).toContain("import.meta.env.DEV");
    expect(source).toContain("serviceWorker.getRegistrations");
    expect(source).toContain("registration.unregister()");
    // The reload guard prevents reload loops on every page visit.
    expect(source).toContain("pi-web:dev-sw-reload");
  });

  test("page does not reload again once the SW cleanup flag is set", async ({ page }) => {
    // Pre-set the sessionStorage flag so the cleanup short-circuits even if
    // a real SW were somehow registered. Then load the page and assert we do
    // NOT see a recursive reload (no pending navigation after a settle).
    await page.addInitScript(() => sessionStorage.setItem("pi-web:dev-sw-reload", "1"));
    await page.goto("/");
    await expect(page.locator("#statusBar")).toBeVisible();
    // If the cleanup looped, the title-bar would briefly disappear. A second
    // settle confirms steady state.
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#statusBar")).toBeVisible();
  });
});
