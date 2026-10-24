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
  createSearchClient,
  createSessionSearchExtension,
  createThreadStore,
  legacyHistoryFilePath,
  loadProfileCredentials,
  migrateLegacyEntries,
  normalizeConfig,
  normalizeSearchResponse,
  normalizeThread,
  normalizeTurn,
  parseCredentialsIni,
  renderAnswerMarkdown,
  renderPanel,
  signRequest,
  threadsFilePath,
  tracesLink,
  type SearchConfig,
  type Thread,
  type Turn,
} from "../examples/pi-web-extensions/session-search";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "FwoGZXIvYXdzEExampleToken==" };
const config: SearchConfig = { endpoint: "https://search.example.test/apps/app123/search", profile: "unit", region: "us-east-1", service: "aisearch", refreshHint: "refresh-creds --once", tracesUrl: "" };
const THREAD = "11111111-2222-4333-8444-555555555555";

const upstreamFixture = {
  documents: [
    { datasetId: "ds-1", documentId: "sha-1", source: { title: "Create the pi sessions domain", project: "pi-web-origin", started_at: "2026-10-20T14:05:00.000Z", session_url: "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b", session_id: "01a13ce5-9ebc-716c-be1c-ec84cf90e58b", passage_count: 12, passages: [{ text: "secret passage", vector: [0.1, 0.2] }] } },
    // The AGENTIC path serialises `source` as a JSON string; SIMPLE returns the object. Keep one hit in each shape.
    { datasetId: "ds-1", documentId: "sha-2", source: JSON.stringify({ title: "Create the pi sessions domain", project: "agent-health", started_at: "2026-10-19T09:00:00.000Z", session_url: "/?sessionId=0199aaaa-0000-7000-8000-000000000002", passage_count: 1, embedding_model: "amazon.titan-embed-text-v2:0", passages: [{ text: "secret passage", vector: [1] }] }) },
    { datasetId: "ds-1", documentId: "sha-3", source: { title: "", project: "", started_at: "not-a-date", session_url: "javascript:alert(1)", session_id: "<img onerror=x>", passage_count: -4 } },
  ],
  retrievalMode: "SIMPLE",
  usage: { planningTokens: 0, synthesisTokens: 0, totalTokens: 123 },
};

const jsonResponse = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "x-amzn-RequestId": "req-0001-abcd" }, ...init });

/** Panel markup without its <style> block, so assertions about words like "disabled" target the DOM, not the CSS. */
const markup = (html: string) => html.slice(html.indexOf("</style>") + "</style>".length);
const timeline = (html: string) => markup(html).slice(markup(html).indexOf('class="ssxTimeline"'));

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
    const request = buildSearchRequest(config.endpoint, { intent: "which session created the domain?", kind: "search", threadId: THREAD });
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

  it("omits the session token header for long-lived keys", () => {
    const request = buildSearchRequest(config.endpoint, { intent: "q", kind: "search", threadId: THREAD });
    const headers = signRequest({ ...request, service: "aisearch", region: "us-east-1", credentials: { accessKeyId: "A", secretAccessKey: "B" } });
    expect(headers["x-amz-security-token"]).toBeUndefined();
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=A\/\d{8}\/us-east-1\/aisearch\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
});

describe("request and response shaping", () => {
  it("Ask is AGENTIC with synthesis and a retrieval budget, Search is a plain SIMPLE list; both carry the thread's conversation id", () => {
    expect(JSON.parse(buildSearchRequest(config.endpoint, { intent: "q", kind: "ask", threadId: THREAD }).body)).toEqual({
      query: { intent: "q" }, retrieval: "AGENTIC", sessionId: THREAD, synthesize: true,
      synthesisOptions: { maxTokens: 600, temperature: 0, responseFormat: "MARKDOWN" }, retrievalOptions: { maxTurns: 6 }, maxResults: 5,
    });
    expect(JSON.parse(buildSearchRequest(config.endpoint, { intent: "q", kind: "search", threadId: THREAD }).body)).toEqual({ query: { intent: "q" }, retrieval: "SIMPLE", sessionId: THREAD, maxResults: 10 });
  });

  it("keeps only display fields, drops passages, normalises string and object sources, and sanitizes session links", () => {
    const result = normalizeSearchResponse(upstreamFixture, 812, "req-1");
    expect(JSON.stringify(result)).not.toContain("passage\"");
    expect(JSON.stringify(result)).not.toContain("secret passage");
    expect(JSON.stringify(result)).not.toContain("vector");
    expect(result.retrievalMode).toBe("SIMPLE");
    expect(result.usage).toEqual({ planningTokens: 0, synthesisTokens: 0, totalTokens: 123 });
    expect(result.elapsedMs).toBe(812);
    expect(result.requestId).toBe("req-1");
    expect(result.documents.map((hit) => hit.title)).toEqual(["Create the pi sessions domain", "Create the pi sessions domain", "Untitled session"]);
    expect(result.documents[0]).toEqual({
      id: "sha-1", title: "Create the pi sessions domain", project: "pi-web-origin", startedAt: "2026-10-20T14:05:00.000Z",
      sessionId: "01a13ce5-9ebc-716c-be1c-ec84cf90e58b", sessionUrl: "/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b", passageCount: 12,
    });
    // JSON-string source, session_id missing: derived from the relative session_url.
    expect(result.documents[1]).toMatchObject({ project: "agent-health", sessionUrl: "/?sessionId=0199aaaa-0000-7000-8000-000000000002", passageCount: 1 });
    // hostile values never become a link.
    expect(result.documents[2]).toMatchObject({ sessionId: "", sessionUrl: "", passageCount: 0, project: "" });
  });

  it("tolerates garbage payloads and hostile request ids", () => {
    expect(normalizeSearchResponse(null)).toEqual({ retrievalMode: "SIMPLE", documents: [], answer: "", citations: [], usage: { planningTokens: 0, synthesisTokens: 0, totalTokens: 0 }, elapsedMs: 0, requestId: "" });
    expect(normalizeSearchResponse({ documents: [1, "x", null], retrievalMode: "AGENTIC", usage: "nope" }, 0, "<script>").requestId).toBe("");
    expect(normalizeSearchResponse({ documents: [{ source: "not json" }, { source: { title: "No ids at all" } }] }).documents).toEqual([
      { id: "doc-0", title: "Untitled session", project: "", startedAt: "", sessionId: "", sessionUrl: "", passageCount: 0 },
      { id: "doc-1", title: "No ids at all", project: "", startedAt: "", sessionId: "", sessionUrl: "", passageCount: 0 },
    ]);
  });

  it("keeps the synthesized answer and in-range citations exactly as the API returned them (observed shape)", () => {
    const synthesized = normalizeSearchResponse({
      ...upstreamFixture,
      retrievalMode: "AGENTIC",
      answer: "  The session `01a13ce5` created the domain [1]. A worker monitored it [2]. <script>alert(1)</script>  ",
      citations: [{ documentIndex: 0 }, { documentIndex: 1 }, { documentIndex: 0 }, { documentIndex: 7 }, { documentIndex: -1 }, { documentIndex: "0" }, null, "junk"],
    }, 1000);
    expect(synthesized.answer).toBe("The session `01a13ce5` created the domain [1]. A worker monitored it [2]. <script>alert(1)</script>");
    expect(synthesized.citations).toEqual([0, 1]);
    const empty = normalizeSearchResponse({ citations: [], documents: [], retrievalMode: "AGENTIC", usage: { planningTokens: 21464, synthesisTokens: 0, totalTokens: 21464 } });
    expect(empty).toMatchObject({ answer: "", citations: [], documents: [] });
    expect(normalizeSearchResponse({ ...upstreamFixture, answer: 42, citations: "x" })).toMatchObject({ answer: "", citations: [] });
    expect(normalizeSearchResponse({ ...upstreamFixture, answer: "a".repeat(9_000) }).answer).toHaveLength(8_000);
  });

  it("classifies expired credentials separately from other upstream failures and keeps the request id", () => {
    const expired = classifyUpstreamError(403, '{"message":"The security token included in the request is expired"}', config, "req-403");
    expect(expired.kind).toBe("credentials");
    expect(expired.requestId).toBe("req-403");
    expect(expired.message).toContain('profile "unit"');
    expect(expired.message).toContain("refresh-creds --once");
    expect(classifyUpstreamError(400, "ExpiredTokenException", { profile: "p", refreshHint: "" }).kind).toBe("credentials");
    const server = classifyUpstreamError(502, "<html>bad gateway</html>", config);
    expect(server.kind).toBe("upstream");
    expect(server.message).toBe("Search API answered HTTP 502: <html>bad gateway</html>");
  });

  it("resolves config from settings values over environment defaults, and builds the traces link only from an http(s) template", () => {
    const env = configFromEnv({ PI_WEB_SESSION_SEARCH_ENDPOINT: " https://e/ ", PI_WEB_SESSION_SEARCH_PROFILE: "p", PI_WEB_SESSION_SEARCH_TRACES_URL: "https://traces.example/r/{requestId}" });
    expect(env).toEqual({ endpoint: "https://e/", profile: "p", region: "us-east-1", service: "aisearch", refreshHint: "", tracesUrl: "https://traces.example/r/{requestId}" });
    expect(normalizeConfig({ profile: "override", region: "   ", endpoint: 42 }, env)).toEqual({ ...env, profile: "override" });
    expect(tracesLink("https://traces.example/r/{requestId}", "a b")).toBe("https://traces.example/r/a%20b");
    expect(tracesLink("https://traces.example/?id=", "x")).toBe("https://traces.example/?id=x");
    expect(tracesLink("", "x")).toBe("");
    expect(tracesLink("https://traces.example/", "")).toBe("");
    expect(tracesLink("javascript:alert(1)//{requestId}", "x")).toBe("");
  });
});

describe("search client", () => {
  const loadCredentials = async () => credentials;
  const input = { intent: "find it", kind: "search" as const, threadId: THREAD };

  it("signs the upstream request, captures x-amzn-RequestId, and returns normalized results", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
      expect(headers["x-amz-security-token"]).toBe(credentials.sessionToken);
      expect(JSON.parse(String(init?.body))).toEqual({ query: { intent: "find it" }, retrieval: "SIMPLE", sessionId: THREAD, maxResults: 10 });
      return jsonResponse(upstreamFixture);
    });
    const search = createSearchClient({ fetch: fetchMock as unknown as typeof fetch, loadCredentials });
    const result = await search(config, input);
    expect(fetchMock).toHaveBeenCalledWith(config.endpoint, expect.anything());
    expect(result.documents).toHaveLength(3);
    expect(result.requestId).toBe("req-0001-abcd");
    expect(result.documents[0].sessionUrl).toBe("/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b");
  });

  it("fails closed on missing or insecure configuration before touching credentials", async () => {
    const fetchMock = vi.fn();
    const loader = vi.fn(loadCredentials);
    const search = createSearchClient({ fetch: fetchMock, loadCredentials: loader });
    await expect(search({ ...config, endpoint: "" }, input)).rejects.toMatchObject({ kind: "config" });
    await expect(search({ ...config, endpoint: "http://search.example.test/x" }, input)).rejects.toMatchObject({ kind: "config" });
    await expect(search({ ...config, endpoint: "not a url" }, input)).rejects.toMatchObject({ kind: "config" });
    expect(loader).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps 403 to an expired-credentials message that carries the refresh hint, the request id, and no secrets", async () => {
    const search = createSearchClient({ fetch: (async () => jsonResponse({ message: "ExpiredToken" }, { status: 403 })) as typeof fetch, loadCredentials });
    const error = await search(config, input).catch((caught) => caught as SearchError);
    expect(error).toMatchObject({ kind: "credentials", requestId: "req-0001-abcd" });
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
    const cancelled = createSearchClient({ fetch: hang, loadCredentials })(config, { ...input, kind: "ask" }, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    await expect(createSearchClient({ fetch: hang, loadCredentials, timeoutMs: 20 })(config, input)).rejects.toMatchObject({ kind: "timeout", message: "Timed out after 0s." });
  });

  it("reports non-JSON bodies and network failures as upstream problems", async () => {
    await expect(createSearchClient({ fetch: (async () => new Response("<html>", { status: 200 })) as typeof fetch, loadCredentials })(config, input)).rejects.toMatchObject({ kind: "upstream" });
    await expect(createSearchClient({ fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch, loadCredentials })(config, input)).rejects.toMatchObject({ kind: "network", message: "Could not reach the search API: fetch failed" });
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

describe("thread store", () => {
  const result = normalizeSearchResponse({ ...upstreamFixture, answer: "The answer [1].", citations: [{ documentIndex: 0 }] }, 900, "req-store");
  const turn = (id: string, at: string, extra: Partial<Turn> = {}): Turn => ({ id, at, kind: "ask", query: `question ${id}`, result, ...extra });
  const threadId = (n: number) => `thread-${String(n).padStart(4, "0")}`;

  async function tempStore(limit?: number, legacy?: unknown) {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-session-search-threads-"));
    tempDirs.push(dir);
    const legacyPath = join(dir, "session-search-history.json");
    if (legacy !== undefined) await writeFile(legacyPath, JSON.stringify(legacy));
    return { dir, legacyPath, store: createThreadStore(join(dir, "nested", "threads.json"), { limit, legacyPath }) };
  }

  it("appends turns to their thread, keeps threads newest first and bounded, with owner-only permissions and no upstream payload", async () => {
    const { store } = await tempStore(3);
    expect(await store.load()).toEqual([]);
    await store.addTurn(threadId(1), turn("a", "2026-10-23T01:00:00.000Z"));
    await store.addTurn(threadId(2), turn("b", "2026-10-23T02:00:00.000Z"));
    await store.addTurn(threadId(1), turn("c", "2026-10-23T03:00:00.000Z", { kind: "search" }));
    await store.addTurn(threadId(3), turn("d", "2026-10-23T04:00:00.000Z"));
    const threads = await store.addTurn(threadId(4), turn("e", "2026-10-23T05:00:00.000Z"));
    expect(threads.map((thread) => thread.id)).toEqual([threadId(4), threadId(3), threadId(1)]);
    expect(threads[2]).toMatchObject({ createdAt: "2026-10-23T01:00:00.000Z", updatedAt: "2026-10-23T03:00:00.000Z" });
    expect(threads[2].turns.map((item) => [item.id, item.kind])).toEqual([["a", "ask"], ["c", "search"]]);
    expect(await store.load()).toEqual(threads);
    const raw = await readFile(store.path, "utf8");
    expect(raw).not.toContain("secret passage");
    expect(raw).not.toContain("vector");
    expect(raw).toContain("req-store");
    expect(JSON.parse(raw)).toMatchObject({ version: 2 });
    if (process.platform !== "win32") expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await store.remove(threadId(3))).map((thread) => thread.id)).toEqual([threadId(4), threadId(1)]);
  });

  it("re-validates stored threads so a tampered file cannot inject markup, links, or empty threads", async () => {
    const { store } = await tempStore();
    await mkdir(join(store.path, ".."), { recursive: true });
    await writeFile(store.path, JSON.stringify({ version: 2, threads: [
      { id: threadId(1), createdAt: "nope", turns: [
        { ...turn("ok", "2026-10-23T01:00:00.000Z"), extra: "field", result: { ...result, documents: [{ ...result.documents[0], sessionId: "javascript:alert(1)", sessionUrl: "javascript:alert(1)", bonus: 1 }], citations: [0, 5, "x"], answer: 7, requestId: "<b>" } },
        { id: "no-query", at: "2026-10-23T01:00:00.000Z", query: "", result },
        { id: "bad-date", at: "yesterday", query: "q", result },
        "garbage", null,
      ] },
      { id: "<script>", turns: [turn("x", "2026-10-23T01:00:00.000Z")] },
      { id: threadId(2), turns: [] },
      "junk",
    ] }));
    const [only, ...rest] = await store.load();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ id: threadId(1), createdAt: "2026-10-23T01:00:00.000Z", updatedAt: "2026-10-23T01:00:00.000Z" });
    expect(only.turns).toHaveLength(1);
    expect("extra" in only.turns[0]).toBe(false);
    expect(only.turns[0].result.documents[0]).toMatchObject({ sessionId: "", sessionUrl: "" });
    expect("bonus" in only.turns[0].result.documents[0]).toBe(false);
    expect(only.turns[0].result).toMatchObject({ citations: [0], answer: "", requestId: "" });
    expect(normalizeTurn(undefined)).toBeUndefined();
    expect(normalizeTurn({ id: "x", at: "2026-10-23T01:00:00.000Z", query: "q", result: {} })).toMatchObject({ kind: "ask", result: { documents: [], answer: "", citations: [], requestId: "" } });
    expect(normalizeThread({ id: threadId(9), turns: [] })).toBeUndefined();
  });

  it("migrates the legacy flat history once: conversations become threads, lone searches single-turn threads, and the legacy file is left alone", async () => {
    const legacy = { version: 1, entries: [
      { id: "l3", at: "2026-10-23T03:00:00.000Z", query: "what project was it in?", mode: "AGENTIC", synthesize: true, threadId: THREAD, result },
      { id: "l2", at: "2026-10-23T02:00:00.000Z", query: "plain simple search", mode: "SIMPLE", synthesize: false, threadId: "22222222-2222-4333-8444-555555555555", result },
      { id: "l1", at: "2026-10-23T01:00:00.000Z", query: "who created the domain?", mode: "AGENTIC", synthesize: true, threadId: THREAD, result },
      { id: "l0", at: "2026-10-22T01:00:00.000Z", query: "very old, no thread id", mode: "AGENTIC", result },
      { id: "bad", at: "yesterday", query: "dropped", result },
    ] };
    const { store, legacyPath } = await tempStore(undefined, legacy);
    const threads = await store.load();
    expect(threads.map((thread) => [thread.id, thread.turns.map((item) => item.query), thread.turns.map((item) => item.kind)])).toEqual([
      [THREAD, ["who created the domain?", "what project was it in?"], ["ask", "ask"]],
      ["22222222-2222-4333-8444-555555555555", ["plain simple search"], ["search"]],
      [expect.stringMatching(/^[0-9a-f-]{36}$/), ["very old, no thread id"], ["ask"]],
    ]);
    expect(threads[0]).toMatchObject({ createdAt: "2026-10-23T01:00:00.000Z", updatedAt: "2026-10-23T03:00:00.000Z" });
    // Persisted in the new file; the legacy file is untouched and not re-read once the thread file exists.
    expect(JSON.parse(await readFile(store.path, "utf8"))).toMatchObject({ version: 2 });
    expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual(legacy);
    await writeFile(legacyPath, JSON.stringify({ version: 1, entries: [{ id: "later", at: "2026-10-24T01:00:00.000Z", query: "added after migration", result }] }));
    expect((await store.load()).map((thread) => thread.turns[0].query)).not.toContain("added after migration");
    expect(migrateLegacyEntries({ entries: "nope" })).toEqual([]);
    expect(migrateLegacyEntries(null)).toEqual([]);
  });

  it("survives a corrupt file, starts empty without a legacy file, and resolves its default locations from the environment", async () => {
    const { store } = await tempStore();
    expect(await store.load()).toEqual([]);
    await mkdir(join(store.path, ".."), { recursive: true });
    await writeFile(store.path, "{not json");
    expect(await store.load()).toEqual([]);
    expect(threadsFilePath({ PI_WEB_SESSION_SEARCH_HISTORY_FILE: "/tmp/x.json", PI_WEB_HOME: "/home/x" })).toBe("/tmp/x.json");
    expect(threadsFilePath({ PI_WEB_HOME: "/web-home" })).toBe(join("/web-home", "session-search-threads.json"));
    expect(threadsFilePath({})).toMatch(/[\\/]\.pi[\\/]agent[\\/]session-search-threads\.json$/);
    expect(legacyHistoryFilePath({ PI_WEB_HOME: "/web-home" })).toBe(join("/web-home", "session-search-history.json"));
  });
});

describe("panel rendering", () => {
  const controller = new AbortController();
  const result = normalizeSearchResponse({ ...upstreamFixture, retrievalMode: "AGENTIC", answer: "The **domain** [1] was created here [3].", citations: [{ documentIndex: 0 }] }, 42_300, "req-render-1");
  const longQuestion = "which session created the OpenSearch domain for pi sessions, and what engine version, instance type, and access policy did it confirm when the domain finished provisioning?";
  const thread: Thread = { id: THREAD, createdAt: "2026-10-23T01:00:00.000Z", updatedAt: "2026-10-23T02:00:00.000Z", turns: [
    { id: "t1", at: "2026-10-23T01:00:00.000Z", kind: "ask", query: longQuestion, result },
    { id: "t2", at: "2026-10-23T02:00:00.000Z", kind: "search", query: "plain list <b>", result: { ...normalizeSearchResponse(upstreamFixture, 600, "req-render-2"), answer: "ignored for search turns" } },
  ] };
  const now = Date.parse("2026-10-23T02:30:00.000Z");

  it("renders the thread as question/answer bubbles with full questions, citations, sessions, and a footer with the request id", () => {
    const html = renderPanel({ threadId: THREAD, threads: [thread], kind: "ask", tracesUrl: "https://traces.example/{requestId}" }, now).html;
    expect(html).toContain(`<div class="ssxUser" role="group" aria-label="Question">${longQuestion}</div>`);
    expect(html).toContain('<div class="ssxUserMeta" title="2026-10-23 01:00 UTC">2 h ago</div>');
    expect(html).toContain("The <strong>domain</strong> <sup");
    expect(html).toContain('<sup class="ssxCite" title="Create the pi sessions domain">[1]</sup>');
    expect(html).toContain('<sup class="ssxCite" title="Untitled session">[3]</sup>');
    expect(html).toContain('<div class="ssxSessionsLabel">Sessions</div>');
    expect(html.match(/class="ssxHit"/g)).toHaveLength(6);
    expect(html).toContain('<a href="/?sessionId=01a13ce5-9ebc-716c-be1c-ec84cf90e58b">Open session</a>');
    expect(html).toContain('<span class="ssxProject">pi-web-origin</span>');
    expect(html).toContain("2026-10-20 14:05 UTC");
    expect(html).toContain("12 passages");
    expect(html).toContain("no session link");
    expect(html).toContain("<span>Ask · AGENTIC</span>");
    expect(html).toContain("<span>42s</span>");
    expect(html).toContain("<span>tokens 123</span>");
    expect(html).toContain('<code class="ssxReqId" title="Request id">req-render-1</code>');
    expect(html).toContain('data-copy="req-render-1" aria-label="Copy request id"');
    expect(html).toContain('<a href="https://traces.example/req-render-1" target="_blank" rel="noopener noreferrer">Open traces</a>');
    // Search turns render the list only, never an answer; the question is escaped.
    expect(html).toContain("plain list &lt;b&gt;");
    expect(html).not.toContain("ignored for search turns");
    expect(html).toContain("<span>Search · SIMPLE</span>");
    expect(html).toContain("<span>0.6s</span>");
    expect(html.match(/class="ssxAnswer"/g)).toHaveLength(1);
    // Newest turn first in the DOM (column-reverse timeline opens at the bottom).
    expect(timeline(html).indexOf("plain list")).toBeLessThan(timeline(html).indexOf(longQuestion));
    // Thread picker lists the thread as current; composer is live with Ask selected.
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("1 turns · 30 min ago".replace("1 turns", "2 turns"));
    expect(html).toMatch(/<input type="search" name="query" placeholder="Search or ask your sessions…"[^>]* autofocus>/);
    expect(html).toContain('<input type="radio" name="kind" value="ask" checked>');
    expect(html).toContain('<button class="webPanelButton ssxSend" type="submit" data-web-action="send">Send</button>');
    expect(html).not.toContain("Continue conversation");
    expect(html).not.toContain("Synthesize");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
  });

  it("hides the traces link without a template and shows an empty thread with a disabled-free composer", () => {
    const html = renderPanel({ threadId: THREAD, threads: [thread], kind: "search" }, now).html;
    expect(html).not.toContain("Open traces");
    expect(html).toContain('<input type="radio" name="kind" value="search" checked>');
    const empty = renderPanel({ threadId: "fresh", threads: [], kind: "ask" }, now).html;
    expect(empty).toContain("Ask a question about your indexed pi-web sessions");
    expect(empty).toContain("No threads yet");
    expect(markup(empty)).not.toContain("ssxUser");
  });

  it("shows the live turn while running (locked composer, Cancel), then error and cancelled states", () => {
    const job = { id: "job-1", threadId: THREAD, kind: "ask" as const, query: "what engine version did it confirm?", startedAt: now - 12_000, controller, state: "running" as const };
    const running = renderPanel({ threadId: THREAD, threads: [thread], kind: "ask", job }, now).html;
    expect(running).toContain('<div class="ssxUser" role="group" aria-label="Question">what engine version did it confirm?</div>');
    expect(running).toContain("Thinking…");
    expect(running).toContain("answers usually take 30–90 s");
    expect(running).toContain('data-web-action="cancel"');
    expect(running).toContain('class="ssxSpinner"');
    // Focus lands on the status element, not a form control, so update() can repaint when the job finishes.
    expect(running).toMatch(/<div class="ssxStatus"[^>]*autofocus/);
    expect(running).not.toMatch(/<input[^>]*autofocus/);
    expect(running).toMatch(/<input type="search" name="query"[^>]* disabled>/);
    expect(running).toContain('<input type="radio" name="kind" value="ask" checked disabled>');
    expect(running).toContain('data-web-action="send" disabled>Send</button>');
    expect(running).toContain('data-web-action="new" disabled>New thread</button>');
    // The live turn sits at the bottom (first in DOM), after the stored turns.
    expect(running.indexOf("what engine version")).toBeLessThan(running.indexOf("plain list"));

    const error = renderPanel({ threadId: THREAD, threads: [thread], kind: "ask", job: { ...job, state: "error", error: new SearchError("creds <expired>", "credentials", "req-err") } }, now).html;
    expect(error).toContain('<div class="ssxError" role="alert">creds &lt;expired&gt;</div>');
    expect(error).toContain('<code class="ssxReqId" title="Request id">req-err</code>');
    expect(markup(error)).not.toContain("disabled");

    const cancelled = renderPanel({ threadId: THREAD, threads: [thread], kind: "ask", job: { ...job, state: "cancelled" } }, now).html;
    expect(cancelled).toContain(">Cancelled.</div>");
    expect(markup(cancelled)).not.toContain("ssxSpinner");
    // A job that belongs to another thread is not drawn into this one.
    const elsewhere = renderPanel({ threadId: "other-thread-1", threads: [thread], kind: "ask", job }, now).html;
    expect(timeline(elsewhere)).not.toContain("what engine version did it confirm?</div>");
    expect(elsewhere).toMatch(/<input type="search" name="query"[^>]* disabled>/);
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
    const historyFile = join(dir, "threads.json");
    let threads = 0;
    const settings: Record<string, unknown> = {};
    createSessionSearchExtension({ fetch: fetchImpl, loadCredentials: async () => credentials, env, historyFile, newThreadId: () => `thread-${++threads}` })({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as PiWebExtensionAPI);
    const ctx = {
      ui: {
        notify,
        web: {
          capabilities: { apiVersion: 1, slots: ["panel", "fab", "header-action"], kinds: ["rendered", "static"], effects: ["open-panel"] },
          contribute: (key: string, spec: unknown) => spec === undefined ? contributions.delete(key) : contributions.set(key, spec),
          update,
          registerSettings: async () => ({ registered: true, migrated: false, usedBackup: false }),
          getSettings: async () => ({ schemaVersion: 1, values: settings }),
        },
      },
    } as unknown as PiWebExtensionContext;
    await handlers.get("session_start")!({}, ctx);
    return { handlers, contributions, update, notify, ctx, historyFile, settings, panel: contributions.get(PANEL_KEY) };
  }

  const fastAnswer = (label: string) => jsonResponse({ ...upstreamFixture, retrievalMode: "AGENTIC", answer: `${label} [1].`, citations: [{ documentIndex: 0 }] });

  it("registers the panel, launcher, and header action; Search turns render inline as a list under the same thread id", async () => {
    const bodies: any[] = [];
    const { handlers, contributions, update, ctx, panel } = await boot((async (_url: string | URL | Request, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return jsonResponse(upstreamFixture); }) as typeof fetch);
    expect([...contributions.keys()]).toEqual([PANEL_KEY, `${PANEL_KEY}-launcher`, `${PANEL_KEY}-header`]);
    expect(contributions.get(`${PANEL_KEY}-launcher`)).toMatchObject({ slot: "fab", opens: PANEL_KEY });
    expect(contributions.get(`${PANEL_KEY}-header`).render()).toEqual({ effects: [{ type: "open-panel", key: PANEL_KEY }] });

    expect((await panel.render()).html).toContain("Ask a question about your indexed pi-web sessions");
    const view = await panel.render({ action: "send", fields: { query: "  which session created the domain  ", kind: "search" } });
    expect(view.title).toBe("Session search");
    expect(view.html).toContain('aria-label="Question">which session created the domain</div>');
    expect(view.html).toContain("Open session");
    expect(view.html).toContain("<span>Search · SIMPLE</span>");
    expect(view.html).not.toContain('class="ssxAnswer"');
    expect(view.html).not.toContain("secret passage");
    expect(bodies[0]).toEqual({ query: { intent: "which session created the domain" }, retrieval: "SIMPLE", sessionId: "thread-1", maxResults: 10 });
    // The composer is empty again and the originating render painted the result: no redundant repaint.
    expect(view.html).not.toMatch(/name="query"[^>]*value=/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(update).not.toHaveBeenCalled();

    const blank = await panel.render({ action: "send", fields: { query: "   ", kind: "search" } });
    expect(bodies).toHaveLength(1);
    expect(blank.html).toContain("which session created the domain");

    await handlers.get("session_shutdown")!({}, ctx);
    expect(contributions.size).toBe(0);
  });

  it("keeps one conversation id across the turns of a thread, mints a new one on New thread, and renders every turn", async () => {
    const bodies: any[] = [];
    const { panel, historyFile } = await boot((async (_url: string | URL | Request, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); bodies.push(body); return fastAnswer(`Turn ${bodies.length} about ${body.query.intent}`); }) as typeof fetch);

    const first = await panel.render({ action: "send", fields: { query: "who created the domain?", kind: "ask" } });
    expect(bodies[0]).toMatchObject({ sessionId: "thread-1", retrieval: "AGENTIC", synthesize: true, retrievalOptions: { maxTurns: 6 }, maxResults: 5 });
    expect(first.html).toContain("Turn 1 about who created the domain? <sup");
    expect(first.html).toContain('<span class="ssxProject">pi-web-origin</span>');

    const second = await panel.render({ action: "send", fields: { query: "what engine version did it confirm?", kind: "ask" } });
    expect(bodies[1].sessionId).toBe("thread-1");
    expect(second.html).toContain('aria-label="Question">who created the domain?</div>');
    expect(second.html).toContain('aria-label="Question">what engine version did it confirm?</div>');
    expect(second.html).toContain("Turn 2 about what engine version");
    expect(second.html).toContain("2 turns");

    const fresh = await panel.render({ action: "new" });
    expect(fresh.html).toContain("Ask a question about your indexed pi-web sessions");
    expect(fresh.html).not.toContain("who created the domain?</div>");
    expect(fresh.html).toContain("Threads <span>(1)</span>");
    await panel.render({ action: "send", fields: { query: "unrelated", kind: "ask" } });
    expect(bodies[2].sessionId).toBe("thread-2");

    const stored = JSON.parse(await readFile(historyFile, "utf8"));
    expect(stored.threads.map((thread: Thread) => [thread.id, thread.turns.map((turn) => turn.query)])).toEqual([["thread-2", ["unrelated"]], ["thread-1", ["who created the domain?", "what engine version did it confirm?"]]]);
    expect(JSON.stringify(stored)).not.toContain("secret passage");
    expect(JSON.stringify(stored)).not.toContain(credentials.sessionToken);

    // Switching threads shows that thread's turns and continues it under its id; deleting falls back to the latest.
    const switched = await panel.render({ action: "thread-open", payload: { id: "thread-1" } });
    expect(switched.html).toContain("what engine version did it confirm?</div>");
    expect(switched.html).not.toContain("unrelated</div>");
    await panel.render({ action: "send", fields: { query: "and the instance type?", kind: "ask" } });
    expect(bodies[3].sessionId).toBe("thread-1");
    const deleted = await panel.render({ action: "thread-delete", payload: { id: "thread-1" } });
    expect(deleted.html).toContain("unrelated</div>");
    expect(deleted.html).not.toContain("instance type");
    expect(JSON.parse(await readFile(historyFile, "utf8")).threads).toHaveLength(1);
    expect((await panel.render({ action: "thread-open", payload: { id: "missing" } })).html).toContain("unrelated</div>");
  });

  it("opens on the most recent thread (never a stale single result), and a fresh host reads the same file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-session-search-reopen-"));
    tempDirs.push(dir);
    const historyFile = join(dir, "threads.json");
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => fastAnswer(`About ${JSON.parse(String(init?.body)).query.intent}`)) as typeof fetch;
    const handlers = new Map<string, Handler>();
    const contributions = new Map<string, any>();
    const ctx = { ui: { notify: vi.fn(), web: { capabilities: { apiVersion: 1, slots: ["panel"], kinds: ["rendered"], effects: [] }, contribute: (key: string, spec: unknown) => spec === undefined ? contributions.delete(key) : contributions.set(key, spec), update: vi.fn(), registerSettings: async () => ({}), getSettings: async () => ({ values: {} }) } } } as unknown as PiWebExtensionContext;
    const makeHost = async () => {
      createSessionSearchExtension({ fetch: fetchImpl, loadCredentials: async () => credentials, env: { PI_WEB_SESSION_SEARCH_ENDPOINT: config.endpoint }, historyFile })({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as PiWebExtensionAPI);
      await handlers.get("session_start")!({}, ctx);
      return contributions.get(PANEL_KEY);
    };
    const panel = await makeHost();
    await panel.render({ action: "send", fields: { query: "older thread question", kind: "ask" } });
    await panel.render({ action: "new" });
    await panel.render({ action: "send", fields: { query: "newest thread question", kind: "ask" } });

    const other = await makeHost();
    const opened = await other.render();
    expect(opened.html).toContain("newest thread question</div>");
    expect(opened.html).toContain("About newest thread question <sup");
    expect(opened.html).not.toContain("older thread question</div>");
    expect(opened.html).toContain("Threads <span>(2)</span>");
    expect(markup(opened.html)).not.toContain("ssxSpinner");
  });

  it("locks the composer while a turn runs, ignores a second send, repaints via update() when done, and honours cancel", async () => {
    const releases: Array<(response: Response) => void> = [];
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      bodies.push(JSON.parse(String(init?.body)));
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      releases.push(resolve);
    })) as unknown as typeof fetch;
    const { panel, update } = await boot(fetchImpl);

    const spinner = await panel.render({ action: "send", fields: { query: "slow one", kind: "ask" } });
    expect(spinner.html).toContain("Thinking…");
    expect(spinner.html).toMatch(/name="query"[^>]* disabled>/);
    const jobId = /"jobId":"(job-\d+)"/.exec(spinner.html.replace(/&quot;/g, '"'))![1];
    expect(update).not.toHaveBeenCalled();

    // In-flight guard: another send (e.g. a stale form) starts nothing and changes nothing.
    const ignored = await panel.render({ action: "send", fields: { query: "second while running", kind: "search" } });
    expect(ignored.html).toContain("Thinking…");
    expect(ignored.html).not.toContain("second while running");
    expect(bodies).toHaveLength(1);
    // A plain repaint (what update()/focusout triggers) never starts a request.
    expect((await panel.render()).html).toContain("Thinking…");
    expect(bodies).toHaveLength(1);

    releases[0](jsonResponse({ documents: [], retrievalMode: "AGENTIC", usage: { planningTokens: 1, synthesisTokens: 2, totalTokens: 3 } }));
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(PANEL_KEY));
    const done = await panel.render();
    expect(done.html).toContain("No sessions matched.");
    expect(done.html).toContain("tokens 3 (planning 1, synthesis 2)");
    expect(done.html).toContain('<code class="ssxReqId" title="Request id">req-0001-abcd</code>');
    expect(markup(done.html)).not.toContain("disabled");
    expect(done.html).toMatch(/name="query"[^>]* autofocus>/);

    const second = await panel.render({ action: "send", fields: { query: "cancel me", kind: "ask" } });
    const secondJobId = /"jobId":"(job-\d+)"/.exec(second.html.replace(/&quot;/g, '"'))![1];
    expect(secondJobId).not.toBe(jobId);
    expect(bodies[1].sessionId).toBe(bodies[0].sessionId);
    const stale = await panel.render({ action: "cancel", payload: { jobId } });
    expect(stale.html).toContain("Thinking…");
    const cancelled = await panel.render({ action: "cancel", payload: { jobId: secondJobId } });
    expect(cancelled.html).toContain(">Cancelled.</div>");
    expect(cancelled.html).toContain("cancel me</div>");
    expect(cancelled.html).not.toContain('class="ssxSpinner"');
    expect(markup(cancelled.html)).not.toContain("disabled");
  });

  it("surfaces expired credentials as an explicit error bubble that keeps the question and the request id", async () => {
    const { panel } = await boot((async () => jsonResponse({ message: "ExpiredToken" }, { status: 403 })) as typeof fetch);
    const view = await panel.render({ action: "send", fields: { query: "anything", kind: "ask" } });
    expect(view.html).toContain('aria-label="Question">anything</div>');
    expect(view.html).toContain('role="alert"');
    expect(view.html).toContain("probably expired");
    expect(view.html).toContain("refresh-creds --once");
    expect(view.html).toContain("req-0001-abcd");
    expect(view.html).not.toContain(credentials.sessionToken);
    // Nothing failed is persisted; the thread stays empty.
    expect(view.html).toContain("No threads yet");
  });

  it("reads the traces URL from live settings", async () => {
    const { panel, settings } = await boot((async () => fastAnswer("Found")) as typeof fetch);
    settings.tracesUrl = "https://traces.example/search?rid={requestId}";
    const view = await panel.render({ action: "send", fields: { query: "q", kind: "ask" } });
    expect(view.html).toContain('<a href="https://traces.example/search?rid=req-0001-abcd" target="_blank" rel="noopener noreferrer">Open traces</a>');
  });
});
