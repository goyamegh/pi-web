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

  test("composer footer label shows the agent and model for the active session", async ({ page }) => {
    await page.goto("/");
    // The mock session boots as agent=mock; the composer footer button label
    // still names the active agent so it is visible without opening the
    // popover. The label stacks agent over model in a two-line grid, so the
    // "·" separator only appears in the tooltip/aria-label, not the text.
    const label = page.locator("#modelSettingsLabel");
    await expect(label).toBeVisible();
    await expect(label.locator(".modelSettingsAgentName")).toHaveText(/pi|claude-code|mock/);
    // We don't pin the model name (the mock provider varies), only that one is
    // rendered and that the accessible label joins both with "·".
    await expect(label.locator(".modelSettingsModelName")).not.toBeEmpty();
    await expect(label).toHaveAttribute("title", /·/);
    // dataset.agent is set from state.currentAgent.
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
    // The status-bar button itself is CSS-hidden behind the action launcher, so
    // assert the data-driven `hidden` property the runtime toggles from
    // capabilities.tree (pi → true, Claude Code → false) rather than visibility.
    await page.goto("/");
    await expect(page.locator("#conversationTreeButton")).toHaveJSProperty("hidden", false);
    const limited = { harness: "claude-code", queue: true, steering: false, followUp: true, thinkingLevel: true, tree: false, compaction: true, retry: true, bash: true, extensions: false, interactions: false };
    await page.request.post("/api/mock/state", { data: { capabilities: limited } });
    await expect(page.locator("#conversationTreeButton")).toHaveJSProperty("hidden", true);
    await page.request.post("/api/mock/state", { data: {} });
    await expect(page.locator("#conversationTreeButton")).toHaveJSProperty("hidden", false);
  });

  test("/api/state reports the harness and capabilities so the frontend can gate features", async ({ page }) => {
    const res = await page.request.get("/api/state");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.capabilities).toBeDefined();
    expect(["pi", "claude-code", "mock"]).toContain(body.capabilities.harness);
    // The flags pi-web's frontend currently consumes; absence of any of these
    // is a wire-format regression that would silently break gating.
    for (const key of ["queue", "steering", "followUp", "thinkingLevel", "tree", "compaction", "retry", "bash", "extensions", "interactions"]) {
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
   * fff419f added a one-time dev-mode cleanup to src/main.ts that unregisters
   * stale production Service Workers and reloads once (guarded by a
   * sessionStorage flag). The e2e server runs the production bundle, so the
   * behavioural contract we can assert here is the reload guard itself.
   */
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
