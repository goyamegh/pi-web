/**
 * session-search — installable pi-web extension (opt-in)
 *
 * Adds a "Session search" panel that queries an AI Search application over your
 * indexed pi-web session history and links each hit back to its session.
 *
 * The browser never sees AWS credentials or raw search passages: the panel is
 * server-rendered HTML, the upstream request is SigV4-signed here on the
 * server from a named profile in ~/.aws/credentials, and only the compact
 * per-session fields (title, project, date, session link, counts, usage) are
 * returned to the page.
 *
 * Configuration lives in pi-web Settings ("Session search"), seeded from
 * environment variables on first use:
 *   PI_WEB_SESSION_SEARCH_ENDPOINT      full POST URL of the search API (required)
 *   PI_WEB_SESSION_SEARCH_PROFILE       AWS credentials profile (default: "default")
 *   PI_WEB_SESSION_SEARCH_REGION        signing region (default: "us-east-1")
 *   PI_WEB_SESSION_SEARCH_SERVICE       signing service name (default: "aisearch")
 *   PI_WEB_SESSION_SEARCH_REFRESH_HINT  command shown when credentials expire (optional)
 */

import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PiWebExtensionAPI, PiWebExtensionContext, PiWebPanelEvent, PiWebPanelView } from "@ashwin-pc/pi-web/extensions";

export const PANEL_KEY = "session-search";
export const SETTINGS_ID = "session-search.settings";
export const SEARCH_TIMEOUT_MS = 180_000;
/** SIMPLE searches usually answer well inside this window; longer ones render a spinner and finish via update(). */
const INLINE_WAIT_MS = 1_500;
const MAX_QUERY_CHARS = 500;
const MAX_RESULTS = 5;

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
  usage: SearchUsage;
  elapsedMs: number;
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

export function buildSearchRequest(endpoint: string, intent: string, mode: RetrievalMode, maxResults = MAX_RESULTS) {
  return {
    url: endpoint,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: { intent }, retrieval: mode, maxResults }),
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
  const rawUsage = root.usage && typeof root.usage === "object" ? root.usage as Record<string, unknown> : {};
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    retrievalMode: root.retrievalMode === "AGENTIC" ? "AGENTIC" : "SIMPLE",
    documents,
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

  return async function search(config: SearchConfig, intent: string, mode: RetrievalMode, signal?: AbortSignal): Promise<SearchResult> {
    if (!config.endpoint) throw new SearchError("No search endpoint is configured. Set PI_WEB_SESSION_SEARCH_ENDPOINT or fill in Settings → Session search.", "config");
    let endpoint: URL;
    try { endpoint = new URL(config.endpoint); } catch { throw new SearchError(`The configured search endpoint is not a valid URL: ${config.endpoint}`, "config"); }
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
      throw new SearchError("The search endpoint must use https:// (signed credentials are sent with every request).", "config");
    }

    const credentials = await loadCredentials(config.profile);
    const request = buildSearchRequest(endpoint.toString(), intent, mode);
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

export type PanelState = { job?: SearchJob; query: string; mode: RetrievalMode; notice?: string };

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}

function formatDate(iso: string) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso || "unknown date";
  return new Date(time).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

const panelStyles = `
<style>
.ssx { display: grid; gap: 12px; font-size: 13.5px; }
.ssx form { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; margin: 0; }
.ssx input[type="search"], .ssx select { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; background: color-mix(in srgb, var(--panel-2) 82%, black); color: var(--text); font: inherit; }
.ssx input:focus, .ssx select:focus { outline: none; border-color: var(--accent); }
.ssx .ssxStatus { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px dashed var(--border); border-radius: 10px; color: var(--muted); outline: none; }
.ssx .ssxSpinner { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: ssxSpin 0.9s linear infinite; flex: none; }
@keyframes ssxSpin { to { transform: rotate(360deg); } }
.ssx .ssxError { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--danger) 60%, var(--border)); border-radius: 10px; color: var(--danger); overflow-wrap: anywhere; }
.ssx .ssxEmpty { padding: 18px 4px; color: var(--muted); text-align: center; }
.ssx ol { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.ssx li { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--panel-2) 55%, transparent); }
.ssx .ssxTitle { font-weight: 600; overflow-wrap: anywhere; }
.ssx .ssxMeta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11.5px; color: var(--muted); }
.ssx .ssxProject { color: var(--text); }
.ssx .ssxMeta a { color: var(--accent); text-decoration: underline dotted; }
.ssx .ssxUsage { font-size: 11.5px; color: var(--muted); }
.ssx .ssxCancel { margin-left: auto; }
</style>`;

function renderForm(state: PanelState) {
  const running = state.job?.state === "running";
  return `<form data-web-action="search" role="search">
    <input type="search" name="query" placeholder="Search your sessions…" maxlength="${MAX_QUERY_CHARS}" value="${escapeHtml(state.query)}" aria-label="Session search query"${running ? "" : " autofocus"}>
    <select name="mode" aria-label="Retrieval mode">
      <option value="SIMPLE"${state.mode === "SIMPLE" ? " selected" : ""}>SIMPLE</option>
      <option value="AGENTIC"${state.mode === "AGENTIC" ? " selected" : ""}>AGENTIC</option>
    </select>
    <button class="webPanelButton" type="submit" data-web-action="search">Search</button>
  </form>`;
}

function renderHit(hit: SessionHit) {
  const meta = [
    hit.project ? `<span class="ssxProject">${escapeHtml(hit.project)}</span>` : "",
    `<span>${escapeHtml(formatDate(hit.startedAt))}</span>`,
    `<span>${hit.passageCount} passage${hit.passageCount === 1 ? "" : "s"}</span>`,
    hit.sessionUrl ? `<a href="${escapeHtml(hit.sessionUrl)}">Open session</a>` : `<span>no session link</span>`,
  ].filter(Boolean).join("<span aria-hidden=\"true\">·</span>");
  return `<li class="ssxHit"><div class="ssxTitle">${escapeHtml(hit.title)}</div><div class="ssxMeta">${meta}</div></li>`;
}

export function renderPanel(state: PanelState): PiWebPanelView {
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
    body = result.documents.length
      ? `<ol class="ssxResults">${result.documents.map(renderHit).join("")}</ol><div class="ssxUsage" role="status">${escapeHtml(usage)}</div>`
      : `<div class="ssxEmpty" role="status">No sessions matched “${escapeHtml(job.query)}”.</div><div class="ssxUsage">${escapeHtml(usage)}</div>`;
  } else {
    body = `<div class="ssxEmpty">${escapeHtml(state.notice || "Search the indexed history of your pi-web sessions. SIMPLE answers in about a second; AGENTIC plans a deeper retrieval.")}</div>`;
  }
  return { title: "Session search", html: `${panelStyles}<div class="ssx">${renderForm(state)}${body}</div>` };
}

// --- Extension wiring --------------------------------------------------------

function firstField(event: PiWebPanelEvent | undefined, name: string) {
  const value = event?.fields?.[name];
  return (Array.isArray(value) ? value[0] : value) || "";
}

function payloadJobId(event?: PiWebPanelEvent) {
  const payload = event?.payload;
  return payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).jobId === "string" ? (payload as Record<string, unknown>).jobId as string : "";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type SessionSearchExtensionOptions = SearchClientOptions & { env?: NodeJS.ProcessEnv };

export function createSessionSearchExtension(options: SessionSearchExtensionOptions = {}) {
  const search = createSearchClient(options);
  const envConfig = configFromEnv(options.env);

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

      const state: PanelState = { query: "", mode: "SIMPLE" };
      let jobCounter = 0;

      function startJob(query: string, mode: RetrievalMode): SearchJob {
        state.job?.controller.abort();
        const job: SearchJob = { id: `job-${++jobCounter}`, query, mode, startedAt: Date.now(), controller: new AbortController(), state: "running" };
        state.job = job;
        void (async () => {
          try {
            job.result = await search(await currentConfig(), query, mode, job.controller.signal);
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
        icon: "search",
        async render(event) {
          const action = event?.action || "view";
          if (action === "search") {
            const query = firstField(event, "query").trim().slice(0, MAX_QUERY_CHARS);
            const mode: RetrievalMode = firstField(event, "mode") === "AGENTIC" ? "AGENTIC" : "SIMPLE";
            state.query = query;
            state.mode = mode;
            if (!query) { state.job = undefined; return renderPanel({ ...state, notice: "Type a question about your sessions first." }); }
            const job = startJob(query, mode);
            job.inlineWait = true;
            const deadline = Date.now() + INLINE_WAIT_MS;
            while (job.state === "running" && Date.now() < deadline) await sleep(25);
            job.inlineWait = false;
            return renderPanel(state);
          }
          if (action === "cancel") {
            const jobId = payloadJobId(event);
            if (state.job && (!jobId || state.job.id === jobId) && state.job.state === "running") {
              state.job.controller.abort();
              state.job.state = "cancelled";
            }
            return renderPanel(state);
          }
          return renderPanel(state);
        },
      });

      web.contribute(`${PANEL_KEY}-launcher`, { slot: "fab", kind: "static", title: "Session search", label: "Session search", icon: "search", opens: PANEL_KEY });
      if (capabilities.slots.includes("header-action") && capabilities.effects.includes("open-panel")) {
        web.contribute(`${PANEL_KEY}-header`, {
          slot: "header-action",
          kind: "rendered",
          title: "Session search",
          label: "Session search",
          icon: "search",
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
