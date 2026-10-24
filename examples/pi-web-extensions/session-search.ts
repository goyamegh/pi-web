/**
 * session-search — installable pi-web extension (opt-in)
 *
 * Adds a chat-shaped "Session search" panel that asks an AI Search application
 * about your indexed pi-web session history. Each thread is a conversation:
 * your question, then the API's answer with the sessions it cites. Every turn
 * of a thread is sent under the same API conversation id, so follow-ups like
 * "what engine version did it confirm?" resolve against the earlier turns.
 *
 * The browser never sees AWS credentials or raw search passages: the panel is
 * server-rendered HTML, the upstream request is SigV4-signed here on the
 * server from a named profile in ~/.aws/credentials, and only the compact
 * per-session fields (title, project, date, session link, counts, usage,
 * request id) plus the API's synthesized answer and citations reach the page.
 *
 * Threads persist in a small JSON file owned by the server user (like the
 * notepad example), newest first, bounded to MAX_THREADS.
 *
 * Configuration lives in pi-web Settings ("Session search"), seeded from
 * environment variables on first use:
 *   PI_WEB_SESSION_SEARCH_ENDPOINT      full POST URL of the search API (required)
 *   PI_WEB_SESSION_SEARCH_PROFILE       AWS credentials profile (default: "default")
 *   PI_WEB_SESSION_SEARCH_REGION        signing region (default: "us-east-1")
 *   PI_WEB_SESSION_SEARCH_SERVICE       signing service name (default: "aisearch")
 *   PI_WEB_SESSION_SEARCH_REFRESH_HINT  command shown when credentials expire (optional)
 *   PI_WEB_SESSION_SEARCH_TRACES_URL    "Open traces" link; `{requestId}` is substituted (optional)
 *   PI_WEB_SESSION_SEARCH_HISTORY_FILE  where threads are stored
 *                                       (default: PI_WEB_HOME/session-search-threads.json
 *                                        or ~/.pi/agent/session-search-threads.json; a legacy
 *                                        session-search-history.json next to it is migrated once)
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PiWebExtensionAPI, PiWebExtensionContext, PiWebPanelEvent, PiWebPanelView } from "@ashwin-pc/pi-web/extensions";

export const PANEL_KEY = "session-search";
export const SETTINGS_ID = "session-search.settings";
export const SEARCH_TIMEOUT_MS = 180_000;
export const MAX_THREADS = 50;
/** Search turns usually answer well inside this window; longer ones render a spinner and finish via update(). */
const INLINE_WAIT_MS = 1_500;
const MAX_QUERY_CHARS = 2_000;
const MAX_ANSWER_CHARS = 8_000;
const SYNTHESIS_OPTIONS = { maxTokens: 600, temperature: 0, responseFormat: "MARKDOWN" } as const;
/** Transparent 1×1 GIF; its onload scrolls the timeline to the newest turn (see renderPanel). */
const SCROLL_ANCHOR_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export type RetrievalMode = "SIMPLE" | "AGENTIC";
/** What the composer's segmented control offers: Ask answers, Search only lists sessions. */
export type TurnKind = "ask" | "search";

export const TURN_PLANS: Record<TurnKind, { mode: RetrievalMode; synthesize: boolean; maxResults: number; maxTurns?: number; label: string }> = {
  ask: { mode: "AGENTIC", synthesize: true, maxResults: 5, maxTurns: 6, label: "Ask" },
  search: { mode: "SIMPLE", synthesize: false, maxResults: 10, label: "Search" },
};

export type SearchConfig = {
  endpoint: string;
  profile: string;
  region: string;
  service: string;
  refreshHint: string;
  /** Template for the "Open traces" link; `{requestId}` is substituted (appended when absent). Empty hides the link. */
  tracesUrl: string;
};

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export type SessionHit = {
  id: string;
  title: string;
  project: string;
  startedAt: string;
  sessionId: string;
  sessionUrl: string;
  passageCount: number;
};

export type SearchUsage = { planningTokens: number; synthesisTokens: number; totalTokens: number };

export type SearchResult = {
  retrievalMode: RetrievalMode;
  documents: SessionHit[];
  /** Synthesized Markdown answer ("" when the API returned none). Citation markers look like `[1]`. */
  answer: string;
  /** Zero-based indexes into `documents` the answer cites, in the API's order. */
  citations: number[];
  usage: SearchUsage;
  elapsedMs: number;
  /** The API's `x-amzn-RequestId` ("" when absent). */
  requestId: string;
};

export type SearchInput = {
  intent: string;
  kind: TurnKind;
  /** API conversation id: every turn of a thread sends the same one so follow-ups resolve. */
  threadId: string;
};

export class SearchError extends Error {
  constructor(
    message: string,
    readonly kind: "config" | "credentials" | "upstream" | "timeout" | "cancelled" | "network",
    readonly requestId = "",
  ) {
    super(message);
    this.name = "SearchError";
  }
}

// --- Configuration -----------------------------------------------------------

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  return {
    endpoint: (env.PI_WEB_SESSION_SEARCH_ENDPOINT || "").trim(),
    profile: (env.PI_WEB_SESSION_SEARCH_PROFILE || "default").trim(),
    region: (env.PI_WEB_SESSION_SEARCH_REGION || "us-east-1").trim(),
    service: (env.PI_WEB_SESSION_SEARCH_SERVICE || "aisearch").trim(),
    refreshHint: (env.PI_WEB_SESSION_SEARCH_REFRESH_HINT || "").trim(),
    tracesUrl: (env.PI_WEB_SESSION_SEARCH_TRACES_URL || "").trim(),
  };
}

export function normalizeConfig(values: Record<string, unknown> | undefined, fallback: SearchConfig): SearchConfig {
  const text = (key: keyof SearchConfig) => {
    const value = values?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : fallback[key];
  };
  return { endpoint: text("endpoint"), profile: text("profile"), region: text("region"), service: text("service"), refreshHint: text("refreshHint"), tracesUrl: text("tracesUrl") };
}

function storageDirectory(env: NodeJS.ProcessEnv) {
  return env.PI_WEB_HOME || join(homedir(), ".pi", "agent");
}

export function threadsFilePath(env: NodeJS.ProcessEnv = process.env) {
  return env.PI_WEB_SESSION_SEARCH_HISTORY_FILE || join(storageDirectory(env), "session-search-threads.json");
}

/** The previous version of this extension kept a flat list of searches here; it is read once to seed the thread store. */
export function legacyHistoryFilePath(env: NodeJS.ProcessEnv = process.env) {
  return join(storageDirectory(env), "session-search-history.json");
}

/** Builds the "Open traces" link for a request id, or "" when no template is configured. */
export function tracesLink(template: string, requestId: string) {
  if (!template || !requestId) return "";
  const url = template.includes("{requestId}") ? template.replaceAll("{requestId}", encodeURIComponent(requestId)) : `${template}${encodeURIComponent(requestId)}`;
  return /^https?:\/\//i.test(url) ? url : "";
}

// --- AWS credentials file -----------------------------------------------------

export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env) {
  return env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), ".aws", "credentials");
}

/** Minimal INI reader for ~/.aws/credentials: `[profile]` sections with `key = value` or `key=value` lines. */
export function parseCredentialsIni(text: string, profile: string): AwsCredentials | undefined {
  let section = "";
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const header = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (header) { section = header[1]; continue; }
    if (section !== profile) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    values[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  const accessKeyId = values.aws_access_key_id;
  const secretAccessKey = values.aws_secret_access_key;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey, ...(values.aws_session_token ? { sessionToken: values.aws_session_token } : {}) };
}

export async function loadProfileCredentials(profile: string, file = credentialsFilePath()): Promise<AwsCredentials> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new SearchError(`AWS credentials file not found at ${file}.`, "credentials");
  }
  const credentials = parseCredentialsIni(text, profile);
  if (!credentials) throw new SearchError(`AWS profile "${profile}" has no access key in ${file}.`, "credentials");
  return credentials;
}

// --- SigV4 signing (node:crypto only, so a copied extension needs no AWS SDK) --

const sha256Hex = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value, "utf8").digest();

function uriEncode(value: string, encodeSlash: boolean) {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return encodeSlash ? encoded : encoded.replace(/%2F/g, "/");
}

export function amzTimestamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export type SignInput = {
  method: string;
  url: string;
  body: string;
  headers?: Record<string, string>;
  service: string;
  region: string;
  credentials: AwsCredentials;
  date?: Date;
};

/** Returns the complete header set (input headers + host/date/token/authorization) for a SigV4-signed request. */
export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  const date = input.date || new Date();
  const amzDate = amzTimestamp(date);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers || {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name].replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalPath = url.pathname.split("/").map((segment) => uriEncode(decodeURIComponent(segment), true)).join("/") || "/";
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

// --- Request / response shaping ----------------------------------------------

export function buildSearchRequest(endpoint: string, input: SearchInput) {
  const plan = TURN_PLANS[input.kind];
  return {
    url: endpoint,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: { intent: input.intent },
      retrieval: plan.mode,
      sessionId: input.threadId,
      ...(plan.synthesize ? { synthesize: true, synthesisOptions: SYNTHESIS_OPTIONS } : {}),
      ...(plan.maxTurns ? { retrievalOptions: { maxTurns: plan.maxTurns } } : {}),
      maxResults: plan.maxResults,
    }),
  };
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

const requestIdText = (value: unknown) => (REQUEST_ID_PATTERN.test(text(value)) ? text(value) : "");

/** The API returns `source` either as an object or as a JSON-encoded string of that object. */
function parseSource(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeHit(fields: Record<string, unknown>, fallbackId: string): SessionHit {
  const sessionIdFromUrl = /^\/\?sessionId=([^&#]+)/.exec(text(fields.session_url ?? fields.sessionUrl))?.[1];
  const sessionId = text(fields.session_id ?? fields.sessionId) || (sessionIdFromUrl ? decodeURIComponent(sessionIdFromUrl) : "");
  const safeSessionId = SESSION_ID_PATTERN.test(sessionId) ? sessionId : "";
  const passageCount = Number(fields.passage_count ?? fields.passageCount);
  return {
    id: text(fields.id, fallbackId),
    title: text(fields.title, "Untitled session"),
    project: text(fields.project),
    startedAt: text(fields.started_at ?? fields.startedAt),
    sessionId: safeSessionId,
    sessionUrl: safeSessionId ? `/?sessionId=${encodeURIComponent(safeSessionId)}` : "",
    passageCount: Number.isFinite(passageCount) && passageCount >= 0 ? Math.floor(passageCount) : 0,
  };
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Keeps only the fields the panel shows; passages, vectors and anything unknown are dropped here. */
export function normalizeSearchResponse(raw: unknown, elapsedMs = 0, requestId = ""): SearchResult {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rawDocuments = Array.isArray(root.documents) ? root.documents : [];
  const documents = rawDocuments.flatMap((entry, index): SessionHit[] => {
    if (!entry || typeof entry !== "object") return [];
    const document = entry as Record<string, unknown>;
    const source = parseSource(document.source);
    const hit = normalizeHit(source, "");
    return [{ ...hit, id: text(document.documentId, hit.sessionId || `doc-${index}`) }];
  });
  // Observed shape (synthesize=true): `answer` is a Markdown string with `[n]` markers and
  // `citations` is `[{ documentIndex: 0 }, …]`; both are absent when nothing was retrieved.
  const citations = (Array.isArray(root.citations) ? root.citations : []).flatMap((entry): number[] => {
    const index = entry && typeof entry === "object" ? (entry as Record<string, unknown>).documentIndex : undefined;
    return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < documents.length ? [index] : [];
  });
  const rawUsage = root.usage && typeof root.usage === "object" ? root.usage as Record<string, unknown> : {};
  return {
    retrievalMode: root.retrievalMode === "AGENTIC" ? "AGENTIC" : "SIMPLE",
    documents,
    answer: text(root.answer).slice(0, MAX_ANSWER_CHARS),
    citations: [...new Set(citations)],
    usage: { planningTokens: count(rawUsage.planningTokens), synthesisTokens: count(rawUsage.synthesisTokens), totalTokens: count(rawUsage.totalTokens) },
    elapsedMs: count(elapsedMs),
    requestId: requestIdText(requestId),
  };
}

export function classifyUpstreamError(status: number, bodyText: string, config: Pick<SearchConfig, "profile" | "refreshHint">, requestId = ""): SearchError {
  const credentialSignals = /ExpiredToken|InvalidSignature|UnrecognizedClient|InvalidClientTokenId|security token/i;
  if (status === 403 || status === 401 || credentialSignals.test(bodyText)) {
    const hint = config.refreshHint ? ` Refresh them and retry: ${config.refreshHint}` : " Refresh them (for example with `ada credentials update … --once`) and retry.";
    return new SearchError(`AWS credentials for profile "${config.profile}" were rejected (HTTP ${status}) — they have probably expired.${hint}`, "credentials", requestId);
  }
  const snippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
  return new SearchError(`Search API answered HTTP ${status}${snippet ? `: ${snippet}` : ""}`, "upstream", requestId);
}

// --- Search client -----------------------------------------------------------

export type SearchClientOptions = {
  fetch?: typeof fetch;
  loadCredentials?: (profile: string) => Promise<AwsCredentials>;
  now?: () => Date;
  timeoutMs?: number;
};

export function createSearchClient(options: SearchClientOptions = {}) {
  const doFetch = options.fetch || globalThis.fetch;
  const loadCredentials = options.loadCredentials || ((profile: string) => loadProfileCredentials(profile));
  const now = options.now || (() => new Date());
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;

  return async function search(config: SearchConfig, input: SearchInput, signal?: AbortSignal): Promise<SearchResult> {
    if (!config.endpoint) throw new SearchError("No search endpoint is configured. Set PI_WEB_SESSION_SEARCH_ENDPOINT or fill in Settings → Session search.", "config");
    let endpoint: URL;
    try { endpoint = new URL(config.endpoint); } catch { throw new SearchError(`The configured search endpoint is not a valid URL: ${config.endpoint}`, "config"); }
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
      throw new SearchError("The search endpoint must use https:// (signed credentials are sent with every request).", "config");
    }

    const credentials = await loadCredentials(config.profile);
    const request = buildSearchRequest(endpoint.toString(), input);
    const headers = signRequest({ ...request, service: config.service, region: config.region, credentials, date: now() });
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const startedAt = Date.now();
    let response: Response;
    try {
      if (combined.aborted) throw combined.reason;
      response = await doFetch(request.url, { method: request.method, headers, body: request.body, signal: combined });
    } catch (error) {
      if (signal?.aborted) throw new SearchError("Cancelled.", "cancelled");
      if (timeout.aborted) throw new SearchError(`Timed out after ${Math.round(timeoutMs / 1000)}s.`, "timeout");
      throw new SearchError(`Could not reach the search API: ${error instanceof Error ? error.message : String(error)}`, "network");
    }
    const requestId = requestIdText(response.headers.get("x-amzn-requestid") ?? response.headers.get("x-amz-request-id") ?? "");
    const bodyText = await response.text();
    if (!response.ok) throw classifyUpstreamError(response.status, bodyText, config, requestId);
    let parsed: unknown;
    try { parsed = JSON.parse(bodyText); } catch { throw new SearchError("Search API returned a non-JSON body.", "upstream", requestId); }
    return normalizeSearchResponse(parsed, Date.now() - startedAt, requestId);
  };
}

// --- Thread store (server-side, per server user, like the notepad example) ----

export type Turn = {
  id: string;
  /** ISO timestamp of when the turn finished. */
  at: string;
  kind: TurnKind;
  query: string;
  result: SearchResult;
};

export type Thread = {
  /** Also the API conversation id (`sessionId`) every turn of the thread is sent under. */
  id: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function normalizeStoredResult(raw: unknown): SearchResult {
  const result = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const documents = (Array.isArray(result.documents) ? result.documents : []).flatMap((hit): SessionHit[] =>
    hit && typeof hit === "object" ? [normalizeHit(hit as Record<string, unknown>, "doc")] : []);
  const usage = result.usage && typeof result.usage === "object" ? result.usage as Record<string, unknown> : {};
  return {
    retrievalMode: result.retrievalMode === "AGENTIC" ? "AGENTIC" : "SIMPLE",
    documents,
    answer: text(result.answer).slice(0, MAX_ANSWER_CHARS),
    citations: [...new Set((Array.isArray(result.citations) ? result.citations : []).filter((index): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0 && index < documents.length))],
    usage: { planningTokens: count(usage.planningTokens), synthesisTokens: count(usage.synthesisTokens), totalTokens: count(usage.totalTokens) },
    elapsedMs: count(result.elapsedMs),
    requestId: requestIdText(result.requestId),
  };
}

/** Re-validates a stored turn so a hand-edited or stale file can never smuggle extra fields or markup into the panel. */
export function normalizeTurn(raw: unknown): Turn | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  const id = text(entry.id);
  const query = text(entry.query).slice(0, MAX_QUERY_CHARS);
  if (!id || !query || !ISO_DATE.test(text(entry.at)) || !entry.result || typeof entry.result !== "object") return undefined;
  // Legacy entries carried `mode` instead of `kind`: AGENTIC searches were answers, SIMPLE ones lists.
  const kind: TurnKind = entry.kind === "search" || (entry.kind === undefined && entry.mode === "SIMPLE") ? "search" : "ask";
  return { id, at: text(entry.at), kind, query, result: normalizeStoredResult(entry.result) };
}

export function normalizeThread(raw: unknown): Thread | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  const id = text(entry.id);
  if (!SESSION_ID_PATTERN.test(id)) return undefined;
  const turns = (Array.isArray(entry.turns) ? entry.turns : []).map(normalizeTurn).filter((turn): turn is Turn => Boolean(turn)).sort((a, b) => a.at.localeCompare(b.at));
  if (!turns.length) return undefined;
  const createdAt = ISO_DATE.test(text(entry.createdAt)) ? text(entry.createdAt) : turns[0].at;
  const updatedAt = ISO_DATE.test(text(entry.updatedAt)) ? text(entry.updatedAt) : turns[turns.length - 1].at;
  return { id, createdAt, updatedAt, turns };
}

/** Turns the previous flat "past searches" list into threads: entries sharing a conversation id form one thread, the rest become single-turn threads. */
export function migrateLegacyEntries(raw: unknown): Thread[] {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const entries = Array.isArray(root.entries) ? root.entries : [];
  const grouped = new Map<string, unknown[]>();
  for (const entry of entries) {
    const threadId = entry && typeof entry === "object" ? text((entry as Record<string, unknown>).threadId) : "";
    const key = SESSION_ID_PATTERN.test(threadId) ? threadId : randomUUID();
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return [...grouped.entries()]
    .map(([id, turns]) => normalizeThread({ id, turns }))
    .filter((thread): thread is Thread => Boolean(thread))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type ThreadStoreOptions = { legacyPath?: string; limit?: number };

export function createThreadStore(path: string, options: ThreadStoreOptions = {}) {
  const limit = options.limit ?? MAX_THREADS;
  let queue: Promise<unknown> = Promise.resolve();
  /** Serialises writes from concurrent sessions of this server; readers never wait. */
  const serial = <T>(task: () => Promise<T>) => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  async function readJson(file: string): Promise<unknown> {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; }
  }

  function normalizeAll(raw: unknown): Thread[] {
    const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const threads = (Array.isArray(root.threads) ? root.threads : []).map(normalizeThread).filter((thread): thread is Thread => Boolean(thread));
    return threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  async function save(threads: Thread[]) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 2, threads }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  let migration: Promise<Thread[]> | undefined;
  /** Newest first. The first load with no thread file seeds it from the legacy flat history, which is left untouched. */
  async function load(): Promise<Thread[]> {
    const own = await readJson(path);
    if (own !== undefined || !options.legacyPath) return normalizeAll(own);
    const legacy = await readJson(options.legacyPath);
    if (legacy === undefined) return [];
    // Not serialised through `serial` (load() runs inside it); concurrent migrations write identical content.
    migration ??= (async () => {
      const migrated = migrateLegacyEntries(legacy).slice(0, limit);
      await save(migrated);
      return migrated;
    })();
    return migration;
  }

  return {
    path,
    load,
    /** Appends a finished turn, creating the thread if needed, and moves the thread to the front; drops the oldest beyond the limit. */
    addTurn: (threadId: string, turn: Turn) => serial(async () => {
      const threads = await load();
      const existing = threads.find((thread) => thread.id === threadId);
      const thread: Thread = existing
        ? { ...existing, updatedAt: turn.at, turns: [...existing.turns.filter((candidate) => candidate.id !== turn.id), turn] }
        : { id: threadId, createdAt: turn.at, updatedAt: turn.at, turns: [turn] };
      const next = [thread, ...threads.filter((candidate) => candidate.id !== threadId)].slice(0, limit);
      await save(next);
      return next;
    }),
    remove: (threadId: string) => serial(async () => {
      const threads = (await load()).filter((thread) => thread.id !== threadId);
      await save(threads);
      return threads;
    }),
  };
}

export type ThreadStore = ReturnType<typeof createThreadStore>;

// --- Answer rendering (safe Markdown subset; the answer is model output, not trusted markup) --

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}

function renderInline(escaped: string, hits: SessionHit[]) {
  return escaped
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
    // Markdown links keep their text only: model output never becomes a clickable URL here.
    .replace(/\[([^\]\n]+)\]\((?:[^)\n]*)\)/g, "$1")
    // Citation markers `[n]` point at the numbered sessions below the answer.
    .replace(/\[(\d{1,2})\]/g, (marker, digits: string) => {
      const hit = hits[Number(digits) - 1];
      return hit ? `<sup class="ssxCite" title="${escapeHtml(hit.title)}">[${digits}]</sup>` : marker;
    });
}

/** Renders paragraphs, headings, bullet/numbered lists, fenced code, and inline emphasis/code/citations; everything else is text. */
export function renderAnswerMarkdown(markdown: string, hits: SessionHit[] = []): string {
  const lines = escapeHtml(markdown.replace(/\r\n?/g, "\n")).split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  const flushParagraph = () => { if (paragraph.length) { out.push(`<p>${renderInline(paragraph.join(" "), hits)}</p>`); paragraph = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((item) => `<li>${renderInline(item, hits)}</li>`).join("")}</${list.tag}>`); list = undefined; } };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^```/.test(line.trim())) {
      flushParagraph(); flushList();
      const code: string[] = [];
      while (++index < lines.length && !/^```/.test(lines[index].trim())) code.push(lines[index]);
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (heading) { flushParagraph(); flushList(); out.push(`<p><strong>${renderInline(heading[1], hits)}</strong></p>`); continue; }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet || numbered)![1]);
      continue;
    }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (list) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  return out.join("");
}

// --- Panel rendering ---------------------------------------------------------

export type SearchJob = {
  id: string;
  threadId: string;
  kind: TurnKind;
  query: string;
  startedAt: number;
  controller: AbortController;
  state: "running" | "done" | "error" | "cancelled";
  /** True while the originating render() is still waiting inline; its own return paints the result. */
  inlineWait?: boolean;
  error?: SearchError;
};

export type PanelState = {
  /** Thread shown in the timeline; also the API conversation id for the next turn. */
  threadId: string;
  threads: Thread[];
  /** Segmented-control position for the next turn. */
  kind: TurnKind;
  job?: SearchJob;
  tracesUrl?: string;
};

function formatDate(iso: string) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso || "unknown date";
  return new Date(time).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

function formatRelative(iso: string, now = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const panelStyles = `
<style>
.ssx { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: 10px; height: 100%; min-height: 320px; font-size: 13.5px; }
.ssx .ssxHead { display: flex; align-items: center; gap: 8px; padding: 0 0 8px; border-bottom: 1px solid var(--border); }
.ssx .ssxHeadMain { display: grid; gap: 2px; flex: 1 1 auto; min-width: 0; }
.ssx .ssxHeadTitle { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; line-height: 1.3; }
.ssx .ssxHeadMeta { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ssx .ssxThreads { position: relative; flex: none; }
.ssx .ssxThreads summary { display: inline-flex; align-items: center; gap: 5px; min-height: 30px; box-sizing: border-box; padding: 4px 9px; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); font-size: 12px; white-space: nowrap; cursor: pointer; list-style: none; }
.ssx .ssxThreads summary:hover { color: var(--text); border-color: var(--accent); }
.ssx .ssxThreads summary::-webkit-details-marker { display: none; }
.ssx .ssxThreads summary::after { content: "▾"; }
.ssx .ssxThreads[open] summary::after { content: "▴"; }
.ssx .ssxThreadList { position: absolute; z-index: 5; top: calc(100% + 4px); right: 0; display: grid; gap: 2px; width: min(360px, 80vw); max-height: 320px; margin: 0; padding: 6px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); box-shadow: 0 8px 24px rgba(0,0,0,.35); list-style: none; }
.ssx .ssxThreadList li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
.ssx .ssxThreadItem { display: grid; gap: 2px; width: 100%; height: auto; min-height: 0; padding: 6px 8px; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--text); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.ssx .ssxThreadItem:hover { background: color-mix(in srgb, var(--panel-2) 70%, transparent); }
.ssx .ssxThreadItem[aria-current="true"] { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.ssx .ssxThreadQ { display: block; max-height: 2.7em; line-height: 1.35; overflow: hidden; overflow-wrap: anywhere; }
.ssx .ssxThreadMeta { font-size: 10.5px; color: var(--muted); }
.ssx .ssxThreadDelete { height: auto; min-height: 0; padding: 4px 6px; border: 0; background: none; color: var(--muted); font: inherit; cursor: pointer; }
.ssx .ssxThreadDelete:hover { color: var(--danger); }
.ssx .ssxNew { flex: none; min-height: 30px; padding: 4px 10px; font-size: 12px; white-space: nowrap; }
.ssx .ssxTimeline { display: grid; align-content: start; min-height: 0; overflow: auto; padding: 2px 2px 4px; overscroll-behavior: contain; }
.ssx .ssxAnchor { display: block; width: 1px; height: 1px; opacity: 0; }
.ssx .ssxTurn { padding: 0 0 14px; }
.ssx .ssxTurn + .ssxTurn { padding-top: 14px; border-top: 1px solid var(--border); }
.ssx .ssxCard { display: grid; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--panel-2) 55%, transparent); overflow: hidden; }
.ssx .ssxAsked { display: grid; gap: 4px; padding: 10px 13px 11px; background: color-mix(in srgb, var(--accent) 12%, var(--panel-2)); border-bottom: 1px solid var(--border); }
.ssx .ssxLabel { display: flex; align-items: baseline; gap: 8px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.ssx .ssxLabel .ssxLabelText { text-transform: none; letter-spacing: 0; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.ssx .ssxWhen { font-weight: 400; letter-spacing: 0; text-transform: none; font-size: 10.5px; }
.ssx .ssxQuestion { margin: 0; width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; color: var(--text); }
.ssx .ssxReply { display: grid; gap: 10px; padding: 11px 13px 10px; line-height: 1.5; }
.ssx .ssxSection { display: grid; gap: 6px; }
.ssx .ssxAnswer p, .ssx .ssxAnswer pre { margin: 0 0 6px; }
.ssx .ssxAnswer > :last-child { margin-bottom: 0; }
.ssx .ssxAnswer ul, .ssx .ssxAnswer ol { margin: 0 0 6px; padding-left: 18px; }
.ssx .ssxAnswer pre { padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--panel-2) 80%, black); overflow: auto; font-size: 12px; }
.ssx .ssxAnswer code { font-size: 12.5px; }
.ssx .ssxCite { font-size: 10px; color: var(--accent); margin-left: 1px; }
.ssx ol, .ssx ul { margin: 0; padding: 0; }
.ssx .ssxSessions { display: grid; gap: 6px; list-style: none; }
.ssx .ssxHit { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--panel) 60%, transparent); }
.ssx .ssxIndex { grid-row: 1 / span 2; align-self: start; min-width: 18px; padding: 1px 5px; border-radius: 6px; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font-size: 11px; font-weight: 600; text-align: center; }
.ssx .ssxTitle { font-weight: 600; overflow-wrap: anywhere; }
.ssx .ssxMeta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11.5px; color: var(--muted); }
.ssx .ssxProject { color: var(--text); }
.ssx .ssxMeta a, .ssx .ssxFooter a { color: var(--accent); text-decoration: underline dotted; }
.ssx .ssxFooter { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding-top: 8px; border-top: 1px dashed var(--border); font-size: 11px; color: var(--muted); }
.ssx .ssxReqId { user-select: all; font-size: 10.5px; }
.ssx .ssxCopy { height: auto; min-height: 0; padding: 1px 7px; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--muted); font: inherit; font-size: 10.5px; cursor: pointer; }
.ssx .ssxCopy:hover { color: var(--text); border-color: var(--accent); }
.ssx .ssxStatus { display: flex; align-items: center; gap: 10px; color: var(--muted); outline: none; }
.ssx .ssxSpinner { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: ssxSpin 0.9s linear infinite; flex: none; }
@keyframes ssxSpin { to { transform: rotate(360deg); } }
.ssx .ssxCancel { margin-left: auto; min-height: 30px; padding: 4px 10px; font-size: 12px; }
.ssx .ssxError { color: var(--danger); overflow-wrap: anywhere; }
.ssx .ssxNone { color: var(--muted); }
.ssx .ssxEmpty { padding: 18px 8px; color: var(--muted); text-align: center; align-self: center; }
.ssx .ssxComposer { display: grid; gap: 8px; margin: 0; padding: 10px; border: 1px solid var(--border); border-radius: 14px; background: color-mix(in srgb, var(--panel-2) 82%, black); }
.ssx .ssxComposer:focus-within { border-color: var(--accent); }
.ssx .ssxComposer input[type="search"] { box-sizing: border-box; width: 100%; padding: 6px 4px; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 14px; outline: none; }
.ssx .ssxComposer input:disabled { opacity: .55; }
.ssx .ssxComposerRow { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ssx .ssxKind { display: inline-flex; padding: 2px; border: 1px solid var(--border); border-radius: 9px; font-size: 12px; }
.ssx .ssxKind label { position: relative; display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 7px; color: var(--muted); cursor: pointer; }
.ssx .ssxKind input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
.ssx .ssxKind label:has(input:checked) { background: color-mix(in srgb, var(--accent) 22%, var(--panel-2)); color: var(--text); font-weight: 600; }
.ssx .ssxKind label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 1px; }
.ssx .ssxKind label:has(input:disabled) { cursor: default; opacity: .6; }
.ssx .ssxSend { min-height: 32px; padding: 5px 14px; }
.ssx .ssxSend:disabled { opacity: .55; cursor: default; }
</style>`;

const KIND_HELP: Record<TurnKind, string> = {
  ask: "Ask: the API answers your question from your sessions and cites them as [n] (agentic retrieval, usually 30–90 s).",
  search: "Search: lists the sessions that match, without an answer (plain retrieval, a few seconds).",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Sticky header: the thread's title (its first question), when it started, its turn count, the thread switcher, and "+ New thread". */
function renderThreadHeader(state: PanelState, thread: Thread | undefined, now: number) {
  const running = state.job?.state === "running";
  const liveQuery = state.job && state.job.threadId === state.threadId && state.job.state !== "done" ? state.job.query : "";
  const title = thread?.turns[0]?.query || liveQuery;
  const startedAt = thread?.createdAt || (liveQuery && state.job ? new Date(state.job.startedAt).toISOString() : "");
  const turnCount = (thread?.turns.length ?? 0) + (liveQuery ? 1 : 0);
  const meta = title
    ? `started ${escapeHtml(formatRelative(startedAt, now))} · ${plural(turnCount, "turn")}`
    : "nothing asked yet";
  const items = state.threads.map((candidate) => {
    const payload = escapeHtml(JSON.stringify({ id: candidate.id }));
    const first = candidate.turns[0];
    return `<li>
      <button type="button" class="ssxThreadItem" data-web-action="thread-open" data-web-payload='${payload}'${candidate.id === state.threadId ? ' aria-current="true"' : ""} title="${escapeHtml(first.query)}">
        <span class="ssxThreadQ">${escapeHtml(first.query)}</span>
        <span class="ssxThreadMeta">${escapeHtml(formatRelative(candidate.updatedAt, now))} · ${plural(candidate.turns.length, "turn")}</span>
      </button>
      <button type="button" class="ssxThreadDelete" data-web-action="thread-delete" data-web-payload='${payload}' aria-label="Delete thread" title="Delete thread">×</button>
    </li>`;
  });
  const switcher = items.length
    ? `<details class="ssxThreads"><summary aria-label="Switch thread" title="${plural(items.length, "saved thread")}">Switch thread</summary><ol class="ssxThreadList" aria-label="Thread list">${items.join("")}</ol></details>`
    : "";
  return `<header class="ssxHead" aria-label="Current thread">
    <div class="ssxHeadMain">
      <div class="ssxHeadTitle" title="${escapeHtml(title || "New thread")}">${title ? escapeHtml(title) : "New thread"}</div>
      <div class="ssxHeadMeta"${startedAt ? ` title="started ${escapeHtml(formatDate(startedAt))}"` : ""}>${meta}</div>
    </div>
    ${switcher}
    <button class="webPanelButton ssxNew" type="button" data-web-action="new" title="Start a new thread: the next question will not see this thread's earlier turns"${running ? " disabled" : ""}>+ New thread</button>
  </header>`;
}

function renderHit(hit: SessionHit, index: number) {
  const meta = [
    hit.project ? `<span class="ssxProject">${escapeHtml(hit.project)}</span>` : "",
    `<span>${escapeHtml(formatDate(hit.startedAt))}</span>`,
    `<span>${plural(hit.passageCount, "passage")}</span>`,
    hit.sessionUrl ? `<a href="${escapeHtml(hit.sessionUrl)}">Open session</a>` : `<span>no session link</span>`,
  ].filter(Boolean).join("<span aria-hidden=\"true\">·</span>");
  return `<li class="ssxHit"><span class="ssxIndex" aria-label="Session ${index + 1}">${index + 1}</span><div class="ssxTitle">${escapeHtml(hit.title)}</div><div class="ssxMeta">${meta}</div></li>`;
}

function renderRequestId(requestId: string, tracesUrl: string | undefined) {
  if (!requestId) return "";
  const id = escapeHtml(requestId);
  const traces = tracesLink(tracesUrl || "", requestId);
  // Panel HTML cannot run <script>, but inline handlers on trusted extension markup do; the id is
  // also user-select:all so one click selects it when the clipboard is unavailable.
  return `<span>request <code class="ssxReqId" title="Request id">${id}</code></span>`
    + `<button type="button" class="ssxCopy" data-copy="${id}" aria-label="Copy request id" onclick="navigator.clipboard&&navigator.clipboard.writeText(this.dataset.copy).then(()=>{this.textContent='Copied';setTimeout(()=>{this.textContent='Copy'},1200)})">Copy</button>`
    + (traces ? `<a href="${escapeHtml(traces)}" target="_blank" rel="noopener noreferrer">Open traces</a>` : "");
}

/** The reply half of a finished turn: an "Answer" section (Ask) or a `Results for "…"` heading (Search), the numbered sessions, and the footer. */
function renderReply(turn: Turn, tracesUrl: string | undefined) {
  const { result } = turn;
  const isAsk = turn.kind === "ask";
  const answer = isAsk
    ? `<section class="ssxSection" aria-label="Answer"><div class="ssxLabel">Answer</div>${result.answer ? `<div class="ssxAnswer">${renderAnswerMarkdown(result.answer, result.documents)}</div>` : `<div class="ssxNone">The API returned no answer for this question.</div>`}</section>`
    : "";
  const sessionsLabel = isAsk
    ? `Matching sessions (${result.documents.length})`
    : `Results for <span class="ssxLabelText">“${escapeHtml(turn.query)}”</span> (${result.documents.length})`;
  const sessions = `<section class="ssxSection" aria-label="${isAsk ? "Matching sessions" : "Results"}"><div class="ssxLabel ssxSessionsLabel">${sessionsLabel}</div>${result.documents.length ? `<ol class="ssxSessions">${result.documents.map(renderHit).join("")}</ol>` : `<div class="ssxNone">No sessions matched.</div>`}</section>`;
  const usage = result.usage;
  const footer = [
    `<span>${TURN_PLANS[turn.kind].label} · ${result.retrievalMode}</span>`,
    `<span>${formatSeconds(result.elapsedMs)}</span>`,
    `<span>tokens ${usage.totalTokens}${usage.planningTokens || usage.synthesisTokens ? ` (planning ${usage.planningTokens}, synthesis ${usage.synthesisTokens})` : ""}</span>`,
    renderRequestId(result.requestId, tracesUrl),
  ].filter(Boolean).join('<span aria-hidden="true">·</span>');
  return `<div class="ssxReply" role="group" aria-label="${isAsk ? "Answer" : "Results"}">${answer}${sessions}<div class="ssxFooter">${footer}</div></div>`;
}

/** The "You asked" header of a turn card: label, relative time, then the full question (wrapping, never clipped). */
function renderAsked(query: string, at: string, now: number) {
  return `<div class="ssxAsked" role="group" aria-label="You asked"><div class="ssxLabel">You asked<span class="ssxWhen" title="${escapeHtml(formatDate(at))}">${escapeHtml(formatRelative(at, now))}</span></div><p class="ssxQuestion">${escapeHtml(query)}</p></div>`;
}

function renderTurn(index: number, asked: string, reply: string, live = false) {
  return `<article class="ssxTurn${live ? " ssxLive" : ""}" aria-label="Turn ${index + 1}"><div class="ssxCard">${asked}${reply}</div></article>`;
}

function renderJob(job: SearchJob, index: number, tracesUrl: string | undefined, now: number) {
  let body = "";
  if (job.state === "running") {
    const payload = escapeHtml(JSON.stringify({ jobId: job.id }));
    // No periodic repaint while running: the host blanks the panel on every update(), which would flash.
    body = `<div class="ssxStatus" role="status" tabindex="-1" autofocus>
      <span class="ssxSpinner" aria-hidden="true"></span>
      <span>${job.kind === "ask" ? "Thinking…" : "Searching…"}${job.kind === "ask" ? " <span class=\"ssxThreadMeta\">answers usually take 30–90 s</span>" : ""}</span>
      <button class="webPanelButton ssxCancel" type="button" data-web-action="cancel" data-web-payload='${payload}'>Cancel</button>
    </div>`;
  } else if (job.state === "error" && job.error) {
    body = `<div class="ssxError" role="alert">${escapeHtml(job.error.message)}</div>${job.error.requestId ? `<div class="ssxFooter">${renderRequestId(job.error.requestId, tracesUrl)}</div>` : ""}`;
  } else {
    body = `<div class="ssxStatus" role="status">Cancelled.</div>`;
  }
  return renderTurn(index, renderAsked(job.query, new Date(job.startedAt).toISOString(), now), `<div class="ssxReply">${body}</div>`, true);
}

function renderComposer(state: PanelState) {
  const running = state.job?.state === "running";
  const lock = running ? " disabled" : "";
  const radio = (kind: TurnKind) => `<label title="${escapeHtml(KIND_HELP[kind])}"><input type="radio" name="kind" value="${kind}"${state.kind === kind ? " checked" : ""}${lock}>${TURN_PLANS[kind].label}</label>`;
  return `<form class="ssxComposer" role="search" aria-label="Composer">
    <input type="search" name="query" placeholder="Ask a question or search your sessions…" maxlength="${MAX_QUERY_CHARS}" aria-label="Ask a question or search your sessions" autocomplete="off"${running ? " disabled" : " autofocus"}>
    <div class="ssxComposerRow">
      <div class="ssxKind" role="radiogroup" aria-label="Mode" title="Ask answers your question with citations; Search only lists matching sessions.">${radio("ask")}${radio("search")}</div>
      <button class="webPanelButton ssxSend" type="submit" data-web-action="send"${lock}>Send</button>
    </div>
  </form>`;
}

export function renderPanel(state: PanelState, now = Date.now()): PiWebPanelView {
  const thread = state.threads.find((candidate) => candidate.id === state.threadId);
  const turns = (thread?.turns ?? []).map((turn, index) => renderTurn(index, renderAsked(turn.query, turn.at, now), renderReply(turn, state.tracesUrl)));
  const job = state.job && state.job.threadId === state.threadId && state.job.state !== "done" ? renderJob(state.job, turns.length, state.tracesUrl, now) : "";
  const items = [...turns, job].filter(Boolean);
  // Oldest turn first. Panel HTML cannot run <script>, so a 1×1 image at the end scrolls the timeline when it
  // loads, so the newest turn's "You asked" header sits at the top of the view (not the bottom of its answer).
  // The scroll repeats briefly because the host may still be animating the panel open when the image loads.
  const anchor = `<img class="ssxAnchor" alt="" aria-hidden="true" src="${SCROLL_ANCHOR_GIF}" onload="var t=this.parentElement,f=function(){var l=t.querySelector('.ssxTurn:last-of-type');if(l)t.scrollTop+=l.getBoundingClientRect().top-t.getBoundingClientRect().top-2};f();setTimeout(f,250);setTimeout(f,700)">`;
  const timeline = items.length
    ? items.join("") + anchor
    : `<div class="ssxEmpty">Ask a question about your sessions — follow-ups in this thread keep the context.</div>`;
  return {
    title: "Session search",
    html: `${panelStyles}<div class="ssx">${renderThreadHeader(state, thread, now)}<div class="ssxTimeline" aria-label="Conversation" aria-live="polite">${timeline}</div>${renderComposer(state)}</div>`,
  };
}

// --- Extension wiring --------------------------------------------------------

function firstField(event: PiWebPanelEvent | undefined, name: string) {
  const value = event?.fields?.[name];
  return (Array.isArray(value) ? value[0] : value) || "";
}

function payloadString(event: PiWebPanelEvent | undefined, name: string) {
  const payload = event?.payload;
  const value = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" ? value : "";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type SessionSearchExtensionOptions = SearchClientOptions & {
  env?: NodeJS.ProcessEnv;
  /** Overrides the thread file location (defaults to threadsFilePath(env)); disables legacy migration. */
  historyFile?: string;
  /** Thread ids, sent as the API's `sessionId`; injectable for tests. */
  newThreadId?: () => string;
};

export function createSessionSearchExtension(options: SessionSearchExtensionOptions = {}) {
  const search = createSearchClient(options);
  const envConfig = configFromEnv(options.env);
  const store = options.historyFile
    ? createThreadStore(options.historyFile)
    : createThreadStore(threadsFilePath(options.env), { legacyPath: legacyHistoryFilePath(options.env) });
  const newThreadId = options.newThreadId || (() => randomUUID());

  return function sessionSearch(pi: PiWebExtensionAPI) {
    pi.on("session_start", async (_event, ctx: PiWebExtensionContext) => {
      const web = ctx.ui.web;
      const capabilities = web?.capabilities;
      if (!(capabilities?.apiVersion === 1 && capabilities.slots.includes("panel") && capabilities.kinds.includes("rendered") && typeof web.contribute === "function" && typeof web.update === "function")) {
        ctx.ui.notify("Session search requires a newer pi-web contribution API.", "warning");
        return;
      }

      let settingsAvailable = true;
      try {
        await web.registerSettings({
          id: SETTINGS_ID,
          title: "Session search",
          schemaVersion: 1,
          fields: [
            { key: "endpoint", type: "text", label: "Search endpoint URL", description: "Full https:// POST URL of the AI Search application that indexes your sessions.", default: envConfig.endpoint },
            { key: "profile", type: "text", label: "AWS profile", description: "Profile in ~/.aws/credentials used to SigV4-sign requests (server side only).", default: envConfig.profile },
            { key: "region", type: "text", label: "Signing region", default: envConfig.region },
            { key: "service", type: "text", label: "Signing service name", default: envConfig.service },
            { key: "refreshHint", type: "text", label: "Credential refresh command", description: "Shown verbatim when the API rejects expired credentials.", default: envConfig.refreshHint },
            { key: "tracesUrl", type: "text", label: "Traces URL", description: "\"Open traces\" link for each answer; {requestId} is substituted (appended when absent). Leave empty to hide the link.", default: envConfig.tracesUrl },
          ],
        });
      } catch {
        settingsAvailable = false;
      }

      async function currentConfig(): Promise<SearchConfig> {
        if (!settingsAvailable) return envConfig;
        try { return normalizeConfig((await web.getSettings(SETTINGS_ID)).values, envConfig); }
        catch { return envConfig; }
      }

      const state: PanelState = { threadId: "", threads: [], kind: "ask", tracesUrl: envConfig.tracesUrl };
      /** A thread the user started with "New thread" in this session; kept current even while it has no turns. */
      let freshThreadId = "";
      let jobCounter = 0;

      async function refreshThreads(threads?: Thread[]) {
        try { state.threads = threads ?? await store.load(); } catch { /* threads are best effort */ }
        try { state.tracesUrl = (await currentConfig()).tracesUrl; } catch { /* keep the previous value */ }
        // Never resurrect a stale view: without a running turn or an explicit fresh thread, show the latest thread.
        const current = state.threads.some((thread) => thread.id === state.threadId);
        const keepFresh = state.threadId && state.threadId === freshThreadId;
        const keepRunning = state.job?.state === "running" && state.job.threadId === state.threadId;
        if (!current && !keepFresh && !keepRunning) state.threadId = state.threads[0]?.id ?? startFreshThread();
      }

      function startFreshThread() {
        freshThreadId = newThreadId();
        return freshThreadId;
      }

      function startJob(query: string, kind: TurnKind, threadId: string): SearchJob {
        const job: SearchJob = { id: `job-${++jobCounter}`, threadId, kind, query, startedAt: Date.now(), controller: new AbortController(), state: "running" };
        state.job = job;
        void (async () => {
          try {
            const result = await search(await currentConfig(), { intent: query, kind, threadId }, job.controller.signal);
            if (!job.controller.signal.aborted) {
              // Persist the turn before the job reads as done, so the view that paints it already lists it.
              const turn: Turn = { id: randomUUID(), at: new Date().toISOString(), kind, query, result };
              try { await refreshThreads(await store.addTurn(threadId, turn)); } catch { /* best effort */ }
              if (freshThreadId === threadId) freshThreadId = "";
            }
            job.state = job.controller.signal.aborted ? "cancelled" : "done";
          } catch (error) {
            if (job.controller.signal.aborted) job.state = "cancelled";
            else { job.state = "error"; job.error = error instanceof SearchError ? error : new SearchError(error instanceof Error ? error.message : String(error), "network"); }
          }
          // Skip the repaint when the result is painted by the originating render() or the cancel action already repainted.
          if (state.job === job && job.state !== "cancelled" && !job.inlineWait) web.update(PANEL_KEY);
        })();
        return job;
      }

      web.contribute(PANEL_KEY, {
        slot: "panel",
        kind: "rendered",
        title: "Session search",
        label: "Session search",
        icon: "session-search",
        async render(event) {
          const action = event?.action || "view";
          await refreshThreads();
          if (action === "send") {
            // In-flight guard: one turn at a time; a second submit while running changes nothing.
            if (state.job?.state === "running") return renderPanel(state);
            const query = firstField(event, "query").trim().slice(0, MAX_QUERY_CHARS);
            const kind: TurnKind = firstField(event, "kind") === "search" ? "search" : "ask";
            state.kind = kind;
            if (!query) return renderPanel(state);
            const job = startJob(query, kind, state.threadId);
            job.inlineWait = true;
            const deadline = Date.now() + INLINE_WAIT_MS;
            while (job.state === "running" && Date.now() < deadline) await sleep(25);
            job.inlineWait = false;
            return renderPanel(state);
          }
          if (action === "cancel") {
            const jobId = payloadString(event, "jobId");
            if (state.job && (!jobId || state.job.id === jobId) && state.job.state === "running") {
              state.job.controller.abort();
              state.job.state = "cancelled";
            }
            return renderPanel(state);
          }
          if (action === "new") {
            if (state.job?.state === "running") { state.job.controller.abort(); state.job.state = "cancelled"; }
            state.job = undefined;
            state.threadId = startFreshThread();
            return renderPanel(state);
          }
          if (action === "thread-open") {
            const id = payloadString(event, "id");
            if (state.threads.some((thread) => thread.id === id)) state.threadId = id;
            return renderPanel(state);
          }
          if (action === "thread-delete") {
            const id = payloadString(event, "id");
            if (id) {
              if (state.job?.threadId === id && state.job.state === "running") { state.job.controller.abort(); state.job.state = "cancelled"; }
              try { await refreshThreads(await store.remove(id)); } catch { /* best effort */ }
              if (state.threadId === id) state.threadId = state.threads[0]?.id ?? startFreshThread();
            }
            return renderPanel(state);
          }
          return renderPanel(state);
        },
      });

      web.contribute(`${PANEL_KEY}-launcher`, { slot: "fab", kind: "static", title: "Session search", label: "Session search", icon: "session-search", opens: PANEL_KEY });
      if (capabilities.slots.includes("header-action") && capabilities.effects.includes("open-panel")) {
        web.contribute(`${PANEL_KEY}-header`, {
          slot: "header-action",
          kind: "rendered",
          title: "Session search",
          label: "Session search",
          icon: "session-search",
          render: () => ({ effects: [{ type: "open-panel", key: PANEL_KEY }] }),
        });
      }
    });

    pi.on("session_shutdown", (_event, ctx: PiWebExtensionContext) => {
      const web = ctx.ui.web;
      if (typeof web?.contribute !== "function") return;
      web.contribute(`${PANEL_KEY}-header`, undefined);
      web.contribute(`${PANEL_KEY}-launcher`, undefined);
      web.contribute(PANEL_KEY, undefined);
    });
  };
}

export default createSessionSearchExtension();
