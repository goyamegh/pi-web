import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignatureV4 } from "@smithy/signature-v4";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebExtensionAPI, PiWebExtensionContext } from "../src/extensions";
import {
  PANEL_KEY,
  SearchError,
  buildSearchRequest,
  classifyUpstreamError,
  configFromEnv,
  createHistoryStore,
  createSearchClient,
  createSessionSearchExtension,
  historyFilePath,
  loadProfileCredentials,
  normalizeConfig,
  normalizeHistoryEntry,
  normalizeSearchResponse,
  parseCredentialsIni,
  renderAnswerMarkdown,
  renderPanel,
  signRequest,
  type HistoryEntry,
  type SearchConfig,
} from "../examples/pi-web-extensions/session-search";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "FwoGZXIvYXdzEExampleToken==" };
const config: SearchConfig = { endpoint: "https://search.example.test/apps/app123/search", profile: "unit", region: "us-east-1", service: "aisearch", refreshHint: "refresh-creds --once" };

const upstreamFixture = {
  documents: [
    { datasetId: "ds-1", documentId: "sha-1", source: { title: "Create the pi sessions domain", project: "pi-web-origin", started_at: "2026-10-20T14:05:00.000Z", session_url: "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b", session_id: "01a13ce5-9ebc-716c-be1c-ec84cf90e58b", passage_count: 12, passages: [{ text: "secret passage", vector: [0.1, 0.2] }] } },
    // The production API serialises `source` as a JSON string; keep one hit in that shape.
    { datasetId: "ds-1", documentId: "sha-2", source: JSON.stringify({ title: "Create the pi sessions domain", project: "agent-health", started_at: "2026-10-19T09:00:00.000Z", session_url: "/?sessionId=0199aaaa-0000-7000-8000-000000000002", passage_count: 1, embedding_model: "amazon.titan-embed-text-v2:0", passages: [{ text: "secret passage", vector: [1] }] }) },
    { datasetId: "ds-1", documentId: "sha-3", source: { title: "", project: "", started_at: "not-a-date", session_url: "javascript:alert(1)", session_id: "<img onerror=x>", passage_count: -4 } },
  ],
  retrievalMode: "SIMPLE",
  usage: { planningTokens: 0, synthesisTokens: 0, totalTokens: 123 },
};

const tempDirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("credentials file parsing", () => {
  it("reads the named profile with and without spaces around '='", () => {
    const ini = [
      "[default]", "aws_access_key_id = DEFAULTKEY", "aws_secret_access_key = DEFAULTSECRET", "",
      "; comment", "[search-team]", "aws_access_key_id=ASIAEXAMPLE", "aws_secret_access_key=SECRETEXAMPLE", "aws_session_token=TOKENEXAMPLE",
      "[other]", "aws_access_key_id = OTHER",
    ].join("\n");
    expect(parseCredentialsIni(ini, "search-team")).toEqual({ accessKeyId: "ASIAEXAMPLE", secretAccessKey: "SECRETEXAMPLE", sessionToken: "TOKENEXAMPLE" });
    expect(parseCredentialsIni(ini, "default")).toEqual({ accessKeyId: "DEFAULTKEY", secretAccessKey: "DEFAULTSECRET" });
    expect(parseCredentialsIni(ini, "other")).toBeUndefined();
    expect(parseCredentialsIni(ini, "missing")).toBeUndefined();
  });

  it("loads from a real file and reports a missing profile without echoing secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-session-search-creds-"));
    tempDirs.push(dir);
    const file = join(dir, "credentials");
    await writeFile(file, "[unit]\naws_access_key_id=AKIAUNIT\naws_secret_access_key=UNITSECRET\n");
    await expect(loadProfileCredentials("unit", file)).resolves.toEqual({ accessKeyId: "AKIAUNIT", secretAccessKey: "UNITSECRET" });
    const missing = await loadProfileCredentials("nope", file).catch((error) => error as SearchError);
    expect(missing).toBeInstanceOf(SearchError);
    expect((missing as SearchError).kind).toBe("credentials");
    expect((missing as SearchError).message).not.toContain("UNITSECRET");
    await expect(loadProfileCredentials("unit", join(dir, "absent"))).rejects.toThrow("credentials file not found");
  });
});

describe("SigV4 request signing", () => {
  it("matches the real @smithy/signature-v4 signer for the same request, time, and credentials", async () => {
    const date = new Date("2026-10-23T18:04:05.000Z");
    const request = buildSearchRequest(config.endpoint, "which session created the domain?", "SIMPLE");
    const ours = signRequest({ ...request, service: config.service, region: config.region, credentials, date });

    class Sha256 {
      private hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
      constructor(secret?: Uint8Array | string) { this.hash = secret === undefined ? createHash("sha256") : createHmac("sha256", secret); }
      update(data: Uint8Array | string) { this.hash.update(data); }
      async digest() { return new Uint8Array(this.hash.digest()); }
    }
    const url = new URL(request.url);
    const oracle = new SignatureV4({ credentials, region: config.region, service: config.service, sha256: Sha256 as any, applyChecksum: true });
    const signed = await oracle.sign({
      method: "POST", protocol: url.protocol, hostname: url.hostname, path: url.pathname, query: {},
      headers: { host: url.host, "content-type": "application/json", "x-amz-content-sha256": ours["x-amz-content-sha256"] },
      body: request.body,
    } as any, { signingDate: date });

    expect(ours.authorization).toBe(signed.headers.authorization);
    expect(ours["x-amz-date"]).toBe("20261023T180405Z");
    expect(ours["x-amz-security-token"]).toBe(credentials.sessionToken);
    expect(ours["x-amz-content-sha256"]).toBe(createHash("sha256").update(request.body).digest("hex"));
  });

  it("omits the session token header for long-lived keys and keeps the body shape the API expects", () => {
    const request = buildSearchRequest(config.endpoint, "q", "AGENTIC", { maxResults: 5 });
    expect(JSON.parse(request.body)).toEqual({ query: { intent: "q" }, retrieval: "AGENTIC", maxResults: 5 });
    const headers = signRequest({ ...request, service: "aisearch", region: "us-east-1", credentials: { accessKeyId: "A", secretAccessKey: "B" } });
    expect(headers["x-amz-security-token"]).toBeUndefined();
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=A\/\d{8}\/us-east-1\/aisearch\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
});

describe("response normalization", () => {
  it("keeps only display fields, drops passages, and sanitizes session links", () => {
    const result = normalizeSearchResponse(upstreamFixture, 812);
    expect(JSON.stringify(result)).not.toContain("passage\"");
    expect(JSON.stringify(result)).not.toContain("secret passage");
    expect(JSON.stringify(result)).not.toContain("vector");
    expect(result.retrievalMode).toBe("SIMPLE");
    expect(result.usage).toEqual({ planningTokens: 0, synthesisTokens: 0, totalTokens: 123 });
    expect(result.elapsedMs).toBe(812);
    expect(result.documents.map((hit) => hit.title)).toEqual(["Create the pi sessions domain", "Create the pi sessions domain", "Untitled session"]);
    expect(result.documents[0]).toEqual({
      id: "sha-1", title: "Create the pi sessions domain", project: "pi-web-origin", startedAt: "2026-10-20T14:05:00.000Z",
      sessionId: "01a13ce5-9ebc-716c-be1c-ec84cf90e58b", sessionUrl: "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b", passageCount: 12,
    });
    // session_id missing: derived from the relative session_url.
    expect(result.documents[1].sessionUrl).toBe("/?sessionId=0199aaaa-0000-7000-8000-000000000002");
    // hostile values never become a link.
    expect(result.documents[2]).toMatchObject({ sessionId: "", sessionUrl: "", passageCount: 0, project: "" });
  });

  it("tolerates garbage payloads", () => {
    expect(normalizeSearchResponse(null)).toEqual({ retrievalMode: "SIMPLE", documents: [], answer: "", citations: [], usage: { planningTokens: 0, synthesisTokens: 0, totalTokens: 0 }, elapsedMs: 0 });
    expect(normalizeSearchResponse({ documents: [1, "x", null], retrievalMode: "AGENTIC", usage: "nope" }).retrievalMode).toBe("AGENTIC");
    expect(normalizeSearchResponse({ documents: [{ source: "not json" }, { source: { title: "No ids at all" } }] }).documents).toEqual([
      { id: "doc-0", title: "Untitled session", project: "", startedAt: "", sessionId: "", sessionUrl: "", passageCount: 0 },
      { id: "doc-1", title: "No ids at all", project: "", startedAt: "", sessionId: "", sessionUrl: "", passageCount: 0 },
    ]);
  });

  it("keeps the synthesized answer and in-range citations exactly as the API returned them (observed shape)", () => {
    // Shape observed on a real synthesize=true response: `answer` is Markdown with `[n]` markers,
    // `citations` is `[{ documentIndex }]`, and both keys are absent when nothing was retrieved.
    const synthesized = normalizeSearchResponse({
      ...upstreamFixture,
      retrievalMode: "AGENTIC",
      answer: "  The session `01a13ce5` created the domain [1]. A worker monitored it [2]. <script>alert(1)</script>  ",
      citations: [{ documentIndex: 0 }, { documentIndex: 1 }, { documentIndex: 0 }, { documentIndex: 7 }, { documentIndex: -1 }, { documentIndex: "0" }, null, "junk"],
    }, 1000);
    expect(synthesized.answer).toBe("The session `01a13ce5` created the domain [1]. A worker monitored it [2]. <script>alert(1)</script>");
    expect(synthesized.citations).toEqual([0, 1]);
    expect(synthesized.answer.length).toBeLessThanOrEqual(8_000);

    const empty = normalizeSearchResponse({ citations: [], documents: [], retrievalMode: "AGENTIC", usage: { planningTokens: 21464, synthesisTokens: 0, totalTokens: 21464 } });
    expect(empty).toMatchObject({ answer: "", citations: [], documents: [] });
    expect(normalizeSearchResponse({ ...upstreamFixture, answer: 42, citations: "x" })).toMatchObject({ answer: "", citations: [] });
    expect(normalizeSearchResponse({ ...upstreamFixture, answer: "a".repeat(9_000) }).answer).toHaveLength(8_000);
  });

  it("asks for synthesis and conversation continuity with the exact body the API documents", () => {
    const synth = buildSearchRequest(config.endpoint, "q", "AGENTIC", { synthesize: true });
    expect(JSON.parse(synth.body)).toEqual({
      query: { intent: "q" }, retrieval: "AGENTIC", synthesize: true,
      synthesisOptions: { maxTokens: 600, temperature: 0, responseFormat: "MARKDOWN" }, maxResults: 5,
    });
    const threaded = buildSearchRequest(config.endpoint, "and then?", "AGENTIC", { synthesize: true, threadId: "thread-1" });
    expect(JSON.parse(threaded.body)).toMatchObject({ sessionId: "thread-1", synthesize: true });
    // synthesize:false and no thread leave the body untouched (SIMPLE never asks for synthesis).
    expect(JSON.parse(buildSearchRequest(config.endpoint, "q", "SIMPLE", { synthesize: false }).body)).toEqual({ query: { intent: "q" }, retrieval: "SIMPLE", maxResults: 5 });
  });

  it("classifies expired credentials separately from other upstream failures", () => {
    const expired = classifyUpstreamError(403, '{"message":"The security token included in the request is expired"}', config);
    expect(expired.kind).toBe("credentials");
    expect(expired.message).toContain('profile "unit"');
    expect(expired.message).toContain("refresh-creds --once");
    expect(classifyUpstreamError(400, "ExpiredTokenException", { profile: "p", refreshHint: "" }).kind).toBe("credentials");
    const server = classifyUpstreamError(502, "<html>bad gateway</html>", config);
    expect(server.kind).toBe("upstream");
    expect(server.message).toBe("Search API answered HTTP 502: <html>bad gateway</html>");
  });

  it("resolves config from settings values over environment defaults", () => {
    const env = configFromEnv({ PI_WEB_SESSION_SEARCH_ENDPOINT: " https://e/ ", PI_WEB_SESSION_SEARCH_PROFILE: "p" });
    expect(env).toEqual({ endpoint: "https://e/", profile: "p", region: "us-east-1", service: "aisearch", refreshHint: "" });
    expect(normalizeConfig({ profile: "override", region: "   ", endpoint: 42 }, env)).toEqual({ ...env, profile: "override" });
  });
});

describe("search client", () => {
  const loadCredentials = async () => credentials;

  it("signs the upstream request and returns normalized results", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
      expect(headers["x-amz-security-token"]).toBe(credentials.sessionToken);
      expect(JSON.parse(String(init?.body))).toEqual({ query: { intent: "find it" }, retrieval: "SIMPLE", maxResults: 5 });
      return new Response(JSON.stringify(upstreamFixture), { status: 200 });
    });
    const search = createSearchClient({ fetch: fetchMock as unknown as typeof fetch, loadCredentials });
    const result = await search(config, "find it", "SIMPLE");
    expect(fetchMock).toHaveBeenCalledWith(config.endpoint, expect.anything());
    expect(result.documents).toHaveLength(3);
    expect(result.documents[0].sessionUrl).toBe("/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b");
  });

  it("fails closed on missing or insecure configuration before touching credentials", async () => {
    const fetchMock = vi.fn();
    const loader = vi.fn(loadCredentials);
    const search = createSearchClient({ fetch: fetchMock, loadCredentials: loader });
    await expect(search({ ...config, endpoint: "" }, "q", "SIMPLE")).rejects.toMatchObject({ kind: "config" });
    await expect(search({ ...config, endpoint: "http://search.example.test/x" }, "q", "SIMPLE")).rejects.toMatchObject({ kind: "config" });
    await expect(search({ ...config, endpoint: "not a url" }, "q", "SIMPLE")).rejects.toMatchObject({ kind: "config" });
    expect(loader).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps 403 to an expired-credentials message that carries the refresh hint and no secrets", async () => {
    const search = createSearchClient({ fetch: (async () => new Response('{"message":"ExpiredToken"}', { status: 403 })) as typeof fetch, loadCredentials });
    const error = await search(config, "q", "SIMPLE").catch((caught) => caught as SearchError);
    expect(error).toMatchObject({ kind: "credentials" });
    expect((error as SearchError).message).toContain("refresh-creds --once");
    expect((error as SearchError).message).not.toContain(credentials.secretAccessKey);
    expect((error as SearchError).message).not.toContain(credentials.sessionToken);
  });

  it("distinguishes user cancellation from the request timeout", async () => {
    const hang = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    const controller = new AbortController();
    const cancelled = createSearchClient({ fetch: hang, loadCredentials })(config, "q", "AGENTIC", controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    await expect(createSearchClient({ fetch: hang, loadCredentials, timeoutMs: 20 })(config, "q", "AGENTIC")).rejects.toMatchObject({ kind: "timeout", message: "Search timed out after 0s." });
  });

  it("reports non-JSON bodies and network failures as upstream problems", async () => {
    await expect(createSearchClient({ fetch: (async () => new Response("<html>", { status: 200 })) as typeof fetch, loadCredentials })(config, "q", "SIMPLE")).rejects.toMatchObject({ kind: "upstream" });
    await expect(createSearchClient({ fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch, loadCredentials })(config, "q", "SIMPLE")).rejects.toMatchObject({ kind: "network", message: "Could not reach the search API: fetch failed" });
  });
});

describe("answer markdown", () => {
  const hits = normalizeSearchResponse(upstreamFixture).documents;

  it("renders a safe subset and escapes everything else", () => {
    const html = renderAnswerMarkdown("## Finding\n\nThe **domain** was created in `pi-web-origin` [1], see [docs](https://evil.example/x) <img src=x onerror=alert(1)>.\n\n- first [2]\n- second [9]\n\n1. one\n2. two\n\n```\n<b>raw</b>\n```", hits);
    expect(html).toContain("<p><strong>Finding</strong></p>");
    expect(html).toContain("<strong>domain</strong>");
    expect(html).toContain("<code>pi-web-origin</code>");
    expect(html).toContain('<sup class="ssxCite" title="Create the pi sessions domain">[1]</sup>');
    expect(html).toContain("<ul><li>first <sup");
    expect(html).toContain("<li>second [9]</li>");
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(html).toContain("<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>");
    expect(html).toContain("see docs &lt;img src=x onerror=alert(1)&gt;.");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("evil.example");
  });

  it("returns nothing for an empty answer and plain paragraphs otherwise", () => {
    expect(renderAnswerMarkdown("", hits)).toBe("");
    expect(renderAnswerMarkdown("Plain\r\nwrapped line.\n\nSecond.")).toBe("<p>Plain wrapped line.</p><p>Second.</p>");
  });
});

describe("history store", () => {
  const result = normalizeSearchResponse({ ...upstreamFixture, answer: "The answer [1].", citations: [{ documentIndex: 0 }] }, 900);
  const entry = (id: string, at: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, at, query: `question ${id}`, mode: "AGENTIC", synthesize: true, threadId: "11111111-2222-4333-8444-555555555555", result, ...extra });

  async function tempStore(limit?: number) {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-session-search-history-"));
    tempDirs.push(dir);
    return { dir, store: createHistoryStore(join(dir, "nested", "history.json"), limit) };
  }

  it("persists normalized results newest first, bounded, with owner-only permissions and no upstream payload", async () => {
    const { store } = await tempStore(3);
    expect(await store.load()).toEqual([]);
    await store.add(entry("a", "2026-10-23T01:00:00.000Z"));
    await store.add(entry("b", "2026-10-23T02:00:00.000Z"));
    await store.add(entry("c", "2026-10-23T03:00:00.000Z"));
    const entries = await store.add(entry("d", "2026-10-23T04:00:00.000Z"));
    expect(entries.map((item) => item.id)).toEqual(["d", "c", "b"]);
    expect(await store.load()).toEqual(entries);
    const raw = await readFile(store.path, "utf8");
    expect(raw).not.toContain("secret passage");
    expect(raw).not.toContain("vector");
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
    if (process.platform !== "win32") expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await store.remove("c")).map((item) => item.id)).toEqual(["d", "b"]);
  });

  it("re-validates stored entries so a tampered file cannot inject markup or links", async () => {
    const { store } = await tempStore();
    await mkdir(join(store.path, ".."), { recursive: true });
    await writeFile(store.path, JSON.stringify({ version: 1, entries: [
      { ...entry("ok", "2026-10-23T01:00:00.000Z"), extra: "field", result: { ...result, documents: [{ ...result.documents[0], sessionId: "javascript:alert(1)", sessionUrl: "javascript:alert(1)", bonus: 1 }], citations: [0, 5, "x"], answer: 7 } },
      { id: "no-query", at: "2026-10-23T01:00:00.000Z", query: "", result },
      { id: "bad-date", at: "yesterday", query: "q", result },
      "garbage", null,
    ] }));
    const [only, ...rest] = await store.load();
    expect(rest).toEqual([]);
    expect(only.id).toBe("ok");
    expect("extra" in only).toBe(false);
    expect(only.result.documents[0]).toMatchObject({ sessionId: "", sessionUrl: "" });
    expect("bonus" in only.result.documents[0]).toBe(false);
    expect(only.result.citations).toEqual([0]);
    expect(only.result.answer).toBe("");
    expect(normalizeHistoryEntry(undefined)).toBeUndefined();
    expect(normalizeHistoryEntry({ id: "x", at: "2026-10-23T01:00:00.000Z", query: "q", threadId: "<bad>", result: {} })).toMatchObject({ mode: "SIMPLE", synthesize: false, result: { documents: [], answer: "", citations: [] } });
    expect(normalizeHistoryEntry({ id: "x", at: "2026-10-23T01:00:00.000Z", query: "q", threadId: "<bad>", result: {} })!.threadId).toBeUndefined();
  });

  it("survives a corrupt file and resolves its default location from the environment", async () => {
    const { store } = await tempStore();
    await mkdir(join(store.path, ".."), { recursive: true });
    await writeFile(store.path, "{not json");
    expect(await store.load()).toEqual([]);
    expect(historyFilePath({ PI_WEB_SESSION_SEARCH_HISTORY_FILE: "/tmp/x.json", PI_WEB_HOME: "/home/x" })).toBe("/tmp/x.json");
    expect(historyFilePath({ PI_WEB_HOME: "/web-home" })).toBe(join("/web-home", "session-search-history.json"));
    expect(historyFilePath({})).toMatch(/[\\/]\.pi[\\/]agent[\\/]session-search-history\.json$/);
  });
});

describe("panel rendering", () => {
  const controller = new AbortController();
  it("renders explicit idle, running, empty, error, and result states", () => {
    const idle = renderPanel({ query: "", mode: "SIMPLE" }).html;
    expect(idle).toContain('name="query"');
    expect(idle).toContain('<option value="AGENTIC">AGENTIC</option>');
    expect(idle).toContain("autofocus");

    const running = renderPanel({ query: "x", mode: "AGENTIC", job: { id: "job-1", query: "x", mode: "AGENTIC", startedAt: 0, controller, state: "running" } }).html;
    expect(running).toContain("Searching (AGENTIC)");
    expect(running).toContain('data-web-action="cancel"');
    expect(running).toContain('class="ssxSpinner"');
    // Focus must land on the status element, not a form control, so update() can repaint when the job finishes.
    expect(running).toMatch(/<div class="ssxStatus"[^>]*autofocus/);
    expect(running).not.toMatch(/<input[^>]*autofocus/);

    const empty = renderPanel({ query: "nothing", mode: "SIMPLE", job: { id: "job-2", query: "nothing", mode: "SIMPLE", startedAt: 0, controller, state: "done", result: normalizeSearchResponse({ documents: [], retrievalMode: "SIMPLE" }, 500) } }).html;
    expect(empty).toContain("No sessions matched “nothing”.");
    expect(empty).toContain("0 results in 0.5s");

    const error = renderPanel({ query: "q", mode: "SIMPLE", job: { id: "job-3", query: "q", mode: "SIMPLE", startedAt: 0, controller, state: "error", error: new SearchError("creds <expired>", "credentials") } }).html;
    expect(error).toContain('role="alert"');
    expect(error).toContain("creds &lt;expired&gt;");

    const results = renderPanel({ query: "q", mode: "SIMPLE", job: { id: "job-4", query: "q", mode: "SIMPLE", startedAt: 0, controller, state: "done", result: normalizeSearchResponse(upstreamFixture, 812) } }).html;
    expect(results.match(/class="ssxHit"/g)).toHaveLength(3);
    expect(results).toContain('<a href="/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b">Open session</a>');
    expect(results).toContain('<span class="ssxProject">pi-web-origin</span>');
    expect(results).toContain("2026-10-20 14:05 UTC");
    expect(results).toContain("12 passages");
    expect(results).toContain("no session link");
    expect(results).toContain("SIMPLE · 3 results in 0.8s · tokens: planning 0, synthesis 0, total 123");
    expect(results).not.toContain("javascript:");
    expect(results).not.toContain("<img");
  });
});

describe("extension wiring", () => {
  type Handler = (event: unknown, ctx: PiWebExtensionContext) => unknown;

  async function boot(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = { PI_WEB_SESSION_SEARCH_ENDPOINT: config.endpoint, PI_WEB_SESSION_SEARCH_PROFILE: "unit", PI_WEB_SESSION_SEARCH_REFRESH_HINT: "refresh-creds --once" }) {
    const handlers = new Map<string, Handler>();
    const contributions = new Map<string, any>();
    const update = vi.fn();
    const notify = vi.fn();
    const dir = await mkdtemp(join(tmpdir(), "pi-web-session-search-wiring-"));
    tempDirs.push(dir);
    const historyFile = join(dir, "history.json");
    let threads = 0;
    createSessionSearchExtension({ fetch: fetchImpl, loadCredentials: async () => credentials, env, historyFile, newThreadId: () => `thread-${++threads}` })({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as PiWebExtensionAPI);
    const ctx = {
      ui: {
        notify,
        web: {
          capabilities: { apiVersion: 1, slots: ["panel", "fab", "header-action"], kinds: ["rendered", "static"], effects: ["open-panel"] },
          contribute: (key: string, spec: unknown) => spec === undefined ? contributions.delete(key) : contributions.set(key, spec),
          update,
          registerSettings: async () => ({ registered: true, migrated: false, usedBackup: false }),
          getSettings: async () => ({ schemaVersion: 1, values: {} }),
        },
      },
    } as unknown as PiWebExtensionContext;
    return { handlers, contributions, update, notify, ctx, historyFile };
  }

  it("registers the panel, launcher, and header action, and searches inline when the upstream is fast", async () => {
    const { handlers, contributions, update, ctx } = await boot((async () => new Response(JSON.stringify(upstreamFixture), { status: 200 })) as typeof fetch);
    await handlers.get("session_start")!({}, ctx);
    expect([...contributions.keys()]).toEqual([PANEL_KEY, `${PANEL_KEY}-launcher`, `${PANEL_KEY}-header`]);
    expect(contributions.get(`${PANEL_KEY}-launcher`)).toMatchObject({ slot: "fab", opens: PANEL_KEY });
    expect(contributions.get(`${PANEL_KEY}-header`).render()).toEqual({ effects: [{ type: "open-panel", key: PANEL_KEY }] });

    const panel = contributions.get(PANEL_KEY);
    expect((await panel.render()).html).toContain("Search the indexed history");
    const view = await panel.render({ action: "search", fields: { query: "  which session created the domain  ", mode: "SIMPLE" } });
    expect(view.title).toBe("Session search");
    expect(view.html).toContain("Open session");
    expect(view.html).toContain('value="which session created the domain"');
    expect(view.html).not.toContain("secret passage");
    // The originating render painted the result, so no redundant repaint is requested.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(update).not.toHaveBeenCalled();

    const blank = await panel.render({ action: "search", fields: { query: "   " } });
    expect(blank.html).toContain("Type a question about your sessions first.");

    await handlers.get("session_shutdown")!({}, ctx);
    expect(contributions.size).toBe(0);
  });

  it("shows a spinner for slow AGENTIC searches, repaints via update() when done, and honours cancel", async () => {
    // Each upstream call hangs until the test releases it (or the client aborts it).
    const releases: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      releases.push(resolve);
    })) as unknown as typeof fetch;
    const release = (response: Response) => releases.shift()!(response);
    const { handlers, contributions, update, ctx } = await boot(fetchImpl);
    await handlers.get("session_start")!({}, ctx);
    const panel = contributions.get(PANEL_KEY);

    const spinner = await panel.render({ action: "search", fields: { query: "slow one", mode: "AGENTIC" } });
    expect(spinner.html).toContain("Searching (AGENTIC)");
    const jobId = /"jobId":"(job-\d+)"/.exec(spinner.html.replace(/&quot;/g, '"'))![1];
    expect(update).not.toHaveBeenCalled();

    release(new Response(JSON.stringify({ documents: [], retrievalMode: "AGENTIC", usage: { planningTokens: 1, synthesisTokens: 2, totalTokens: 3 } }), { status: 200 }));
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(PANEL_KEY));
    const done = await panel.render();
    expect(done.html).toContain("No sessions matched “slow one”.");
    expect(done.html).toContain("AGENTIC · 0 results");
    expect(done.html).toContain("planning 1, synthesis 2, total 3");

    const second = await panel.render({ action: "search", fields: { query: "cancel me", mode: "AGENTIC" } });
    const secondJobId = /"jobId":"(job-\d+)"/.exec(second.html.replace(/&quot;/g, '"'))![1];
    expect(secondJobId).not.toBe(jobId);
    const stale = await panel.render({ action: "cancel", payload: { jobId } });
    expect(stale.html).toContain("Searching (AGENTIC)");
    const cancelled = await panel.render({ action: "cancel", payload: { jobId: secondJobId } });
    expect(cancelled.html).toContain("Search cancelled.");
    expect(cancelled.html).not.toContain('class="ssxSpinner"');
  });

  it("surfaces expired credentials as an explicit error state", async () => {
    const { handlers, contributions, ctx } = await boot((async () => new Response('{"message":"ExpiredToken"}', { status: 403 })) as typeof fetch);
    await handlers.get("session_start")!({}, ctx);
    const view = await contributions.get(PANEL_KEY).render({ action: "search", fields: { query: "anything" } });
    expect(view.html).toContain('role="alert"');
    expect(view.html).toContain("probably expired");
    expect(view.html).toContain("refresh-creds --once");
    expect(view.html).not.toContain(credentials.sessionToken);
  });

  it("locks the mode and synthesis controls while a request is in flight, and a superseding search keeps the locked values", async () => {
    const bodies: any[] = [];
    const releases: Array<(response: Response) => void> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      bodies.push(JSON.parse(String(init?.body)));
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      releases.push(resolve);
    })) as typeof fetch;
    const { handlers, contributions, ctx, update } = await boot(fetchImpl);
    await handlers.get("session_start")!({}, ctx);
    const panel = contributions.get(PANEL_KEY);

    const running = await panel.render({ action: "search", fields: { query: "slow", mode: "AGENTIC", synthesize: "1" } });
    expect(running.html).toMatch(/<select name="mode" aria-label="Retrieval mode" disabled>/);
    expect(running.html).toMatch(/<input type="checkbox" name="synthesize" value="1" checked disabled>/);
    expect(running.html).toContain('<input type="hidden" name="mode" value="AGENTIC">');
    expect(running.html).toContain('<input type="hidden" name="synthesize" value="1">');
    // The form itself carries no click action: only the submit button does.
    expect(running.html).toContain('<form role="search">');
    expect(running.html).not.toMatch(/<form[^>]*data-web-action/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ retrieval: "AGENTIC", synthesize: true });

    // A plain repaint (what update()/focusout triggers) never starts a request or changes the job.
    const repaint = await panel.render();
    expect(repaint.html).toContain("Searching (AGENTIC)");
    expect(bodies).toHaveLength(1);

    // The in-flight result still lands afterwards and is painted with the locked settings.
    releases[0](new Response(JSON.stringify({ ...upstreamFixture, retrievalMode: "AGENTIC", answer: "Done [1].", citations: [{ documentIndex: 0 }] }), { status: 200 }));
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(PANEL_KEY));
    const done = await panel.render();
    expect(done.html).toContain('<option value="AGENTIC" selected>');
    expect(done.html).toMatch(/<select name="mode" aria-label="Retrieval mode">/);
    expect(done.html).toContain('class="ssxAnswer"');
    expect(done.html).toContain("Done <sup");
    expect(done.html).toContain("[1] Create the pi sessions domain</a>");
    expect(done.html).toContain('<span class="ssxIndex" aria-label="Result 1">1</span>');
    expect(done.html).toContain("AGENTIC · 3 results");
  });

  it("only synthesizes AGENTIC searches and never asks SIMPLE for an answer", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify(upstreamFixture), { status: 200 }); }) as typeof fetch;
    const { handlers, contributions, ctx } = await boot(fetchImpl);
    await handlers.get("session_start")!({}, ctx);
    const panel = contributions.get(PANEL_KEY);
    await panel.render({ action: "search", fields: { query: "simple", mode: "SIMPLE", synthesize: "1" } });
    expect(bodies[0]).not.toHaveProperty("synthesize");
    const view = await panel.render({ action: "search", fields: { query: "agentic without synth", mode: "AGENTIC" } });
    expect(bodies[1]).not.toHaveProperty("synthesize");
    expect(view.html).toMatch(/<input type="checkbox" name="synthesize" value="1">/);
    expect(view.html).not.toContain('class="ssxAnswer"');
  });

  it("records finished searches in history, restores them instantly, clears with New search, and deletes", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response(JSON.stringify({ ...upstreamFixture, retrievalMode: "AGENTIC", answer: `Answer ${calls} [1].`, citations: [{ documentIndex: 0 }] }), { status: 200 }); }) as typeof fetch;
    const { handlers, contributions, ctx, historyFile } = await boot(fetchImpl);
    await handlers.get("session_start")!({}, ctx);
    const panel = contributions.get(PANEL_KEY);
    expect((await panel.render()).html).not.toContain('class="ssxHistory"');

    await panel.render({ action: "search", fields: { query: "first question", mode: "AGENTIC", synthesize: "1" } });
    const second = await panel.render({ action: "search", fields: { query: "second question", mode: "AGENTIC", synthesize: "1" } });
    expect(calls).toBe(2);
    expect(second.html).toContain("Answer 2 <sup");
    const items = [...second.html.matchAll(/class="ssxHistoryItem" data-web-action="history-open" data-web-payload='([^']+)'( aria-current="true")?/g)];
    expect(items).toHaveLength(2);
    expect(second.html.indexOf("second question")).toBeLessThan(second.html.indexOf("first question"));
    expect(items[0][2]).toBe(' aria-current="true"');
    const firstId = JSON.parse(items[1][1].replace(/&quot;/g, '"')).id;

    const stored = JSON.parse(await readFile(historyFile, "utf8"));
    expect(stored.entries.map((entry: any) => entry.query)).toEqual(["second question", "first question"]);
    expect(JSON.stringify(stored)).not.toContain("secret passage");
    expect(JSON.stringify(stored)).not.toContain(credentials.sessionToken);

    const restored = await panel.render({ action: "history-open", payload: { id: firstId } });
    expect(calls).toBe(2);
    expect(restored.html).toContain("Answer 1 <sup");
    expect(restored.html).toContain('value="first question"');
    expect(restored.html).toContain('<option value="AGENTIC" selected>');
    expect(restored.html).toMatch(new RegExp(`data-web-payload='&quot;id&quot;:&quot;${firstId}&quot;}' aria-current="true"`.replace("'&quot;", "'{&quot;")));

    const cleared = await panel.render({ action: "new" });
    expect(cleared.html).toContain('value=""');
    expect(cleared.html).toContain("Search the indexed history");
    expect(cleared.html).toContain('class="ssxHistoryItem"');

    const deleted = await panel.render({ action: "history-delete", payload: { id: firstId } });
    expect(deleted.html).not.toContain("first question");
    expect(deleted.html).toContain("second question");
    expect(JSON.parse(await readFile(historyFile, "utf8")).entries).toHaveLength(1);
    expect((await panel.render({ action: "history-open", payload: { id: "missing" } })).html).toContain("Search the indexed history");
  });

  it("continues a conversation under the same API sessionId and shows the turns", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return new Response(JSON.stringify({ ...upstreamFixture, retrievalMode: "AGENTIC", answer: `Turn ${bodies.length} about ${body.query.intent} [1].`, citations: [{ documentIndex: 0 }] }), { status: 200 });
    }) as typeof fetch;
    const { handlers, contributions, ctx } = await boot(fetchImpl);
    await handlers.get("session_start")!({}, ctx);
    const panel = contributions.get(PANEL_KEY);

    const idle = await panel.render();
    expect(idle.html).not.toContain('name="continue"');
    const first = await panel.render({ action: "search", fields: { query: "who created the domain?", mode: "AGENTIC", synthesize: "1" } });
    expect(bodies[0].sessionId).toBe("thread-1");
    expect(first.html).toMatch(/<input type="checkbox" name="continue" value="1">/);
    expect(first.html).not.toContain('class="ssxThread"');

    const second = await panel.render({ action: "search", fields: { query: "what project was it in?", mode: "AGENTIC", synthesize: "1", continue: "1" } });
    expect(bodies[1].sessionId).toBe("thread-1");
    expect(second.html).toContain("Conversation · 2 turns");
    expect(second.html).toContain('<div class="ssxTurnQ">who created the domain?</div>');
    expect(second.html).toContain('<div class="ssxTurnQ">what project was it in?</div>');
    expect(second.html).toContain("Turn 1 about who created the domain? [1].");
    expect(second.html).toMatch(/<input type="checkbox" name="continue" value="1" checked>/);

    // Unticking starts a fresh conversation id; New search also drops the thread.
    const third = await panel.render({ action: "search", fields: { query: "unrelated", mode: "AGENTIC", synthesize: "1" } });
    expect(bodies[2].sessionId).toBe("thread-2");
    expect(third.html).not.toContain('class="ssxThread"');
    await panel.render({ action: "search", fields: { query: "follow", mode: "AGENTIC", synthesize: "1", continue: "1" } });
    expect(bodies[3].sessionId).toBe("thread-2");
    await panel.render({ action: "new" });
    await panel.render({ action: "search", fields: { query: "again", mode: "AGENTIC", continue: "1" } });
    expect(bodies[4].sessionId).toBe("thread-3");

    // Restoring a threaded history entry brings its turns back and lets the user continue it.
    const restoredThread = await panel.render();
    const ids = [...restoredThread.html.matchAll(/data-web-action="history-open" data-web-payload='([^']+)'/g)].map((match) => JSON.parse(match[1].replace(/&quot;/g, '"')).id);
    const secondTurnId = ids[ids.length - 2]; // newest first: "what project was it in?"
    const restored = await panel.render({ action: "history-open", payload: { id: secondTurnId } });
    expect(restored.html).toContain("Conversation · 2 turns");
    expect(restored.html).toMatch(/<input type="checkbox" name="continue" value="1" checked>/);
    await panel.render({ action: "search", fields: { query: "and then?", mode: "AGENTIC", continue: "1" } });
    expect(bodies[5].sessionId).toBe("thread-1");
  });
});
