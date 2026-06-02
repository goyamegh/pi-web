import { expect, test } from "@playwright/test";

const pinnedKey = "pi-web-pinned-sessions";

function seedPinned(...sessions: Array<{ id: string; label: string }>) {
  return JSON.stringify(sessions);
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test.describe("session switch performance", () => {
  test("does NOT issue a GET /api/messages after a tab switch (transcript embedded in /api/sessions/open)", async ({ page }) => {
    // Regression: previously every switch made a sequential POST → GET
    // round-trip. The transcript now ships inside the open response so the
    // GET /api/messages call is unnecessary on the critical path.
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned(
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      )],
    );

    await page.goto("/");
    // Prime the bar so cachedSessions is populated.
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    await page.locator("#sessionCloseButton").click();

    // Capture network requests during the switch only.
    const messagesCalls: string[] = [];
    const onRequest = (request: import("@playwright/test").Request) => {
      const url = request.url();
      if (url.includes("/api/messages")) messagesCalls.push(url);
    };
    page.on("request", onRequest);

    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");

    // Give any deferred (idle) calls a chance to fire so we can prove they're
    // not on the critical path. /api/models is allowed; /api/messages must not.
    await page.waitForTimeout(300);
    page.off("request", onRequest);

    expect(messagesCalls, "no GET /api/messages should be issued during a session switch").toEqual([]);
  });

  test("/api/sessions/open response embeds a non-empty messages array", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned(
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      )],
    );

    await page.goto("/");
    await page.locator("#sessionButton").click();
    await page.locator("#sessionCloseButton").click();

    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/api/sessions/open") && response.request().method() === "POST",
    );
    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();
    const response = await responsePromise;

    const body = await response.json();
    expect(Array.isArray(body.messages)).toBe(true);
    // The mock harness seeds at least one message after a switch.
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.messages[0]).toHaveProperty("role");
  });

  test("perf telemetry logs a timing summary when ?perf=1 is set", async ({ page }) => {
    // Telemetry is opt-in to keep the console quiet in normal usage. When
    // enabled it must emit a single summary line per switch with the
    // total= phase so users can compare numbers across runs.
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned(
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      )],
    );

    const logs: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "log") logs.push(msg.text());
    });

    await page.goto("/?perf=1");
    await page.locator("#sessionButton").click();
    await page.locator("#sessionCloseButton").click();

    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    // Allow the trailing perf.end() call to flush.
    await page.waitForTimeout(200);

    const perfLogs = logs.filter((line) => line.includes("[pi-web perf] session-switch"));
    expect(perfLogs.length, `expected at least one perf log, saw: ${logs.join(" | ")}`).toBeGreaterThan(0);
    expect(perfLogs[0]).toMatch(/total=\d+ms/);
    expect(perfLogs[0]).toMatch(/embedded=true/);
  });

  test("perf telemetry stays silent when not opted in", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [pinnedKey, seedPinned(
        { id: "mock-current", label: "Current mock session" },
        { id: "mock-older", label: "Older mock session" },
      )],
    );

    const logs: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "log") logs.push(msg.text());
    });

    await page.goto("/");
    await page.locator("#sessionButton").click();
    await page.locator("#sessionCloseButton").click();
    await page.locator(".sessionBarTab").filter({ hasText: "Older mock session" }).click();
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
    await page.waitForTimeout(200);

    const perfLogs = logs.filter((line) => line.includes("[pi-web perf]"));
    expect(perfLogs).toEqual([]);
  });
});
