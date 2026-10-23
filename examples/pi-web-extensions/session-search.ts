/**
 * session-search — installable pi-web extension (opt-in)
 *
 * Adds a "Session search" panel that queries an AI Search application over your
 * indexed pi-web session history and links each hit back to its session.
 *
 * The browser never sees AWS credentials or raw search passages: the panel is
 * server-rendered HTML, the upstream request is SigV4-signed here on the
 * server from a named profile in ~/.aws/credentials, and only the compact
 * per-session fields (title, project, date, session link, counts, usage) plus
 * the API's synthesized answer and citations are returned to the page.
 *
 * Past searches (question, mode, normalized results, answer) are kept in a
 * small JSON file owned by the server user — like the notepad example — so a
 * previous answer can be reopened without another upstream call.
 *
 * Configuration lives in pi-web Settings ("Session search"), seeded from
 * environment variables on first use:
 *   PI_WEB_SESSION_SEARCH_ENDPOINT      full POST URL of the search API (required)
 *   PI_WEB_SESSION_SEARCH_PROFILE       AWS credentials profile (default: "default")
 *   PI_WEB_SESSION_SEARCH_REGION        signing region (default: "us-east-1")
 *   PI_WEB_SESSION_SEARCH_SERVICE       signing service name (default: "aisearch")
 *   PI_WEB_SESSION_SEARCH_REFRESH_HINT  command shown when credentials expire (optional)
 *   PI_WEB_SESSION_SEARCH_HISTORY_FILE  where past searches are stored
 *                                       (default: PI_WEB_HOME/session-search-history.json
 *                                        or ~/.pi/agent/session-search-history.json)
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PiWebExtensionAPI, PiWebExtensionContext, PiWebPanelEvent, PiWebPanelView } from "@ashwin-pc/pi-web/extensions";

export const PANEL_KEY = "session-search";
export const SETTINGS_ID = "session-search.settings";
export const SEARCH_TIMEOUT_MS = 180_000;
export const MAX_HISTORY_ENTRIES = 50;
/** SIMPLE searches usually answer well inside this window; longer ones render a spinner and finish via update(). */
const INLINE_WAIT_MS = 1_500;
const MAX_QUERY_CHARS = 500;
const MAX_ANSWER_CHARS = 8_000;
const MAX_RESULTS = 5;
const SYNTHESIS_OPTIONS = { maxTokens: 600, temperature: 0, responseFormat: "MARKDOWN" } as const;

export type RetrievalMode = "SIMPLE" | "AGENTIC";

export type SearchConfig = {
  endpoint: string;
  profile: string;
  region: string;
  service: string;
  refreshHint: string;
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
};

/** What the request asks the API for, beyond the question itself. */
export type SearchOptions = {
  synthesize?: boolean;
  /** API conversation id: turns that share it let the API resolve references like "that session". */
  threadId?: string;
  maxResults?: number;
};

export class SearchError extends Error {
  constructor(message: string, readonly kind: "config" | "credentials" | "upstream" | "timeout" | "cancelled" | "network") {
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
  };
}

export function normalizeConfig(values: Record<string, unknown> | undefined, fallback: SearchConfig): SearchConfig {
  const text = (key: keyof SearchConfig) => {
    const value = values?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : fallback[key];
  };
  return { endpoint: text("endpoint"), profile: text("profile"), region: text("region"), service: text("service"), refreshHint: text("refreshHint") };
}

export function historyFilePath(env: NodeJS.ProcessEnv = process.env) {
  if (env.PI_WEB_SESSION_SEARCH_HISTORY_FILE) return env.PI_WEB_SESSION_SEARCH_HISTORY_FILE;
  return env.PI_WEB_HOME ? join(env.PI_WEB_HOME, "session-search-history.json") : join(homedir(), ".pi", "agent", "session-search-history.json");
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

export function buildSearchRequest(endpoint: string, intent: string, mode: RetrievalMode, options: SearchOptions = {}) {
  return {
    url: endpoint,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: { intent },
      retrieval: mode,
      ...(options.threadId ? { sessionId: options.threadId } : {}),
      ...(options.synthesize ? { synthesize: true, synthesisOptions: SYNTHESIS_OPTIONS } : {}),
      maxResults: options.maxResults ?? MAX_RESULTS,
    }),
  };
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/;

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** The API returns `source` either as an object or as a JSON-encoded string of that object. */
function parseSource(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Keeps only the fields the panel shows; passages, vectors and anything unknown are dropped here. */
export function normalizeSearchResponse(raw: unknown, elapsedMs = 0): SearchResult {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rawDocuments = Array.isArray(root.documents) ? root.documents : [];
  const documents = rawDocuments.flatMap((entry, index): SessionHit[] => {
    if (!entry || typeof entry !== "object") return [];
    const document = entry as Record<string, unknown>;
    const source = parseSource(document.source);
    const sessionIdFromUrl = /^\/\?sessionId=([^&#]+)/.exec(text(source.session_url))?.[1];
    const sessionId = text(source.session_id) || (sessionIdFromUrl ? decodeURIComponent(sessionIdFromUrl) : "");
    const safeSessionId = SESSION_ID_PATTERN.test(sessionId) ? sessionId : "";
    const passageCount = Number(source.passage_count);
    return [{
      id: text(document.documentId, sessionId || `doc-${index}`),
      title: text(source.title, "Untitled session"),
      project: text(source.project),
      startedAt: text(source.started_at),
      sessionId: safeSessionId,
      sessionUrl: safeSessionId ? `/?sessionId=${encodeURIComponent(safeSessionId)}` : "",
      passageCount: Number.isFinite(passageCount) && passageCount >= 0 ? Math.floor(passageCount) : 0,
    }];
  });
  // Observed shape (synthesize=true): `answer` is a Markdown string with `[n]` markers and
  // `citations` is `[{ documentIndex: 0 }, …]`; both are absent when nothing was retrieved.
  const citations = (Array.isArray(root.citations) ? root.citations : []).flatMap((entry): number[] => {
    const index = entry && typeof entry === "object" ? (entry as Record<string, unknown>).documentIndex : undefined;
    return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < documents.length ? [index] : [];
  });
  const rawUsage = root.usage && typeof root.usage === "object" ? root.usage as Record<string, unknown> : {};
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    retrievalMode: root.retrievalMode === "AGENTIC" ? "AGENTIC" : "SIMPLE",
    documents,
    answer: text(root.answer).slice(0, MAX_ANSWER_CHARS),
    citations: [...new Set(citations)],
    usage: { planningTokens: count(rawUsage.planningTokens), synthesisTokens: count(rawUsage.synthesisTokens), totalTokens: count(rawUsage.totalTokens) },
    elapsedMs,
  };
}

export function classifyUpstreamError(status: number, bodyText: string, config: Pick<SearchConfig, "profile" | "refreshHint">): SearchError {
  const credentialSignals = /ExpiredToken|InvalidSignature|UnrecognizedClient|InvalidClientTokenId|security token/i;
  if (status === 403 || status === 401 || credentialSignals.test(bodyText)) {
    const hint = config.refreshHint ? ` Refresh them and retry: ${config.refreshHint}` : " Refresh them (for example with `ada credentials update … --once`) and retry.";
    return new SearchError(`AWS credentials for profile "${config.profile}" were rejected (HTTP ${status}) — they have probably expired.${hint}`, "credentials");
  }
  const snippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
  return new SearchError(`Search API answered HTTP ${status}${snippet ? `: ${snippet}` : ""}`, "upstream");
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

  return async function search(config: SearchConfig, intent: string, mode: RetrievalMode, signal?: AbortSignal, searchOptions: SearchOptions = {}): Promise<SearchResult> {
    if (!config.endpoint) throw new SearchError("No search endpoint is configured. Set PI_WEB_SESSION_SEARCH_ENDPOINT or fill in Settings → Session search.", "config");
    let endpoint: URL;
    try { endpoint = new URL(config.endpoint); } catch { throw new SearchError(`The configured search endpoint is not a valid URL: ${config.endpoint}`, "config"); }
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
      throw new SearchError("The search endpoint must use https:// (signed credentials are sent with every request).", "config");
    }

    const credentials = await loadCredentials(config.profile);
    const request = buildSearchRequest(endpoint.toString(), intent, mode, searchOptions);
    const headers = signRequest({ ...request, service: config.service, region: config.region, credentials, date: now() });
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const startedAt = Date.now();
    let response: Response;
    try {
      if (combined.aborted) throw combined.reason;
      response = await doFetch(request.url, { method: request.method, headers, body: request.body, signal: combined });
    } catch (error) {
      if (signal?.aborted) throw new SearchError("Search cancelled.", "cancelled");
      if (timeout.aborted) throw new SearchError(`Search timed out after ${Math.round(timeoutMs / 1000)}s.`, "timeout");
      throw new SearchError(`Could not reach the search API: ${error instanceof Error ? error.message : String(error)}`, "network");
    }
    const bodyText = await response.text();
    if (!response.ok) throw classifyUpstreamError(response.status, bodyText, config);
    let parsed: unknown;
    try { parsed = JSON.parse(bodyText); } catch { throw new SearchError("Search API returned a non-JSON body.", "upstream"); }
    return normalizeSearchResponse(parsed, Date.now() - startedAt);
  };
}

// --- Search history (server-side, per server user, like the notepad example) --

export type HistoryEntry = {
  id: string;
  /** ISO timestamp of when the search finished. */
  at: string;
  query: string;
  mode: RetrievalMode;
  synthesize: boolean;
  /** API conversation id this turn was asked under; turns sharing it form a conversation. */
  threadId?: string;
  result: SearchResult;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Re-validates a stored entry so a hand-edited or stale file can never smuggle extra fields or markup into the panel. */
export function normalizeHistoryEntry(raw: unknown): HistoryEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  const result = entry.result && typeof entry.result === "object" ? entry.result as Record<string, unknown> : undefined;
  const id = text(entry.id);
  const query = text(entry.query).slice(0, MAX_QUERY_CHARS);
  if (!id || !query || !result || !ISO_DATE.test(text(entry.at))) return undefined;
  const documents = (Array.isArray(result.documents) ? result.documents : []).flatMap((hit): SessionHit[] => {
    if (!hit || typeof hit !== "object") return [];
    const h = hit as Record<string, unknown>;
    const sessionId = SESSION_ID_PATTERN.test(text(h.sessionId)) ? text(h.sessionId) : "";
    const passageCount = Number(h.passageCount);
    return [{
      id: text(h.id, "doc"), title: text(h.title, "Untitled session"), project: text(h.project), startedAt: text(h.startedAt),
      sessionId, sessionUrl: sessionId ? `/?sessionId=${encodeURIComponent(sessionId)}` : "",
      passageCount: Number.isFinite(passageCount) && passageCount >= 0 ? Math.floor(passageCount) : 0,
    }];
  });
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const usage = result.usage && typeof result.usage === "object" ? result.usage as Record<string, unknown> : {};
  const threadId = text(entry.threadId);
  return {
    id, at: text(entry.at), query,
    mode: entry.mode === "AGENTIC" ? "AGENTIC" : "SIMPLE",
    synthesize: entry.synthesize === true,
    ...(SESSION_ID_PATTERN.test(threadId) ? { threadId } : {}),
    result: {
      retrievalMode: result.retrievalMode === "AGENTIC" ? "AGENTIC" : "SIMPLE",
      documents,
      answer: text(result.answer).slice(0, MAX_ANSWER_CHARS),
      citations: [...new Set((Array.isArray(result.citations) ? result.citations : []).filter((index): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0 && index < documents.length))],
      usage: { planningTokens: count(usage.planningTokens), synthesisTokens: count(usage.synthesisTokens), totalTokens: count(usage.totalTokens) },
      elapsedMs: count(result.elapsedMs),
    },
  };
}

export function createHistoryStore(path: string, limit = MAX_HISTORY_ENTRIES) {
  let queue: Promise<unknown> = Promise.resolve();
  /** Serialises writes from concurrent sessions of this server; readers never wait. */
  const serial = <T>(task: () => Promise<T>) => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  async function load(): Promise<HistoryEntry[]> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(path, "utf8")); } catch { return []; }
    const entries = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).entries) ? (raw as Record<string, unknown>).entries as unknown[] : [];
    return entries.map(normalizeHistoryEntry).filter((entry): entry is HistoryEntry => Boolean(entry)).slice(0, limit);
  }

  async function save(entries: HistoryEntry[]) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  return {
    path,
    load,
    /** Newest first; drops the oldest entries beyond the limit. */
    add: (entry: HistoryEntry) => serial(async () => {
      const entries = [entry, ...(await load()).filter((existing) => existing.id !== entry.id)].slice(0, limit);
      await save(entries);
      return entries;
    }),
    remove: (id: string) => serial(async () => {
      const entries = (await load()).filter((entry) => entry.id !== id);
      await save(entries);
      return entries;
    }),
  };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;

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
    // Citation markers `[n]` point at the numbered results below the answer.
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
  query: string;
  mode: RetrievalMode;
  startedAt: number;
  controller: AbortController;
  state: "running" | "done" | "error" | "cancelled";
  /** True while the originating render() is still waiting inline; its own return paints the result. */
  inlineWait?: boolean;
  result?: SearchResult;
  error?: SearchError;
};

export type Thread = { id: string; turns: HistoryEntry[] };

export type PanelState = {
  job?: SearchJob;
  query: string;
  mode: RetrievalMode;
  /** "Synthesize answer" toggle; only honoured for AGENTIC searches. */
  synthesize?: boolean;
  /** "Continue conversation": the next search reuses the thread's API conversation id. */
  continueThread?: boolean;
  thread?: Thread;
  history?: HistoryEntry[];
  /** History entry whose results are currently shown (restored without a request). */
  activeHistoryId?: string;
  notice?: string;
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
.ssx { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; font-size: 13.5px; }
.ssx.ssxWithHistory { grid-template-columns: minmax(120px, 150px) minmax(0, 1fr); }
.ssx .ssxMain { display: grid; gap: 12px; min-width: 0; }
.ssx form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin: 0; }
.ssx .ssxOptions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 12px; color: var(--muted); }
.ssx .ssxOptions label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.ssx .ssxOptions label:has(:disabled) { cursor: default; opacity: .6; }
.ssx form:has(select[name="mode"] option[value="SIMPLE"]:checked) .ssxSynth { display: none; }
.ssx input[type="search"], .ssx select { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; background: color-mix(in srgb, var(--panel-2) 82%, black); color: var(--text); font: inherit; }
.ssx select { width: auto; height: auto; min-height: 0; padding: 5px 6px; font-size: 12px; }
.ssx input:focus, .ssx select:focus { outline: none; border-color: var(--accent); }
.ssx .ssxStatus { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px dashed var(--border); border-radius: 10px; color: var(--muted); outline: none; }
.ssx .ssxSpinner { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: ssxSpin 0.9s linear infinite; flex: none; }
@keyframes ssxSpin { to { transform: rotate(360deg); } }
.ssx .ssxError { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--danger) 60%, var(--border)); border-radius: 10px; color: var(--danger); overflow-wrap: anywhere; }
.ssx .ssxEmpty { padding: 18px 4px; color: var(--muted); text-align: center; }
.ssx ol, .ssx ul { margin: 0; padding: 0; }
.ssx .ssxResults { display: grid; gap: 6px; list-style: none; }
.ssx .ssxHit { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--panel-2) 55%, transparent); }
.ssx .ssxIndex { grid-row: 1 / span 2; align-self: start; min-width: 18px; padding: 1px 5px; border-radius: 6px; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font-size: 11px; font-weight: 600; text-align: center; }
.ssx .ssxTitle { font-weight: 600; overflow-wrap: anywhere; }
.ssx .ssxMeta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11.5px; color: var(--muted); }
.ssx .ssxProject { color: var(--text); }
.ssx .ssxMeta a { color: var(--accent); text-decoration: underline dotted; }
.ssx .ssxUsage { font-size: 11.5px; color: var(--muted); }
.ssx .ssxCancel { margin-left: auto; }
.ssx .ssxAnswer { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border)); border-radius: 12px; background: color-mix(in srgb, var(--accent) 7%, transparent); line-height: 1.5; }
.ssx .ssxAnswerLabel { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); }
.ssx .ssxAnswerBody p, .ssx .ssxAnswerBody pre { margin: 0 0 6px; }
.ssx .ssxAnswerBody ul, .ssx .ssxAnswerBody ol { margin: 0 0 6px; padding-left: 18px; }
.ssx .ssxAnswerBody pre { padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--panel-2) 80%, black); overflow: auto; font-size: 12px; }
.ssx .ssxAnswerBody code { font-size: 12.5px; }
.ssx .ssxCite { font-size: 10px; color: var(--accent); margin-left: 1px; }
.ssx .ssxCitations { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11.5px; color: var(--muted); }
.ssx .ssxCitations a { color: var(--accent); text-decoration: underline dotted; }
.ssx .ssxThread { display: grid; gap: 4px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; font-size: 12px; }
.ssx .ssxThreadLabel { font-size: 11px; font-weight: 600; color: var(--muted); }
.ssx .ssxTurn { display: grid; gap: 1px; padding: 4px 0; border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
.ssx .ssxTurn:first-of-type { border-top: 0; }
.ssx .ssxTurnQ { font-weight: 600; overflow-wrap: anywhere; }
.ssx .ssxTurnA { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ssx .ssxHistory { display: grid; gap: 6px; align-content: start; min-width: 0; padding-right: 10px; border-right: 1px solid var(--border); }
.ssx .ssxHistoryLabel { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.ssx .ssxHistoryList { display: grid; gap: 4px; list-style: none; }
.ssx .ssxHistoryList li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
.ssx .ssxHistoryItem { display: grid; gap: 2px; width: 100%; height: auto; min-height: 0; padding: 6px 8px; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--text); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.ssx .ssxHistoryItem:hover { background: color-mix(in srgb, var(--panel-2) 70%, transparent); }
.ssx .ssxHistoryItem[aria-current="true"] { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.ssx .ssxHistoryQ { display: block; max-height: 2.7em; line-height: 1.35; overflow: hidden; overflow-wrap: anywhere; }
.ssx .ssxHistoryMeta { font-size: 10.5px; color: var(--muted); }
.ssx .ssxHistoryDelete { height: auto; min-height: 0; padding: 4px 6px; border: 0; background: none; color: var(--muted); font: inherit; cursor: pointer; opacity: 0; }
.ssx .ssxHistoryList li:hover .ssxHistoryDelete, .ssx .ssxHistoryDelete:focus-visible { opacity: 1; }
</style>`;

function renderForm(state: PanelState) {
  const running = state.job?.state === "running";
  const synthesize = state.synthesize !== false;
  const canContinue = Boolean(state.thread) || state.job?.state === "done";
  const lock = running ? " disabled" : "";
  // While a request is in flight the mode/synthesis controls are locked; hidden copies keep a
  // superseding search on the same settings instead of silently changing them.
  return `<form role="search">
    <input type="search" name="query" placeholder="Search your sessions…" maxlength="${MAX_QUERY_CHARS}" value="${escapeHtml(state.query)}" aria-label="Session search query"${running ? "" : " autofocus"}>
    <button class="webPanelButton" type="submit" data-web-action="search">Search</button>
    <div class="ssxOptions">
      <label>Mode <select name="mode" aria-label="Retrieval mode"${lock}>
        <option value="SIMPLE"${state.mode === "SIMPLE" ? " selected" : ""}>SIMPLE</option>
        <option value="AGENTIC"${state.mode === "AGENTIC" ? " selected" : ""}>AGENTIC</option>
      </select></label>
      <label class="ssxSynth"><input type="checkbox" name="synthesize" value="1"${synthesize ? " checked" : ""}${lock}> Synthesize answer</label>
      ${canContinue ? `<label class="ssxContinue"><input type="checkbox" name="continue" value="1"${state.continueThread ? " checked" : ""}${lock}> Continue conversation</label>` : ""}
      ${running ? `<input type="hidden" name="mode" value="${state.mode}">${synthesize ? `<input type="hidden" name="synthesize" value="1">` : ""}${state.continueThread ? `<input type="hidden" name="continue" value="1">` : ""}` : ""}
    </div>
  </form>`;
}

function renderHit(hit: SessionHit, index: number) {
  const meta = [
    hit.project ? `<span class="ssxProject">${escapeHtml(hit.project)}</span>` : "",
    `<span>${escapeHtml(formatDate(hit.startedAt))}</span>`,
    `<span>${hit.passageCount} passage${hit.passageCount === 1 ? "" : "s"}</span>`,
    hit.sessionUrl ? `<a href="${escapeHtml(hit.sessionUrl)}">Open session</a>` : `<span>no session link</span>`,
  ].filter(Boolean).join("<span aria-hidden=\"true\">·</span>");
  return `<li class="ssxHit"><span class="ssxIndex" aria-label="Result ${index + 1}">${index + 1}</span><div class="ssxTitle">${escapeHtml(hit.title)}</div><div class="ssxMeta">${meta}</div></li>`;
}

function renderAnswer(result: SearchResult) {
  if (!result.answer) return "";
  const citations = result.citations.map((index) => {
    const hit = result.documents[index];
    const label = `[${index + 1}] ${escapeHtml(hit.title)}`;
    return hit.sessionUrl ? `<a href="${escapeHtml(hit.sessionUrl)}">${label}</a>` : `<span>${label}</span>`;
  });
  return `<section class="ssxAnswer" aria-label="Synthesized answer">
    <div class="ssxAnswerLabel">Answer</div>
    <div class="ssxAnswerBody">${renderAnswerMarkdown(result.answer, result.documents)}</div>
    ${citations.length ? `<div class="ssxCitations"><span>Sources:</span>${citations.join("")}</div>` : ""}
  </section>`;
}

function renderThread(thread: Thread | undefined) {
  if (!thread || thread.turns.length < 2) return "";
  const turns = thread.turns.map((turn) => {
    const answer = turn.result.answer.replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
    return `<div class="ssxTurn"><div class="ssxTurnQ">${escapeHtml(turn.query)}</div><div class="ssxTurnA">${answer ? escapeHtml(answer.slice(0, 160)) : `${turn.result.documents.length} result${turn.result.documents.length === 1 ? "" : "s"}`}</div></div>`;
  });
  return `<section class="ssxThread" aria-label="Conversation turns"><div class="ssxThreadLabel">Conversation · ${thread.turns.length} turn${thread.turns.length === 1 ? "" : "s"}</div>${turns.join("")}</section>`;
}

function renderHistory(history: HistoryEntry[], activeId: string | undefined, now: number) {
  if (!history.length) return "";
  const items = history.map((entry) => {
    const payload = escapeHtml(JSON.stringify({ id: entry.id }));
    return `<li>
      <button type="button" class="ssxHistoryItem" data-web-action="history-open" data-web-payload='${payload}'${entry.id === activeId ? ' aria-current="true"' : ""} title="${escapeHtml(entry.query)}">
        <span class="ssxHistoryQ">${escapeHtml(entry.query)}</span>
        <span class="ssxHistoryMeta">${entry.mode} · ${escapeHtml(formatRelative(entry.at, now))}</span>
      </button>
      <button type="button" class="ssxHistoryDelete" data-web-action="history-delete" data-web-payload='${payload}' aria-label="Remove from history" title="Remove from history">×</button>
    </li>`;
  });
  return `<aside class="ssxHistory" aria-label="Past searches">
    <button class="webPanelButton" type="button" data-web-action="new">New search</button>
    <div class="ssxHistoryLabel">Past searches</div>
    <ol class="ssxHistoryList">${items.join("")}</ol>
  </aside>`;
}

export function renderPanel(state: PanelState, now = Date.now()): PiWebPanelView {
  const job = state.job;
  let body = "";
  if (job?.state === "running") {
    const payload = escapeHtml(JSON.stringify({ jobId: job.id }));
    body = `<div class="ssxStatus" role="status" tabindex="-1" autofocus>
      <span class="ssxSpinner" aria-hidden="true"></span>
      <span>Searching (${job.mode})… ${job.mode === "AGENTIC" ? "agentic retrieval can take 1–2 minutes." : ""}</span>
      <button class="webPanelButton ssxCancel" type="button" data-web-action="cancel" data-web-payload='${payload}'>Cancel</button>
    </div>`;
  } else if (job?.state === "error" && job.error) {
    body = `<div class="ssxError" role="alert">${escapeHtml(job.error.message)}</div>`;
  } else if (job?.state === "cancelled") {
    body = `<div class="ssxEmpty" role="status">Search cancelled.</div>`;
  } else if (job?.state === "done" && job.result) {
    const { result } = job;
    const usage = `${result.retrievalMode} · ${result.documents.length} result${result.documents.length === 1 ? "" : "s"} in ${formatSeconds(result.elapsedMs)} · tokens: planning ${result.usage.planningTokens}, synthesis ${result.usage.synthesisTokens}, total ${result.usage.totalTokens}`;
    body = renderThread(state.thread) + renderAnswer(result) + (result.documents.length
      ? `<ol class="ssxResults">${result.documents.map(renderHit).join("")}</ol><div class="ssxUsage" role="status">${escapeHtml(usage)}</div>`
      : `<div class="ssxEmpty" role="status">No sessions matched “${escapeHtml(job.query)}”.</div><div class="ssxUsage">${escapeHtml(usage)}</div>`);
  } else {
    body = `<div class="ssxEmpty">${escapeHtml(state.notice || "Search the indexed history of your pi-web sessions. SIMPLE answers in about a second; AGENTIC plans a deeper retrieval and can synthesize an answer.")}</div>`;
  }
  const history = renderHistory(state.history ?? [], state.activeHistoryId, now);
  return {
    title: "Session search",
    html: `${panelStyles}<div class="ssx${history ? " ssxWithHistory" : ""}">${history}<div class="ssxMain">${renderForm(state)}${body}</div></div>`,
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
  /** Overrides the history file location (defaults to historyFilePath(env)). */
  historyFile?: string;
  /** Conversation ids sent as the API's `sessionId`; injectable for tests. */
  newThreadId?: () => string;
};

export function createSessionSearchExtension(options: SessionSearchExtensionOptions = {}) {
  const search = createSearchClient(options);
  const envConfig = configFromEnv(options.env);
  const history = createHistoryStore(options.historyFile || historyFilePath(options.env));
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

      const state: PanelState = { query: "", mode: "SIMPLE", synthesize: true, history: [] };
      let jobCounter = 0;

      async function refreshHistory(entries?: HistoryEntry[]) {
        try { state.history = entries ?? await history.load(); } catch { /* history is best effort */ }
      }

      function startJob(query: string, mode: RetrievalMode, synthesize: boolean, threadId: string): SearchJob {
        state.job?.controller.abort();
        const job: SearchJob = { id: `job-${++jobCounter}`, query, mode, startedAt: Date.now(), controller: new AbortController(), state: "running" };
        state.job = job;
        state.activeHistoryId = undefined;
        void (async () => {
          try {
            const result = await search(await currentConfig(), query, mode, job.controller.signal, { synthesize, threadId });
            if (!job.controller.signal.aborted) {
              // Record the turn before the job reads as done, so the view that paints the
              // result (inline or via update()) already lists it under past searches.
              const entry: HistoryEntry = { id: randomUUID(), at: new Date().toISOString(), query, mode, synthesize, threadId, result };
              if (state.thread?.id === threadId) state.thread.turns.push(entry);
              if (state.job === job) state.activeHistoryId = entry.id;
              try { await refreshHistory(await history.add(entry)); } catch { /* history is best effort */ }
            }
            job.result = result;
            job.state = job.controller.signal.aborted ? "cancelled" : "done";
          } catch (error) {
            if (job.controller.signal.aborted) job.state = "cancelled";
            else { job.state = "error"; job.error = error instanceof SearchError ? error : new SearchError(error instanceof Error ? error.message : String(error), "network"); }
          }
          // Skip the repaint when the result is painted by the originating render(), when the cancel
          // action already repainted, or when a newer search superseded this job.
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
          if (action === "search") {
            const query = firstField(event, "query").trim().slice(0, MAX_QUERY_CHARS);
            const mode: RetrievalMode = firstField(event, "mode") === "AGENTIC" ? "AGENTIC" : "SIMPLE";
            const synthesize = firstField(event, "synthesize") === "1";
            const continueThread = firstField(event, "continue") === "1";
            state.query = query;
            state.mode = mode;
            state.synthesize = synthesize;
            state.continueThread = continueThread;
            if (!query) { state.job = undefined; state.activeHistoryId = undefined; return renderPanel({ ...state, notice: "Type a question about your sessions first." }); }
            // Every search carries an API conversation id so it can be continued later; "Continue
            // conversation" reuses the current one and the API resolves references to earlier turns.
            if (!(continueThread && state.thread)) state.thread = { id: newThreadId(), turns: [] };
            const job = startJob(query, mode, mode === "AGENTIC" && synthesize, state.thread.id);
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
            state.job?.controller.abort();
            state.job = undefined;
            state.query = "";
            state.thread = undefined;
            state.continueThread = false;
            state.activeHistoryId = undefined;
            await refreshHistory();
            return renderPanel(state);
          }
          if (action === "history-open") {
            await refreshHistory();
            const entry = state.history?.find((candidate) => candidate.id === payloadString(event, "id"));
            if (entry) {
              if (state.job?.state === "running") state.job.controller.abort();
              state.query = entry.query;
              state.mode = entry.mode;
              state.synthesize = entry.mode === "AGENTIC" ? entry.synthesize : state.synthesize;
              state.activeHistoryId = entry.id;
              state.job = { id: `history-${entry.id}`, query: entry.query, mode: entry.mode, startedAt: Date.parse(entry.at), controller: new AbortController(), state: "done", result: entry.result };
              if (entry.threadId) {
                // The thread is restored so the user can pick it up; "Continue conversation" is only
                // pre-ticked when the entry was already part of a multi-turn conversation.
                const turns = (state.history ?? []).filter((turn) => turn.threadId === entry.threadId).sort((a, b) => a.at.localeCompare(b.at));
                state.thread = { id: entry.threadId, turns };
                state.continueThread = turns.length > 1;
              } else {
                state.thread = undefined;
                state.continueThread = false;
              }
            }
            return renderPanel(state);
          }
          if (action === "history-delete") {
            const id = payloadString(event, "id");
            if (id) {
              try { await refreshHistory(await history.remove(id)); } catch { /* best effort */ }
              if (state.activeHistoryId === id) { state.activeHistoryId = undefined; state.job = undefined; }
              if (state.thread) state.thread.turns = state.thread.turns.filter((turn) => turn.id !== id);
            }
            return renderPanel(state);
          }
          await refreshHistory();
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
