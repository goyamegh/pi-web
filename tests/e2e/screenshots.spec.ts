import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("screenshots during and after a run", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#prompt")).toBeVisible();

  await page.locator("#prompt").fill("interleaving test with tool");
  await expect(page.locator("#primaryButton")).toBeEnabled();

  // Screenshot before sending
  await page.screenshot({ path: "test-results/screenshots/1-before-send.png", fullPage: true });

  await page.locator("#primaryButton").click();

  // Poll and screenshot on every DOM change during streaming
  let last = "";
  let screenshotIndex = 2;
  const start = Date.now();
  let stoppedAt: number | null = null;

  for (let i = 0; i < 400; i++) {
    const html = await page.locator("#messages").innerHTML();
    if (html !== last) {
      last = html;
      const isStreaming = await page.locator("#primaryButton").evaluate(el => el.classList.contains("dangerAction"));
      const phase = isStreaming ? "during" : "after";
      // Scroll to bottom before screenshotting
      await page.evaluate(() => { const m = document.querySelector("#messages"); if (m) m.scrollTop = m.scrollHeight; });
      await page.screenshot({
        path: `test-results/screenshots/${String(screenshotIndex).padStart(2,"0")}-${phase}-${Date.now()-start}ms.png`,
        fullPage: true
      });
      screenshotIndex++;
    }
    const isStreaming = await page.locator("#primaryButton").evaluate(el => el.classList.contains("dangerAction"));
    if (!isStreaming && stoppedAt === null && i > 0) stoppedAt = Date.now() - start;
    if (stoppedAt !== null && (Date.now() - start) > stoppedAt + 1000) break;
    await page.waitForTimeout(40);
  }

  // Final screenshot after fully settled
  await page.screenshot({ path: `test-results/screenshots/${String(screenshotIndex).padStart(2,"0")}-final-settled.png`, fullPage: true });

  // Dump /api/messages to see what the server actually returned
  const apiMessages = await page.evaluate(async () => {
    const res = await fetch("/api/messages");
    const data = await res.json();
    return data.messages?.map((m: any) => ({ role: m.role, toolName: m.toolName, text: m.text?.slice(0, 80) }));
  });
  console.log("\n/api/messages response:", JSON.stringify(apiMessages, null, 2));

  expect(screenshotIndex).toBeGreaterThan(2);
});
