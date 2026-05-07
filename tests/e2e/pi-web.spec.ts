import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test.describe("composer layout", () => {
  test("status header shows current session title and path", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("#statusBar")).toBeVisible();
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await expect(page.locator("#statusPath")).toContainText("pi-web");
  });

  test("new session resets status title", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");

    await page.locator("#sessionButton").click();
    await page.locator("#sessionNewButton").click();

    await expect(page.locator("#statusTitle")).toHaveText("New session");
  });

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

  test("composer action row is flush, 40px tall, and has rounded bottom corners", async ({ page }) => {
    await page.goto("/");

    const footerBox = await page.locator(".composerFooter").boundingBox();
    const textAreaBox = await page.locator("#prompt").boundingBox();
    const modelBox = await page.locator("#modelSelect").boundingBox();
    const sendBox = await page.locator("#primaryButton").boundingBox();
    expect(footerBox).toBeTruthy();
    expect(textAreaBox).toBeTruthy();
    expect(modelBox).toBeTruthy();
    expect(sendBox).toBeTruthy();

    expect(footerBox!.height).toBeCloseTo(40, 1);
    expect(footerBox!.y).toBeCloseTo(textAreaBox!.y + textAreaBox!.height, 1);
    expect(modelBox!.height).toBeCloseTo(40, 1);
    expect(sendBox!.height).toBeCloseTo(40, 1);

    const modelRadius = await page.locator("#modelSelect").evaluate((el) => getComputedStyle(el).borderBottomLeftRadius);
    const sendRadius = await page.locator("#primaryButton").evaluate((el) => getComputedStyle(el).borderBottomRightRadius);
    expect(modelRadius).toBe("15px");
    expect(sendRadius).toBe("15px");
  });

  test("composer focus ring is inset instead of clipped", async ({ page }) => {
    await page.goto("/");
    await page.locator("#modelSelect").focus();
    const styles = await page.locator("#modelSelect").evaluate((el) => getComputedStyle(el));
    expect(styles.outlineStyle).toBe("none");
    expect(styles.boxShadow).toContain("inset");
  });

  test("composer expands to fullscreen editor", async ({ page }) => {
    await page.goto("/");
    const composer = page.locator("#promptForm");
    const before = await composer.boundingBox();
    expect(before).toBeTruthy();

    await composer.hover();
    await page.locator("#expandButton").click();

    await expect(composer).toHaveClass(/expanded/);
    const after = await composer.boundingBox();
    expect(after).toBeTruthy();
    expect(after!.height).toBeGreaterThan(before!.height * 2);

    await page.locator("#expandButton").click();
    await expect(composer).not.toHaveClass(/expanded/);
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
    const drawer = page.locator("#sessionDrawer");
    await expect(page.locator("#sessionNewButton")).toBeVisible();
    await expect(drawer.getByText("Current mock session")).toBeVisible();
    await expect(drawer.getByText("Older mock session")).toBeVisible();

    await drawer.getByText("Older mock session").click();
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
  test("empty attachment container collapses and populated attachment row has padding", async ({ page }) => {
    await page.goto("/");
    const attachments = page.locator("#attachments");
    await expect(attachments).toHaveCSS("display", "none");

    const file = {
      name: "tiny.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgo=", "base64"),
    };
    await page.locator("#imageInput").setInputFiles(file);
    await expect(page.locator(".attachmentChip")).toBeVisible();
    await expect(attachments).toHaveCSS("padding-top", "8px");
    await expect(attachments).toHaveCSS("padding-right", "8px");
    await expect(attachments).toHaveCSS("padding-bottom", "8px");
    await expect(attachments).toHaveCSS("padding-left", "8px");

    const attachmentBg = await attachments.evaluate((el) => getComputedStyle(el).backgroundColor);
    const composerBg = await page.locator("#promptForm").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(attachmentBg).toBe(composerBg);
  });

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

  test("renders edit tool calls as a side-by-side intraline diff with an icon layout toggle", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("edit diff");
    await page.locator("#primaryButton").click();

    const card = page.locator(".toolCard.toolCard--success", { hasText: "edit" }).last();
    await expect(card).toBeVisible();
    await expect(card.locator(".toolCardName")).toHaveText("edit");
    await expect(card.locator(".toolCardSubtitle")).toHaveText("/some/file.ts");
    await expect(card.locator(".diffContainer")).toHaveClass(/diffContainer--sideBySide/);
    await expect(card.locator(".diffLayoutToggle")).toHaveAttribute("aria-label", "Switch to top/bottom diff view");
    await expect(card.locator(".diffLayoutToggle svg")).toHaveCount(1);
    await expect(card.locator(".diffLine--changed")).toHaveCount(2);
    await expect(card.locator(".diffWord--del", { hasText: "41" })).toBeVisible();
    await expect(card.locator(".diffWord--add", { hasText: "42" })).toBeVisible();
    await expect(card.locator(".diffWord--del", { hasText: "log" })).toBeVisible();
    await expect(card.locator(".diffWord--add", { hasText: "info" })).toBeVisible();
    await expect(card.locator(".toolCardBody")).toHaveCount(0);

    await card.locator(".diffLayoutToggle").click();
    await expect(card.locator(".diffContainer")).toHaveClass(/diffContainer--stacked/);
    await expect(card.locator(".diffLayoutToggle")).toHaveAttribute("aria-label", "Switch to side-by-side diff view");
  });

  test("does not crash when edit tool args omit oldText or newText", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await page.locator("#prompt").fill("malformed edit");
    await page.locator("#primaryButton").click();

    const card = page.locator(".toolCard.toolCard--success", { hasText: "edit" }).last();
    await expect(card).toBeVisible();
    await expect(card.locator(".diffContainer")).toBeVisible();
    expect(errors).not.toContain("Cannot read properties of undefined (reading 'split')");
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

test.describe("code block copy button", () => {
  test("copy button appears on hover and switches to check icon on click", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("please return markdown");
    await page.locator("#primaryButton").click();

    const pre = page.locator(".message.assistant .markdownBody pre").last();
    await expect(pre).toBeVisible();

    const copyBtn = pre.locator(".copyCode");

    // move mouse away so no hover state bleeds in
    await page.mouse.move(0, 0);
    await expect(copyBtn).toBeHidden();

    await pre.hover();
    await expect(copyBtn).toBeVisible();

    // before click: copy state
    await expect(copyBtn).toHaveAttribute("data-icon", "copy");

    await copyBtn.click();

    // after click: check state
    await expect(copyBtn).toHaveAttribute("data-icon", "check");
  });

  test("copy button reverts to copy icon after timeout", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("please return markdown");
    await page.locator("#primaryButton").click();

    const pre = page.locator(".message.assistant .markdownBody pre").last();
    await pre.hover();
    await pre.locator(".copyCode").click();
    await expect(pre.locator(".copyCode")).toHaveAttribute("data-icon", "check");

    await page.waitForTimeout(2000);
    await expect(pre.locator(".copyCode")).toHaveAttribute("data-icon", "copy");
  });
});

// Minimal valid 1x1 transparent PNG
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("image rendering", () => {
  test.beforeAll(async () => {
    const artifactDir = join(process.cwd(), ".pi-web-uploads", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "e2e-test.png"), VALID_PNG);
  });

  test("image actions appear on hover with fullscreen, download and open buttons", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("show artifact");
    await page.locator("#primaryButton").click();

    const frame = page.locator(".message.assistant .imageFrame").last();
    await expect(frame).toBeVisible();

    // move mouse away so no hover state bleeds in
    await page.mouse.move(0, 0);
    const actions = frame.locator(".imageActions");
    await expect(actions).toBeHidden();

    await frame.hover();
    await expect(actions).toBeVisible();

    await expect(frame.locator('[title="Fullscreen"]')).toBeVisible();
    await expect(frame.locator('[title="Download"]')).toBeVisible();
    await expect(frame.locator('[title="Open in new tab"]')).toBeVisible();
  });

  test("fullscreen button opens overlay with image", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("show artifact");
    await page.locator("#primaryButton").click();

    const frame = page.locator(".message.assistant .imageFrame").last();
    await expect(frame).toBeVisible();
    await frame.hover();
    await frame.locator('[title="Fullscreen"]').click();

    const overlay = page.locator(".imageOverlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator("img")).toBeVisible();
  });

  test("overlay closes when clicked", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("show artifact");
    await page.locator("#primaryButton").click();

    const frame = page.locator(".message.assistant .imageFrame").last();
    await expect(frame).toBeVisible();
    await frame.hover();
    await frame.locator('[title="Fullscreen"]').click();

    const overlay = page.locator(".imageOverlay");
    await expect(overlay).toBeVisible();
    await overlay.click();
    await expect(overlay).toHaveCount(0);
  });

  test("image is constrained and does not overflow the message", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("show artifact");
    await page.locator("#primaryButton").click();

    const img = page.locator(".message.assistant .imageFrame img").last();
    await expect(img).toBeVisible();

    const imgBox = await img.boundingBox();
    const msgBox = await page.locator(".message.assistant").last().boundingBox();
    expect(imgBox).toBeTruthy();
    expect(msgBox).toBeTruthy();
    expect(imgBox!.width).toBeLessThanOrEqual(msgBox!.width + 1);
  });
});
