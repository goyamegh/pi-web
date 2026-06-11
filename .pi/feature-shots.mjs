import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:8901";
const OUT = ".pi/web/artifacts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const log = [];

async function go() {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(600);
}

// 1. Main view: repo info bar + composer + agent·model footer label
await go();
await page.screenshot({ path: `${OUT}/feat-01-main-repo-bar.png` });
const footerLabel = await page.locator("#modelSettingsLabel").first().textContent().catch(() => "");
const repoBarVisible = await page.locator("#repoInfoBar").isVisible().catch(() => false);
log.push(`footer label: ${JSON.stringify(footerLabel)} | repoInfoBar present: ${await page.locator('#repoInfoBar').count()}`);

// 2. Agent dropdown in the model popover
await page.locator("#modelSettingsButton").click();
await sleep(400);
await page.screenshot({ path: `${OUT}/feat-02-agent-dropdown.png` });
const agentOptions = await page.locator("#modelSettingsPopover select").first().locator("option").allTextContents().catch(() => []);
log.push(`model popover first-select options: ${JSON.stringify(agentOptions)}`);
await page.keyboard.press("Escape").catch(() => {});
await sleep(200);

// 3. Session drawer: 3 sessions, agent badges, filter bar, pin-folder, per-row buttons
await page.locator("#sessionButton").click();
await sleep(600);
await page.screenshot({ path: `${OUT}/feat-03-drawer-badges-filters.png` });
log.push(`agent badges: ${await page.locator('.sessionAgentBadge').count()} (cc=${await page.locator('.sessionAgentBadge-claude-code').count()})`);
log.push(`filter bar 'Hide inactive'/'Saved only': ${await page.locator('.sessionFilterToggle').count()} toggles`);
log.push(`pin-folder buttons: ${await page.locator('.sessionFolderPinButton').count()}`);
log.push(`rename buttons: ${await page.locator('.sessionRenameBtn').count()} | active toggles: ${await page.locator('.sessionActiveToggle').count()} | bookmark btns: ${await page.locator('.sessionBookmarkBtn').count()}`);

// 4. Inline rename input opened on the first row
const firstRow = page.locator(".sessionItem").first();
await firstRow.locator(".sessionRenameBtn").click();
await sleep(300);
await page.screenshot({ path: `${OUT}/feat-04-inline-rename.png` });
log.push(`rename input visible: ${await page.locator('.sessionRenameInput').isVisible().catch(() => false)}`);
await page.keyboard.press("Escape").catch(() => {});
await sleep(200);

// 5. Saved-only filter toggled on
const savedToggle = page.locator(".sessionFilterToggle", { hasText: "Saved only" }).locator("input");
if (await savedToggle.count()) {
  await savedToggle.first().check().catch(() => {});
  await sleep(300);
  await page.screenshot({ path: `${OUT}/feat-05-saved-only-filter.png` });
  await savedToggle.first().uncheck().catch(() => {});
}

// 6. Drawer resize handle present (draggable width)
log.push(`drawer resize handle: ${await page.locator('.sessionDrawerResizeHandle, [data-session-drawer-resize], #sessionDrawer .resizeHandle').count()} (any class match)`);
const handleClasses = await page.evaluate(() => {
  const d = document.querySelector('#sessionDrawer');
  return d ? Array.from(d.querySelectorAll('*')).map(e => e.className).filter(c => typeof c === 'string' && /resiz|handle|drag/i.test(c)) : [];
});
log.push(`resize-handle-like elements: ${JSON.stringify(handleClasses.slice(0,5))}`);

console.log(log.join("\n"));
await browser.close();
