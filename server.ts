import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createMockHarness } from "./server/mock.js";
import { resolveBundledExtensionPaths, resolvePiWebExtensionPaths } from "./server/extensions.js";
import { createSessionUiStateStore, defaultSessionUiState } from "./server/sessionUiState.js";
import { createSettingsStore } from "./server/settings.js";
import { findArtifactFile, isValidArtifactPath } from "./server/shared/artifacts.js";
import { assertDirectory, createDirectory, listDirectories } from "./server/shared/fsList.js";
import { git, gitCommitDetails, gitCwdFromRepoParam, gitDiff, gitLog, gitStatus, gitSync, isGitRepo, listGitRepos, readGitImage } from "./server/shared/git.js";
import type { PiWebSession } from "./server/types.js";
import {
  type AgentAdapter,
  type AgentKind,
  ccProjectDir,
  ccSessionFile,
  createClaudeCodeAdapter,
  listCCSessions,
  loadCCMessages,
  wrapPiSession,
} from "./server/agent/index.js";
import type { SlashCommandDto } from "./server/session/dto.js";
import { SessionActivity } from "./server/session/activity.js";
import { RealtimeHub, SessionUnreadTracker } from "./server/realtime.js";
import { createWebUiBridge } from "./server/extensions/webUi.js";
import { LocalSessionService, SessionServiceError } from "./server/session/service.js";
import {
  conversationTreeForSession,
  getSessionSlashCommands,
  isAssistantAbortedMessage,
  isAssistantFailureMessage,
  isIncompleteToolResultMessage,
  messageEntryRefs,
  projectSessionState,
  sessionIsRetrying,
  sessionStats,
  simplifyMessage,
  simplifyModel,
  textFromContent,
} from "./server/session/projection.js";

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const distDir = join(appDir, "dist");
const staticDir = distDir;

const isDev = process.env.PI_WEB_DEV === "1" || process.env.NODE_ENV === "development";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const token = process.env.PI_WEB_TOKEN || "";
let piCwd = resolve(process.env.PI_WEB_CWD || process.cwd());
const knownCwds = new Set<string>([piCwd]);

const webUiContextFile = join(appDir, "contexts", "web-ui.md");
const bundledExtensionsDir = join(appDir, ".pi", "extensions");
const noSession = process.env.PI_WEB_NO_SESSION === "1";
const mockMode = process.env.PI_WEB_MOCK === "1";
const execFileAsync = promisify(execFile);

type WebSlashCommandInfo = SlashCommandDto;

const webSlashCommands: WebSlashCommandInfo[] = [
  { name: "help", description: "Show slash command help", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "commands", description: "List available web, extension, prompt, and skill commands", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "reload", description: "Reload pi resources, extensions, skills, prompts, and models", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "model", description: "List models or switch with /model <provider/model-id>", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "models", description: "List available models", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "thinking", description: "Show or set reasoning level", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "new", description: "Start a new session", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "clear", description: "Release this session to history and start fresh in the same tab", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "compact", description: "Compact conversation context; optional instructions after the command", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "abort", description: "Stop the current response", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "stop", description: "Stop the current response", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
  { name: "logout", description: "Clear the web UI token in this browser", source: "web", sourceInfo: { path: "<pi-web>", source: "pi-web", scope: "temporary", origin: "top-level" } },
];

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function sendJson(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function pipeReadStream(res: ServerResponse, file: string) {
  const stream = createReadStream(file);
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function unauthorized(res: ServerResponse) {
  sendJson(res, 401, { ok: false, error: "Unauthorized" });
}

function requestToken(req: IncomingMessage): string {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  return url.searchParams.get("token") || "";
}

function isAuthorized(req: IncomingMessage): boolean {
  return !token || requestToken(req) === token;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

function serveArtifact(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const artifactPath = decodeURIComponent(url.pathname.slice("/api/artifacts/".length));
  if (!isValidArtifactPath(artifactPath)) return sendJson(res, 400, { ok: false, error: "Invalid artifact path" });

  const artifactRoots = new Set([piCwd, ...knownCwds]);
  const resolvedFile = findArtifactFile(artifactRoots, artifactPath);
  if (!resolvedFile) return sendJson(res, 404, { ok: false, error: "Artifact not found" });

  res.writeHead(200, {
    "content-type": contentTypes[extname(resolvedFile).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
  });
  pipeReadStream(res, resolvedFile);
}

function cacheControlFor(relative: string): string {
  const name = relative.replace(/^\/+/, "");
  const base = name.split("/").pop() || name;
  // The service-worker script, its registration shim, and the workbox runtime
  // MUST never be cached: if iOS Safari serves a stale /sw.js it never detects
  // a new service worker, so the old SW keeps serving the old precached bundle
  // forever (refresh appears to do nothing). Force revalidation every load.
  if (base === "sw.js" || base === "registerSW.js" || /^workbox-[A-Za-z0-9_-]+\.js$/.test(base)) {
    return "no-cache, no-store, must-revalidate";
  }
  // HTML / the app shell is served network-first and must stay fresh so it
  // always references the current hashed asset names.
  if (base === "index.html" || base.endsWith(".html") || base === "manifest.webmanifest") {
    return "no-cache";
  }
  // Content-hashed build assets are immutable — safe to cache aggressively.
  if (name.startsWith("assets/") && /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(base)) {
    return "public, max-age=31536000, immutable";
  }
  // Everything else (icons, svg, etc.): revalidate to stay safe.
  return "no-cache";
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = resolve(staticDir, relative);

  if (!file.startsWith(staticDir) || !existsSync(file)) {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }

  res.writeHead(200, {
    "content-type": contentTypes[extname(file)] || "application/octet-stream",
    "cache-control": cacheControlFor(relative),
  });
  pipeReadStream(res, file);
}

function hasUserMessages(value: PiWebSession) {
  return value.messages.some((message: any) => message?.role === "user");
}

async function ensurePiWebStorage(cwd = piCwd) {
  const webDir = join(cwd, ".pi", "web");
  await mkdir(webDir, { recursive: true });
  const ignoreFile = join(webDir, ".gitignore");
  if (!existsSync(ignoreFile)) await writeFile(ignoreFile, "*\n");
}

async function setPiCwd(path: string) {
  piCwd = await assertDirectory(path, piCwd);
  knownCwds.add(piCwd);
  await ensurePiWebStorage(piCwd);
}

type RepoPrInfo = { number: number; url: string; title?: string };
type RepoInfo = {
  ok: true;
  cwd: string;
  isRepo: boolean;
  root?: string;
  rootName?: string;
  cwdRel?: string;
  branch?: string;
  upstream?: string;
  shortHash?: string;
  hash?: string;
  pr?: RepoPrInfo | null;
};

const repoInfoCache = new Map<string, { value: RepoInfo; expiresAt: number }>();
const repoInfoCacheTtlMs = 4_000;

async function detectGithubPr(cwd: string, branch: string): Promise<RepoPrInfo | null> {
  if (!branch) return null;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", branch, "--json", "number,url,title"],
      { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    const data = JSON.parse(stdout) as { number?: number; url?: string; title?: string };
    if (typeof data.number === "number" && typeof data.url === "string") {
      return { number: data.number, url: data.url, title: data.title };
    }
    return null;
  } catch {
    return null;
  }
}

async function getRepoInfo(cwd: string): Promise<RepoInfo> {
  const now = Date.now();
  const cached = repoInfoCache.get(cwd);
  if (cached && cached.expiresAt > now) return cached.value;

  const base: RepoInfo = { ok: true, cwd, isRepo: false };
  if (!(await isGitRepo(cwd))) {
    repoInfoCache.set(cwd, { value: base, expiresAt: now + repoInfoCacheTtlMs });
    return base;
  }

  const [rootRes, branchRes, upstreamRes, hashRes, shortHashRes] = await Promise.all([
    git(["rev-parse", "--show-toplevel"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["branch", "--show-current"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["rev-parse", "HEAD"], 15_000, cwd).catch(() => ({ stdout: "" })),
    git(["rev-parse", "--short", "HEAD"], 15_000, cwd).catch(() => ({ stdout: "" })),
  ]);

  const root = rootRes.stdout.trim();
  const branch = branchRes.stdout.trim();
  const rel = root ? relative(root, cwd) : "";

  // Resolve PR info synchronously so the first response already contains the
  // hyperlink. `gh pr view` has a 5s timeout and is cached for repoInfoCacheTtlMs.
  const pr = branch ? await detectGithubPr(cwd, branch) : null;

  const info: RepoInfo = {
    ok: true,
    cwd,
    isRepo: true,
    root: root || undefined,
    rootName: root ? basename(root) : undefined,
    cwdRel: rel.startsWith("..") ? "" : rel,
    branch: branch || undefined,
    upstream: upstreamRes.stdout.trim() || undefined,
    hash: hashRes.stdout.trim() || undefined,
    shortHash: shortHashRes.stdout.trim() || undefined,
    pr,
  };

  repoInfoCache.set(cwd, { value: info, expiresAt: Date.now() + repoInfoCacheTtlMs });
  return info;
}
async function requestCwdFromSessionId(sessionId: string | null) {
  if (!sessionId) return piCwd;
  if (sessionId === session.sessionId) return sessionCwd(session);
  for (const entry of liveSessions.values()) {
    if (entry.session.sessionId === sessionId) return sessionCwd(entry.session);
  }
  const info = await findSessionInfoById(sessionId);
  if (!info) throw new Error("Session not found");
  return info.cwd || piCwd;
}

// Models confirmed broken with this Copilot integration — tracked at runtime.
const blockedModelIds = new Set<string>();

// Parse allowed model IDs from Copilot's model_not_available_for_integrator error.
// Returns null if no such error has been seen yet.
function copilotAllowedIdsFromSession(targetSession: PiWebSession = session): Set<string> | null {
  const entries = targetSession.messages;
  for (let i = entries.length - 1; i >= 0; i--) {
    const msg = entries[i] as any;
    const err: string = msg?.errorMessage || msg?.message?.errorMessage || "";
    if (!err.includes("model_not_available_for_integrator")) continue;
    const match = err.match(/Available models: \[([^\]]+)\]/);
    if (!match) continue;
    return new Set(match[1].split(/\s+/).map((s: string) => s.trim()).filter(Boolean));
  }
  return null;
}

function getAvailableModels(targetSession: PiWebSession = session) {
  const all = targetSession.modelRuntime.getAvailableSnapshot();
  const allowed = copilotAllowedIdsFromSession(targetSession);
  return all.filter((m: any) => {
    if (blockedModelIds.has(m.id)) return false;
    if (allowed && !allowed.has(m.id)) return false;
    return true;
  });
}

const imageExtensions: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

async function persistPromptImages(images: Array<{ data: string; mimeType: string; name?: string }>, cwd = piCwd) {
  if (!images.length) return "";
  await ensurePiWebStorage(cwd);
  const uploadDir = join(cwd, ".pi", "web", "uploads");
  await mkdir(uploadDir, { recursive: true });

  const lines: string[] = [];
  for (const image of images) {
    const extension = imageExtensions[image.mimeType] || ".img";
    const safeName = String(image.name || "image").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}-${safeName}${safeName.endsWith(extension) ? "" : extension}`;
    const filePath = join(uploadDir, fileName);
    const data = Buffer.from(image.data, "base64");
    await writeFile(filePath, data);
    lines.push(`- ${filePath}`);
  }

  return `\n\nAttached image file${images.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

function sessionCwd(targetSession: PiWebSession | any = session) {
  return String(targetSession?.sessionManager?.getCwd?.() || targetSession?.cwd || piCwd);
}

type RetrySessionTarget =
  | { kind: "failure"; messages: any[]; index: number; message: any }
  | { kind: "aborted"; messages: any[]; index: number; message: any }
  | { kind: "toolResult"; messages: any[]; index: number; message: any };

function trailingRetryTarget(targetSession: PiWebSession): RetrySessionTarget | undefined {
  const messages = Array.isArray(targetSession.agent?.state?.messages) ? targetSession.agent.state.messages as any[] : [];
  const index = messages.length - 1;
  const message = index >= 0 ? messages[index] : undefined;
  if (isAssistantFailureMessage(message)) return { kind: "failure", messages, index, message };
  if (isAssistantAbortedMessage(message)) return { kind: "aborted", messages, index, message };
  if (isIncompleteToolResultMessage(message)) return { kind: "toolResult", messages, index, message };
  return undefined;
}

function branchBeforeTrailingMessages(targetSession: PiWebSession, shouldBranchBefore: (message: any) => boolean) {
  const manager = targetSession.sessionManager;
  if (typeof manager.getBranch !== "function") return false;
  let branch: any[];
  try {
    branch = manager.getBranch();
  } catch {
    return false;
  }
  if (!Array.isArray(branch)) return false;

  let lastMessageIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "message") {
      lastMessageIndex = index;
      break;
    }
  }
  if (lastMessageIndex < 0) return false;
  const lastMessage = branch[lastMessageIndex]?.message;
  if (!shouldBranchBefore(lastMessage)) return false;

  let firstRemovedIndex = lastMessageIndex;
  while (firstRemovedIndex > 0) {
    const previous = branch[firstRemovedIndex - 1];
    if (previous?.type !== "message" || !shouldBranchBefore(previous.message)) break;
    firstRemovedIndex -= 1;
  }

  const firstRemoved = branch[firstRemovedIndex];
  const parentId = typeof firstRemoved?.parentId === "string" ? firstRemoved.parentId : null;
  if (parentId && typeof manager.branch === "function") manager.branch(parentId);
  else if (!parentId && typeof manager.resetLeaf === "function") manager.resetLeaf();
  else return false;
  return true;
}

function syncAgentMessagesToSessionContext(targetSession: PiWebSession) {
  const internal = targetSession as any;
  if (typeof targetSession.sessionManager?.buildSessionContext !== "function") return false;
  internal.agent.state.messages = targetSession.sessionManager.buildSessionContext().messages;
  return true;
}

function assertCanRetryFromFailure(targetSession: PiWebSession) {
  if (targetSession.isStreaming) throw new Error("Wait for the current response to finish before retrying.");
  if (targetSession.isCompacting) throw new Error("Wait for compaction to finish before retrying.");
  if (!trailingRetryTarget(targetSession)) throw new Error("There is no failed or incomplete response to retry.");
}

async function retrySessionFromFailure(targetSession: PiWebSession) {
  assertCanRetryFromFailure(targetSession);
  if (typeof targetSession.retryFromFailure === "function") {
    await targetSession.retryFromFailure();
    return;
  }

  const target = trailingRetryTarget(targetSession);
  if (!target) throw new Error("There is no failed or incomplete response to retry.");

  const internal = targetSession as any;
  if (!internal.agent || typeof internal.agent.continue !== "function") throw new Error("Continuing is not available in this session.");

  if (target.kind === "failure") {
    const branched = branchBeforeTrailingMessages(targetSession, isAssistantFailureMessage);
    if (!branched || !syncAgentMessagesToSessionContext(targetSession)) {
      while (target.messages.length > 0 && isAssistantFailureMessage(target.messages[target.messages.length - 1])) target.messages.pop();
    }
  } else if (target.kind === "aborted") {
    const branched = branchBeforeTrailingMessages(targetSession, isAssistantAbortedMessage);
    if (!branched || !syncAgentMessagesToSessionContext(targetSession)) {
      if (isAssistantAbortedMessage(target.messages[target.messages.length - 1])) target.messages.pop();
    }
  }

  try {
    await internal.agent.continue();
    while (typeof internal._handlePostAgentRun === "function" && await internal._handlePostAgentRun()) {
      await internal.agent.continue();
    }
  } finally {
    internal._systemPromptOverride = undefined;
    if (typeof internal._flushPendingBashMessages === "function") internal._flushPendingBashMessages();
  }
}

function rememberSessionLocation(info: { id: string; path: string; cwd?: string }, cwd = piCwd) {
  if (info.id && info.path) sessionLocations.set(info.id, { path: resolve(info.path), cwd: resolve(info.cwd || cwd) });
}

function simplifySessionInfo(
  info: Awaited<ReturnType<typeof SessionManager.list>>[number] & { agent?: "pi" | "claude-code" },
  cwd = piCwd,
  agent: "pi" | "claude-code" = "pi",
) {
  rememberSessionLocation(info, cwd);
  const resolvedAgent = info.agent === "pi" || info.agent === "claude-code" ? info.agent : agent;
  return {
    id: info.id,
    name: info.name,
    firstMessage: info.firstMessage,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    cwd: info.cwd || cwd,
    agent: resolvedAgent,
    isCurrent: false,
    saved: savedSessionIds.has(info.id),
    runtime: sessionActivity.runtimeForPath(info.path),
  };
}

function applySessionUnreadState<T extends { id: string }>(sessions: T[], sessionUiState: { sessionUnreadStates?: Array<{ sessionId: string; unreadAt: string }> }) {
  const unreadById = new Map((sessionUiState.sessionUnreadStates || []).map((item) => [item.sessionId, item]));
  return sessions.map((item) => {
    const unread = unreadById.get(item.id);
    return unread ? { ...item, unread: true, unreadAt: unread.unreadAt } : { ...item, unread: false };
  });
}

const sessionListRequests = new Map<string, Promise<ReturnType<typeof simplifySessionInfo>[]>>();

async function listSessionInfos(extraCwds: string[] = []) {
  if (noSession) return [];
  if (mockMode) return mockSessions.map((info) => simplifySessionInfo(info as any, info.cwd || piCwd));
  const cwds = new Set<string>(knownCwds);
  for (const cwd of extraCwds) {
    if (typeof cwd !== "string" || !cwd.trim()) continue;
    cwds.add(resolve(cwd));
  }
  const orderedCwds = Array.from(cwds).sort();
  const key = orderedCwds.join("\n");
  const existing = sessionListRequests.get(key);
  if (existing) return existing;
  const request = (async () => {
    const groups = await Promise.all(orderedCwds.map(async (cwd) => {
      // Pi sessions for this cwd — read from pi's session manager.
      const piRows = await SessionManager.list(cwd).then(
        (sessions) => sessions.map((info) => simplifySessionInfo(info, cwd, "pi")),
        () => [],
      );
      // Claude Code sessions for this cwd — scan ~/.claude/projects/<slug>/.
      const ccRows = await listCCSessions(cwd).then(
        (sessions) => sessions.map((info) => simplifySessionInfo(
          {
            id: info.id,
            path: info.path,
            name: info.name,
            firstMessage: info.firstMessage,
            created: info.created,
            modified: info.modified,
            messageCount: info.messageCount,
            allMessagesText: info.firstMessage,
            cwd: info.cwd,
          },
          cwd,
          "claude-code",
        )),
        () => [],
      );
      return [...piRows, ...ccRows];
    }));
    return groups.flat().sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  })();
  sessionListRequests.set(key, request);
  try { return await request; }
  finally { sessionListRequests.delete(key); }
}

function currentState(targetSession: PiWebSession = session) {
  const projected = projectSessionState(targetSession, sessionCwd(targetSession));
  const { thinkingLevels: _thinkingLevels, ...base } = projected;
  const isRunning = Boolean(projected.isStreaming || projected.isRetrying || projected.isCompacting);
  return {
    ...base,
    activeCwd: (targetSession as any).activeCwd || undefined,
    agent: (targetSession as AgentAdapter).kind,
    capabilities: (targetSession as AgentAdapter).getCapabilities(),
    runtimeStartedAt: typeof (targetSession as any).runtimeStartedAt === "string"
      ? (targetSession as any).runtimeStartedAt
      : sessionActivity.startedAtForPath(targetSession.sessionFile, isRunning),
    runtimeLastActivityAt: typeof (targetSession as any).runtimeLastActivityAt === "string"
      ? (targetSession as any).runtimeLastActivityAt
      : sessionActivity.lastActivityAtForPath(targetSession.sessionFile, isRunning),
    runtime: sessionActivity.runtimeForPath(targetSession.sessionFile),
    ...webUiBridge.entries(targetSession),
  };
}

function currentStateWithThinkingLevels(targetSession: PiWebSession = session) {
  return {
    ...currentState(targetSession),
    thinkingLevels: targetSession.getAvailableThinkingLevels(),
  };
}

function getSlashCommands(value: PiWebSession = session): WebSlashCommandInfo[] {
  return [...webSlashCommands, ...(value as AgentAdapter).getAgentSlashCommands() as WebSlashCommandInfo[]];
}

function formatSlashCommandList(commands: WebSlashCommandInfo[]) {
  // Note: "claude-code" group label is added preemptively so CC adapter slash
  // commands appear under their own heading once that adapter ships.
  const groups: Array<[string, string]> = [
    ["web", "Web"],
    ["extension", "Extensions"],
    ["prompt", "Prompts"],
    ["skill", "Skills"],
    ["claude-code", "Claude Code"],
  ];
  const lines: string[] = ["Available slash commands:"];
  for (const [source, label] of groups) {
    const matching = commands.filter((command) => command.source === source);
    if (!matching.length) continue;
    lines.push("", `${label}:`);
    for (const command of matching) {
      lines.push(`/${command.name}${command.description ? ` - ${command.description}` : ""}`);
    }
  }
  return lines.join("\n");
}

function slashHelp(targetSession: PiWebSession = session) {
  return [
    "Type / in the composer to browse available commands.",
    "",
    "Web commands run in pi-web; extension, prompt, and skill commands are discovered from pi's extension/resource system.",
    "",
    formatSlashCommandList(getSlashCommands(targetSession)),
  ].join("\n");
}

function formatModelList(targetSession: PiWebSession = session) {
  return getAvailableModels(targetSession)
    .map((model: any) => `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`)
    .join("\n");
}

async function executeSlashCommand(input: string, targetSession: PiWebSession = session) {
  const trimmed = input.trim();
  const [rawName = "", ...rest] = trimmed.replace(/^\/+/, "").split(/\s+/);
  const name = rawName.toLowerCase();
  const args = rest.join(" ").trim();

  switch (name) {
    case "help":
    case "?":
      return { message: slashHelp(targetSession), state: currentStateWithThinkingLevels(targetSession) };

    case "commands":
      return { message: formatSlashCommandList(getSlashCommands(targetSession)), state: currentStateWithThinkingLevels(targetSession) };

    case "reload": {
      if (targetSession.isStreaming) throw new Error("Wait for the current response to finish before reloading.");
      if (targetSession.isCompacting) throw new Error("Wait for compaction to finish before reloading.");
      if (typeof targetSession.reload !== "function") throw new Error("Reload is not available in this session.");
      await targetSession.reload();
      return { message: "Reloaded pi resources, extensions, and models.", state: currentStateWithThinkingLevels(targetSession) };
    }

    case "model": {
      if (!args) {
        return { message: formatModelList(targetSession) || "No models available.", state: currentStateWithThinkingLevels(targetSession) };
      }
      const slashIndex = args.indexOf("/");
      if (slashIndex <= 0) throw new Error("Usage: /model <provider/model-id>");
      const provider = args.slice(0, slashIndex);
      const id = args.slice(slashIndex + 1);
      const model = targetSession.modelRuntime.getModel(provider, id);
      if (!model) throw new Error(`Model not found: ${args}`);
      await targetSession.setModel(model);
      return { message: `Model set to ${provider}/${id}.`, state: currentStateWithThinkingLevels(targetSession) };
    }

    case "models":
      return { message: formatModelList(targetSession) || "No models available.", state: currentStateWithThinkingLevels(targetSession) };

    case "thinking": {
      if (!args) {
        return { message: `Thinking level: ${targetSession.thinkingLevel}\nAvailable: ${targetSession.getAvailableThinkingLevels().join(", ")}`, state: currentStateWithThinkingLevels(targetSession) };
      }
      const levels = targetSession.getAvailableThinkingLevels();
      if (!levels.includes(args as any)) throw new Error(`Unknown thinking level: ${args}. Available: ${levels.join(", ")}`);
      targetSession.setThinkingLevel(args as any);
      return { message: `Thinking level set to ${targetSession.thinkingLevel}.`, state: currentStateWithThinkingLevels(targetSession) };
    }

    case "new": {
      const newSession = await createNewLiveSession(sessionCwd(targetSession), targetSession.sessionFile);
      return { message: "New session.", state: currentStateWithThinkingLevels(newSession) };
    }

    case "clear": {
      if (targetSession.isStreaming) throw new Error("Wait for the current response to finish before clearing.");
      if (targetSession.isCompacting) throw new Error("Wait for compaction to finish before clearing.");
      const oldSessionId = targetSession.sessionId;
      const newSession = await createNewLiveSession(sessionCwd(targetSession), targetSession.sessionFile);
      const state = currentStateWithThinkingLevels(newSession);
      const sessionUiState = await transferCurrentTabUiState(oldSessionId, newSession.sessionId, state.sessionTitle || "New session", state.cwd);
      return { message: "Cleared tab. Previous session remains in history.", state: { ...state, sessionUiState } };
    }

    case "compact": {
      if (targetSession.isStreaming) throw new Error("Wait for the current response to finish before compacting.");
      if (targetSession.isCompacting) throw new Error("Compaction is already running.");
      if (typeof targetSession.compact !== "function") throw new Error("Compaction is not available in this session.");
      sessionActivity.ensureStarted(targetSession);
      const releaseWorkLease = acquireWorkLease(targetSession);
      void targetSession.compact(args || undefined).catch((error: unknown) => {
        sessionActivity.clearStarted(targetSession);
        broadcast({
          type: "server_error",
          sessionId: targetSession.sessionId,
          sessionFile: targetSession.sessionFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(releaseWorkLease);
      return { message: "Compaction started.", state: currentStateWithThinkingLevels(targetSession) };
    }

    case "abort":
    case "stop":
      await targetSession.abort();
      return { message: "Aborted.", state: currentStateWithThinkingLevels(targetSession) };

    default:
      throw new Error(`Unknown slash command: /${name}. Try /help.`);
  }
}

async function findSessionInfoById(id: string, cwd?: string) {
  if (!id) return undefined;
  if (noSession) return undefined;
  if (mockMode) {
    const hit = mockSessions.find((info) => info.id === id);
    return hit ? { ...hit, cwd: hit.cwd || cwd } : undefined;
  }

  if (cwd && cwd.trim()) {
    const resolvedCwd = resolve(cwd);
    const sessionInfo = (await SessionManager.list(resolvedCwd)).find((info) => info.id === id);
    if (sessionInfo?.cwd) knownCwds.add(sessionInfo.cwd);
    if (sessionInfo) return sessionInfo;
  }


  for (const knownCwd of knownCwds) {
    const sessionInfo = (await SessionManager.list(knownCwd)).find((info) => info.id === id);
    if (sessionInfo?.cwd) knownCwds.add(sessionInfo.cwd);
    if (sessionInfo) return sessionInfo;
  }

  const sessionInfo = (await SessionManager.listAll()).find((info) => info.id === id);
  if (sessionInfo?.cwd) knownCwds.add(sessionInfo.cwd);
  if (sessionInfo) return sessionInfo;

  // Claude Code fallback: scan ~/.claude/projects/<slug>/ for the id across all
  // known cwds (not just the active one) so a CC session stays openable after
  // the user switches cwd. The result carries the cwd the hit was found under so
  // getOrCreateLiveSessionById can flip piCwd to it before constructing the
  // adapter — the CC adapter binds its `--add-dir` and transcript path off piCwd
  // at construction time, and a mismatched piCwd would write the new turn into
  // the wrong project slug.
  const ccCwds = [cwd, ...knownCwds].filter((c): c is string => Boolean(c && c.trim()));
  for (const ccCwd of (ccCwds.length ? ccCwds : [piCwd])) {
    const ccSessions = await listCCSessions(ccCwd).catch(() => []);
    const ccHit = ccSessions.find((info) => info.id === id);
    if (ccHit) return { id: ccHit.id, path: ccHit.path, cwd: ccCwd } as { id: string; path: string; cwd: string };
  }


  return undefined;
}

async function trashOrRemoveSessionFile(path: string) {
  try {
    await execFileAsync("trash", [path], { timeout: 15_000 });
    return "trashed" as const;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    await rm(path, { force: true });
    return "deleted" as const;
  }
}

async function deleteSessionById(id: string, cwd?: string) {
  if (noSession) throw new Error("Sessions are disabled.");

  const info = await findSessionInfoById(id, cwd);
  if (!info) {
    const error = new Error("Session not found");
    (error as any).status = 404;
    throw error;
  }

  const live = liveSessions.get(info.path);
  if (live?.session?.isStreaming || live?.session?.isCompacting) {
    const error = new Error("Wait for the session to finish before deleting it.");
    (error as any).status = 409;
    throw error;
  }

  if (live) await disposeLiveSession(info.path, "delete", true);

  if (mockMode) {
    const index = mockSessions.findIndex((item) => item.id === id);
    if (index >= 0) mockSessions.splice(index, 1);
    return { id, disposition: "deleted" as const };
  }

  return { id, disposition: await trashOrRemoveSessionFile(info.path) };
}

function liveSessionById(id: string) {
  if (id === session.sessionId) return session;
  return liveById.get(id);
}

function defaultSessionDir(cwd: string) {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", safePath);
}

async function resolveSessionLocation(id: string, cwd = piCwd) {
  if (!id || noSession) return undefined;
  if (mockMode) {
    const info = mockSessions.find((item) => item.id === id);
    if (info) rememberSessionLocation(info as any, info.cwd || cwd);
    return info ? sessionLocations.get(id) : undefined;
  }

  const candidateCwds = new Set([resolve(cwd), ...knownCwds]);
  const suffix = `_${id}.jsonl`;
  for (const resolvedCwd of candidateCwds) {
    const directory = defaultSessionDir(resolvedCwd);
    let names: string[];
    try { names = await readdir(directory); } catch { continue; }
    const name = names.find((entry) => entry.endsWith(suffix));
    if (!name) continue;
    const location = { path: join(directory, name), cwd: resolvedCwd };
    sessionLocations.set(id, location);
    knownCwds.add(resolvedCwd);
    return location;
  }

  // Claude Code fallback: scan ~/.claude/projects/<slug>/ across candidate
  // cwds so a CC session stays openable after the user switches cwd.
  for (const resolvedCwd of candidateCwds) {
    const ccSessions = await listCCSessions(resolvedCwd).catch(() => []);
    const ccHit = ccSessions.find((info) => info.id === id);
    if (!ccHit) continue;
    const location = { path: resolve(ccHit.path), cwd: resolvedCwd };
    sessionLocations.set(id, location);
    knownCwds.add(resolvedCwd);
    return location;
  }
  return undefined;
}

async function openSessionAtLocation(id: string, location: { path: string; cwd: string }) {
  const resolvedPath = resolve(location.path);
  const dir = dirname(resolvedPath);
  const isCC = detectAgentForPath(resolvedPath) === "claude-code";
  const validDir = isCC ? resolve(ccProjectDir(location.cwd)) : defaultSessionDir(location.cwd);
  if (!mockMode && dir !== validDir) throw new Error("Invalid session location");
  // The CC adapter binds --add-dir and its transcript path off piCwd at
  // construction time; flip piCwd to the session's home cwd first so a new
  // turn does not land in the wrong project slug. Pi sessions open in place
  // without touching the global cwd.
  if (isCC && resolve(location.cwd) !== resolve(piCwd)) await setPiCwd(location.cwd);
  const target = await getOrCreateLiveSession(location.path);
  if (target.sessionId !== id) {
    if (target !== session) await disposeLiveSession(sessionPathKey(target), "reset", true);
    throw new Error("Session location did not match requested ID");
  }
  sessionLocations.set(id, { path: resolvedPath, cwd: resolve(location.cwd) });
  return target;
}

async function getOrCreateLiveSessionById(id: string, cwd?: string) {
  const existing = liveSessionById(id);
  if (existing) return existing;
  const pending = openingById.get(id);
  if (pending) return pending;

  const opening = (async () => {
    const remembered = sessionLocations.get(id);
    if (remembered) {
      try { return await openSessionAtLocation(id, remembered); }
      catch { sessionLocations.delete(id); }
    }
    const resolved = await resolveSessionLocation(id, cwd);
    return resolved ? openSessionAtLocation(id, resolved) : undefined;
  })();
  openingById.set(id, opening);
  try { return await opening; }
  finally { openingById.delete(id); }
}

async function switchToSessionId(id: string, cwd?: string) {
  const target = await getOrCreateLiveSessionById(id, cwd);
  if (!target) throw new Error("Session not found");
  return target;
}

const modelRuntime = await ModelRuntime.create();
const settingsStore = createSettingsStore(process.env.PI_WEB_SETTINGS_FILE || join(getAgentDir(), "pi-web-settings.json"));
const sessionUiStateStore = createSessionUiStateStore(process.env.PI_WEB_SESSION_UI_STATE_FILE || join(getAgentDir(), "pi-web-session-ui-state.json"));

// Saved sessions store
const savedSessionsFile = join(getAgentDir(), "pi-web-saved-sessions.json");
let savedSessionIds: Set<string> = new Set();
(async () => {
  try {
    const data = JSON.parse(await readFile(savedSessionsFile, "utf-8"));
    if (Array.isArray(data)) savedSessionIds = new Set(data);
  } catch {}
})();
async function persistSavedSessions() {
  await mkdir(dirname(savedSessionsFile), { recursive: true });
  const tmp = `${savedSessionsFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify([...savedSessionIds]), "utf-8");
  await rename(tmp, savedSessionsFile);
}

// liveSessions stores AgentAdapter values — every session, pi or mock, is
// wrapped exactly once inside registerLiveSession() so callers never have to
// distinguish raw pi sessions from agent-tagged ones at use sites.
type LiveSessionEntry = {
  session: AgentAdapter;
  unsubscribe?: () => void;
  viewerClientIds: Set<string>;
  workLeases: number;
  disposeTimer?: ReturnType<typeof setTimeout>;
  disposing?: boolean;
};

type ViewerLease = {
  sessionKey: string;
  sockets: Set<WebSocket>;
  releaseTimer?: ReturnType<typeof setTimeout>;
};

function envMs(name: string, fallback: number) {
  const raw = Number(process.env[name] || fallback);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const defaultSessionIdleGraceMs = 24 * 60 * 60 * 1000;
const sessionIdleGraceMs = envMs("PI_WEB_SESSION_IDLE_GRACE_MS", defaultSessionIdleGraceMs);
const viewerLeaseGraceMs = envMs("PI_WEB_VIEWER_LEASE_GRACE_MS", Math.min(30_000, sessionIdleGraceMs));
const websocketHeartbeatMs = envMs("PI_WEB_WS_HEARTBEAT_MS", 30_000);
const websocketMaxMissedHeartbeats = Math.max(1, Math.floor(envMs("PI_WEB_WS_MAX_MISSED_HEARTBEATS", 3)));
const liveSessions = new Map<string, LiveSessionEntry>();
const liveById = new Map<string, PiWebSession>();
const sessionLocations = new Map<string, { path: string; cwd: string }>();
const openingById = new Map<string, Promise<PiWebSession | undefined>>();
const viewerLeases = new Map<string, ViewerLease>();
const sessionActivity = new SessionActivity((path) => liveSessions.get(path)?.session);
let session: AgentAdapter;
let modelFallbackMessage: string | undefined;

let realtimeHub: RealtimeHub;
const unreadTracker = new SessionUnreadTracker(sessionUiStateStore, sessionActivity, (value) => realtimeHub.broadcast(value));
realtimeHub = new RealtimeHub(websocketHeartbeatMs, websocketMaxMissedHeartbeats, (value) => unreadTracker.handle(value));

function broadcast(value: unknown) {
  realtimeHub.broadcast(value);
}

function markSessionUnreadCompleted(sessionId: string, unreadAt = new Date().toISOString()) {
  unreadTracker.markCompleted(sessionId, unreadAt);
}

function clearSessionUnread(sessionId: string) {
  unreadTracker.clear(sessionId);
}

const mockHarness = createMockHarness({
  piCwd,
  broadcast,
  isCurrentSession: (value: PiWebSession) => value === session,
  currentState,
});
const { mockSessions, createMockSession, resetMockSessions, getMockLifecycle } = mockHarness;

function sessionPathKey(value: { sessionFile?: string; sessionId?: string }) {
  return String(value.sessionFile || value.sessionId || "");
}

function cleanClientId(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 120).replace(/[^a-zA-Z0-9_.:-]/g, "");
}

function clientIdFromRequest(req: IncomingMessage, fallback?: unknown) {
  const raw = req.headers["x-pi-web-client-id"];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  return cleanClientId(headerValue) || cleanClientId(fallback);
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
  if (timer) clearTimeout(timer);
}

function cancelLiveSessionCleanup(entry: LiveSessionEntry) {
  clearTimer(entry.disposeTimer);
  entry.disposeTimer = undefined;
}

function isLiveSessionBusy(entry: LiveSessionEntry) {
  return Boolean(entry.session?.isStreaming || entry.session?.isCompacting || entry.workLeases > 0);
}

function shouldKeepLiveSession(entry: LiveSessionEntry) {
  return entry.session === session || entry.viewerClientIds.size > 0 || isLiveSessionBusy(entry);
}

function scheduleLiveSessionCleanup(key: string) {
  const entry = liveSessions.get(key);
  if (!entry || entry.disposing) return;
  if (shouldKeepLiveSession(entry)) {
    cancelLiveSessionCleanup(entry);
    return;
  }
  if (entry.disposeTimer) return;
  entry.disposeTimer = setTimeout(() => {
    entry.disposeTimer = undefined;
    void disposeLiveSession(key, "idle");
  }, sessionIdleGraceMs);
}

async function emitSessionShutdown(value: any) {
  const runner = value?.extensionRunner;
  if (!runner?.hasHandlers?.("session_shutdown")) return;
  await runner.emit({ type: "session_shutdown", reason: "quit" });
}

async function disposeLiveSession(key: string, reason: "idle" | "delete" | "reset" = "idle", force = false) {
  const entry = liveSessions.get(key);
  if (!entry || entry.disposing) return;
  if (!force && shouldKeepLiveSession(entry)) return;

  entry.disposing = true;
  cancelLiveSessionCleanup(entry);
  const value = entry.session;
  const sessionId = String(value?.sessionId || "");
  const sessionFile = String(value?.sessionFile || key || "");

  for (const [clientId, lease] of viewerLeases) {
    if (lease.sessionKey !== key) continue;
    clearTimer(lease.releaseTimer);
    viewerLeases.delete(clientId);
  }

  try {
    await emitSessionShutdown(value);
  } catch (error) {
    console.warn(`Could not emit session shutdown before ${reason}:`, error);
  }

  try {
    entry.unsubscribe?.();
  } catch (error) {
    console.warn(`Could not unsubscribe session before ${reason}:`, error);
  }

  try {
    (value as { dispose?: () => void })?.dispose?.();
  } catch (error) {
    console.warn(`Could not dispose session after ${reason}:`, error);
  }

  liveSessions.delete(key);
  if (liveById.get(sessionId) === value) liveById.delete(sessionId);
  sessionActivity.clearSession(key, value);

  if (sessionId) {
    broadcast({ type: "session_runtime_changed", sessionId, sessionFile, runtime: sessionActivity.runtimeForPath(sessionFile) });
  }
}

function scheduleViewerLeaseRelease(clientId: string) {
  const lease = viewerLeases.get(clientId);
  if (!lease || lease.sockets.size > 0) return;
  clearTimer(lease.releaseTimer);
  lease.releaseTimer = setTimeout(() => releaseViewerLease(clientId), viewerLeaseGraceMs);
}

function releaseViewerLease(clientId: string) {
  const lease = viewerLeases.get(clientId);
  if (!lease) return;
  clearTimer(lease.releaseTimer);
  viewerLeases.delete(clientId);
  const entry = liveSessions.get(lease.sessionKey);
  if (entry) {
    entry.viewerClientIds.delete(clientId);
    scheduleLiveSessionCleanup(lease.sessionKey);
  }
}

function acquireViewerLease(clientId: string, value: any) {
  if (!clientId || !value) return undefined;
  const key = sessionPathKey(value);
  const entry = liveSessions.get(key);
  if (!key || !entry) return undefined;

  let lease = viewerLeases.get(clientId);
  const sockets = lease?.sockets || new Set<WebSocket>();
  clearTimer(lease?.releaseTimer);
  if (lease && lease.sessionKey !== key) {
    const previous = liveSessions.get(lease.sessionKey);
    previous?.viewerClientIds.delete(clientId);
    scheduleLiveSessionCleanup(lease.sessionKey);
  }

  lease = { sessionKey: key, sockets };
  viewerLeases.set(clientId, lease);
  entry.viewerClientIds.add(clientId);
  cancelLiveSessionCleanup(entry);
  if (sockets.size === 0) scheduleViewerLeaseRelease(clientId);
  return lease;
}

function bindViewerSocket(clientId: string, ws: WebSocket) {
  const lease = viewerLeases.get(clientId);
  if (!lease) return;
  clearTimer(lease.releaseTimer);
  lease.releaseTimer = undefined;
  lease.sockets.add(ws);
  ws.on("close", () => {
    const current = viewerLeases.get(clientId);
    current?.sockets.delete(ws);
    if (!current || current.sockets.size > 0) return;
    releaseViewerLease(clientId);
  });
}

function noteViewerLeaseFromRequest(req: IncomingMessage, value: any, fallbackClientId?: unknown) {
  const clientId = clientIdFromRequest(req, fallbackClientId);
  if (clientId) acquireViewerLease(clientId, value);
}

function acquireWorkLease(value: any) {
  const key = sessionPathKey(value);
  const entry = liveSessions.get(key);
  if (!entry) return () => undefined;
  entry.workLeases++;
  cancelLiveSessionCleanup(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.workLeases = Math.max(0, entry.workLeases - 1);
    scheduleLiveSessionCleanup(key);
  };
}

// Wrap an incoming pi/mock session into an AgentAdapter and register it on
// liveSessions. The input type is `any` because pi's createAgentSession()
// returns AgentSession (with optional sessionFile) which does not satisfy our
// stricter PiWebSession contract. Sessions that are *already* AgentAdapters
// (e.g. the Claude Code adapter, which sets `kind` itself in its constructor)
// are passed through verbatim so we don't clobber their kind/capabilities.
function registerLiveSession(rawSession: any): AgentAdapter {
  const value: AgentAdapter = rawSession?.kind && typeof rawSession.getCapabilities === "function"
    ? rawSession as AgentAdapter
    : wrapPiSession(rawSession as PiWebSession, mockMode ? "mock" : "pi");
  const key = sessionPathKey(value);
  if (!key || liveSessions.get(key)?.session === value) return value;

  const unsubscribe = value.subscribe?.((event: unknown) => {
    const e = event as any;
    const enriched = sessionActivity.enrichEvent(value, event);
    const eventSessionFile = enriched.sessionFile;
    const eventSessionId = enriched.sessionId;
    const eventForClient = enriched.event;

    // Track models that fail with model_not_supported and remove them from the list.

    broadcast({ type: "pi_event", sessionId: eventSessionId, sessionFile: eventSessionFile, event: eventForClient });
    broadcast({
      type: "session_runtime_changed",
      sessionId: eventSessionId,
      sessionFile: eventSessionFile,
      runtime: sessionActivity.runtimeForEvent(eventSessionFile, e),
    });

    // Broadcast state update when session name or active cwd changes
    if (e?.type === "session_info_changed" || e?.type === "active_cwd_changed") {
      broadcast({ type: "state_changed", ...currentState(value) });
    }

    if (e?.type === "message_end" || e?.type === "agent_end" || e?.type === "compaction_end") {
      broadcast({ type: "session_stats_changed", sessionId: eventSessionId, sessionFile: eventSessionFile, stats: sessionStats(value) });
    }

    if (e?.type === "message_end" || e?.type === "turn_end") {
      const msg = e?.message ?? e?.toolResults?.[0];
      const err: string = msg?.errorMessage || msg?.message?.errorMessage || "";
      const modelId: string = msg?.model || msg?.message?.model || "";
      if (modelId && (err.includes("model_not_supported") || err.includes("model_not_available"))) {
        if (!blockedModelIds.has(modelId)) {
          blockedModelIds.add(modelId);
          broadcast({ type: "models_updated", sessionId: eventSessionId, models: getAvailableModels(value).map(simplifyModel) });
        }
      }
    }
  });
  liveSessions.set(key, { session: value, unsubscribe, viewerClientIds: new Set(), workLeases: 0 });
  liveById.set(value.sessionId, value);
  if (value.sessionFile) sessionLocations.set(value.sessionId, { path: resolve(value.sessionFile), cwd: sessionCwd(value) });
  queueMicrotask(() => scheduleLiveSessionCleanup(key));
  return value;
}

function additionalExtensionPaths(cwd = piCwd) {
  return [
    ...resolveBundledExtensionPaths({ piCwd: cwd, appDir, bundledExtensionsDir }),
    ...resolvePiWebExtensionPaths(cwd),
  ];
}

/**
 * Detect which agent owns a given session-file path. CC writes UUID-named
 * .jsonl files under ~/.claude/projects/<slug>/; everything else is treated as
 * pi (its session files live under getAgentDir() with .session.json suffixes).
 * Used to dispatch open-session requests to the right adapter.
 */
function detectAgentForPath(path: string): AgentKind {
  const claudeProjects = join(process.env.HOME || "", ".claude", "projects");
  if (path.startsWith(claudeProjects) && path.endsWith(".jsonl")) return "claude-code";
  return mockMode ? "mock" : "pi";
}

async function makeClaudeCodeAdapter(sessionId?: string, cwd: string = piCwd): Promise<AgentAdapter> {
  const webUiContext = existsSync(webUiContextFile) ? readFileSync(webUiContextFile, "utf-8") : "";
  const settings = await settingsStore.read();
  return createClaudeCodeAdapter({
    cwd,
    sessionId,
    appendSystemPrompt: webUiContext || undefined,
    initialModel: settings.defaults.model && settings.defaults.agent === "claude-code"
      ? { provider: settings.defaults.model.provider, id: settings.defaults.model.id }
      : undefined,
    initialThinkingLevel: settings.defaults.thinkingLevel,
  });
}

async function makeAgentSession(path?: string, sessionStartEvent?: SessionStartEvent, cwd = piCwd) {
  if (mockMode) return { session: createMockSession(path), modelFallbackMessage: undefined };

  const targetCwd = await assertDirectory(cwd, piCwd);
  const sessionManager = noSession
    ? SessionManager.inMemory(targetCwd)
    : path
      ? SessionManager.open(path)
      : SessionManager.create(targetCwd);
  if (!path && !noSession && sessionStartEvent?.reason === "new") sessionManager.newSession();

  const resolvedCwd = sessionCwd({ sessionManager });
  knownCwds.add(resolvedCwd);
  await ensurePiWebStorage(resolvedCwd);

  const webUiContext = existsSync(webUiContextFile) ? readFileSync(webUiContextFile, "utf-8") : "";

  const loader = new DefaultResourceLoader({
    cwd: resolvedCwd,
    agentDir: getAgentDir(),
    additionalExtensionPaths: additionalExtensionPaths(resolvedCwd),
    appendSystemPromptOverride: (base) => [
      ...base,
      webUiContext,
    ].filter(Boolean),
  });
  await loader.reload();

  const result = await createAgentSession({
    cwd: resolvedCwd,
    sessionManager,
    modelRuntime,
    resourceLoader: loader,
    sessionStartEvent,
  });
  await webUiBridge.bind(result.session);
  return result;
}

/**
 * Build a fresh AgentAdapter of the requested kind. Used by both first-boot
 * session creation and explicit /api/sessions/new POSTs. CC adapter creation
 * goes via makeClaudeCodeAdapter() which spawns no child process until the
 * first prompt; pi adapter creation goes via the existing makeAgentSession().
 */
async function makeAdapter(
  agent: AgentKind,
  options: { path?: string; sessionStartEvent?: SessionStartEvent; cwd?: string } = {},
): Promise<{ session: any; modelFallbackMessage?: string }> {
  if (agent === "claude-code") {
    const sessionId = options.path ? options.path.match(/([0-9a-f-]{36})\.jsonl$/i)?.[1] : undefined;
    return { session: await makeClaudeCodeAdapter(sessionId, options.cwd) };
  }
  // Both "pi" and "mock" go through makeAgentSession; mockMode is a process-
  // wide flag that makeAgentSession() already honors when constructing the
  // session via createMockSession().
  return makeAgentSession(options.path, options.sessionStartEvent, options.cwd);
}

async function getOrCreateLiveSession(path: string) {
  const existing = liveSessions.get(path)?.session;
  if (existing) {
    scheduleLiveSessionCleanup(path);
    return existing;
  }
  const agent = detectAgentForPath(path);
  const created = await makeAdapter(agent, { path });
  if (created.modelFallbackMessage) console.warn(created.modelFallbackMessage);
  return registerLiveSession(created.session);
}

async function applyDefaultSessionSettings(value: any) {
  const settings = await settingsStore.read();
  const modelSetting = settings.defaults.model;
  if (modelSetting) {
    const model = value.modelRuntime.getModel(modelSetting.provider, modelSetting.id);
    if (model) await value.setModel(model);
  }
  const thinkingLevel = settings.defaults.thinkingLevel;
  if (thinkingLevel && value.getAvailableThinkingLevels().includes(thinkingLevel as any)) {
    value.setThinkingLevel(thinkingLevel as any);
  }
}

async function applyDefaultSessionBucket(sessionId: string) {
  const color = (await settingsStore.read()).defaults.sessionBucketColor;
  if (!sessionId || !color) return undefined;
  const current = await sessionUiStateStore.read();
  if (current.sessionMarkers.some((marker) => marker.sessionId === sessionId)) return current;
  const sessionUiState = await sessionUiStateStore.write({
    ...current,
    sessionMarkers: [{ sessionId, color, updatedAt: new Date().toISOString() }, ...current.sessionMarkers],
  });
  broadcast({ type: "session_ui_state_changed", sessionUiState });
  return sessionUiState;
}

async function createNewLiveSession(cwd?: string, previousSessionFile?: string, agent?: AgentKind) {
  const targetCwd = cwd ? await assertDirectory(cwd, piCwd) : piCwd;
  knownCwds.add(targetCwd);
  await ensurePiWebStorage(targetCwd);
  const settings = await settingsStore.read();
  // Same precedence rule as boot: explicit param wins; in mockMode we always
  // produce a mock session; otherwise consult the persisted last-used agent.
  const targetAgent: AgentKind = agent
    || (mockMode ? "mock" : (settings.defaults.agent || "pi"));
  const created = await makeAdapter(targetAgent, {
    sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
    cwd: targetCwd,
  });
  if (created.modelFallbackMessage) console.warn(created.modelFallbackMessage);
  const value = created.session;
  if (mockMode) {
    value.sessionManager.newSession();
    value.agent.state.messages = value.sessionManager.buildSessionContext().messages;
  }
  // Apply default model/thinking only for pi-style sessions; CC adapter
  // bootstraps its own defaults from settings inside createClaudeCodeAdapter().
  if (targetAgent !== "claude-code") {
    await applyDefaultSessionSettings(value);
  }

  // Persist last-used agent so the next "+" defaults to the same kind.
  if (targetAgent === "pi" || targetAgent === "claude-code") {
    if (settings.defaults.agent !== targetAgent) {
      await settingsStore.patch({ defaults: { agent: targetAgent } });
    }
  }

  const liveSession = registerLiveSession(value);
  await applyDefaultSessionBucket(liveSession.sessionId);
  return liveSession;
}

async function transferCurrentTabUiState(oldSessionId: string, newSessionId: string, _newLabel: string, cwd: string) {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return sessionUiStateStore.read();
  const current = await sessionUiStateStore.read();
  const oldPinnedIndex = current.pinnedSessions.findIndex((item) => item.id === oldSessionId);
  const oldMarker = current.sessionMarkers.find((item) => item.sessionId === oldSessionId);
  const hasUnreadState = current.sessionUnreadStates.some((item) => item.sessionId === oldSessionId || item.sessionId === newSessionId);
  if (oldPinnedIndex === -1 && !oldMarker && !hasUnreadState) return current;

  const pinnedSessions = current.pinnedSessions.filter((item) => item.id !== oldSessionId && item.id !== newSessionId);
  if (oldPinnedIndex !== -1) {
    pinnedSessions.splice(Math.min(oldPinnedIndex, pinnedSessions.length), 0, { id: newSessionId, cwd });
  }

  const sessionMarkers = current.sessionMarkers.filter((item) => item.sessionId !== oldSessionId && item.sessionId !== newSessionId);
  if (oldMarker) {
    sessionMarkers.unshift({ sessionId: newSessionId, color: oldMarker.color, updatedAt: new Date().toISOString() });
  }
  const sessionUnreadStates = current.sessionUnreadStates.filter((item) => item.sessionId !== oldSessionId && item.sessionId !== newSessionId);

  const next = await sessionUiStateStore.write({ ...current, pinnedSessions, sessionMarkers, sessionUnreadStates });
  broadcast({ type: "session_ui_state_changed", sessionUiState: next });
  return next;
}

async function switchEmptySessionCwd(targetSession: PiWebSession, cwd: string) {
  if (targetSession.isStreaming) throw new Error("Wait for the current response to finish before changing the working directory.");
  if (targetSession.isCompacting) throw new Error("Wait for compaction to finish before changing the working directory.");
  if (hasUserMessages(targetSession)) throw new Error("Working directory can only be changed before the first message.");
  const agentKind: AgentKind = (targetSession as AgentAdapter).kind === "claude-code"
    ? "claude-code"
    : (targetSession as AgentAdapter).kind === "mock" ? "mock" : "pi";
  const newSession = await createNewLiveSession(cwd, targetSession.sessionFile, agentKind);
  return currentStateWithThinkingLevels(newSession);
}

async function navigateSession(targetSession: PiWebSession, targetId: string, options: Record<string, unknown>) {
  if (targetSession.isStreaming) throw new SessionServiceError("Wait for the current response to finish before navigating the tree", 409);
  if (targetSession.isCompacting) throw new SessionServiceError("Wait for the current compaction to finish before navigating the tree", 409);
  if (!targetSession.navigateTree) throw new SessionServiceError("Tree navigation is not available");
  const releaseWorkLease = acquireWorkLease(targetSession);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    releaseWorkLease();
    broadcast({ type: "session_runtime_changed", sessionId: targetSession.sessionId, sessionFile: targetSession.sessionFile, runtime: sessionActivity.runtimeForPath(targetSession.sessionFile) });
  };
  try {
    const navigation = targetSession.navigateTree(targetId, options as any);
    broadcast({ type: "session_runtime_changed", sessionId: targetSession.sessionId, sessionFile: targetSession.sessionFile, runtime: sessionActivity.runtimeForPath(targetSession.sessionFile) });
    const result = await navigation;
    const state = currentStateWithThinkingLevels(targetSession);
    broadcast({ type: "state_changed", ...state });
    return { ...result, leafId: targetSession.sessionManager.getLeafId?.() || null, state, finish };
  } catch (error) {
    finish();
    throw error;
  }
}

async function startSessionPrompt(targetSession: PiWebSession, input: { message: string; mode: string; images: Array<{ data: string; mimeType: string; name?: string }> }) {
  const imageFileNote = await persistPromptImages(input.images, sessionCwd(targetSession));
  const promptText = `${input.message || "Please review the attached image."}${imageFileNote}`;
  if (!targetSession.isStreaming && !targetSession.isCompacting) sessionActivity.ensureStarted(targetSession);
  const promptSessionFile = targetSession.sessionFile;
  const releaseWorkLease = acquireWorkLease(targetSession);
  void targetSession.prompt(promptText, {
    ...(targetSession.isStreaming ? { streamingBehavior: input.mode } : {}),
    ...(input.images.length ? { images: input.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })) } : {}),
  }).catch((error: unknown) => broadcast({ type: "server_error", sessionId: targetSession.sessionId, sessionFile: targetSession.sessionFile, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      const isRunning = Boolean(targetSession.isStreaming || targetSession.isCompacting);
      if (promptSessionFile && sessionActivity.hasStarted(promptSessionFile) && !isRunning) {
        sessionActivity.clearStarted(targetSession, promptSessionFile);
        markSessionUnreadCompleted(targetSession.sessionId);
      }
      broadcast({ type: "session_runtime_changed", sessionId: targetSession.sessionId, sessionFile: targetSession.sessionFile, runtime: sessionActivity.runtimeForPath(targetSession.sessionFile) });
      releaseWorkLease();
    });
}

async function startSessionRetry(targetSession: PiWebSession) {
  try { assertCanRetryFromFailure(targetSession); } catch (error) { throw new SessionServiceError(error instanceof Error ? error.message : String(error), 409); }
  sessionActivity.ensureStarted(targetSession);
  const retrySessionFile = targetSession.sessionFile;
  const releaseWorkLease = acquireWorkLease(targetSession);
  void retrySessionFromFailure(targetSession).catch((error: unknown) => {
    sessionActivity.clearStarted(targetSession, retrySessionFile);
    broadcast({ type: "server_error", sessionId: targetSession.sessionId, sessionFile: targetSession.sessionFile, error: error instanceof Error ? error.message : String(error) });
  }).finally(() => {
    const isRunning = Boolean(targetSession.isStreaming || targetSession.isCompacting);
    if (retrySessionFile && sessionActivity.hasStarted(retrySessionFile) && !isRunning) {
      sessionActivity.clearStarted(targetSession, retrySessionFile);
      markSessionUnreadCompleted(targetSession.sessionId);
    }
    broadcast({ type: "session_runtime_changed", sessionId: targetSession.sessionId, sessionFile: targetSession.sessionFile, runtime: sessionActivity.runtimeForPath(targetSession.sessionFile) });
    releaseWorkLease();
  });
}

const webUiBridge = createWebUiBridge({
  emit: broadcast,
  clientCount: () => realtimeHub.clientCount,
  acquireWorkLease,
  createNewSession: createNewLiveSession,
  sessionCwd: (value) => sessionCwd(value),
  state: (value) => currentStateWithThinkingLevels(value),
});

const sessionService = new LocalSessionService({
  currentSessionId: () => session.sessionId,
  globalCwd: () => piCwd,
  resolve: (id) => getOrCreateLiveSessionById(id),
  cwd: (value) => sessionCwd(value),
  decorateState: (value) => currentStateWithThinkingLevels(value),
  decorateMessageContent: (content, sessionFile) => sessionActivity.decorateMessageContent(content, sessionFile),
  availableModels: (value) => getAvailableModels(value),
  webCommands: webSlashCommands,
  list: listSessionInfos,
  create: createNewLiveSession,
  open: switchToSessionId,
  delete: deleteSessionById,
  switchCwd: switchEmptySessionCwd,
  executeCommand: executeSlashCommand,
  prompt: startSessionPrompt,
  retry: startSessionRetry,
  navigate: navigateSession,
  invokeHeaderAction: (value, key) => webUiBridge.invokeHeaderAction(value, key),
  invokeArtifactAction: (value, input) => webUiBridge.invokeArtifactAction(value, input),
  invokeGitTab: (value, input) => webUiBridge.invokeGitTab(value, input),
  reportError: (value, error) => broadcast({ type: "server_error", sessionId: value.sessionId, sessionFile: value.sessionFile, error: error instanceof Error ? error.message : String(error) }),
});

await ensurePiWebStorage();

// Boot the initial session using the persisted last-used agent (defaults to
// pi on first run). In mockMode we always boot the mock harness regardless of
// saved settings so test fixtures stay deterministic; the saved "agent"
// preference is only relevant outside mockMode.
const bootSettings = await settingsStore.read();
const bootAgent: AgentKind = mockMode
  ? "mock"
  : (bootSettings.defaults.agent || "pi");
const createdSession = await makeAdapter(bootAgent);
session = registerLiveSession(createdSession.session);
modelFallbackMessage = createdSession.modelFallbackMessage;

if (modelFallbackMessage) {
  console.warn(modelFallbackMessage);
}

let viteDevServer: ViteDevServer | undefined;

const server = createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      if (method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
        return serveArtifact(req, res);
      }

      if (!isAuthorized(req)) return unauthorized(res);

      if (mockMode && method === "POST" && url.pathname === "/api/mock/reset") {
        await Promise.all(Array.from(liveSessions.keys()).map((key) => disposeLiveSession(key, "reset", true)));
        resetMockSessions();
        await sessionUiStateStore.write(defaultSessionUiState);
        session = registerLiveSession(createMockSession());
        broadcast({ type: "session_ui_state_changed", sessionUiState: defaultSessionUiState });
        broadcast({ type: "state_changed", ...currentState() });
        return sendJson(res, 200, { ok: true });
      }

      if (mockMode && method === "GET" && url.pathname === "/api/mock/live-sessions") {
        return sendJson(res, 200, {
          ok: true,
          liveSessions: Array.from(liveSessions.values()).map((entry) => ({
            sessionId: String(entry.session?.sessionId || ""),
            sessionFile: String(entry.session?.sessionFile || ""),
            viewerLeases: entry.viewerClientIds.size,
            workLeases: entry.workLeases,
            hasDisposeTimer: Boolean(entry.disposeTimer),
            isStreaming: Boolean(entry.session?.isStreaming),
            isCompacting: Boolean(entry.session?.isCompacting),
          })),
          viewerLeases: Array.from(viewerLeases.entries()).map(([clientId, lease]) => ({
            clientId,
            sessionKey: lease.sessionKey,
            sockets: lease.sockets.size,
            hasReleaseTimer: Boolean(lease.releaseTimer),
          })),
          lifecycle: getMockLifecycle(),
        });
      }

      if (method === "GET" && url.pathname === "/api/fs/dirs") {
        try {
          return sendJson(res, 200, await listDirectories(url.searchParams.get("path") || piCwd, piCwd));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/fs/dirs") {
        const body = await readBody(req) as { parent?: unknown; name?: unknown };
        try {
          return sendJson(res, 201, await createDirectory(String(body.parent || piCwd), String(body.name || ""), piCwd));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/repos") {
        return sendJson(res, 200, await listGitRepos(await requestCwdFromSessionId(url.searchParams.get("sessionId"))));
      }

      if (method === "GET" && url.pathname === "/api/git/status") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          return sendJson(res, 200, await gitStatus(await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd), url.searchParams.get("fetch") === "1"));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/repo-info") {
        try {
          const cwdParam = url.searchParams.get("cwd");
          const target = cwdParam && isAbsolute(cwdParam) ? await assertDirectory(cwdParam) : await gitCwdFromRepoParam(url.searchParams.get("repo"), piCwd);
          return sendJson(res, 200, await getRepoInfo(target));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/log") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          return sendJson(res, 200, await gitLog(await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd)));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/commit") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          return sendJson(res, 200, await gitCommitDetails(url.searchParams.get("hash") || "", await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd)));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/diff") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd);
          if (!await isGitRepo(cwd)) return sendJson(res, 404, { ok: false, error: "Not a Git repository" });
          return sendJson(res, 200, await gitDiff({
            cwd,
            path: url.searchParams.get("path") || "",
            staged: url.searchParams.get("staged") === "1",
          }));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/image") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd);
          if (!await isGitRepo(cwd)) return sendJson(res, 404, { ok: false, error: "Not a Git repository" });
          const image = await readGitImage({
            cwd,
            path: url.searchParams.get("path") || "",
            oldPath: url.searchParams.get("oldPath") || undefined,
            version: url.searchParams.get("version") || "",
            staged: url.searchParams.get("staged") === "1",
          });
          if (!image) return sendJson(res, 415, { ok: false, error: "Not an image file" });
          res.writeHead(200, {
            "content-type": contentTypes[extname(image.displayPath).toLowerCase()] || "application/octet-stream",
            "cache-control": "no-store",
          });
          if ("file" in image && typeof image.file === "string") pipeReadStream(res, image.file);
          else res.end(image.data);
          return;
        } catch (error) {
          return sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/git/sync") {
        try {
          const baseCwd = await requestCwdFromSessionId(url.searchParams.get("sessionId"));
          const cwd = await gitCwdFromRepoParam(url.searchParams.get("repo"), baseCwd);
          if (!await isGitRepo(cwd)) return sendJson(res, 404, { ok: false, error: "Not a Git repository" });
          return sendJson(res, 200, await gitSync(cwd));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/state") {
        const requestedSessionId = url.searchParams.get("sessionId") || undefined;
        noteViewerLeaseFromRequest(req, await sessionService.require(requestedSessionId), url.searchParams.get("clientId"));
        return sendJson(res, 200, {
          ok: true,
          ...await sessionService.state(requestedSessionId),
          sessionUiState: await sessionUiStateStore.read(),
          tokenRequired: Boolean(token),
        });
      }

      if (method === "POST" && url.pathname === "/api/web-header-action/invoke") {
        const body = await readBody(req) as { sessionId?: unknown; key?: unknown };
        try {
          return sendJson(res, 200, { ok: true, ...await sessionService.invokeHeaderAction(typeof body.sessionId === "string" ? body.sessionId : undefined, body.key) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = error instanceof SessionServiceError ? error.status : message === "key is required" || message === "Header action returned no markdown" ? 400 : message === "Header action not found" ? 404 : 500;
          return sendJson(res, status, { ok: false, error: message });
        }
      }

      if (method === "POST" && url.pathname === "/api/web-artifact-action/invoke") {
        const body = await readBody(req) as { sessionId?: unknown } & Record<string, unknown>;
        try {
          return sendJson(res, 200, { ok: true, ...await sessionService.invokeArtifactAction(typeof body.sessionId === "string" ? body.sessionId : undefined, body) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = error instanceof SessionServiceError ? error.status : message === "Artifact action not found" ? 404 : message === "Invalid artifact context" || message === "Artifact action does not match this artifact" || message === "key is required" || message === "Artifact action returned no result" ? 400 : 500;
          return sendJson(res, status, { ok: false, error: message });
        }
      }

      if (method === "POST" && url.pathname === "/api/web-git-tab/invoke") {
        const body = await readBody(req) as { sessionId?: unknown; key?: unknown; action?: unknown; payload?: unknown; repo?: unknown };
        try {
          return sendJson(res, 200, { ok: true, ...await sessionService.invokeGitTab(typeof body.sessionId === "string" ? body.sessionId : undefined, body) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = error instanceof SessionServiceError ? error.status : message === "key is required" || message === "Git tab returned no HTML or composer context" ? 400 : message === "Git tab not found" ? 404 : 500;
          return sendJson(res, status, { ok: false, error: message });
        }
      }

      if (method === "GET" && url.pathname === "/api/session/stats") {
        return sendJson(res, 200, { ok: true, ...await sessionService.stats(url.searchParams.get("sessionId") || undefined) });
      }

      if (method === "GET" && url.pathname === "/api/session/tree") {
        return sendJson(res, 200, await sessionService.tree(url.searchParams.get("sessionId") || undefined));
      }

      if (method === "POST" && url.pathname === "/api/session/tree/navigate") {
        const body = await readBody(req) as { sessionId?: unknown; targetId?: unknown; summarize?: unknown; customInstructions?: unknown; replaceInstructions?: unknown; label?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
        await sessionService.require(requestedSessionId);
        const targetId = String(body.targetId || "").trim();
        if (!targetId) return sendJson(res, 400, { ok: false, error: "targetId is required" });
        const { finish, ...result } = await sessionService.navigate(requestedSessionId, targetId, {
          summarize: Boolean(body.summarize),
          customInstructions: typeof body.customInstructions === "string" && body.customInstructions.trim() ? body.customInstructions.trim() : undefined,
          replaceInstructions: Boolean(body.replaceInstructions),
          label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined,
        });
        try {
          return sendJson(res, 200, { ok: true, ...result });
        } finally {
          finish();
        }
      }

      if (method === "POST" && url.pathname === "/api/session/tree/abort-summary") {
        const body = await readBody(req) as { sessionId?: unknown };
        return sendJson(res, 202, { ok: true, ...await sessionService.abortBranchSummary(typeof body.sessionId === "string" ? body.sessionId : undefined) });
      }

      if (method === "GET" && url.pathname === "/api/messages") {
        return sendJson(res, 200, { ok: true, messages: await sessionService.messages(url.searchParams.get("sessionId") || undefined) });
      }

      if (method === "GET" && url.pathname === "/api/sessions") {
        const extraCwds = url.searchParams.getAll("cwd");
        const sessionUiState = await sessionUiStateStore.read();
        return sendJson(res, 200, { ok: true, sessions: applySessionUnreadState(await sessionService.list(extraCwds), sessionUiState) });
      }

      if (method === "GET" && url.pathname === "/api/session-ui-state") {
        return sendJson(res, 200, { ok: true, sessionUiState: await sessionUiStateStore.read() });
      }

      if (method === "PATCH" && url.pathname === "/api/session-ui-state") {
        const sessionUiState = await sessionUiStateStore.patch(await readBody(req));
        broadcast({ type: "session_ui_state_changed", sessionUiState });
        return sendJson(res, 200, { ok: true, sessionUiState });
      }

      if (method === "POST" && url.pathname === "/api/session-ui-state/read") {
        const body = await readBody(req) as { sessionId?: unknown };
        const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : session.sessionId;
        const sessionUiState = await sessionUiStateStore.markRead(sessionId);
        broadcast({ type: "session_ui_state_changed", sessionUiState });
        return sendJson(res, 200, { ok: true, sessionUiState });
      }

      if (method === "POST" && url.pathname === "/api/sessions/delete") {
        const body = await readBody(req) as { sessionId?: unknown; id?: unknown; cwd?: unknown; activeSessionId?: unknown };
        const requestedId = typeof body.sessionId === "string" ? body.sessionId : typeof body.id === "string" ? body.id : "";
        const activeSessionId = typeof body.activeSessionId === "string" ? body.activeSessionId : "";
        if (!requestedId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });
        if (activeSessionId && activeSessionId === requestedId) return sendJson(res, 409, { ok: false, error: "Switch to another session before deleting the current session." });
        try {
          const result = await sessionService.delete(requestedId, typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : undefined) as { id: string; disposition: "trashed" | "deleted" };
          const sessionUiState = await sessionUiStateStore.removeSession(result.id);
          broadcast({ type: "session_deleted", sessionId: result.id, disposition: result.disposition });
          broadcast({ type: "session_ui_state_changed", sessionUiState });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error: any) {
          return sendJson(res, Number(error?.status) || 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }


      if (method === "GET" && url.pathname === "/api/settings") {
        return sendJson(res, 200, { ok: true, settings: await settingsStore.read() });
      }

      if (method === "PATCH" && url.pathname === "/api/settings") {
        const settings = await settingsStore.patch(await readBody(req));
        broadcast({ type: "settings_updated", settings });
        return sendJson(res, 200, { ok: true, settings });
      }

      if (method === "GET" && url.pathname === "/api/commands") {
        return sendJson(res, 200, { ok: true, commands: await sessionService.commands(url.searchParams.get("sessionId") || undefined) });
      }

      if (method === "GET" && url.pathname === "/api/models") {
        return sendJson(res, 200, { ok: true, ...await sessionService.models(url.searchParams.get("sessionId") || undefined) });
      }

      if (method === "POST" && url.pathname === "/api/model") {
        const body = await readBody(req) as { sessionId?: unknown; provider?: unknown; id?: unknown; thinkingLevel?: unknown };
        const provider = String(body.provider || "").trim();
        const id = String(body.id || "").trim();
        if (!provider || !id) return sendJson(res, 400, { ok: false, error: "provider and id are required" });
        const state = await sessionService.setModel(typeof body.sessionId === "string" ? body.sessionId : undefined, provider, id, typeof body.thinkingLevel === "string" ? body.thinkingLevel : undefined);
        // Persist the pick as the default for future sessions (same last-used
        // pattern as defaults.agent). Cross-agent picks are benign: each agent's
        // apply path validates against its own registry and no-ops on a miss.
        await settingsStore.patch({ defaults: { model: { provider, id }, ...(typeof body.thinkingLevel === "string" ? { thinkingLevel: body.thinkingLevel } : {}) } });
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && url.pathname === "/api/command") {
        const body = await readBody(req) as { sessionId?: unknown; command?: unknown };
        const command = String(body.command || "").trim();
        if (!command.startsWith("/")) return sendJson(res, 400, { ok: false, error: "Slash command is required" });

        const result = await sessionService.executeCommand(typeof body.sessionId === "string" ? body.sessionId : undefined, command);
        const stateSessionId = (result as any)?.state?.sessionId;
        const stateSession = typeof stateSessionId === "string" ? await getOrCreateLiveSessionById(stateSessionId) : undefined;
        noteViewerLeaseFromRequest(req, stateSession || await sessionService.require(typeof body.sessionId === "string" ? body.sessionId : undefined));
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && url.pathname === "/api/shell") {
        const body = await readBody(req) as { sessionId?: unknown; command?: unknown; excludeFromContext?: unknown };
        const command = String(body.command || "").trim();
        if (!command) return sendJson(res, 400, { ok: false, error: "command is required" });
        return sendJson(res, 200, { ok: true, ...await sessionService.executeShell(typeof body.sessionId === "string" ? body.sessionId : undefined, command, Boolean(body.excludeFromContext)) });
      }

      if (method === "POST" && url.pathname === "/api/extension-ui/respond") {
        const body = await readBody(req) as { id?: unknown } & Record<string, unknown>;
        const id = String(body.id || "").trim();
        if (!id) return sendJson(res, 400, { ok: false, error: "id is required" });
        if (!webUiBridge.respond(id, body)) return sendJson(res, 404, { ok: false, error: "Extension UI request not found" });
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && url.pathname === "/api/prompt") {
        const body = await readBody(req) as { sessionId?: unknown; message?: unknown; mode?: unknown; images?: unknown };
        const message = String(body.message || "").trim();
        const images = Array.isArray(body.images) ? body.images.flatMap((image) => {
          if (!image || typeof image !== "object") return [];
          const value = image as Record<string, unknown>;
          return value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string" && value.mimeType.startsWith("image/")
            ? [{ data: value.data, mimeType: value.mimeType, ...(typeof value.name === "string" ? { name: value.name } : {}) }]
            : [];
        }) : [];
        if (!message && images.length === 0) return sendJson(res, 400, { ok: false, error: "message or image is required" });
        const result = await sessionService.prompt(typeof body.sessionId === "string" ? body.sessionId : undefined, { message, mode: body.mode === "followUp" ? "followUp" : "steer", images });
        return sendJson(res, 202, { ok: true, ...result });
      }

      if (method === "POST" && url.pathname === "/api/session/retry") {
        const body = await readBody(req) as { sessionId?: unknown };
        return sendJson(res, 202, { ok: true, ...await sessionService.retry(typeof body.sessionId === "string" ? body.sessionId : undefined) });
      }

      if (method === "POST" && url.pathname === "/api/abort") {
        const body = await readBody(req) as { sessionId?: unknown };
        return sendJson(res, 202, { ok: true, ...await sessionService.abort(typeof body.sessionId === "string" ? body.sessionId : undefined) });
      }

      if (method === "POST" && url.pathname === "/api/compaction/abort") {
        const body = await readBody(req) as { sessionId?: unknown };
        return sendJson(res, 202, { ok: true, ...await sessionService.abortCompaction(typeof body.sessionId === "string" ? body.sessionId : undefined) });
      }

      if (method === "POST" && url.pathname === "/api/session/name") {
        const body = await readBody(req) as { sessionId?: unknown; name?: unknown };
        const name = String(body.name || "").trim();
        const state = await sessionService.rename(typeof body.sessionId === "string" ? body.sessionId : undefined, name);
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && url.pathname === "/api/session/saved") {
        const body = await readBody(req) as { sessionId?: unknown; saved?: unknown };
        const targetId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (!targetId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });
        const saved = Boolean(body.saved);
        if (saved) savedSessionIds.add(targetId);
        else savedSessionIds.delete(targetId);
        await persistSavedSessions();
        return sendJson(res, 200, { ok: true, sessionId: targetId, saved });
      }

      if (method === "POST" && (url.pathname === "/api/new-chat" || url.pathname === "/api/sessions/new")) {
        const body = await readBody(req) as { cwd?: unknown; sessionId?: unknown; agent?: unknown };
        const requestedAgent = body.agent === "pi" || body.agent === "claude-code" ? body.agent : undefined;
        const previousSession = typeof body.sessionId === "string" ? await getOrCreateLiveSessionById(body.sessionId) : session;
        const targetCwd = typeof body.cwd === "string" ? body.cwd : previousSession ? sessionCwd(previousSession) : undefined;
        const newSession = await createNewLiveSession(targetCwd, previousSession?.sessionFile, requestedAgent);
        noteViewerLeaseFromRequest(req, newSession);
        const state = currentStateWithThinkingLevels(newSession);
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && url.pathname === "/api/session/cwd") {
        const body = await readBody(req) as { sessionId?: unknown; cwd?: unknown };
        const cwd = String(body.cwd || "").trim();
        if (!cwd) return sendJson(res, 400, { ok: false, error: "cwd is required" });
        try {
          const state = await sessionService.switchCwd(typeof body.sessionId === "string" ? body.sessionId : undefined, cwd);
          const stateSession = state.sessionId ? await getOrCreateLiveSessionById(String(state.sessionId)) : undefined;
          if (stateSession) noteViewerLeaseFromRequest(req, stateSession);
          broadcast({ type: "state_changed", ...state });
          return sendJson(res, 200, { ok: true, ...state });
        } catch (error) {
          const status = error instanceof SessionServiceError ? error.status : 400;
          return sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "POST" && url.pathname === "/api/sessions/open") {
        const body = await readBody(req) as { id?: unknown; sessionId?: unknown; cwd?: unknown; clientId?: unknown };
        const requestedId = typeof body.sessionId === "string" ? body.sessionId : typeof body.id === "string" ? body.id : "";
        if (!requestedId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });

        let targetSession: PiWebSession | undefined;
        try {
          targetSession = await switchToSessionId(requestedId, typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : undefined);
        } catch {
          return sendJson(res, 404, { ok: false, error: "Session not found" });
        }
        noteViewerLeaseFromRequest(req, targetSession, body.clientId);
        const state = currentStateWithThinkingLevels(targetSession);
        return sendJson(res, 200, { ok: true, ...state });
      }

      return sendJson(res, 404, { ok: false, error: "Unknown API route" });
    }

    // Server-side cache-bust: when PI_WEB_SW_RESET=1 (env) OR a `.pi-sw-reset`
    // sentinel file exists in the app dir, serve a self-destroying service
    // worker at /sw.js. The sentinel form lets an operator toggle the reset on
    // a running server with `touch .pi-sw-reset` (and `rm` to restore) without
    // a restart, since the check runs per request.
    // A client captured by a stale SW re-fetches the SW script on its next
    // navigation (the spec bypasses the HTTP cache for the script, and our
    // no-store header guarantees it), installs this one, which deletes every
    // cache and unregisters itself — freeing the client to load fresh content
    // straight from the network. Loop-safe: it force-reloads clients only the
    // first time (guarded by a marker cache), so re-registering
    // it does not bounce the page repeatedly. Flip the flag off once clients
    // have recovered to restore the normal PWA service worker.
    if (req.method === "GET" && url.pathname === "/sw.js" && (process.env.PI_WEB_SW_RESET === "1" || existsSync(join(appDir, ".pi-sw-reset")))) {
      const body = `// pi-web self-destroying service worker (PI_WEB_SW_RESET=1)
const KILL_FLAG = 'pi-sw-killed';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const firstTime = !(await caches.has(KILL_FLAG));
    for (const key of await caches.keys()) { if (key !== KILL_FLAG) await caches.delete(key); }
    try { await self.registration.unregister(); } catch (e) {}
    if (firstTime) {
      await caches.open(KILL_FLAG);
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) { try { client.navigate(client.url); } catch (e) {} }
    }
  })());
});
`;
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache, no-store, must-revalidate" });
      res.end(body);
      return;
    }

    if (viteDevServer) {
      viteDevServer.middlewares(req, res, () => {
        if (!res.writableEnded) sendJson(res, 404, { ok: false, error: "Not found" });
      });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    const status = error instanceof SessionServiceError ? error.status : 500;
    sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") return;

  if (!isAuthorized(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", async (ws, req) => {
  const realtimeWs = ws;
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const lastSeq = Number(url.searchParams.get("lastSeq") || 0);
  const latestSeq = realtimeHub.attach(realtimeWs, lastSeq);

  const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
  const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
  const clientId = cleanClientId(url.searchParams.get("clientId") || "");
  if (clientId) {
    acquireViewerLease(clientId, targetSession || session);
    bindViewerSocket(clientId, realtimeWs);
  }
  const helloState = targetSession ? currentState(targetSession) : currentState();
  realtimeWs.send(JSON.stringify({
    type: "hello",
    seq: latestSeq,
    ...helloState,
  }));
});

if (isDev) {
  viteDevServer = await createViteServer({
    appType: "spa",
    server: {
      middlewareMode: true,
      hmr: { server },
    },
  });
}

server.listen(port, host, () => {
  console.log(`pi-web listening on http://${host}:${port}`);
  console.log(`Pi cwd: ${piCwd}`);
  console.log(isDev ? "Mode: development (Vite HMR enabled)" : "Mode: production");
  console.log(token ? "Auth: bearer token required" : "Auth: disabled (set PI_WEB_TOKEN to enable)");
});
