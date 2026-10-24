/**
 * Integration: the real pi-web contribution bridge (the code behind
 * POST /api/web-contributions/invoke) hosting the session-search extension,
 * with a real settings store, a real credentials file, and a real HTTP upstream
 * that verifies the SigV4 signature the way AWS would.
 */
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignatureV4 } from "@smithy/signature-v4";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebUiBridge } from "../server/extensions/webUi.js";
import { createSettingsStore } from "../server/settings.js";
import type { PiWebExtensionAPI, PiWebExtensionContext } from "../src/extensions.js";
import { PANEL_KEY, SETTINGS_ID, createSessionSearchExtension } from "../examples/pi-web-extensions/session-search.js";

const fakeCredentials = { accessKeyId: "ASIAINTEGRATION", secretAccessKey: "integration/secret/value", sessionToken: "IQoJIntegrationSessionToken==" };

const upstreamFixture = {
  documents: [
    { datasetId: "ds", documentId: "a", source: { title: "Create the pi sessions OpenSearch domain", project: "pi-web-origin", started_at: "2026-10-21T10:00:00Z", session_url: "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b", session_id: "01a13ce5-9ebc-716c-be1c-ec84cf90e58b", passage_count: 7, passages: Array.from({ length: 3 }, (_, index) => ({ text: `passage body ${index}`, embedding: [0.1, 0.2, 0.3] })) } },
    // Production serialises `source` as a JSON string.
    { datasetId: "ds", documentId: "b", source: JSON.stringify({ title: "Index pi sessions", project: "pi-web-origin", started_at: "2026-10-20T10:00:00Z", session_url: "/?sessionId=0199bbbb-0000-7000-8000-000000000001", session_id: "0199bbbb-0000-7000-8000-000000000001", passage_count: 2, passages: [{ text: "passage body string", embedding: [0.4] }] }) },
    { datasetId: "ds", documentId: "c", source: { title: "Index pi sessions", project: "agent-health", started_at: "2026-10-19T10:00:00Z", session_url: "/?sessionId=0199cccc-0000-7000-8000-000000000001", session_id: "0199cccc-0000-7000-8000-000000000001", passage_count: 1 } },
  ],
  retrievalMode: "SIMPLE",
  usage: { planningTokens: 11, synthesisTokens: 22, totalTokens: 33 },
};

type Received = { headers: IncomingMessage["headers"]; body: string; url: string };

class Sha256 {
  private hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(secret?: Uint8Array | string) { this.hash = secret === undefined ? createHash("sha256") : createHmac("sha256", secret); }
  update(data: Uint8Array | string) { this.hash.update(data); }
  async digest() { return new Uint8Array(this.hash.digest()); }
}

/** Recomputes the SigV4 signature from the request the upstream actually received, like AWS does. */
async function verifySignature(received: Received, region: string, service: string) {
  const amzDate = String(received.headers["x-amz-date"]);
  const signingDate = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
  const signedHeaderNames = /SignedHeaders=([^,]+)/.exec(String(received.headers.authorization))![1].split(";");
  const headers = Object.fromEntries(signedHeaderNames.map((name) => [name, String(received.headers[name])]));
  const signer = new SignatureV4({ credentials: fakeCredentials, region, service, sha256: Sha256 as any, applyChecksum: false });
  const url = new URL(received.url, `http://${received.headers.host}`);
  const expected = await signer.sign({ method: "POST", protocol: "http:", hostname: url.hostname, port: Number(url.port), path: url.pathname, query: {}, headers, body: received.body } as any, { signingDate });
  return expected.headers.authorization === received.headers.authorization;
}

describe("session-search extension through the pi-web contribution bridge", () => {
  let upstream: Server;
  let upstreamUrl: string;
  let received: Received[] = [];
  let respond: (req: Received) => { status: number; body: string } = () => ({ status: 200, body: JSON.stringify(upstreamFixture) });
  let tempDir: string;

  beforeEach(async () => {
    received = [];
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const entry = { headers: req.headers, body: Buffer.concat(chunks).toString(), url: req.url || "/" };
        received.push(entry);
        const reply = respond(entry);
        res.writeHead(reply.status, { "content-type": "application/json", "x-amzn-RequestId": `upstream-req-${received.length}` }).end(reply.body);
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    upstreamUrl = `http://127.0.0.1:${address.port}/apps/app-under-test/search`;

    tempDir = await mkdtemp(join(tmpdir(), "pi-web-session-search-it-"));
    await writeFile(join(tempDir, "credentials"), `[integration]\naws_access_key_id=${fakeCredentials.accessKeyId}\naws_secret_access_key=${fakeCredentials.secretAccessKey}\naws_session_token=${fakeCredentials.sessionToken}\n`, { mode: 0o600 });
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", join(tempDir, "credentials"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    upstream.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function host() {
    const emitted: any[] = [];
    const settingsStore = createSettingsStore(join(tempDir, "settings.json"));
    const bridge = createWebUiBridge({
      emit: (value) => emitted.push(value),
      clientCount: () => 1,
      withWorkLease: (_session: any, _label: string, operation: () => Promise<any>) => operation(),
      createNewSession: async () => ({}),
      sessionCwd: () => tempDir,
      state: () => ({}),
      settingsStore,
      modelOptions: () => new Set<string>(),
    });
    let ui: any;
    const session = {
      sessionId: "search-session", sessionFile: join(tempDir, "session.jsonl"), agent: { waitForIdle: async () => undefined },
      bindExtensions: async (options: any) => { ui = options.uiContext; },
    };
    await bridge.bind(session);

    const handlers = new Map<string, (event: unknown, ctx: PiWebExtensionContext) => unknown>();
    // Threads go where a real install puts them: PI_WEB_HOME/session-search-threads.json (legacy history alongside).
    const extension = createSessionSearchExtension({
      env: { PI_WEB_SESSION_SEARCH_ENDPOINT: upstreamUrl, PI_WEB_SESSION_SEARCH_PROFILE: "integration", PI_WEB_SESSION_SEARCH_REGION: "us-east-1", PI_WEB_SESSION_SEARCH_SERVICE: "aisearch", PI_WEB_SESSION_SEARCH_REFRESH_HINT: "my-refresh --profile integration --once", PI_WEB_HOME: tempDir },
    });
    extension({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as PiWebExtensionAPI);
    await handlers.get("session_start")!({}, { ui, cwd: tempDir } as unknown as PiWebExtensionContext);
    const invoke = (event: Record<string, unknown>) => bridge.invokeContribution(session, { slot: "panel", key: PANEL_KEY, event });
    return { bridge, session, emitted, invoke, handlers, ui, settingsStore, historyFile: join(tempDir, "session-search-threads.json") };
  }

  it("publishes browser-safe descriptors and settings for the panel", async () => {
    const { bridge, session } = await host();
    const entries = bridge.entries(session).webContributions as any[];
    expect(entries.map((entry) => [entry.key, entry.slot])).toEqual([
      [PANEL_KEY, "panel"], [`${PANEL_KEY}-launcher`, "fab"], [`${PANEL_KEY}-header`, "header-action"],
    ]);
    expect(entries.find((entry) => entry.slot === "fab")).toMatchObject({ opens: PANEL_KEY, icon: "session-search" });
    // The panel asks the host for no title bar; it draws its own header row with a host-handled close action.
    expect(entries.find((entry) => entry.slot === "panel")).toMatchObject({ chrome: "none", title: "Session search", icon: "session-search" });
    expect(entries.find((entry) => entry.slot === "header-action")).toMatchObject({ icon: "session-search", title: "Session search" });
    const serialized = JSON.stringify(entries);
    expect(entries.every((entry) => !("render" in entry) && !("source" in entry))).toBe(true);
    expect(serialized).not.toContain(upstreamUrl);
    expect(serialized).not.toContain(fakeCredentials.sessionToken);
    const schema = bridge.settingsSchemas().find((candidate: any) => candidate.id === SETTINGS_ID) as any;
    expect(schema.fields.map((field: any) => field.key)).toEqual(["endpoint", "profile", "region", "service", "refreshHint", "tracesUrl"]);
    await expect(bridge.invokeContribution(session, { slot: "header-action", key: `${PANEL_KEY}-header` }))
      .resolves.toMatchObject({ effects: [{ type: "open-panel", key: PANEL_KEY }] });
  });

  it("Search turn: signs the upstream request with the profile credentials and returns only display fields as a list", async () => {
    const { invoke, emitted } = await host();
    const idle = await invoke({});
    expect(idle.html).toContain('name="query"');
    expect(idle.html).toContain("Ask a question about your sessions — follow-ups in this thread keep the context.");
    expect(idle.html).toContain('<span class="ssxHeadTitle" title="New thread">New thread</span>');

    const view = await invoke({ action: "send", fields: { query: "which session created the OpenSearch domain for pi sessions", mode: "simple" } });
    expect(view.title).toBe("Session search");

    // Upstream saw exactly one signed POST with the API's request shape.
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe("/apps/app-under-test/search");
    const body = JSON.parse(received[0].body);
    expect(body).toEqual({ query: { intent: "which session created the OpenSearch domain for pi sessions" }, retrieval: "SIMPLE", maxResults: 10, sessionId: body.sessionId });
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(received[0].headers["x-amz-security-token"]).toBe(fakeCredentials.sessionToken);
    expect(received[0].headers.authorization).toContain(`Credential=${fakeCredentials.accessKeyId}/`);
    expect(received[0].headers.authorization).toContain("/us-east-1/aisearch/aws4_request");
    await expect(verifySignature(received[0], "us-east-1", "aisearch")).resolves.toBe(true);
    await expect(verifySignature(received[0], "us-west-2", "aisearch")).resolves.toBe(false);

    // The browser gets the question, titles, projects, dates, links, counts, usage and request id — nothing else.
    expect(view.html).toContain('<p class="ssxQuestion">which session created the OpenSearch domain for pi sessions</p>');
    expect(view.html.match(/class="ssxHit"/g)).toHaveLength(3);
    expect(view.html).toContain("Create the pi sessions OpenSearch domain");
    expect(view.html).toContain('<a href="/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b">Open session</a>');
    expect(view.html).toContain('<span class="ssxProject">agent-health</span>');
    expect(view.html).toContain("2026-10-21 10:00 UTC");
    expect(view.html).toContain("7 passages");
    expect(view.html).toContain('<span class="ssxFooterMode" title="Mode of this turn">SIMPLE</span>');
    expect(view.html).toContain("tokens 33 (planning 11, synthesis 22)");
    expect(view.html).toContain('<code class="ssxReqId" title="Request id">upstream-req-1</code>');
    expect(view.html).toContain('Results (SIMPLE) for <span class="ssxLabelText">“which session created the OpenSearch domain for pi sessions”</span> · 3');
    expect(view.html).not.toContain('class="ssxAnswer"');
    expect(view.html).not.toContain('aria-label="Answer"');
    expect(view.html).not.toContain("Open traces");
    for (const leak of ["passage body", "embedding", "0.1,0.2", fakeCredentials.secretAccessKey, fakeCredentials.sessionToken, fakeCredentials.accessKeyId, "aws4_request"]) {
      expect(view.html).not.toContain(leak);
    }

    // A fast turn is painted by the invoke response itself; no repaint event is needed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emitted.some((event) => event.type === "web_contribution_updated" && event.key === PANEL_KEY)).toBe(false);

    // AGENTIC (no synthesis) in the same thread: AGENTIC retrieval, five results, no synthesize flag, no retrieval budget; the
    // reply is a list headed by the mode with no Answer section, even if the upstream happened to include an answer.
    respond = () => ({ status: 200, body: JSON.stringify({ ...upstreamFixture, retrievalMode: "AGENTIC", answer: "should not be shown", citations: [{ documentIndex: 0 }] }) });
    const agentic = await invoke({ action: "send", fields: { query: "index pi sessions", mode: "agentic" } });
    expect(received).toHaveLength(2);
    expect(JSON.parse(received[1].body)).toEqual({ query: { intent: "index pi sessions" }, retrieval: "AGENTIC", maxResults: 5, sessionId: body.sessionId });
    expect(agentic.html).toContain('Results (AGENTIC) for <span class="ssxLabelText">“index pi sessions”</span> · 3');
    expect(agentic.html).toContain('<span class="ssxFooterMode" title="Mode of this turn">AGENTIC</span>');
    expect(agentic.html).not.toContain('aria-label="Answer"');
    expect(agentic.html).not.toContain("should not be shown");
    expect(agentic.html).toContain('<input type="radio" name="mode" value="agentic" checked>');
    expect(agentic.html).toContain("started just now · </span>2 turns");
  });

  it("Ask turns: one conversation id per thread, a new one after New thread, answer + citations + sessions + footer rendered, threads persisted and reloaded by a fresh host", async () => {
    const answerFixture = {
      ...upstreamFixture,
      retrievalMode: "AGENTIC",
      answer: "The domain was created by **this session** [1]; a later run indexed it [2]. <script>alert(1)</script>",
      citations: [{ documentIndex: 0 }, { documentIndex: 1 }],
      usage: { planningTokens: 331761, synthesisTokens: 1624, totalTokens: 333385 },
    };
    respond = (request) => ({ status: 200, body: JSON.stringify({ ...answerFixture, answer: `${answerFixture.answer} (re: ${JSON.parse(request.body).query.intent})` }) });
    try {
      const first = await host();
      await first.settingsStore.patchExtension(SETTINGS_ID, { tracesUrl: "https://traces.example.test/{requestId}" }, { schemaVersion: 1 });
      const view = await first.invoke({ action: "send", fields: { query: "which session created the OpenSearch domain for pi sessions", mode: "agentic-answer" } });
      const body = JSON.parse(received[0].body);
      expect(body).toMatchObject({ retrieval: "AGENTIC", synthesize: true, synthesisOptions: { maxTokens: 600, temperature: 0, responseFormat: "MARKDOWN" }, retrievalOptions: { maxTurns: 6 }, maxResults: 5 });
      expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      await expect(verifySignature(received[0], "us-east-1", "aisearch")).resolves.toBe(true);
      expect(view.html).toContain('class="ssxAnswer"');
      expect(view.html).toContain("The domain was created by <strong>this session</strong> <sup");
      expect(view.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(view.html).not.toContain("<script>");
      expect(view.html).toContain('<sup class="ssxCite" title="Create the pi sessions OpenSearch domain">[1]</sup>');
      expect(view.html).toContain('<sup class="ssxCite" title="Index pi sessions">[2]</sup>');
      expect(view.html.indexOf('class="ssxAnswer"')).toBeLessThan(view.html.indexOf('class="ssxSessions"'));
      expect(view.html).toContain('<span class="ssxFooterMode" title="Mode of this turn">AGENTIC + ANSWER</span>');
      expect(view.html).toContain("tokens 333385 (planning 331761, synthesis 1624)");
      expect(view.html).toContain('<code class="ssxReqId" title="Request id">upstream-req-1</code>');
      expect(view.html).toContain('<a href="https://traces.example.test/upstream-req-1" target="_blank" rel="noopener noreferrer">Open traces</a>');
      for (const leak of ["passage body", "embedding", fakeCredentials.secretAccessKey, fakeCredentials.sessionToken, fakeCredentials.accessKeyId, upstreamUrl]) expect(view.html).not.toContain(leak);

      // Follow-up in the same thread reuses the conversation id and renders both turns.
      const followUp = await first.invoke({ action: "send", fields: { query: "what engine version did it confirm?", mode: "agentic-answer" } });
      expect(JSON.parse(received[1].body).sessionId).toBe(body.sessionId);
      expect(followUp.html).toContain('<p class="ssxQuestion">which session created the OpenSearch domain for pi sessions</p>');
      expect(followUp.html).toContain('<p class="ssxQuestion">what engine version did it confirm?</p>');
      expect(followUp.html).toContain("(re: what engine version did it confirm?)");
      expect(followUp.html).toContain("2 turns");

      // New thread mints a different conversation id.
      const fresh = await first.invoke({ action: "new" });
      expect(fresh.html).not.toContain("what engine version did it confirm?</p>");
      await first.invoke({ action: "send", fields: { query: "unrelated question", mode: "agentic-answer" } });
      expect(JSON.parse(received[2].body).sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(received[2].body).sessionId).not.toBe(body.sessionId);

      // The file holds normalized turns grouped by thread — no raw upstream payload, vectors, or credentials.
      const stored = await readFile(first.historyFile, "utf8");
      const parsed = JSON.parse(stored);
      expect(parsed.version).toBe(2);
      expect(parsed.threads.map((thread: any) => [thread.id, thread.turns.map((turn: any) => turn.query)])).toEqual([
        [JSON.parse(received[2].body).sessionId, ["unrelated question"]],
        [body.sessionId, ["which session created the OpenSearch domain for pi sessions", "what engine version did it confirm?"]],
      ]);
      expect(parsed.threads[1].turns[0]).toMatchObject({ mode: "agentic-answer", result: { citations: [0, 1], requestId: "upstream-req-1" } });
      for (const leak of ["passage body", "embedding", "0.1,0.2", fakeCredentials.secretAccessKey, fakeCredentials.sessionToken, upstreamUrl]) expect(stored).not.toContain(leak);

      // A brand-new host (server restart / another session) opens on the most recent thread with no upstream call,
      // and can switch to and continue the older one under its original conversation id.
      const second = await host();
      const opened = await second.invoke({});
      expect(received).toHaveLength(3);
      expect(opened.html).toContain('<p class="ssxQuestion">unrelated question</p>');
      expect(opened.html).not.toContain("what engine version did it confirm?</p>");
      expect(opened.html).toContain('title="2 saved threads">Switch thread</summary>');
      const switched = await second.invoke({ action: "thread-open", payload: { id: body.sessionId } });
      expect(switched.html).toContain("what engine version did it confirm?</p>");
      expect(switched.html).toContain("The domain was created by <strong>this session</strong> <sup");
      await second.invoke({ action: "send", fields: { query: "and the instance type?", mode: "agentic-answer" } });
      expect(JSON.parse(received[3].body).sessionId).toBe(body.sessionId);
    } finally {
      respond = () => ({ status: 200, body: JSON.stringify(upstreamFixture) });
    }
  });

  it("migrates a legacy flat history file into threads on first load without touching it", async () => {
    const legacy = { version: 1, entries: [
      { id: "l2", at: "2026-10-22T02:00:00.000Z", query: "what project was it in?", mode: "AGENTIC", synthesize: true, threadId: "aaaaaaaa-0000-4000-8000-000000000001", result: { retrievalMode: "AGENTIC", documents: [{ id: "a", title: "Create the pi sessions OpenSearch domain", project: "pi-web-origin", startedAt: "2026-10-21T10:00:00Z", sessionId: "01a13ce5-9ebc-716c-be1c-ec84cf90e58b", sessionUrl: "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b", passageCount: 7 }], answer: "In **pi-web-origin** [1].", citations: [0], usage: { planningTokens: 1, synthesisTokens: 2, totalTokens: 3 }, elapsedMs: 1200 } },
      { id: "l1", at: "2026-10-22T01:00:00.000Z", query: "who created the domain?", mode: "AGENTIC", synthesize: true, threadId: "aaaaaaaa-0000-4000-8000-000000000001", result: { retrievalMode: "AGENTIC", documents: [], answer: "This session did.", citations: [], usage: { planningTokens: 0, synthesisTokens: 0, totalTokens: 0 }, elapsedMs: 900 } },
      { id: "l0", at: "2026-10-21T01:00:00.000Z", query: "lone simple search", mode: "SIMPLE", synthesize: false, result: { retrievalMode: "SIMPLE", documents: [], answer: "", citations: [], usage: { planningTokens: 0, synthesisTokens: 0, totalTokens: 0 }, elapsedMs: 300 } },
    ] };
    await writeFile(join(tempDir, "session-search-history.json"), JSON.stringify(legacy));
    const { invoke, historyFile } = await host();
    const opened = await invoke({});
    expect(received).toHaveLength(0);
    expect(opened.html).toContain('title="2 saved threads">Switch thread</summary>');
    expect(opened.html).toContain('<p class="ssxQuestion">who created the domain?</p>');
    expect(opened.html).toContain('<p class="ssxQuestion">what project was it in?</p>');
    expect(opened.html).toContain("In <strong>pi-web-origin</strong> <sup");
    expect(opened.html).toContain('<a href="/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b">Open session</a>');
    const stored = JSON.parse(await readFile(historyFile, "utf8"));
    expect(stored.threads.map((thread: any) => thread.turns.map((turn: any) => [turn.query, turn.mode]))).toEqual([
      [["who created the domain?", "agentic-answer"], ["what project was it in?", "agentic-answer"]],
      [["lone simple search", "simple"]],
    ]);
    expect(stored.threads.map((thread: any) => thread.mode)).toEqual(["agentic-answer", "simple"]);
    expect(JSON.parse(await readFile(join(tempDir, "session-search-history.json"), "utf8"))).toEqual(legacy);
    // Continuing the migrated thread keeps its original conversation id.
    await invoke({ action: "send", fields: { query: "and then?", mode: "simple" } });
    expect(JSON.parse(received[0].body).sessionId).toBe("aaaaaaaa-0000-4000-8000-000000000001");
  });

  it("renders an explicit credentials-expired state on 403 without leaking the token", async () => {
    respond = () => ({ status: 403, body: JSON.stringify({ message: "The security token included in the request is expired" }) });
    try {
      const { invoke } = await host();
      const view = await invoke({ action: "send", fields: { query: "anything", mode: "agentic-answer" } });
      expect(view.html).toContain('<p class="ssxQuestion">anything</p>');
      expect(view.html).toContain('role="alert"');
      expect(view.html).toContain('AWS credentials for profile &quot;integration&quot; were rejected (HTTP 403)');
      expect(view.html).toContain("my-refresh --profile integration --once");
      expect(view.html).toContain('<code class="ssxReqId" title="Request id">upstream-req-1</code>');
      expect(view.html).not.toContain(fakeCredentials.sessionToken);
      expect(view.html).not.toContain(fakeCredentials.secretAccessKey);
      expect(received[0].headers["x-amz-security-token"]).toBe(fakeCredentials.sessionToken);
    } finally {
      respond = () => ({ status: 200, body: JSON.stringify(upstreamFixture) });
    }
  });

  it("renders an empty state, and reads live settings so a missing profile fails before any network call", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ documents: [], retrievalMode: "SIMPLE", usage: { planningTokens: 0, synthesisTokens: 0, totalTokens: 0 } }) });
    try {
      const { invoke, settingsStore, ui } = await host();
      const empty = await invoke({ action: "send", fields: { query: "nothing here", mode: "simple" } });
      expect(empty.html).toContain("No sessions matched.");
      expect(empty.html).toContain('<span class="ssxFooterMode" title="Mode of this turn">SIMPLE</span>');
      expect(received).toHaveLength(1);

      // Settings are read on every turn: switching the profile through the real store changes the next request.
      await settingsStore.patchExtension(SETTINGS_ID, { profile: "absent" }, { schemaVersion: 1 });
      expect((await ui.web.getSettings(SETTINGS_ID)).values.profile).toBe("absent");
      const missing = await invoke({ action: "send", fields: { query: "nothing here", mode: "simple" } });
      expect(missing.html).toContain('role="alert"');
      expect(missing.html).toContain("AWS profile &quot;absent&quot; has no access key");
      expect(received).toHaveLength(1);
    } finally {
      respond = () => ({ status: 200, body: JSON.stringify(upstreamFixture) });
    }
  });
});

describe("standalone installation", () => {
  it("loads a copied session-search.ts through the real pi extension loader without repo dependencies", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { copyFile, mkdir } = await import("node:fs/promises");
    const { pathToFileURL } = await import("node:url");
    const { resolve } = await import("node:path");
    const home = await mkdtemp(join(tmpdir(), "pi-web-copied-session-search-"));
    try {
      const directory = join(home, ".pi/web/extensions");
      await mkdir(directory, { recursive: true });
      const extension = join(directory, "session-search.ts");
      await copyFile(resolve("examples/pi-web-extensions/session-search.ts"), extension);
      const loader = pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js")).href;
      const script = `
        import { loadExtensions } from ${JSON.stringify(loader)};
        const result = await loadExtensions([${JSON.stringify(extension)}], process.cwd());
        console.log(JSON.stringify({ errors: result.errors, count: result.extensions.length }));
      `;
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
        cwd: home, env: { ...process.env, HOME: home, NODE_OPTIONS: "", NODE_PATH: "" }, timeout: 20_000,
      });
      expect(JSON.parse(stdout.trim())).toEqual({ errors: [], count: 1 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
