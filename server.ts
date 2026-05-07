import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const distDir = join(appDir, "dist");
const staticDir = distDir;

const isDev = process.env.PI_WEB_DEV === "1" || process.env.NODE_ENV === "development";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const token = process.env.PI_WEB_TOKEN || "";
const piCwd = resolve(process.env.PI_WEB_CWD || process.cwd());
const noSession = process.env.PI_WEB_NO_SESSION === "1";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
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
    if (p.type === "toolCall") return `[tool call: ${String(p.toolName || "tool")}]`;
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

function simplifyMessage(message: unknown) {
  if (!message || typeof message !== "object") return message;
  const m = message as Record<string, unknown>;
  return {
    role: m.role,
    text: textFromContent(m.content),
    timestamp: m.timestamp,
    raw: m,
  };
}

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session, modelFallbackMessage } = await createAgentSession({
  cwd: piCwd,
  sessionManager: noSession ? SessionManager.inMemory() : SessionManager.create(piCwd),
  authStorage,
  modelRegistry,
});

const clients = new Set<WebSocket>();
function broadcast(value: unknown) {
  const data = JSON.stringify(value);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

session.subscribe((event) => {
  broadcast({ type: "pi_event", event });
});

if (modelFallbackMessage) {
  console.warn(modelFallbackMessage);
}

let viteDevServer: ViteDevServer | undefined;

const server = createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      if (!isAuthorized(req)) return unauthorized(res);

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
        return sendJson(res, 200, { ok: true, messages: session.messages.map(simplifyMessage) });
      }

      if (method === "GET" && url.pathname === "/api/models") {
        return sendJson(res, 200, {
          ok: true,
          cwd: piCwd,
          current: simplifyModel(session.model),
          thinkingLevel: session.thinkingLevel,
          thinkingLevels: session.getAvailableThinkingLevels(),
          models: session.modelRegistry.getAvailable().map(simplifyModel),
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

      if (method === "POST" && url.pathname === "/api/prompt") {
        const body = await readBody(req) as { message?: unknown; mode?: unknown; images?: unknown };
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
        void session.prompt(promptText, {
          ...(session.isStreaming ? { streamingBehavior: mode } : {}),
          ...(images.length ? { images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) } : {}),
        })
          .catch((error) => broadcast({ type: "server_error", error: error instanceof Error ? error.message : String(error) }));

        return sendJson(res, 202, { ok: true });
      }

      if (method === "POST" && url.pathname === "/api/abort") {
        await session.abort();
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && url.pathname === "/api/new-chat") {
        if (session.isStreaming) await session.abort();
        session.clearQueue();
        session.sessionManager.newSession();
        session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
        const state = {
          cwd: piCwd,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          isStreaming: session.isStreaming,
          model: simplifyModel(session.model),
          thinkingLevel: session.thinkingLevel,
        };
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
