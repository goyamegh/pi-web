import { expect, test } from "@playwright/test";

/**
 * Slash command picker + dispatch coverage for the composer.
 *
 * The composer fetches /api/commands and renders matches as the user types
 * `/foo`. The dispatch path branches on `command.source`:
 *   - source === "web"     → POST /api/command  (server-handled overlay
 *                            commands like /help, /reload, /new)
 *   - source !== "web"     → POST /api/prompt   (forwarded to the agent;
 *                            for Claude Code this means CC's subprocess
 *                            interprets the leading `/` and runs the
 *                            command/skill itself)
 *
 * The CC adapter's discovery (server/agent/claude-code/commands.ts) emits
 * source: "claude-code" entries — including user-level `~/.claude/commands/*.md`
 * (the `/cp-oncall` case from this branch's bug report) and plugin
 * commands/skills. Pi-web's frontend has to route these correctly without
 * special-casing the agent kind. We mock /api/commands in this test so the
 * harness is independent of the backing agent — what we are pinning is the
 * frontend contract that drives the picker and dispatch.
 */

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test.describe("slash command picker (CC sources)", () => {
  test("renders a claude-code sourced command in the picker and submits via /api/prompt", async ({ page }) => {
    // Inject a CC command into the picker without exercising the real CC
    // adapter — we only care about frontend dispatch in this test.
    await page.route("**/api/commands*", async (route) => {
      const original = await route.fetch();
      const data = await original.json();
      data.commands.push({
        name: "cp-oncall",
        description: "CP Oncall diagnostic assistant for AWS OpenSearch Service.",
        source: "claude-code",
        sourceInfo: { path: "<test>", source: "claude-code", scope: "user", origin: "user-commands" },
      });
      await route.fulfill({ status: 200, body: JSON.stringify(data), headers: { "content-type": "application/json" } });
    });

    // Capture submissions so we can assert which endpoint the composer hits.
    const promptCalls: string[] = [];
    const commandCalls: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      const url = new URL(req.url());
      if (url.pathname === "/api/prompt") promptCalls.push(req.postData() || "");
      else if (url.pathname === "/api/command") commandCalls.push(req.postData() || "");
    });

    await page.goto("/");

    const prompt = page.locator("#prompt");
    await prompt.click();
    await prompt.fill("/cp-oncall");

    // Picker shows the cp-oncall row.
    const picker = page.locator("#slashCommands");
    await expect(picker).toBeVisible();
    const item = picker.locator(".slashCommandItem", { hasText: "/cp-oncall" });
    await expect(item).toBeVisible();
    await expect(item.locator(".slashCommandName")).toHaveText("/cp-oncall");
    await expect(item.locator(".slashCommandSource")).toHaveText("claude-code");

    // Submit with Cmd-Enter (avoids the picker's Enter-to-apply behavior).
    await prompt.press("Meta+Enter");

    // Frontend contract: a non-web command goes through /api/prompt so the
    // active agent (CC) processes the slash itself. /api/command is reserved
    // for pi-web's own overlay (/help, /new, ...).
    await expect.poll(() => promptCalls.length).toBeGreaterThan(0);
    expect(commandCalls).toHaveLength(0);
    const body = JSON.parse(promptCalls[0]);
    expect(body.message).toBe("/cp-oncall");
  });

  test("a `web`-sourced overlay command still routes to /api/command", async ({ page }) => {
    // /help is in webSlashCommandNames; verify the routing didn't get
    // accidentally inverted by the CC bridging change.
    const promptCalls: string[] = [];
    const commandCalls: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      const url = new URL(req.url());
      if (url.pathname === "/api/prompt") promptCalls.push(req.postData() || "");
      else if (url.pathname === "/api/command") commandCalls.push(req.postData() || "");
    });

    await page.goto("/");
    const prompt = page.locator("#prompt");
    await prompt.click();
    await prompt.fill("/help");
    await prompt.press("Meta+Enter");

    await expect.poll(() => commandCalls.length).toBeGreaterThan(0);
    expect(promptCalls).toHaveLength(0);
  });

  test("filters the picker as the user narrows the query", async ({ page }) => {
    await page.route("**/api/commands*", async (route) => {
      const original = await route.fetch();
      const data = await original.json();
      data.commands.push(
        {
          name: "cp-oncall",
          description: "CP Oncall diagnostic assistant",
          source: "claude-code",
          sourceInfo: { source: "claude-code", scope: "user", origin: "user-commands" },
        },
        {
          name: "demo-plugin:investigate",
          description: "Investigate skill from demo-plugin",
          source: "claude-code",
          sourceInfo: { source: "claude-code", scope: "plugin", origin: "demo-plugin" },
        },
      );
      await route.fulfill({ status: 200, body: JSON.stringify(data), headers: { "content-type": "application/json" } });
    });

    await page.goto("/");
    const prompt = page.locator("#prompt");
    await prompt.click();
    await prompt.fill("/cp");

    const picker = page.locator("#slashCommands");
    await expect(picker).toBeVisible();
    await expect(picker.locator(".slashCommandItem", { hasText: "/cp-oncall" })).toBeVisible();
    // The investigate skill matches neither name nor description for "cp" and
    // should not appear; this guards against the picker's filter accidentally
    // becoming substring-on-the-whole-record.
    await expect(picker.locator(".slashCommandItem", { hasText: "/demo-plugin:investigate" })).toHaveCount(0);
  });
});
