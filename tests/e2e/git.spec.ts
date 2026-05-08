import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("git panel opens, switches views, and commit rows do not overlap", async ({ page }) => {
  await page.goto("/");
  await page.locator("#gitButton").click();
  await expect(page.locator("#gitPanel")).toBeVisible();
  await expect(page.locator("#gitStatusTab")).toHaveClass(/active/);

  await page.locator("#gitGraphTab").click();
  await expect(page.locator("#gitGraphTab")).toHaveClass(/active/);
  await expect(page.locator(".gitCommitItem").first()).toBeVisible();

  const overlaps = await page.locator(".gitCommitItem").evaluateAll((items) => {
    const boxes = items.slice(0, 12).map((item) => item.getBoundingClientRect());
    return boxes.some((box, index) => index > 0 && box.top < boxes[index - 1].bottom - 0.5);
  });
  expect(overlaps).toBe(false);
});

test("git repo accordion switches the selected repo", async ({ page }) => {
  await page.route("**/api/git/repos", (route) => route.fulfill({ json: {
    ok: true,
    cwd: "/workspace",
    depth: 1,
    repos: [
      { path: "repo-a", root: "/workspace/repo-a", branch: "main", upstream: "", ahead: 0, behind: 0, dirtyCount: 1, isCurrent: false },
      { path: "repo-b", root: "/workspace/repo-b", branch: "feature", upstream: "", ahead: 0, behind: 0, dirtyCount: 1, isCurrent: false },
    ],
  } }));
  await page.route("**/api/git/status?**", (route) => {
    const repo = new URL(route.request().url()).searchParams.get("repo");
    return route.fulfill({ json: {
      ok: true,
      isRepo: true,
      root: `/workspace/${repo}`,
      branch: repo === "repo-b" ? "feature" : "main",
      upstream: "",
      defaultRemoteBranch: "",
      ahead: 0,
      behind: 0,
      files: [{ path: repo === "repo-b" ? "b.txt" : "a.txt", indexStatus: " ", worktreeStatus: "M", label: "modified", staged: false }],
    } });
  });
  await page.route("**/api/git/log?**", (route) => route.fulfill({ json: { ok: true, isRepo: true, commits: [] } }));
  await page.route("**/api/git/diff?**", (route) => route.fulfill({ json: { ok: true, path: "file.txt", staged: false, diff: "" } }));

  await page.goto("/");
  await page.locator("#gitButton").click();
  await expect(page.locator(".gitRepoAccordion summary")).toContainText("repo-a");
  await expect(page.locator(".gitFilePath")).toHaveText("a.txt");

  await page.locator(".gitRepoAccordion summary").click();
  await page.locator(".gitRepoItem", { hasText: "repo-b" }).click();

  await expect(page.locator(".gitRepoAccordion summary")).toContainText("repo-b");
  await expect(page.locator(".gitFilePath")).toHaveText("b.txt");
  await expect(page.locator("#gitFooter")).toContainText("repo-b");
});

test("git commit detail shows changed files, diff, and layout toggle", async ({ page }) => {
  await page.goto("/");
  await page.locator("#gitButton").click();
  await page.locator("#gitGraphTab").click();
  await page.locator(".gitCommitItem").first().click();

  await expect(page.locator(".gitCommitDetails")).toBeVisible();
  await expect(page.locator(".gitCommitFiles")).toBeVisible();
  await expect(page.locator(".gitPatchFile").first()).toBeVisible();

  const diff = page.locator(".gitDetailPane .diffContainer").first();
  await expect(diff).toHaveClass(/diffContainer--/);
  const wasStacked = (await diff.getAttribute("class"))?.includes("diffContainer--stacked") ?? false;
  await page.locator(".gitDetailPane .diffLayoutToggle").first().click();
  await expect(diff).toHaveClass(wasStacked ? /diffContainer--sideBySide/ : /diffContainer--stacked/);
});
