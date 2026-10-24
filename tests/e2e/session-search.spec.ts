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

const LONG_QUESTION = "which session created the OpenSearch domain for pi sessions, and what engine version, instance type, and access policy did it confirm when the domain finished provisioning and the first index was created?";

const fixture = {
  documents: [
    { documentId: "a", source: { title: "Create the pi sessions OpenSearch domain", project: "pi-web-origin", started_at: "2026-10-21T10:00:00Z", session_url: "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b", session_id: "01a13ce5-9ebc-716c-be1c-ec84cf90e58b", passage_count: 7, passages: [{ text: "hidden passage", embedding: [0.5] }] } },
    // The AGENTIC path serialises `source` as a JSON string.
    { documentId: "b", source: JSON.stringify({ title: "Index pi sessions", project: "pi-web-origin", started_at: "2026-10-20T10:00:00Z", session_url: "/?sessionId=0199bbbb-0000-7000-8000-000000000001", session_id: "0199bbbb-0000-7000-8000-000000000001", passage_count: 2, passages: [{ text: "hidden passage", embedding: [0.4] }] }) },
    { documentId: "c", source: { title: "Index pi sessions", project: "agent-health", started_at: "2026-10-19T10:00:00Z", session_url: "/?sessionId=0199cccc-0000-7000-8000-000000000001", session_id: "0199cccc-0000-7000-8000-000000000001", passage_count: 1 } },
  ],
  retrievalMode: "SIMPLE",
  usage: { planningTokens: 11, synthesisTokens: 22, totalTokens: 33 },
};

const synthesized = (intent: string) => ({
  ...fixture,
  retrievalMode: "AGENTIC",
  answer: `The session \`01a13ce5\` created the **OpenSearch domain** for pi sessions [1]. A later session indexed them [2]. (re: ${intent})`,
  citations: [{ documentIndex: 0 }, { documentIndex: 1 }],
  usage: { planningTokens: 331761, synthesisTokens: 1624, totalTokens: 333385 },
});

const historyDirs: string[] = [];
test.afterEach(async () => { await Promise.all(historyDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** Boots the real extension against a scripted upstream and wires its panel into the mock server's invoke route. */
async function installExtension(page: Page) {
  const pendingSlow: Array<(response: Response) => void> = [];
  const requests: any[] = [];
  let requestCounter = 0;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "x-amzn-RequestId": `e2e-req-${++requestCounter}` } });
  const upstream = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const intent = body.query.intent as string;
    if (intent.includes("expired")) return reply({ message: "The security token included in the request is expired" }, 403);
    if (intent.includes("nothing")) return reply({ ...fixture, documents: [] });
    if (intent.includes("slow")) {
      return new Promise<Response>((resolve, reject) => {
        pendingSlow.push(resolve);
        init?.signal?.addEventListener("abort", () => {
          pendingSlow.splice(pendingSlow.indexOf(resolve), 1);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (body.synthesize) return reply(synthesized(intent));
    // AGENTIC without synthesis: the API reports the agentic mode and returns documents only (no answer).
    if (body.retrieval === "AGENTIC") return reply({ ...fixture, retrievalMode: "AGENTIC", usage: { planningTokens: 4100, synthesisTokens: 0, totalTokens: 4100 } });
    return reply(fixture);
  };

  const handlers = new Map<string, (event: unknown, ctx: PiWebExtensionContext) => unknown>();
  const contributions = new Map<string, any>();
  const historyDir = await mkdtemp(join(tmpdir(), "pi-web-session-search-e2e-"));
  historyDirs.push(historyDir);
  createSessionSearchExtension({
    fetch: upstream as typeof fetch,
    loadCredentials: async () => credentials,
    historyFile: join(historyDir, "threads.json"),
    env: { PI_WEB_SESSION_SEARCH_ENDPOINT: "https://search.example.test/apps/e2e/search", PI_WEB_SESSION_SEARCH_PROFILE: "e2e", PI_WEB_SESSION_SEARCH_REFRESH_HINT: "refresh-e2e-creds --once", PI_WEB_SESSION_SEARCH_TRACES_URL: "https://traces.example.test/{requestId}" },
  })({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as PiWebExtensionAPI);
  await handlers.get("session_start")!({}, {
    ui: {
      notify: () => undefined,
      web: {
        capabilities: { apiVersion: 1, slots: ["panel", "fab", "header-action"], kinds: ["rendered", "static"], effects: ["open-panel"] },
        contribute: (key: string, spec: unknown) => spec === undefined ? contributions.delete(key) : contributions.set(key, spec),
        // The real host emits this event when an extension calls update(); replay it through the mock server.
        update: (key: string) => void page.request.post("/api/mock/event", { data: { type: "web_contribution_updated", sessionId: "mock-current", key } }).catch(() => undefined),
        registerSettings: async () => ({ registered: true, migrated: false, usedBackup: false }),
        getSettings: async () => ({ schemaVersion: 1, values: {} }),
      },
    },
  } as unknown as PiWebExtensionContext);

  await page.request.post("/api/mock/state", { data: {
    webContributions: [
      { version: 1, key: PANEL_KEY, slot: "panel", kind: "rendered", title: "Session search", label: "Session search", icon: "session-search", chrome: contributions.get(PANEL_KEY).chrome },
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

  return { invocations, requests, releaseSlow: () => pendingSlow.shift()?.(reply({ ...fixture, retrievalMode: "AGENTIC" })) };
}

async function openPanel(page: Page) {
  const stateLoaded = page.waitForResponse((response) => response.url().includes("/api/state") && response.ok());
  await page.goto("/");
  await stateLoaded;
  await page.locator('#headerActions .webHeaderActionButton[title="Session search"]').click();
  const panel = page.locator("#webExtensionPanel");
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * The timeline must be scrolled so the latest turn's "You asked" header is fully in view, at the top of the
 * timeline — or, when the turn is too short to reach the top, with the timeline scrolled to its end.
 */
async function expectLatestHeaderInView(panel: ReturnType<Page["locator"]>) {
  await expect.poll(() => panel.locator(".ssxTimeline").evaluate((timeline) => {
    const asked = timeline.querySelector(".ssxTurn:last-of-type .ssxAsked")!;
    const t = timeline.getBoundingClientRect();
    const a = asked.getBoundingClientRect();
    const fullyVisible = a.top >= t.top - 1 && a.bottom <= t.bottom + 1;
    const atTop = a.top - t.top < 40;
    const atEnd = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= 1;
    return { fullyVisible, placed: atTop || atEnd };
  })).toEqual({ fullyVisible: true, placed: true });
}

const composer = (panel: ReturnType<Page["locator"]>) => ({
  input: panel.getByRole("searchbox", { name: "Ask a question or search your sessions" }),
  simple: panel.getByRole("radio", { name: "SIMPLE", exact: true }),
  agentic: panel.getByRole("radio", { name: "AGENTIC", exact: true }),
  answer: panel.getByRole("radio", { name: "AGENTIC + ANSWER", exact: true }),
  send: panel.getByRole("button", { name: "Send" }),
});

/** Every side of the element's computed border is 0px (hairline dividers are drawn with pseudo-elements, not borders). */
const borderWidths = (locator: ReturnType<Page["locator"]>) => locator.evaluate((element) => {
  const style = getComputedStyle(element);
  return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
});

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
});

test("one header row and flat turns: an AGENTIC + ANSWER turn shows 'You asked', 'Answer' with citations, 'Matching sessions (MODE)', footer; SIMPLE and AGENTIC turns show 'Results (MODE) for' and no Answer", async ({ page }) => {
  const { invocations, requests } = await installExtension(page);

  // The launcher is the top-right control of the header and carries the extension's own logo.
  const stateLoaded = page.waitForResponse((response) => response.url().includes("/api/state") && response.ok());
  await page.goto("/");
  await stateLoaded;
  const launcher = page.locator('#headerActions .webHeaderActionButton[title="Session search"]');
  await expect(launcher).toBeVisible();
  await expect(launcher.locator("svg circle")).toHaveCount(1);
  await expect(launcher.locator("svg path")).toHaveCount(2);
  const placement = await launcher.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const bar = button.closest("#statusBar")!.getBoundingClientRect();
    return { top: rect.top, right: rect.right, barRight: bar.right, barTop: bar.top };
  });
  expect(placement.top).toBeGreaterThanOrEqual(placement.barTop);
  expect(placement.barRight - placement.right).toBeLessThanOrEqual(12);

  await launcher.click();
  const panel = page.locator("#webExtensionPanel");
  await expect(panel).toBeVisible();
  // ONE header: the host draws no title bar (chrome: "none"); the panel's own row is the only header and sits at the very top.
  await expect(panel.locator("header.webPanelHeader")).toBeHidden();
  await expect(panel.locator("h2")).toBeHidden();
  await expect(panel.getByText("Session search", { exact: true })).toBeHidden();
  await expect(panel.locator("header:visible")).toHaveCount(1);
  const header = panel.locator(".ssxHead");
  await expect(header).toBeVisible();
  const [panelBox, headerBox] = await Promise.all([panel.boundingBox(), header.boundingBox()]);
  expect(headerBox!.y - panelBox!.y).toBeLessThanOrEqual(2);
  // Its controls: "+ New thread" and × (host-handled close); the thread switcher appears once a thread exists.
  await expect(header.getByRole("button", { name: "+ New thread" })).toBeVisible();
  await expect(header.getByRole("button", { name: "Close panel" })).toBeVisible();
  await expect(header.locator('[data-web-action="close-panel"]')).toHaveCount(1);
  expect(await borderWidths(header)).toEqual(["0px", "0px", "1px", "0px"]); // bottom hairline only
  const { input, simple, agentic, answer: answerMode, send } = composer(panel);
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("placeholder", "Ask a question or search your sessions…");
  // Three explicit modes with exact labels; AGENTIC + ANSWER is the default; each explains itself in one line on hover.
  await expect(panel.locator(".ssxModes label")).toHaveText(["SIMPLE", "AGENTIC", "AGENTIC + ANSWER"]);
  await expect(answerMode).toBeChecked();
  await expect(simple).not.toBeChecked();
  await expect(agentic).not.toBeChecked();
  for (const [index, prefix] of ["SIMPLE: ", "AGENTIC: ", "AGENTIC + ANSWER: "].entries()) {
    const title = await panel.locator(".ssxModes label").nth(index).getAttribute("title");
    expect(title!.startsWith(prefix)).toBe(true);
    expect(title).not.toContain("\n");
  }
  // Empty thread: the header says so, and the hint explains what a thread is.
  await expect(header.locator(".ssxHeadTitle")).toHaveText("New thread");
  await expect(header.locator(".ssxHeadMeta")).toHaveText("nothing asked yet");
  await expect(header.locator("summary")).toHaveCount(0);
  // The old controls are gone.
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await expect(panel.getByRole("combobox")).toHaveCount(0);
  await expect(panel.getByText("Continue conversation")).toHaveCount(0);
  await expect(panel.getByText("Synthesize answer")).toHaveCount(0);
  await expect(panel.locator(".ssxEmpty")).toHaveText("Ask a question about your sessions — follow-ups in this thread keep the context.");

  // Composer pinned at the bottom, Send right-aligned, even while the thread is empty.
  const body = panel.locator(".webPanelBody");
  const geometry = async () => {
    const [bodyBox, formBox, sendBox, inputBox] = await Promise.all([body.boundingBox(), panel.locator(".ssxComposer").boundingBox(), send.boundingBox(), input.boundingBox()]);
    return { bodyBottom: bodyBox!.y + bodyBox!.height, formBottom: formBox!.y + formBox!.height, formRight: formBox!.x + formBox!.width, sendRight: sendBox!.x + sendBox!.width, inputX: inputBox!.x, sendX: sendBox!.x };
  };
  let g = await geometry();
  expect(g.bodyBottom - g.formBottom).toBeLessThanOrEqual(24);
  expect(g.formRight - g.sendRight).toBeLessThanOrEqual(16);
  expect(g.sendX).toBeGreaterThan(g.inputX);

  // AGENTIC + ANSWER: one borderless turn. Its "You asked" band carries the whole question, left-aligned, full width, wrapped, unclipped.
  await input.fill(LONG_QUESTION);
  await input.press("Enter");
  const turns = panel.locator(".ssxTurn");
  const asked = panel.getByRole("group", { name: "You asked" });
  const question = panel.locator(".ssxQuestion");
  await expect(turns).toHaveCount(1);
  await expect(turns.first()).toHaveAttribute("aria-label", "Turn 1");
  await expect(asked).toHaveCount(1);
  await expect(asked.locator(".ssxLabel")).toContainText("You asked");
  await expect(asked.locator(".ssxWhen")).toHaveText("just now");
  await expect(question).toHaveText(LONG_QUESTION);
  const untruncated = await question.evaluate((element) => {
    const style = getComputedStyle(element);
    const range = document.createRange(); range.selectNodeContents(element);
    const lines = range.getClientRects().length;
    return { overflowHidden: style.overflow === "hidden" || style.textOverflow === "ellipsis", clipped: element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1, lineClamp: (style as any).webkitLineClamp, nowrap: style.whiteSpace === "nowrap", wrapped: lines > 1 };
  });
  expect(untruncated).toEqual({ overflowHidden: false, clipped: false, lineClamp: "none", nowrap: false, wrapped: true });
  const questionBox = (await question.boundingBox())!;
  const turnBox = (await turns.first().boundingBox())!;
  const timelineBox0 = (await panel.locator(".ssxTimeline").boundingBox())!;
  expect(questionBox.x - turnBox.x).toBeLessThanOrEqual(20); // left-aligned…
  expect(questionBox.width).toBeGreaterThan(turnBox.width * 0.85); // …and full width
  expect(questionBox.y).toBeGreaterThanOrEqual(timelineBox0.y - 1); // the first word is in view, not scrolled off the top
  expect(questionBox.y + questionBox.height).toBeLessThanOrEqual(timelineBox0.y + timelineBox0.height + 1);
  // Flat: the turn is not a bordered card and there is no card wrapper; "You asked" is a tinted band, the reply is plain.
  await expect(panel.locator(".ssxCard")).toHaveCount(0);
  expect(await borderWidths(turns.first())).toEqual(["0px", "0px", "0px", "0px"]);
  expect(await borderWidths(asked.first())).toEqual(["0px", "0px", "0px", "0px"]);
  expect(await borderWidths(panel.locator(".ssxReply").first())).toEqual(["0px", "0px", "0px", "0px"]);
  const bandTint = await asked.first().evaluate((element) => getComputedStyle(element).backgroundColor);
  const replyTint = await panel.locator(".ssxReply").first().evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(bandTint).not.toBe("rgba(0, 0, 0, 0)");
  expect(replyTint).toBe("rgba(0, 0, 0, 0)");
  // The thread header titles the thread by this question (one line, full text on hover) and counts its turns — on the same row as the meta.
  await expect(header.locator(".ssxHeadTitle")).toHaveText(LONG_QUESTION);
  await expect(header.locator(".ssxHeadTitle")).toHaveAttribute("title", LONG_QUESTION);
  const oneLine = await header.locator(".ssxHeadTitle").evaluate((element) => ({ ellipsis: getComputedStyle(element).textOverflow === "ellipsis", nowrap: getComputedStyle(element).whiteSpace === "nowrap", height: element.getBoundingClientRect().height }));
  expect(oneLine.ellipsis).toBe(true); expect(oneLine.nowrap).toBe(true); expect(oneLine.height).toBeLessThan(28);
  await expect(header.locator(".ssxHeadMeta")).toHaveText("started just now · 1 turn");
  await expect(header.locator("summary")).toHaveText("Switch thread");
  const row = await header.evaluate((element) => {
    const tops = [".ssxHeadTitle", ".ssxHeadMeta", "summary", ".ssxNew", ".ssxClose"].map((selector) => {
      const rect = element.querySelector(selector)!.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    return { spread: Math.max(...tops) - Math.min(...tops), height: element.getBoundingClientRect().height };
  });
  expect(row.spread).toBeLessThan(12); // every control is vertically centred on one row
  expect(row.height).toBeLessThan(60);

  const answer = panel.getByRole("group", { name: "Answer" });
  await expect(answer).toHaveCount(1);
  await expect(answer.locator("section[aria-label='Answer'] > .ssxLabel")).toHaveText("Answer");
  const markdown = answer.locator(".ssxAnswer");
  await expect(markdown).toContainText("created the OpenSearch domain for pi sessions");
  await expect(markdown.locator("strong")).toHaveText("OpenSearch domain");
  await expect(markdown.locator("code")).toHaveText("01a13ce5");
  await expect(markdown.locator(".ssxCite")).toHaveText(["[1]", "[2]"]);
  await expect(markdown.locator(".ssxCite").first()).toHaveAttribute("title", "Create the pi sessions OpenSearch domain");
  await expect(answer.locator(".ssxSessionsLabel")).toHaveText("Matching sessions (AGENTIC + ANSWER) · 3");
  const hits = answer.locator(".ssxHit");
  await expect(hits).toHaveCount(3);
  // Session rows are list rows: no box border; a hairline (pseudo-element) separates consecutive rows.
  for (let index = 0; index < 3; index++) expect(await borderWidths(hits.nth(index))).toEqual(["0px", "0px", "0px", "0px"]);
  expect(await hits.nth(1).evaluate((element) => getComputedStyle(element, "::before").height)).toBe("1px");
  expect(await hits.nth(0).evaluate((element) => getComputedStyle(element, "::before").content)).toBe("none");
  await expect(hits.nth(0)).toContainText("Create the pi sessions OpenSearch domain");
  await expect(hits.nth(0)).toContainText("pi-web-origin");
  await expect(hits.nth(0)).toContainText("2026-10-21 10:00 UTC");
  await expect(hits.nth(0)).toContainText("7 passages");
  await expect(hits.nth(0).getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b");
  await expect(hits.nth(2)).toContainText("agent-health");
  expect((await markdown.boundingBox())!.y).toBeLessThan((await hits.first().boundingBox())!.y);
  const footer = answer.locator(".ssxFooter");
  await expect(footer.locator(".ssxFooterMode")).toHaveText("AGENTIC + ANSWER");
  expect(await borderWidths(footer)).toEqual(["0px", "0px", "0px", "0px"]);
  await expect(footer).toContainText(/\d+(\.\d)?s/);
  await expect(footer).toContainText("tokens 333385 (planning 331761, synthesis 1624)");
  await expect(footer.locator(".ssxReqId")).toHaveText("e2e-req-1");
  await expect(footer.getByRole("button", { name: "Copy request id" })).toBeVisible();
  await expect(footer.getByRole("link", { name: "Open traces" })).toHaveAttribute("href", "https://traces.example.test/e2e-req-1");
  await expect(panel.locator(".webPanelBody")).not.toContainText("hidden passage");
  await expect(panel.locator(".webPanelBody")).not.toContainText(credentials.sessionToken);
  expect(requests.at(-1)).toMatchObject({ query: { intent: LONG_QUESTION }, retrieval: "AGENTIC", synthesize: true, synthesisOptions: { maxTokens: 600, temperature: 0, responseFormat: "MARKDOWN" }, retrievalOptions: { maxTurns: 6 }, maxResults: 5 });
  expect(invocations.at(-1)).toMatchObject({ slot: "panel", key: PANEL_KEY, event: { action: "send", fields: { query: LONG_QUESTION, mode: "agentic-answer" } } });
  // The composer is cleared and still pinned at the bottom.
  await expect(input).toHaveValue("");
  g = await geometry();
  expect(g.bodyBottom - g.formBottom).toBeLessThanOrEqual(24);

  // SIMPLE: `Results (SIMPLE) for "…"` and the list only — no Answer section — in the same thread, under the same conversation id.
  await simple.check();
  await input.fill("index pi sessions");
  await send.click();
  await expect(turns).toHaveCount(2);
  await expect(question.last()).toHaveText("index pi sessions"); // newest turn last, drawn below the earlier one…
  const positions = await question.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().y));
  expect(positions[1]).toBeGreaterThan(positions[0]);
  // …separated by a hairline divider (not a border on the article), and the timeline is scrolled so the newest turn's "You asked" header is at the top of the view.
  expect(await borderWidths(turns.nth(1))).toEqual(["0px", "0px", "0px", "0px"]);
  expect(await turns.nth(1).evaluate((element) => getComputedStyle(element, "::before").height)).toBe("1px");
  expect(await turns.nth(0).evaluate((element) => getComputedStyle(element, "::before").content)).toBe("none");
  let latest = turns.nth(1);
  await expect(latest.locator(".ssxAsked")).toBeInViewport();
  await expectLatestHeaderInView(panel);
  await expect(latest.getByRole("group", { name: "Results" })).toHaveCount(1);
  await expect(latest.getByRole("group", { name: "Answer" })).toHaveCount(0);
  await expect(latest.locator(".ssxAnswer")).toHaveCount(0);
  await expect(latest.locator("section[aria-label='Answer']")).toHaveCount(0);
  await expect(latest.locator(".ssxSessionsLabel")).toHaveText("Results (SIMPLE) for “index pi sessions” · 3");
  await expect(latest.locator(".ssxHit")).toHaveCount(3);
  await expect(header.locator(".ssxHeadTitle")).toHaveText(LONG_QUESTION); // the title stays the FIRST question
  await expect(header.locator(".ssxHeadMeta")).toHaveText("started just now · 2 turns");
  await expect(latest.locator(".ssxFooter .ssxFooterMode")).toHaveText("SIMPLE");
  await expect(latest.locator(".ssxFooter")).toContainText("tokens 33");
  expect(requests.at(-1)).toEqual({ query: { intent: "index pi sessions" }, retrieval: "SIMPLE", sessionId: requests[0].sessionId, maxResults: 10 });
  await expect(simple).toBeChecked();

  // AGENTIC (no answer): agentic retrieval, five results, no synthesis — the API returns documents only, so the turn is a
  // `Results (AGENTIC) for "…"` list with no Answer section at all.
  await agentic.check();
  await input.fill("sessions that indexed pi history");
  await send.click();
  await expect(turns).toHaveCount(3);
  latest = turns.nth(2);
  await expect(latest.locator(".ssxQuestion")).toHaveText("sessions that indexed pi history");
  await expect(latest.getByRole("group", { name: "Results" })).toHaveCount(1);
  await expect(latest.getByRole("group", { name: "Answer" })).toHaveCount(0);
  await expect(latest.locator("section[aria-label='Answer']")).toHaveCount(0);
  await expect(latest.locator(".ssxAnswer")).toHaveCount(0);
  await expect(latest.locator(".ssxSessionsLabel")).toHaveText("Results (AGENTIC) for “sessions that indexed pi history” · 3");
  await expect(latest.locator(".ssxHit")).toHaveCount(3);
  await expect(latest.locator(".ssxFooter .ssxFooterMode")).toHaveText("AGENTIC");
  await expect(latest.locator(".ssxFooter")).not.toContainText("ran ");
  await expect(latest.locator(".ssxFooter")).toContainText("tokens 4100");
  expect(requests.at(-1)).toEqual({ query: { intent: "sessions that indexed pi history" }, retrieval: "AGENTIC", sessionId: requests[0].sessionId, maxResults: 5 });
  expect(invocations.at(-1)).toMatchObject({ event: { action: "send", fields: { mode: "agentic" } } });
  await expect(agentic).toBeChecked();
  await expect(header.locator(".ssxHeadMeta")).toHaveText("started just now · 3 turns");

  // The mode is remembered per thread: close with the panel's own × (host-handled, no extension call) and reopen → AGENTIC is still selected.
  const invokesBeforeClose = invocations.length;
  await header.getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toBeHidden();
  expect(invocations.length).toBe(invokesBeforeClose);
  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(turns).toHaveCount(3);
  await expect(agentic).toBeChecked();
  await expect(answerMode).not.toBeChecked();
  // A new thread starts on the default mode; switching back to the saved thread restores AGENTIC.
  await header.getByRole("button", { name: "+ New thread" }).click();
  await expect(answerMode).toBeChecked();
  await header.locator("summary").click();
  await panel.locator(".ssxThreadItem").first().click();
  await expect(turns).toHaveCount(3);
  await expect(agentic).toBeChecked();
  await simple.check();

  // Empty and error turns stay in the thread with their question.
  await input.fill("nothing like this");
  await input.press("Enter");
  await expect(turns.last().locator(".ssxReply")).toContainText("No sessions matched.");
  await expect(turns.last().locator(".ssxSessionsLabel")).toHaveText("Results (SIMPLE) for “nothing like this” · 0");
  await input.fill("expired credentials please");
  await input.press("Enter");
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText('AWS credentials for profile "e2e" were rejected (HTTP 403)');
  await expect(alert).toContainText("refresh-e2e-creds --once");
  await expect(question.last()).toHaveText("expired credentials please");
  await expect(panel.locator(".webPanelBody")).not.toContainText(credentials.sessionToken);
  await expect(input).toBeEnabled();
});

test("follow-ups reuse the thread's conversation id, New thread mints another, and reopening the panel shows the latest thread", async ({ page }) => {
  const { requests } = await installExtension(page);
  const panel = await openPanel(page);
  const { input, send } = composer(panel);
  const question = panel.locator(".ssxQuestion");
  const header = panel.locator(".ssxHead");

  await input.fill("which session created the OpenSearch domain for pi sessions");
  await input.press("Enter");
  await expect(question).toHaveCount(1);
  await input.fill("what engine version did it confirm?");
  await send.click();
  await expect(question).toHaveCount(2);
  await expect(panel.locator(".ssxAnswer").last()).toContainText("(re: what engine version did it confirm?)");
  expect(requests).toHaveLength(2);
  expect(requests[0].sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[1].sessionId).toBe(requests[0].sessionId);
  const threads = panel.locator("summary", { hasText: "Switch thread" });
  await expect(threads).toHaveAttribute("title", "1 saved thread");
  await expect(header.locator(".ssxHeadTitle")).toHaveText("which session created the OpenSearch domain for pi sessions");
  await expect(header.locator(".ssxHeadMeta")).toHaveText("started just now · 2 turns");

  await panel.getByRole("button", { name: "+ New thread" }).click();
  await expect(question).toHaveCount(0);
  await expect(header.locator(".ssxHeadTitle")).toHaveText("New thread");
  await expect(panel.locator(".ssxEmpty")).toContainText("Ask a question about your sessions");
  await input.fill("unrelated question in a new thread");
  await input.press("Enter");
  await expect(question).toHaveCount(1);
  expect(requests).toHaveLength(3);
  expect(requests[2].sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[2].sessionId).not.toBe(requests[0].sessionId);
  await expect(threads).toHaveAttribute("title", "2 saved threads");
  await expect(header.locator(".ssxHeadTitle")).toHaveText("unrelated question in a new thread");

  // Close (the panel's own ×) and reopen: the most recent thread, with its turns, is what comes back — never a lone stale result.
  await panel.locator(".ssxHead").getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toBeHidden();
  await page.locator('#headerActions .webHeaderActionButton[title="Session search"]').click();
  await expect(panel).toBeVisible();
  await expect(question).toHaveCount(1);
  await expect(question).toHaveText("unrelated question in a new thread");
  expect(requests).toHaveLength(3);

  // Switch to the older thread from the dropdown (first question + relative time) and continue it under its original conversation id; then delete it.
  await threads.click();
  const items = panel.locator(".ssxThreadItem");
  await expect(items).toHaveCount(2);
  // The open dropdown stays inside the panel (it is anchored to the header, not to the small summary button).
  const [listBox, panelBodyBox] = await Promise.all([panel.locator(".ssxThreadList").boundingBox(), panel.locator(".webPanelBody").boundingBox()]);
  expect(listBox!.x).toBeGreaterThanOrEqual(panelBodyBox!.x - 1);
  expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(panelBodyBox!.x + panelBodyBox!.width + 1);
  await expect(items.nth(0).locator(".ssxThreadQ")).toHaveText("unrelated question in a new thread");
  await expect(items.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(items.nth(1).locator(".ssxThreadQ")).toHaveText("which session created the OpenSearch domain for pi sessions");
  await expect(items.nth(1).locator(".ssxThreadMeta")).toHaveText("just now · 2 turns");
  await items.nth(1).click();
  await expect(question).toHaveCount(2);
  await expect(header.locator(".ssxHeadTitle")).toHaveText("which session created the OpenSearch domain for pi sessions");
  await expect(question.first()).toHaveText("which session created the OpenSearch domain for pi sessions");
  await input.fill("and the instance type?");
  await input.press("Enter");
  await expect(question).toHaveCount(3);
  expect(requests[3].sessionId).toBe(requests[0].sessionId);

  // Reload the page: the panel still opens on the most recent thread (the one just continued).
  await page.reload();
  await page.locator('#headerActions .webHeaderActionButton[title="Session search"]').click();
  await expect(question).toHaveCount(3);
  await expect(question.last()).toHaveText("and the instance type?");
  // …scrolled so the newest turn's "You asked" header is at the top of the timeline (not the bottom of its answer).
  const latestAsked = panel.locator(".ssxTurn").last().locator(".ssxAsked");
  await expect(latestAsked).toBeInViewport();
  await expect(latestAsked.locator(".ssxLabel")).toContainText("You asked");
  await expectLatestHeaderInView(panel);
  await expect(header.locator(".ssxHeadMeta")).toHaveText("started just now · 3 turns");

  await threads.click();
  await panel.getByRole("button", { name: "Delete thread" }).nth(0).click();
  await expect(question).toHaveCount(1);
  await expect(question).toHaveText("unrelated question in a new thread");
  await expect(threads).toHaveAttribute("title", "1 saved thread");
  expect(requests).toHaveLength(4);
});

test("while an Ask turn is in flight the composer is locked, Cancel ends it, and a completed slow turn repaints on its own", async ({ page }) => {
  const { invocations, requests, releaseSlow } = await installExtension(page);
  const panel = await openPanel(page);
  const { input, simple, agentic, answer, send } = composer(panel);
  const question = panel.locator(".ssxQuestion");

  await input.fill("slow agentic question");
  await input.press("Enter");
  await expect(question).toHaveText("slow agentic question");
  const status = panel.getByRole("status");
  await expect(status).toContainText("Thinking…");
  await expect(status).toContainText("answers usually take 30–90 s");
  await expect(panel.locator(".ssxSpinner")).toBeVisible();
  await expect(input).toBeDisabled();
  await expect(send).toBeDisabled();
  await expect(simple).toBeDisabled();
  await expect(agentic).toBeDisabled();
  await expect(answer).toBeDisabled();
  await expect(panel.getByRole("button", { name: "+ New thread" })).toBeDisabled();
  await expect(panel.locator(".ssxHead .ssxHeadTitle")).toHaveText("slow agentic question");
  const sends = () => invocations.filter((call) => call.event?.action === "send").length;
  expect(sends()).toBe(1);
  expect(requests).toHaveLength(1);

  // Forcing interactions on the locked composer starts nothing.
  await input.click({ force: true });
  await send.click({ force: true });
  await simple.click({ force: true });
  await page.waitForTimeout(300);
  expect(sends()).toBe(1);
  expect(requests).toHaveLength(1);
  await expect(panel.locator(".ssxSpinner")).toBeVisible();

  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(status).toHaveText("Cancelled.");
  await expect(panel.locator(".ssxSpinner")).toHaveCount(0);
  await expect(input).toBeEnabled();
  await expect(send).toBeEnabled();

  // Second slow turn: let it finish; the extension's update() must repaint without any click.
  await input.fill("another slow one");
  await input.press("Enter");
  await expect(panel.locator(".ssxSpinner")).toBeVisible();
  await expect(input).toBeDisabled();
  releaseSlow();
  await expect(panel.locator(".ssxHit")).toHaveCount(3, { timeout: 10_000 });
  await expect(panel.getByRole("group", { name: "Answer" }).locator(".ssxFooter .ssxFooterMode")).toHaveText("AGENTIC + ANSWER");
  await expect(input).toBeEnabled();
  await expect(input).toBeFocused();
  // The cancelled turn is not kept; the thread holds the finished one only.
  await expect(question).toHaveCount(1);
  await expect(question).toHaveText("another slow one");
  expect(requests).toHaveLength(2);
  expect(requests[1].sessionId).toBe(requests[0].sessionId);
});
