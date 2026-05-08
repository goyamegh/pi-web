import { expect, test } from "@playwright/test";

function getMessageOrder(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const messages = document.querySelectorAll("#messages > *");
    return Array.from(messages).map((el) => {
      const isToolCard = el.classList.contains("toolCard");
      if (isToolCard) {
        const toolName = el.querySelector(".toolCardName")?.textContent?.trim();
        const toolBadge = el.querySelector(".toolCardBadge")?.textContent?.trim();
        return `[toolCard: ${toolName} (${toolBadge})]`;
      }
      const role = el.classList.contains("assistant") ? "assistant" : el.classList.contains("user") ? "user" : "system";
      const body = el.querySelector(".body")?.textContent?.trim().slice(0, 80);
      return `[${role}: "${body}"]`;
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("poll DOM during and after a run to observe message order", async ({ page }) => {
  await page.goto("/");
  // Wait for page to be ready
  await expect(page.locator("#prompt")).toBeVisible();

  // Send a prompt
  await page.locator("#prompt").fill("interleaving test with tool");
  await expect(page.locator("#primaryButton")).toBeEnabled();
  await page.locator("#primaryButton").click();

  const allSnapshots: { timeMs: number; order: string[] }[] = [];
  const start = Date.now();

  // Poll every 30ms until streaming stops and then a bit more
  let stoppedStreamingAt: number | null = null;
  for (let i = 0; i < 300; i++) {
    const order = await getMessageOrder(page);
    allSnapshots.push({ timeMs: Date.now() - start, order });

    const isStreaming = await page.locator("#primaryButton").evaluate(
      el => el.classList.contains("dangerAction")
    );
    if (!isStreaming && stoppedStreamingAt === null && i > 0) {
      stoppedStreamingAt = Date.now() - start;
    }
    // Once streaming has stopped, keep polling for 600ms more to catch refreshMessages settling
    if (stoppedStreamingAt !== null && (Date.now() - start) > stoppedStreamingAt + 1000) break;
    await page.waitForTimeout(30);
  }

  // Print only snapshots where the DOM changed
  console.log("\n=== DOM snapshots (only on change) ===");
  let last = "";
  for (const snap of allSnapshots) {
    const s = JSON.stringify(snap.order);
    if (s !== last) {
      console.log(`+${snap.timeMs}ms:`, snap.order);
      last = s;
    }
  }
  console.log(`\nStreaming stopped at: +${stoppedStreamingAt}ms`);
  console.log("Final DOM order:", allSnapshots[allSnapshots.length - 1]?.order);

  expect(allSnapshots.length).toBeGreaterThan(0);
});
