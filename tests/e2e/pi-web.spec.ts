import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test.describe("composer layout", () => {
  test("composer controls fit without horizontal overflow", async ({ page }) => {
    await page.goto("/");
    const composer = page.locator("#promptForm");
    await expect(composer).toBeVisible();
    await expect(page.locator("#sessionButton")).toBeVisible();
    await expect(page.locator("#primaryButton")).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);

    const composerBox = await composer.boundingBox();
    const sendBox = await page.locator("#primaryButton").boundingBox();
    expect(composerBox).toBeTruthy();
    expect(sendBox).toBeTruthy();
    expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(composerBox!.x + composerBox!.width + 1);
  });

  test("non-send composer action icons are borderless", async ({ page }) => {
    await page.goto("/");
    for (const selector of ["#thinkingButton", "#queueToggle", "#attachButton", "#tokenButton"]) {
      const styles = await page.locator(selector).evaluate((el) => getComputedStyle(el));
      expect(styles.borderTopColor).toBe("rgba(0, 0, 0, 0)");
      expect(styles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    }
    const sendBorder = await page.locator("#primaryButton").evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(sendBorder).not.toBe("rgba(0, 0, 0, 0)");
  });
});

test.describe("sessions drawer", () => {
  test("shows a spinner for a background running session", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("slow background task");
    await page.locator("#primaryButton").click();
    await page.locator("#sessionButton").click();
    await expect(page.locator(".sessionItem", { hasText: "Current mock session" }).locator(".sessionSpinner")).toBeVisible();

    await page.getByText("Older mock session").click();
    await page.locator("#sessionButton").click();
    await expect(page.locator(".sessionItem", { hasText: "Current mock session" }).locator(".sessionSpinner")).toBeVisible();
    await expect(page.locator(".sessionItem", { hasText: "Older mock session" }).locator(".sessionSpinner")).toHaveCount(0);
  });

  test("opens, lists sessions, resumes an older session, and creates new session", async ({ page }) => {
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await expect(page.locator("#sessionNewButton")).toBeVisible();
    await expect(page.getByText("Current mock session")).toBeVisible();
    await expect(page.getByText("Older mock session")).toBeVisible();

    await page.getByText("Older mock session").click();
    await expect(page.locator("#sessionDrawer")).toBeHidden();
    await expect(page.getByText("Resumed older session.")).toBeVisible();

    await page.locator("#sessionButton").click();
    await page.locator("#sessionNewButton").click();
    await expect(page.locator("#sessionDrawer")).toBeHidden();
    await expect(page.locator(".message.system", { hasText: "New session" })).toBeVisible();
  });
});

test.describe("slash commands", () => {
  test("runs slash commands from the composer", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("/reload");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.system", { hasText: "› /reload" })).toBeVisible();
    await expect(page.locator(".message.system", { hasText: "Reloaded pi resources" })).toBeVisible();

    await page.locator("#prompt").fill("/thinking low");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.system", { hasText: "Thinking level set to low" })).toBeVisible();
  });
});

test.describe("attachments and prompt", () => {
  test("supports image-only prompt and attachment removal", async ({ page }) => {
    await page.goto("/");
    const file = {
      name: "tiny.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgo=", "base64"),
    };
    await page.locator("#imageInput").setInputFiles(file);
    await expect(page.locator(".attachmentChip")).toBeVisible();
    await expect(page.locator("#primaryButton")).toBeEnabled();

    await page.locator(".removeAttachment").click();
    await expect(page.locator(".attachmentChip")).toHaveCount(0);
    await expect(page.locator("#primaryButton")).toBeDisabled();

    await page.locator("#imageInput").setInputFiles(file);
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.user .messageImageThumb")).toBeVisible();
    await expect(page.getByText("Mock response with image.").first()).toBeVisible();
  });
});

test.describe("tool cards", () => {
  test("renders tool results as tool cards instead of tool bubbles", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("use tool");
    await page.locator("#primaryButton").click();

    const card = page.locator(".toolCard.toolCard--success").last();
    await expect(card).toBeVisible();
    await expect(card.locator(".toolCardName")).toHaveText("read");
    await expect(card.locator(".toolCardSubtitle")).toHaveText("/some/file");
    await expect(card.locator(".toolCardBody")).toContainText("file contents here");
    await expect(page.locator(".toolCard--running")).toHaveCount(0);
    await expect(page.locator(".message.tool")).toHaveCount(0);
  });
});

test.describe("assistant markdown rendering", () => {
  test("renders normal assistant responses as markdown", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("please return markdown");
    await page.locator("#primaryButton").click();

    const latestAssistant = page.locator(".message.assistant", { hasText: "Here is" }).last();
    await expect(latestAssistant.locator(".markdownBody strong")).toHaveText("bold");
    await expect(latestAssistant.locator(".markdownBody li")).toHaveText(["one", "two"]);
    await expect(latestAssistant.locator(".markdownBody pre code")).toContainText("const answer = 42;");
    await expect(latestAssistant.locator(".body")).not.toContainText("**bold**");
  });

  test("renders collapsed long assistant messages as markdown before and after show more", async ({ page }) => {
    await page.goto("/");
    const longMessage = page.locator(".message.assistant.collapsible").first();
    await expect(longMessage).toBeVisible();
    await expect(longMessage).toHaveClass(/collapsed/);

    const toggle = longMessage.locator(".messageToggle");
    let toggleStyles = await toggle.evaluate((el) => getComputedStyle(el));
    expect(toggleStyles.borderTopStyle).toBe("none");
    await toggle.hover();
    toggleStyles = await toggle.evaluate((el) => getComputedStyle(el));
    expect(toggleStyles.borderTopStyle).toBe("none");

    await expect(longMessage.locator(".body.markdownBody")).toHaveAttribute("data-markdown-rendered", "true");
    await expect(longMessage.locator(".markdownBody h2").first()).toHaveText("Image attachment support");
    await expect(longMessage.locator(".markdownBody strong").first()).toHaveText("enabled");
    await expect(longMessage.locator(".body")).not.toContainText("**enabled**");

    await toggle.click();
    await expect(longMessage).not.toHaveClass(/collapsed/);
    await expect(toggle).toHaveText("Show less");
    await expect(longMessage.locator(".markdownBody pre code").first()).toContainText("const enabled = true;");

    await toggle.click();
    await expect(longMessage).toHaveClass(/collapsed/);
  });
});
