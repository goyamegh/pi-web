import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  const input = page.locator(".folderPickerInput");
  await expect(input).toBeVisible();
  // Wait for the picker's initial directory load, which rewrites input.value.
  await expect(page.locator(".folderPickerRow").first()).toBeVisible();
  await input.fill(target);
  await input.press("Enter");
  await expect(input).toHaveValue(target);
  await page.getByRole("button", { name: "Select folder" }).click();

  // The picker should close and the status bar should show the new cwd.
  await expect(page.locator(".folderPicker")).toHaveCount(0);
  await expect(page.locator("#statusPath")).toHaveText(target);
});

test("new-session button on a drawer folder starts a session in that folder", async ({ page }) => {
  const target = mkdtempSync(join(tmpdir(), "pi-web-folder-select-"));
  await page.request.patch("/api/session-ui-state", { data: { pinnedFolders: [target] } });
  await page.goto("/");

  await page.locator("#sessionButton").click();
  const group = page.locator(".sessionFolderGroup.pinned").first();
  await expect(group).toBeVisible();
  await group.locator(".sessionFolderNewButton").click();

  await expect(page.locator("#statusPath")).toHaveText(target);
});
