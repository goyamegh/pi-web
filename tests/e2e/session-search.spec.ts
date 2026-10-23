/**
 * E2E: the session-search extension's real server-side renderer drives the
 * real pi-web panel in a browser. The mock server hosts no extensions, so the
 * invoke route is answered here by the actual extension code with the upstream
 * search API replaced by an in-test fake.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { PiWebExtensionAPI, PiWebExtensionContext } from "../../src/extensions";
import { PANEL_KEY, createSessionSearchExtension } from "../../examples/pi-web-extensions/session-search";

const credentials = { accessKeyId: "ASIAE2E", secretAccessKey: "e2e-secret", sessionToken: "e2e-session-token" };

const fixture = {
  documents: [
    { documentId: "a", source: { title: "Create the pi sessions OpenSearch domain", project: "pi-web-origin", started_at: "2026-10-21T10:00:00Z", session_url: "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b", session_id: "01a13ce5-9ebc-716c-be1c-ec84cf90e58b", passage_count: 7, passages: [{ text: "hidden passage", embedding: [0.5] }] } },
    // Production serialises `source` as a JSON string.
    { documentId: "b", source: JSON.stringify({ title: "Index pi sessions", project: "pi-web-origin", started_at: "2026-10-20T10:00:00Z", session_url: "/?sessionId=0199bbbb-0000-7000-8000-000000000001", session_id: "0199bbbb-0000-7000-8000-000000000001", passage_count: 2, passages: [{ text: "hidden passage", embedding: [0.4] }] }) },
    { documentId: "c", source: { title: "Index pi sessions", project: "agent-health", started_at: "2026-10-19T10:00:00Z", session_url: "/?sessionId=0199cccc-0000-7000-8000-000000000001", session_id: "0199cccc-0000-7000-8000-000000000001", passage_count: 1 } },
  ],
  retrievalMode: "SIMPLE",
  usage: { planningTokens: 11, synthesisTokens: 22, totalTokens: 33 },
};

const synthesized = {
  ...fixture,
  retrievalMode: "AGENTIC",
  answer: "The session `01a13ce5` created the **OpenSearch domain** for pi sessions [1]. A later session indexed them [2].",
  citations: [{ documentIndex: 0 }, { documentIndex: 1 }],
  usage: { planningTokens: 331761, synthesisTokens: 1624, totalTokens: 333385 },
};

const historyDirs: string[] = [];
test.afterEach(async () => { await Promise.all(historyDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** Boots the real extension against a scripted upstream and wires its panel into the mock server's invoke route. */
async function installExtension(page: Page) {
  const pendingSlow: Array<(response: Response) => void> = [];
  const requests: any[] = [];
  const upstream = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const intent = body.query.intent as string;
    if (intent.includes("expired")) return new Response(JSON.stringify({ message: "The security token included in the request is expired" }), { status: 403 });
    if (intent.includes("nothing")) return new Response(JSON.stringify({ ...fixture, documents: [] }), { status: 200 });
    if (intent.includes("slow")) {
      return new Promise<Response>((resolve, reject) => {
        pendingSlow.push(resolve);
        init?.signal?.addEventListener("abort", () => {
          pendingSlow.splice(pendingSlow.indexOf(resolve), 1);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (body.synthesize) return new Response(JSON.stringify(synthesized), { status: 200 });
    return new Response(JSON.stringify(fixture), { status: 200 });
  };

  const handlers = new Map<string, (event: unknown, ctx: PiWebExtensionContext) => unknown>();
  const contributions = new Map<string, any>();
  const historyDir = await mkdtemp(join(tmpdir(), "pi-web-session-search-e2e-"));
  historyDirs.push(historyDir);
  createSessionSearchExtension({
    fetch: upstream as typeof fetch,
    loadCredentials: async () => credentials,
    historyFile: join(historyDir, "history.json"),
    env: { PI_WEB_SESSION_SEARCH_ENDPOINT: "https://search.example.test/apps/e2e/search", PI_WEB_SESSION_SEARCH_PROFILE: "e2e", PI_WEB_SESSION_SEARCH_REFRESH_HINT: "refresh-e2e-creds --once" },
  })({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as PiWebExtensionAPI);
  await handlers.get("session_start")!({}, {
    ui: {
      notify: () => undefined,
      web: {
        capabilities: { apiVersion: 1, slots: ["panel", "fab", "header-action"], kinds: ["rendered", "static"], effects: ["open-panel"] },
        contribute: (key: string, spec: unknown) => spec === undefined ? contributions.delete(key) : contributions.set(key, spec),
        // The real host emits this event when an extension calls update(); replay it through the mock server.
        update: (key: string) => void page.request.post("/api/mock/event", { data: { type: "web_contribution_updated", sessionId: "mock-current", key } }),
        registerSettings: async () => ({ registered: true, migrated: false, usedBackup: false }),
        getSettings: async () => ({ schemaVersion: 1, values: {} }),
      },
    },
  } as unknown as PiWebExtensionContext);

  await page.request.post("/api/mock/state", { data: {
    webContributions: [
      { version: 1, key: PANEL_KEY, slot: "panel", kind: "rendered", title: "Session search", label: "Session search", icon: "session-search" },
      { version: 1, key: `${PANEL_KEY}-launcher`, slot: "fab", kind: "static", title: "Session search", label: "Session search", icon: "session-search", opens: PANEL_KEY },
      { version: 1, key: `${PANEL_KEY}-header`, slot: "header-action", kind: "rendered", title: "Session search", label: "Session search", icon: "session-search" },
    ],
  } });

  const invocations: any[] = [];
  await page.route("**/api/web-contributions/invoke", async (route) => {
    const input = route.request().postDataJSON();
    invocations.push(input);
    if (input.slot === "header-action") {
      await route.fulfill({ json: { ok: true, label: "Session search", ...contributions.get(`${PANEL_KEY}-header`).render() } });
      return;
    }
    const view = await contributions.get(PANEL_KEY).render(input.event);
    await route.fulfill({ json: { ok: true, ...view } });
  });

  return { invocations, requests, releaseSlow: () => pendingSlow.shift()?.(new Response(JSON.stringify({ ...fixture, retrievalMode: "AGENTIC" }), { status: 200 })) };
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("searches sessions from the panel and renders results, empty, and error states", async ({ page }) => {
  const { invocations } = await installExtension(page);
  const stateLoaded = page.waitForResponse((response) => response.url().includes("/api/state") && response.ok());
  await page.goto("/");
  await stateLoaded;

  // The launcher is the top-right control of the header and carries the extension's own logo
  // (a magnifying glass peeking out of a chat bubble: one circle + two paths, not a generic star).
  const launcher = page.locator('#headerActions .webHeaderActionButton[title="Session search"]');
  await expect(launcher).toBeVisible();
  await expect(launcher.locator("svg circle")).toHaveCount(1);
  await expect(launcher.locator("svg path")).toHaveCount(2);
  const placement = await launcher.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const bar = button.closest("#statusBar")!.getBoundingClientRect();
    const rightmost = Math.max(...Array.from(button.closest("#statusBar")!.querySelectorAll<HTMLElement>("button, a, span"))
      .filter((element) => element.offsetWidth > 0 && element !== button && !button.contains(element) && !element.contains(button))
      .map((element) => element.getBoundingClientRect().right));
    return { top: rect.top, right: rect.right, barRight: bar.right, barTop: bar.top, rightmostOther: rightmost, color: getComputedStyle(button.querySelector("svg")!).stroke };
  });
  expect(placement.top).toBeGreaterThanOrEqual(placement.barTop);
  expect(placement.top).toBeLessThan(40);
  expect(placement.barRight - placement.right).toBeLessThanOrEqual(12);
  expect(placement.right).toBeGreaterThanOrEqual(placement.rightmostOther);
  expect(placement.color).not.toBe("none");

  await launcher.click();
  const panel = page.locator("#webExtensionPanel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("h2")).toHaveText("Session search");
  await expect(panel.locator("h2 .webPanelTitleIcon svg circle")).toHaveCount(1);
  const query = panel.getByRole("searchbox", { name: "Session search query" });
  await expect(query).toBeVisible();
  await expect(panel.getByRole("combobox", { name: "Retrieval mode" })).toHaveValue("SIMPLE");
  // The synthesis toggle only applies to AGENTIC searches and is hidden for SIMPLE.
  await expect(panel.getByRole("checkbox", { name: "Synthesize answer" })).toBeHidden();

  await query.fill("which session created the OpenSearch domain for pi sessions");
  await panel.getByRole("button", { name: "Search", exact: true }).click();

  const hits = panel.locator(".ssxHit");
  await expect(hits).toHaveCount(3);
  await expect(hits.nth(0)).toContainText("Create the pi sessions OpenSearch domain");
  await expect(hits.nth(0)).toContainText("pi-web-origin");
  await expect(hits.nth(0)).toContainText("2026-10-21 10:00 UTC");
  await expect(hits.nth(0)).toContainText("7 passages");
  await expect(hits.nth(0).getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b");
  await expect(hits.nth(2)).toContainText("agent-health");
  await expect(panel.locator(".ssxUsage")).toContainText("SIMPLE · 3 results in");
  await expect(panel.locator(".ssxUsage")).toContainText("tokens: planning 11, synthesis 22, total 33");
  await expect(panel.locator(".webPanelBody")).not.toContainText("hidden passage");
  expect(invocations.at(-1)).toMatchObject({ slot: "panel", key: PANEL_KEY, event: { action: "search", fields: { query: "which session created the OpenSearch domain for pi sessions", mode: "SIMPLE" } } });
  await expect(query).toHaveValue("which session created the OpenSearch domain for pi sessions");

  await query.fill("nothing like this");
  await query.press("Enter");
  await expect(panel.getByRole("status")).toContainText("No sessions matched “nothing like this”.");
  await expect(hits).toHaveCount(0);

  await query.fill("expired credentials please");
  await query.press("Enter");
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText('AWS credentials for profile "e2e" were rejected (HTTP 403)');
  await expect(alert).toContainText("refresh-e2e-creds --once");
  await expect(panel.locator(".webPanelBody")).not.toContainText(credentials.sessionToken);
  await expect(hits).toHaveCount(0);
});

test("shows a cancellable spinner for slow AGENTIC searches and repaints when the result arrives", async ({ page }) => {
  const { releaseSlow } = await installExtension(page);
  const stateLoaded = page.waitForResponse((response) => response.url().includes("/api/state") && response.ok());
  await page.goto("/");
  await stateLoaded;
  await page.locator(".actionLauncherToggle").click();
  await page.locator(".actionLauncherItem", { hasText: "Session search" }).click();
  const panel = page.locator("#webExtensionPanel");
  await expect(panel).toBeVisible();

  const query = panel.getByRole("searchbox", { name: "Session search query" });
  await query.fill("slow agentic question");
  await panel.getByRole("combobox", { name: "Retrieval mode" }).selectOption("AGENTIC");
  await panel.getByRole("button", { name: "Search", exact: true }).click();

  const status = panel.getByRole("status");
  await expect(status).toContainText("Searching (AGENTIC)");
  await expect(status).toContainText("1–2 minutes");
  await expect(panel.locator(".ssxSpinner")).toBeVisible();
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(status).toHaveText("Search cancelled.");
  await expect(panel.locator(".ssxSpinner")).toHaveCount(0);

  // Second slow search: let it finish; the extension's update() must repaint without any click.
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await expect(panel.locator(".ssxSpinner")).toBeVisible();
  releaseSlow();
  await expect(panel.locator(".ssxHit")).toHaveCount(3, { timeout: 10_000 });
  await expect(panel.locator(".ssxUsage")).toContainText("AGENTIC · 3 results in");
  await expect(panel.getByRole("combobox", { name: "Retrieval mode" })).toHaveValue("AGENTIC");
});

test("AGENTIC with synthesis renders the answer and citations above the numbered results, and history restores it without a request", async ({ page }) => {
  const { invocations, requests } = await installExtension(page);
  const stateLoaded = page.waitForResponse((response) => response.url().includes("/api/state") && response.ok());
  await page.goto("/");
  await stateLoaded;
  await page.locator('.webHeaderActionButton[title="Session search"]').click();
  const panel = page.locator("#webExtensionPanel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "New search" })).toHaveCount(0);

  const query = panel.getByRole("searchbox", { name: "Session search query" });
  const mode = panel.getByRole("combobox", { name: "Retrieval mode" });
  const synth = panel.getByRole("checkbox", { name: "Synthesize answer" });
  await mode.selectOption("AGENTIC");
  await expect(synth).toBeVisible();
  await expect(synth).toBeChecked();
  await query.fill("which session created the OpenSearch domain for pi sessions");
  await panel.getByRole("button", { name: "Search", exact: true }).click();

  const answer = panel.getByRole("region", { name: "Synthesized answer" });
  await expect(answer).toBeVisible();
  await expect(answer).toContainText("created the OpenSearch domain for pi sessions");
  await expect(answer.locator("strong")).toHaveText("OpenSearch domain");
  await expect(answer.locator("code")).toHaveText("01a13ce5");
  await expect(answer.locator(".ssxCite")).toHaveText(["[1]", "[2]"]);
  await expect(answer.locator(".ssxCite").first()).toHaveAttribute("title", "Create the pi sessions OpenSearch domain");
  await expect(answer.locator(".ssxCitations a")).toHaveText(["[1] Create the pi sessions OpenSearch domain", "[2] Index pi sessions"]);
  await expect(answer.locator(".ssxCitations a").first()).toHaveAttribute("href", "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b");
  const hits = panel.locator(".ssxHit");
  await expect(hits).toHaveCount(3);
  await expect(hits.nth(0).locator(".ssxIndex")).toHaveText("1");
  await expect(hits.nth(2).locator(".ssxIndex")).toHaveText("3");
  expect(await answer.boundingBox().then((box) => box!.y)).toBeLessThan(await hits.first().boundingBox().then((box) => box!.y));
  await expect(panel.locator(".ssxUsage")).toContainText("AGENTIC · 3 results in");
  await expect(panel.locator(".ssxUsage")).toContainText("tokens: planning 331761, synthesis 1624, total 333385");
  expect(requests.at(-1)).toMatchObject({ retrieval: "AGENTIC", synthesize: true, synthesisOptions: { maxTokens: 600, temperature: 0, responseFormat: "MARKDOWN" }, maxResults: 5 });
  await expect(panel.getByRole("checkbox", { name: "Continue conversation" })).toBeVisible();

  // Second search lands on top of the history list; the first can be reopened instantly.
  await query.fill("nothing like this");
  await query.press("Enter");
  await expect(panel.getByRole("status").first()).toContainText("No sessions matched");
  const history = panel.getByRole("complementary", { name: "Past searches" });
  await expect(history).toBeVisible();
  const items = history.locator(".ssxHistoryItem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("nothing like this");
  await expect(items.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(items.nth(1)).toContainText("which session created the OpenSearch domain");
  await expect(items.nth(1)).toContainText("AGENTIC");
  expect(history.boundingBox().then((box) => box!.x)).resolves.toBeLessThan(await query.boundingBox().then((box) => box!.x));

  const upstreamCalls = requests.length;
  await items.nth(1).click();
  await expect(answer).toBeVisible();
  await expect(answer).toContainText("created the OpenSearch domain for pi sessions");
  await expect(query).toHaveValue("which session created the OpenSearch domain for pi sessions");
  await expect(mode).toHaveValue("AGENTIC");
  await expect(items.nth(1)).toHaveAttribute("aria-current", "true");
  expect(requests.length).toBe(upstreamCalls);
  expect(invocations.at(-1)).toMatchObject({ event: { action: "history-open" } });

  await history.getByRole("button", { name: "New search" }).click();
  await expect(query).toHaveValue("");
  await expect(answer).toHaveCount(0);
  await expect(panel.locator(".ssxEmpty")).toContainText("Search the indexed history");
  await expect(items).toHaveCount(2);
  expect(requests.length).toBe(upstreamCalls);
});

test("mode and synthesis controls are locked while a search is in flight, clicks inside the form start nothing, and the result still lands", async ({ page }) => {
  const { invocations, requests, releaseSlow } = await installExtension(page);
  const stateLoaded = page.waitForResponse((response) => response.url().includes("/api/state") && response.ok());
  await page.goto("/");
  await stateLoaded;
  await page.locator('.webHeaderActionButton[title="Session search"]').click();
  const panel = page.locator("#webExtensionPanel");
  const query = panel.getByRole("searchbox", { name: "Session search query" });
  const mode = panel.getByRole("combobox", { name: "Retrieval mode" });
  const synth = panel.getByRole("checkbox", { name: "Synthesize answer" });

  await mode.selectOption("AGENTIC");
  await query.fill("slow agentic question");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await expect(panel.locator(".ssxSpinner")).toBeVisible();
  const searches = () => invocations.filter((call) => call.event?.action === "search").length;
  expect(searches()).toBe(1);
  expect(requests).toHaveLength(1);

  // Locked controls: the user cannot flip them mid-flight, and interacting with the form is inert.
  await expect(mode).toBeDisabled();
  await expect(synth).toBeDisabled();
  await mode.click({ force: true });
  await synth.click({ force: true });
  await query.click();
  await query.fill("typed while waiting");
  await page.waitForTimeout(300);
  expect(searches()).toBe(1);
  expect(requests).toHaveLength(1);
  await expect(panel.locator(".ssxSpinner")).toBeVisible();
  await expect(mode).toHaveValue("AGENTIC");
  await expect(synth).toBeChecked();

  // The in-flight result lands and unlocks the controls with the same settings.
  await query.blur();
  releaseSlow();
  await expect(panel.locator(".ssxHit")).toHaveCount(3, { timeout: 10_000 });
  await expect(mode).toBeEnabled();
  await expect(mode).toHaveValue("AGENTIC");
  await expect(synth).toBeEnabled();
  await expect(panel.locator(".ssxUsage")).toContainText("AGENTIC · 3 results in");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ query: { intent: "slow agentic question" }, retrieval: "AGENTIC" });
});
