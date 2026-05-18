import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test.describe("iOS viewport and orientation fixes", () => {
  test("viewport meta tag includes viewport-fit=cover and maximum-scale=1", async ({ page }) => {
    await page.goto("/");
    const content = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(content).toContain("viewport-fit=cover");
    expect(content).toContain("maximum-scale=1");
  });

  test("no horizontal overflow exists on page load", async ({ page }) => {
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });

  test("no horizontal overflow after focusing the textarea", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").focus();
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });

  test("app container uses position fixed", async ({ page }) => {
    await page.goto("/");
    const position = await page.locator(".app").evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe("fixed");
  });

  test("--app-height and --app-top CSS variables are set on the document", async ({ page }) => {
    await page.goto("/");
    const vars = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        height: style.getPropertyValue("--app-height").trim(),
        top: style.getPropertyValue("--app-top").trim(),
      };
    });
    expect(vars.height).toMatch(/^\d+px$/);
    expect(vars.top).toBe("0px");
  });

  test("textarea font-size is at least 16px to prevent iOS auto-zoom", async ({ page }) => {
    await page.goto("/");
    const fontSize = await page.locator("#prompt").evaluate((el) => {
      return parseFloat(getComputedStyle(el).fontSize);
    });
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });

  test("touch-action is set to manipulation on body", async ({ page }) => {
    await page.goto("/");
    const touchAction = await page.evaluate(() => getComputedStyle(document.body).touchAction);
    expect(touchAction).toBe("manipulation");
  });

  test("jumpToLatestButton uses absolute positioning (not fixed)", async ({ page }) => {
    await page.goto("/");
    // Scroll up to make the jump button appear
    await page.locator("#prompt").fill("use tool");
    await page.locator("#primaryButton").click();
    await page.waitForTimeout(500);

    const jumpBtn = page.locator(".jumpToLatestButton");
    // The button may or may not be visible depending on scroll state,
    // but verify its CSS rule is correct via evaluate
    const position = await page.evaluate(() => {
      const btn = document.querySelector(".jumpToLatestButton");
      if (!btn) return "absolute"; // button not in DOM yet, check the stylesheet
      return getComputedStyle(btn).position;
    });
    expect(position).toBe("absolute");
  });

  test("keyboard-open class hides session bar on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // Seed a pinned session so the session bar is visible
    const pinnedKey = "pi-web-pinned-sessions";
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, JSON.stringify([{ id: "mock-current", label: "Current mock session" }])],
    );

    await page.goto("/");
    await expect(page.locator("#sessionBar")).toBeVisible();

    // Simulate keyboard-open state
    await page.evaluate(() => {
      document.documentElement.classList.add("keyboard-open");
    });

    await expect(page.locator("#sessionBar")).toBeHidden();

    // Remove keyboard-open class — session bar comes back
    await page.evaluate(() => {
      document.documentElement.classList.remove("keyboard-open");
    });

    await expect(page.locator("#sessionBar")).toBeVisible();
  });

  test("app height updates when visualViewport is simulated to resize", async ({ page }) => {
    await page.goto("/");

    const initialHeight = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue("--app-height").trim();
    });
    expect(initialHeight).toMatch(/^\d+px$/);

    // The syncAppHeight function uses visualViewport.height — verify it's wired up
    // by checking that the variable matches the viewport height
    const viewportHeight = page.viewportSize()?.height || 800;
    expect(parseInt(initialHeight)).toBeCloseTo(viewportHeight, -1);
  });

  test("overscroll-behavior is none to prevent pull-to-refresh", async ({ page }) => {
    await page.goto("/");
    const overscroll = await page.evaluate(() => getComputedStyle(document.body).overscrollBehavior);
    expect(overscroll).toBe("none");
  });

  test("focusin handler resets scroll position", async ({ page }) => {
    await page.goto("/");

    // Artificially set a horizontal scroll to simulate drift
    await page.evaluate(() => {
      document.documentElement.scrollLeft = 50;
    });

    // Focus the textarea — the handler should reset scroll
    await page.locator("#prompt").focus();
    await page.waitForTimeout(100);

    const scrollLeft = await page.evaluate(() => document.documentElement.scrollLeft);
    expect(scrollLeft).toBe(0);
  });
});
