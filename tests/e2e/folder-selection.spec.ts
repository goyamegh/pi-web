import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSessionUiState } from "./helpers/sessionUiState.js";

// Regression coverage for folder selection (goyamegh fork):
// sessionCwd() on the server resolves a session's folder via
// sessionManager.getCwd() and falls back to the server-global boot cwd.
// Adapters that omit getCwd (Claude Code did; the mock harness ignored the
// requested cwd entirely) made picking a folder from the drawer or the
// folder picker appear to do nothing — the status bar and session grouping
// kept showing the old folder.

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

/** Drive the responsive folder picker (quick view → browse → path edit → Use). */
async function pickFolder(page: import("@playwright/test").Page, target: string) {
  await expect(page.getByRole("dialog", { name: "Folder" })).toBeVisible();
  await page.getByRole("button", { name: "Browse folders" }).click();
  await page.getByRole("button", { name: "Edit folder path" }).click();
  const input = page.getByRole("textbox", { name: "Folder path" });
  await expect(input).toBeVisible();
  await input.fill(target);
  await input.press("Enter");
  await page.getByRole("button", { name: `Use ${target}` }).click();
}

test("selecting a folder from the picker switches the working directory", async ({ page }) => {
  const target = mkdtempSync(join(tmpdir(), "pi-web-folder-select-"));
  await page.goto("/");

  // Start a fresh session so the empty-state cwd chooser is visible.
  await page.locator("#prompt").fill("/clear");
  await page.locator("#primaryButton").click();
  await expect(page.locator("#statusTitle")).toHaveText("New session");

  const emptyState = page.locator("#emptyCwdChooser");
  await expect(emptyState).toBeVisible();
  await emptyState.getByRole("button", { name: "Change working directory" }).click();

  await pickFolder(page, target);

  // The picker should close and the status bar should show the new cwd.
  await expect(page.locator(".folderPicker")).toHaveCount(0);
  await expect(page.locator("#statusPath")).toHaveText(target);
});

test("repo info bar follows the session folder after a switch", async ({ page }) => {
  // Regression: fetchInfo() used state.activeCwd (CC-only) and fell back to
  // the server-global cwd, so after a folder switch the bar kept showing the
  // boot repo forever.
  const cwdParams: string[] = [];
  await page.route("**/api/repo-info**", async (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd");
    if (cwd) cwdParams.push(cwd);
    await route.continue();
  });

  const target = mkdtempSync(join(tmpdir(), "pi-web-folder-select-"));
  await page.goto("/");
  // Boot cwd is the pi-web repo — the bar starts visible.
  await expect(page.locator("#repoInfoBar")).toBeVisible();

  await page.locator("#prompt").fill("/clear");
  await page.locator("#primaryButton").click();
  await expect(page.locator("#statusTitle")).toHaveText("New session");
  const emptyState = page.locator("#emptyCwdChooser");
  await expect(emptyState).toBeVisible();
  await emptyState.getByRole("button", { name: "Change working directory" }).click();
  await pickFolder(page, target);
  await expect(page.locator("#statusPath")).toHaveText(target);

  // The bar must query and reflect the session's new folder — a temp dir
  // with no git repo renders the notRepo state showing that path — instead
  // of continuing to show the boot repo.
  await expect(page.locator("#repoInfoBar")).toHaveClass(/notRepo/);
  await expect(page.locator("#repoInfoBar .repoInfoPath")).toHaveText(target);
  await expect.poll(() => cwdParams.at(-1)).toBe(target);
});

test("new-session button on a drawer folder starts a session in that folder", async ({ page }) => {
  const target = mkdtempSync(join(tmpdir(), "pi-web-folder-select-"));
  await seedSessionUiState(page, { pinnedFolders: [target] });
  await page.goto("/");

  await page.locator("#sessionButton").click();
  const group = page.locator(".sessionFolderGroup.pinned").first();
  await expect(group).toBeVisible();
  await group.locator(".sessionFolderNewButton").click();

  await expect(page.locator("#statusPath")).toHaveText(target);
});

test("a mock reset forgets folder switches so later specs see the boot cwd and a unique session index", async ({ page }) => {
  // Regression: switching folders taught the server extra cwds; after
  // /api/mock/reset the mock lister still ran once per remembered cwd and
  // returned every session twice, blanking the drawer for every later spec.
  const bootCwd = (await (await page.request.get("/api/state")).json()).cwd as string;
  const target = mkdtempSync(join(tmpdir(), "pi-web-folder-select-"));
  await seedSessionUiState(page, { pinnedFolders: [target] });
  const created = await (await page.request.post("/api/sessions/new", { data: { cwd: target } })).json();
  expect(created.ok).toBe(true);
  expect(created.cwd).toBe(target);

  await page.request.post("/api/mock/reset");
  const state = await (await page.request.get("/api/state")).json();
  expect(state.cwd).toBe(bootCwd);
  const { sessions } = await (await page.request.get("/api/sessions")).json();
  const ids = sessions.map((item: { id: string }) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(expect.arrayContaining(["mock-current", "mock-older"]));
});
