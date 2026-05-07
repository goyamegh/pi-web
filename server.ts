import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join, resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { createMockHarness } from "./server/mock.js";
import type { PiWebSession } from "./server/types.js";

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const distDir = join(appDir, "dist");
const staticDir = distDir;

const isDev = process.env.PI_WEB_DEV === "1" || process.env.NODE_ENV === "development";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const token = process.env.PI_WEB_TOKEN || "";
const piCwd = resolve(process.env.PI_WEB_CWD || process.cwd());
const artifactDir = join(piCwd, ".pi-web-uploads", "artifacts");
const webUiContextFile = join(appDir, "contexts", "web-ui.md");
const noSession = process.env.PI_WEB_NO_SESSION === "1";
const mockMode = process.env.PI_WEB_MOCK === "1";
const execFileAsync = promisify(execFile);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

function safeArtifactName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 160);
}

function serveArtifact(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const rawName = decodeURIComponent(url.pathname.slice("/api/artifacts/".length));
  const name = safeArtifactName(rawName);
  if (!name || rawName.includes("..") || rawName.includes("/") || name !== rawName) return sendJson(res, 400, { ok: false, error: "Invalid artifact name" });

  const file = resolve(artifactDir, name);
  if (!file.startsWith(artifactDir) || !existsSync(file)) return sendJson(res, 404, { ok: false, error: "Artifact not found" });

  res.writeHead(200, {
    "content-type": contentTypes[extname(file).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
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

  res.writeHead(200, { "content-type": contentTypes[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") return p.text;
    if (p.type === "image") return "[image]";
    // toolCall parts are rendered as tool cards in the UI — omit from text
    return "";
  }).filter(Boolean).join("\n");
}

function simplifyModel(model: any) {
  if (!model) return undefined;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

async function git(args: string[], timeout = 15_000) {
  return execFileAsync("git", args, { cwd: piCwd, timeout, maxBuffer: 10 * 1024 * 1024 });
}

async function isGitRepo() {
  try { await git(["rev-parse", "--is-inside-work-tree"]); return true; } catch { return false; }
}

function gitLabel(indexStatus: string, worktreeStatus: string) {
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (indexStatus === "U" || worktreeStatus === "U" || indexStatus === "A" && worktreeStatus === "A" || indexStatus === "D" && worktreeStatus === "D") return "conflicted";
  if (indexStatus === "R" || worktreeStatus === "R") return "renamed";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus !== " " && indexStatus !== "?") return "staged";
  return "modified";
}

function parseStatusLine(line: string) {
  const indexStatus = line[0] || " ";
  const worktreeStatus = line[1] || " ";
  const rawPath = line.slice(3);
  const renamed = rawPath.includes(" -> ");
  const [oldPath, path] = renamed ? rawPath.split(" -> ") : [undefined, rawPath];
  return { path: path || rawPath, oldPath, indexStatus, worktreeStatus, label: gitLabel(indexStatus, worktreeStatus), staged: indexStatus !== " " && indexStatus !== "?" };
}

async function gitStatus() {
  if (!await isGitRepo()) return { ok: true, isRepo: false, ahead: 0, behind: 0, files: [] };
  const [{ stdout: root }, { stdout: branchOut }, { stdout: porcelain }, upstreamResult, defaultResult] = await Promise.all([
    git(["rev-parse", "--show-toplevel"]),
    git(["branch", "--show-current"]).catch(() => ({ stdout: "" })),
    git(["status", "--porcelain=v1", "-b"]),
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => ({ stdout: "" })),
    git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => ({ stdout: "" })),
  ]);
  const lines = porcelain.trimEnd().split("\n").filter(Boolean);
  const header = lines[0] || "";
  const ahead = Number(header.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(header.match(/behind (\d+)/)?.[1] || 0);
  const trackedFiles = lines.slice(1).map(parseStatusLine).filter((file) => file.label !== "untracked");
  const { stdout: untrackedOut } = await git(["ls-files", "--others", "--exclude-standard"]).catch(() => ({ stdout: "" }));
  const untrackedFiles = untrackedOut.split("\n").map((path) => path.trim()).filter(Boolean).map((path) => ({
    path,
    indexStatus: "?",
    worktreeStatus: "?",
    label: "untracked",
    staged: false,
  }));
  return {
    ok: true,
    isRepo: true,
    root: root.trim(),
    branch: branchOut.trim(),
    upstream: upstreamResult.stdout.trim(),
    defaultRemoteBranch: defaultResult.stdout.trim(),
    ahead,
    behind,
    files: [...trackedFiles, ...untrackedFiles],
  };
}

function safeGitPath(path: string) {
  if (!path || path.startsWith("/") || path.includes("..") || path.includes("\0")) throw new Error("Invalid path");
  return path;
}

function parseCommit(entry: string) {
  const [hash = "", shortHash = "", parents = "", author = "", date = "", refs = "", subject = ""] = entry.split("\x1f");
  return { hash, shortHash, parents: parents ? parents.split(" ").filter(Boolean) : [], author, date, refs: refs ? refs.split(", ").filter(Boolean) : [], subject };
}

async function gitLog() {
  if (!await isGitRepo()) return { ok: true, isRepo: false, commits: [] };
  const { stdout } = await git(["log", "--all", "-n", "200", "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s%x1e"]);
  const commits = stdout.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map(parseCommit);
  return { ok: true, isRepo: true, commits };
}

async function gitCommitDetails(hash: string) {
  if (!await isGitRepo()) throw new Error("Not a Git repository");
  if (!/^[a-f0-9]{7,40}$/i.test(hash)) throw new Error("Invalid commit hash");
  const [{ stdout: commitOut }, { stdout: nameOut }, { stdout: numstatOut }, { stdout: diff }] = await Promise.all([
    git(["show", "-s", "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s", hash]),
    git(["show", "--name-status", "--format=", hash]),
    git(["show", "--numstat", "--format=", hash]),
    git(["show", "--format=", "--patch", "--find-renames", hash]),
  ]);
  const stats = new Map<string, { additions?: number; deletions?: number }>();
  for (const line of numstatOut.split("\n").filter(Boolean)) {
    const [add, del, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    stats.set(path, { additions: Number(add) || 0, deletions: Number(del) || 0 });
  }
  const files = nameOut.split("\n").filter(Boolean).map((line) => {
    const [status, ...parts] = line.split("\t");
    const path = parts.at(-1) || "";
    return { path, status, ...(stats.get(path) || {}) };
  });
  return { ok: true, commit: parseCommit(commitOut.trim()), files, diff };
}

// Models confirmed broken with this Copilot integration — tracked at runtime.
const blockedModelIds = new Set<string>();

// Parse allowed model IDs from Copilot's model_not_available_for_integrator error.
// Returns null if no such error has been seen yet.
function copilotAllowedIdsFromSession(): Set<string> | null {
  const entries = session.messages;
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

function getAvailableModels() {
  const all = session.modelRegistry.getAvailable();
  const allowed = copilotAllowedIdsFromSession();
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

async function persistPromptImages(images: Array<{ data: string; mimeType: string; name?: string }>) {
  if (!images.length) return "";
  const uploadDir = join(piCwd, ".pi-web-uploads");
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

function simplifyMessage(message: unknown, toolCallArgs?: Map<string, Record<string, unknown>>) {
  if (!message || typeof message !== "object") return message;
  const m = message as Record<string, unknown>;
  if (m.role === "toolResult") {
    const args = toolCallArgs?.get(m.toolCallId as string);
    return {
      role: "toolResult",
      toolName: m.toolName,
      toolArgs: args,
      isError: Boolean(m.isError),
      text: textFromContent(m.content),
      timestamp: m.timestamp,
      raw: m,
    };
  }
  return {
    role: m.role,
    text: textFromContent(m.content),
    timestamp: m.timestamp,
    raw: m,
  };
}

function runtimeForPath(path: string) {
  const live = liveSessions.get(path)?.session;
  const isStreaming = Boolean(live?.isStreaming);
  const isCompacting = Boolean(live?.isCompacting);
  return {
    loaded: Boolean(live),
    isRunning: isStreaming || isCompacting,
    isStreaming,
    isCompacting,
    pendingMessageCount: Number(live?.pendingMessageCount || 0),
    model: simplifyModel(live?.model),
  };
}

function simplifySessionInfo(info: Awaited<ReturnType<typeof SessionManager.list>>[number]) {
  return {
    id: info.id,
    name: info.name,
    firstMessage: info.firstMessage,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    isCurrent: info.id === session.sessionId,
    runtime: runtimeForPath(info.path),
  };
}

async function listSessionInfos() {
  if (noSession) return [];
  if (mockMode) return mockSessions.map(simplifySessionInfo);
  const sessions = await SessionManager.list(piCwd);
  return sessions.map(simplifySessionInfo);
}

function currentState() {
  return {
    cwd: piCwd,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.getSessionName?.(),
    isStreaming: session.isStreaming,
    model: simplifyModel(session.model),
    thinkingLevel: session.thinkingLevel,
  };
}

function currentStateWithThinkingLevels() {
  return {
    ...currentState(),
    thinkingLevels: session.getAvailableThinkingLevels(),
  };
}

function slashHelp() {
  return [
    "Supported web slash commands:",
    "/help - show this help",
    "/reload - reload pi resources/extensions/models",
    "/model - list available models",
    "/model <provider/model-id> - switch model",
    "/models - list available models",
    "/thinking <level> - set thinking level",
    "/new - start a new session",
    "/abort - stop the current response",
  ].join("\n");
}

function formatModelList() {
  return getAvailableModels()
    .map((model: any) => `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`)
    .join("\n");
}

async function executeSlashCommand(input: string) {
  const trimmed = input.trim();
  const [rawName = "", ...rest] = trimmed.replace(/^\/+/, "").split(/\s+/);
  const name = rawName.toLowerCase();
  const args = rest.join(" ").trim();

  switch (name) {
    case "help":
    case "?":
      return { message: slashHelp(), state: currentStateWithThinkingLevels() };

    case "reload": {
      if (session.isStreaming) throw new Error("Wait for the current response to finish before reloading.");
      if (session.isCompacting) throw new Error("Wait for compaction to finish before reloading.");
      if (typeof session.reload !== "function") throw new Error("Reload is not available in this session.");
      await session.reload();
      return { message: "Reloaded pi resources, extensions, and models.", state: currentStateWithThinkingLevels() };
    }

    case "model": {
      if (!args) {
        return { message: formatModelList() || "No models available.", state: currentStateWithThinkingLevels() };
      }
      const slashIndex = args.indexOf("/");
      if (slashIndex <= 0) throw new Error("Usage: /model <provider/model-id>");
      const provider = args.slice(0, slashIndex);
      const id = args.slice(slashIndex + 1);
      const model = session.modelRegistry.find(provider, id);
      if (!model) throw new Error(`Model not found: ${args}`);
      await session.setModel(model);
      return { message: `Model set to ${provider}/${id}.`, state: currentStateWithThinkingLevels() };
    }

    case "models":
      return { message: formatModelList() || "No models available.", state: currentStateWithThinkingLevels() };

    case "thinking": {
      if (!args) {
        return { message: `Thinking level: ${session.thinkingLevel}\nAvailable: ${session.getAvailableThinkingLevels().join(", ")}`, state: currentStateWithThinkingLevels() };
      }
      const levels = session.getAvailableThinkingLevels();
      if (!levels.includes(args as any)) throw new Error(`Unknown thinking level: ${args}. Available: ${levels.join(", ")}`);
      session.setThinkingLevel(args as any);
      return { message: `Thinking level set to ${session.thinkingLevel}.`, state: currentStateWithThinkingLevels() };
    }

    case "new":
    case "new-chat":
    case "clear": {
      session = await createNewLiveSession();
      return { message: "New session.", state: currentStateWithThinkingLevels() };
    }

    case "abort":
    case "stop":
      await session.abort();
      return { message: "Aborted.", state: currentStateWithThinkingLevels() };

    default:
      throw new Error(`Unknown slash command: /${name}. Try /help.`);
  }
}

async function findSessionInfoById(id: string) {
  if (!id) return undefined;
  const sessions = noSession ? [] : mockMode ? mockSessions : await SessionManager.list(piCwd);
  return sessions.find((info) => info.id === id);
}

async function getOrCreateLiveSessionById(id: string) {
  if (id === session.sessionId) return session;
  for (const entry of liveSessions.values()) {
    if (entry.session.sessionId === id) return entry.session;
  }
  const info = await findSessionInfoById(id);
  return info ? getOrCreateLiveSession(info.path) : undefined;
}

async function switchToSessionId(id: string) {
  const target = await getOrCreateLiveSessionById(id);
  if (!target) throw new Error("Session not found");
  session = target;
}

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const liveSessions = new Map<string, { session: any; unsubscribe?: () => void }>();
let session: PiWebSession;
let modelFallbackMessage: string | undefined;

const clients = new Set<WebSocket>();
function broadcast(value: unknown) {
  const data = JSON.stringify(value);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

const mockHarness = createMockHarness({
  piCwd,
  broadcast,
  isCurrentSession: (value: PiWebSession) => value === session,
  currentState,
});
const { mockSessions, createMockSession } = mockHarness;

function sessionPathKey(value: any) {
  return String(value.sessionFile || value.sessionId || "");
}

function registerLiveSession(value: any) {
  const key = sessionPathKey(value);
  if (!key || liveSessions.get(key)?.session === value) return value;

  const unsubscribe = value.subscribe?.((event: unknown) => {
    const eventSessionFile = value.sessionFile;
    const eventSessionId = value.sessionId;
    broadcast({ type: "pi_event", sessionId: eventSessionId, sessionFile: eventSessionFile, event });
    broadcast({
      type: "session_runtime_changed",
      sessionId: eventSessionId,
      sessionFile: eventSessionFile,
      runtime: runtimeForPath(eventSessionFile),
    });

    // Track models that fail with model_not_supported and remove them from the list.
    const e = event as any;

    // Broadcast state update when session name changes
    if (e?.type === "session_info_changed") {
      broadcast({ type: "state_changed", ...currentState() });
    }

    if (e?.type === "message_end" || e?.type === "turn_end") {
      const msg = e?.message ?? e?.toolResults?.[0];
      const err: string = msg?.errorMessage || msg?.message?.errorMessage || "";
      const modelId: string = msg?.model || msg?.message?.model || "";
      if (modelId && (err.includes("model_not_supported") || err.includes("model_not_available"))) {
        if (!blockedModelIds.has(modelId)) {
          blockedModelIds.add(modelId);
          broadcast({ type: "models_updated", models: getAvailableModels().map(simplifyModel) });
        }
      }
    }
  });
  liveSessions.set(key, { session: value, unsubscribe });
  return value;
}

async function makeAgentSession(path?: string) {
  if (mockMode) return { session: createMockSession(path), modelFallbackMessage: undefined };

  const sessionManager = noSession ? SessionManager.inMemory() : SessionManager.create(piCwd);
  if (path && !noSession) sessionManager.setSessionFile(path);

  const webUiContext = existsSync(webUiContextFile) ? readFileSync(webUiContextFile, "utf-8") : "";

  const loader = new DefaultResourceLoader({
    cwd: piCwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [
      ...base,
      webUiContext,
    ].filter(Boolean),
  });
  await loader.reload();

  return createAgentSession({
    cwd: piCwd,
    sessionManager,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
  });
}

async function getOrCreateLiveSession(path: string) {
  const existing = liveSessions.get(path)?.session;
  if (existing) return existing;
  const created = await makeAgentSession(path);
  if (created.modelFallbackMessage) console.warn(created.modelFallbackMessage);
  return registerLiveSession(created.session);
}

async function createNewLiveSession() {
  const created = await makeAgentSession();
  if (created.modelFallbackMessage) console.warn(created.modelFallbackMessage);
  const value = created.session;
  value.sessionManager.newSession();
  value.agent.state.messages = value.sessionManager.buildSessionContext().messages;
  return registerLiveSession(value);
}

const createdSession = await makeAgentSession();
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
        for (const entry of liveSessions.values()) entry.unsubscribe?.();
        liveSessions.clear();
        session = registerLiveSession(createMockSession());
        broadcast({ type: "state_changed", ...currentState() });
        return sendJson(res, 200, { ok: true });
      }

      if (method === "GET" && url.pathname === "/api/git/status") {
        return sendJson(res, 200, await gitStatus());
      }

      if (method === "GET" && url.pathname === "/api/git/log") {
        return sendJson(res, 200, await gitLog());
      }

      if (method === "GET" && url.pathname === "/api/git/commit") {
        try {
          return sendJson(res, 200, await gitCommitDetails(url.searchParams.get("hash") || ""));
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      if (method === "GET" && url.pathname === "/api/git/diff") {
        if (!await isGitRepo()) return sendJson(res, 404, { ok: false, error: "Not a Git repository" });
        const filePath = safeGitPath(url.searchParams.get("path") || "");
        const staged = url.searchParams.get("staged") === "1";
        const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
        let { stdout } = await git(args);
        if (!stdout) {
          const status = await gitStatus() as any;
          const file = status.files?.find((f: any) => f.path === filePath);
          if (file?.label === "untracked") stdout = (await git(["diff", "--no-index", "--", "/dev/null", filePath]).catch((error: any) => ({ stdout: error.stdout || "" }))).stdout;
        }
        return sendJson(res, 200, { ok: true, path: filePath, staged, diff: stdout });
      }

      if (method === "POST" && url.pathname === "/api/git/sync") {
        if (!await isGitRepo()) return sendJson(res, 404, { ok: false, error: "Not a Git repository" });
        const status = await gitStatus() as any;
        const branch = status.branch;
        if (!branch) return sendJson(res, 400, { ok: false, error: "Cannot sync detached HEAD" });
        const fetchResult = await git(["fetch", "--prune", "origin"], 60_000);
        const pullResult = await git(["pull", "--rebase", "--autostash", "origin", branch], 120_000);
        return sendJson(res, 200, { ok: true, output: `${fetchResult.stdout}${fetchResult.stderr}${pullResult.stdout}${pullResult.stderr}`, status: await gitStatus() });
      }

      if (method === "GET" && url.pathname === "/api/state") {
        return sendJson(res, 200, {
          ok: true,
          cwd: piCwd,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          isStreaming: session.isStreaming,
          model: simplifyModel(session.model),
          thinkingLevel: session.thinkingLevel,
          tokenRequired: Boolean(token),
        });
      }

      if (method === "GET" && url.pathname === "/api/messages") {
        const requestedSessionId = url.searchParams.get("sessionId") || session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        const msgs = targetSession.messages;
        // Build toolCallId -> args map from assistant messages
        const toolCallArgs = new Map<string, Record<string, unknown>>();
        for (const m of msgs) {
          const msg = m as any;
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part?.type === "toolCall" && part.id) {
                toolCallArgs.set(part.id, part.arguments || {});
              }
            }
          }
        }
        return sendJson(res, 200, { ok: true, messages: msgs.map((m: unknown) => simplifyMessage(m, toolCallArgs)) });
      }

      if (method === "GET" && url.pathname === "/api/sessions") {
        return sendJson(res, 200, { ok: true, sessions: await listSessionInfos() });
      }

      if (method === "GET" && url.pathname === "/api/models") {
        return sendJson(res, 200, {
          ok: true,
          cwd: piCwd,
          current: simplifyModel(session.model),
          thinkingLevel: session.thinkingLevel,
          thinkingLevels: session.getAvailableThinkingLevels(),
          models: getAvailableModels().map(simplifyModel),
        });
      }

      if (method === "POST" && url.pathname === "/api/model") {
        const body = await readBody(req) as { provider?: unknown; id?: unknown; thinkingLevel?: unknown };
        const provider = String(body.provider || "").trim();
        const id = String(body.id || "").trim();
        if (!provider || !id) return sendJson(res, 400, { ok: false, error: "provider and id are required" });

        const model = session.modelRegistry.find(provider, id);
        if (!model) return sendJson(res, 404, { ok: false, error: "Model not found" });

        await session.setModel(model);
        if (typeof body.thinkingLevel === "string") session.setThinkingLevel(body.thinkingLevel as any);

        const state = {
          cwd: piCwd,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          model: simplifyModel(session.model),
          thinkingLevel: session.thinkingLevel,
          thinkingLevels: session.getAvailableThinkingLevels(),
        };
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && url.pathname === "/api/command") {
        const body = await readBody(req) as { command?: unknown };
        const command = String(body.command || "").trim();
        if (!command.startsWith("/")) return sendJson(res, 400, { ok: false, error: "Slash command is required" });

        const result = await executeSlashCommand(command);
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && url.pathname === "/api/prompt") {
        const body = await readBody(req) as { sessionId?: unknown; message?: unknown; mode?: unknown; images?: unknown };
        const message = String(body.message || "").trim();
        const images = Array.isArray(body.images)
          ? body.images.filter((image): image is { type: "image"; data: string; mimeType: string; name?: string } => {
            if (!image || typeof image !== "object") return false;
            const value = image as Record<string, unknown>;
            return value.type === "image"
              && typeof value.data === "string"
              && typeof value.mimeType === "string"
              && value.mimeType.startsWith("image/");
          })
          : [];
        if (!message && images.length === 0) return sendJson(res, 400, { ok: false, error: "message or image is required" });

        const imageFileNote = await persistPromptImages(images);
        const promptText = `${message || "Please review the attached image."}${imageFileNote}`;
        const mode = body.mode === "followUp" ? "followUp" : "steer";
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        void targetSession.prompt(promptText, {
          ...(targetSession.isStreaming ? { streamingBehavior: mode } : {}),
          ...(images.length ? { images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) } : {}),
        })
          .catch((error: unknown) => broadcast({
            type: "server_error",
            sessionId: targetSession.sessionId,
            sessionFile: targetSession.sessionFile,
            error: error instanceof Error ? error.message : String(error),
          }));

        return sendJson(res, 202, { ok: true, sessionId: targetSession.sessionId });
      }

      if (method === "POST" && url.pathname === "/api/abort") {
        const body = await readBody(req) as { sessionId?: unknown };
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : session.sessionId;
        const targetSession = requestedSessionId === session.sessionId ? session : await getOrCreateLiveSessionById(requestedSessionId);
        if (!targetSession) return sendJson(res, 404, { ok: false, error: "Session not found" });
        void targetSession.abort().catch((error: unknown) => broadcast({
          type: "server_error",
          sessionId: targetSession.sessionId,
          sessionFile: targetSession.sessionFile,
          error: error instanceof Error ? error.message : String(error),
        }));
        return sendJson(res, 202, { ok: true, sessionId: targetSession.sessionId });
      }

      if (method === "POST" && (url.pathname === "/api/new-chat" || url.pathname === "/api/sessions/new")) {
        session = await createNewLiveSession();
        const state = currentState();
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      if (method === "POST" && url.pathname === "/api/sessions/open") {
        const body = await readBody(req) as { id?: unknown; sessionId?: unknown };
        const requestedId = typeof body.sessionId === "string" ? body.sessionId : typeof body.id === "string" ? body.id : "";
        if (!requestedId) return sendJson(res, 400, { ok: false, error: "sessionId is required" });

        try {
          await switchToSessionId(requestedId);
        } catch {
          return sendJson(res, 404, { ok: false, error: "Session not found" });
        }
        const state = currentState();
        broadcast({ type: "state_changed", ...state });
        return sendJson(res, 200, { ok: true, ...state });
      }

      return sendJson(res, 404, { ok: false, error: "Unknown API route" });
    }

    if (viteDevServer) {
      viteDevServer.middlewares(req, res, () => {
        if (!res.writableEnded) sendJson(res, 404, { ok: false, error: "Not found" });
      });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
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

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: "hello",
    cwd: piCwd,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    model: simplifyModel(session.model),
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
  }));
  ws.on("close", () => clients.delete(ws));
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
