import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AuthKernel, AuthStore } from "./server/auth/kernel.js";
import { resolveAuthConfig } from "./server/auth/config.js";
import { trustedOrigin, originFailureHint } from "./server/auth/origin.js";
import { forwardedHost, trustedProxyPeer } from "./server/auth/proxy.js";
import { proxyHttpRequest } from "./server/shared/httpProxy.js";

const publicHost = process.env.HOST || "127.0.0.1";
const publicPort = Number(process.env.PORT || 8787);
const childHost = process.env.PI_WEB_CHILD_HOST || "127.0.0.1";
const childPort = Number(process.env.PI_WEB_CHILD_PORT || publicPort + 1);
const token = process.env.PI_WEB_TOKEN || "";
const restartGraceMs = Number(process.env.PI_WEB_RESTART_GRACE_MS || 250);

const tunnelName = process.env.PI_WEB_TUNNEL_NAME || "";
const tunnelAllow = process.env.PI_WEB_TUNNEL_ALLOW || "";
const tunnelBin = process.env.PI_WEB_TUNNEL_BIN || "tunnel";
const tunnelPort = Number(process.env.PI_WEB_TUNNEL_PORT || publicPort);
const tunnelRestartDelayMs = Number(process.env.PI_WEB_TUNNEL_RESTART_DELAY_MS || 2000);

let child: ChildProcess | undefined;
let childStarting = false;
let childGeneration = 0;
let expectedExit = false;
let shuttingDown = false;

let tunnel: ChildProcess | undefined;
let tunnelStarting = false;
let tunnelGeneration = 0;
let tunnelExpectedExit = false;

async function isAuthorized(req: IncomingMessage, mutation = false): Promise<boolean> {
  try {
    const config = resolveAuthConfig(process.env);
    const kernel = new AuthKernel(config.legacyMode, new AuthStore(process.env.PI_WEB_AUTH_STORE || join(getAgentDir(), "web", "auth.json")), token, true, config.trustedHeader, config.policy, config.methods);
    await kernel.refreshConfig();
    const auth = await kernel.gate(req);
    if (!auth.ok) return false;
    return !mutation || auth.via !== "session" || (!!req.headers["x-pi-web-client-id"] && trustedOrigin(req, process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`));
  } catch { return false; }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function startChild(): void {
  if (childStarting) return;
  childStarting = true;
  childGeneration += 1;
  const generation = childGeneration;

  const env = {
    ...process.env,
    HOST: childHost,
    PORT: String(childPort),
    PI_WEB_DEV: process.env.PI_WEB_DEV || "1",
    PI_WEB_SUPERVISED: "1",
    PI_WEB_AUTH_ORIGIN: process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`,
    // OTel: pi runs in-process in server.ts, so the agent-health profiling
    // extension (dropped into ~/.pi/web/extensions/) reads these at runtime
    // and exports each pi-web session's spans (session.id = <ts>_<uuid>) to
    // the OTLP collector feeding agent-health's observability cluster.
    // Override either via the environment; base URL, extension appends /v1/traces.
    OTEL_EXPORTER_OTLP_ENDPOINT:
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      "https://h5r8zdtqkj.execute-api.us-east-1.amazonaws.com",
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || "pi-agent",
  };

  console.log(`[supervisor] starting child #${generation} on ${childHost}:${childPort}`);
  const nextChild = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = nextChild;

  nextChild.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  nextChild.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  nextChild.on("spawn", () => {
    childStarting = false;
  });

  nextChild.on("exit", (code, signal) => {
    if (child?.pid === undefined || childGeneration !== generation) return;
    const wasExpected = expectedExit;
    expectedExit = false;
    console.log(
      `[supervisor] child #${generation} exited code=${code ?? ""} signal=${signal ?? ""}${wasExpected ? " (expected)" : " (unexpected)"}`,
    );
    child = undefined;
    childStarting = false;
    if (shuttingDown || wasExpected) return;
    // Unexpected exit (crash, OOM, external SIGTERM/SIGKILL, etc.) — respawn.
    setTimeout(startChild, 1000);
  });
}

function stopChild(): Promise<void> {
  return new Promise((resolve) => {
    const current = child;
    if (!current || current.pid === undefined || current.exitCode !== null) return resolve();

    expectedExit = true;

    const timeout = setTimeout(() => {
      current.kill("SIGKILL");
      resolve();
    }, 5000);

    current.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    if (!current.killed) current.kill("SIGTERM");
  });
}

async function restartChild(): Promise<void> {
  console.log("[supervisor] restarting child");
  await stopChild();
  await new Promise((resolve) => setTimeout(resolve, restartGraceMs));
  startChild();
}

function startTunnel(): void {
  if (!tunnelName || tunnelStarting || shuttingDown) return;
  tunnelStarting = true;
  tunnelGeneration += 1;
  const generation = tunnelGeneration;

  const args = ["create", String(tunnelPort), "--name", tunnelName];
  if (tunnelAllow) args.push("--allow", tunnelAllow);

  console.log(`[supervisor] starting tunnel #${generation}: ${tunnelBin} ${args.join(" ")}`);
  let nextTunnel: ChildProcess;
  try {
    nextTunnel = spawn(tunnelBin, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    tunnelStarting = false;
    console.error(`[supervisor] failed to spawn tunnel: ${(error as Error).message}`);
    if (!shuttingDown) setTimeout(startTunnel, tunnelRestartDelayMs);
    return;
  }
  tunnel = nextTunnel;

  nextTunnel.stdout?.on("data", (chunk) => process.stdout.write(`[tunnel] ${chunk}`));
  nextTunnel.stderr?.on("data", (chunk) => process.stderr.write(`[tunnel] ${chunk}`));

  nextTunnel.on("spawn", () => {
    tunnelStarting = false;
  });

  nextTunnel.on("error", (error) => {
    console.error(`[supervisor] tunnel #${generation} error: ${error.message}`);
  });

  nextTunnel.on("exit", (code, signal) => {
    if (tunnel?.pid === undefined || tunnelGeneration !== generation) return;
    const wasExpected = tunnelExpectedExit;
    tunnelExpectedExit = false;
    console.log(
      `[supervisor] tunnel #${generation} exited code=${code ?? ""} signal=${signal ?? ""}${wasExpected ? " (expected)" : " (unexpected)"}`,
    );
    tunnel = undefined;
    tunnelStarting = false;
    if (shuttingDown || wasExpected) return;
    setTimeout(startTunnel, tunnelRestartDelayMs);
  });
}

function stopTunnel(): Promise<void> {
  return new Promise((resolve) => {
    const current = tunnel;
    if (!current || current.killed) return resolve();

    tunnelExpectedExit = true;

    const timeout = setTimeout(() => {
      current.kill("SIGKILL");
      resolve();
    }, 5000);

    current.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    current.kill("SIGTERM");
  });
}

function destroyQuietly(socket: NodeJS.WritableStream & { destroy?: (error?: Error) => void }, error?: Error): void {
  socket.destroy?.(error);
}

const supervisor = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/restart" || url.pathname === "/__supervisor/restart") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST required" });
    if (!trustedOrigin(req, process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`)) return sendJson(res, 403, { ok: false, error: originFailureHint });
    if (!await isAuthorized(req, true)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    sendJson(res, 202, { ok: true, message: "Restarting pi-web child" });
    void restartChild();
    return;
  }

  if (url.pathname === "/__supervisor/status") {
    if (!await isAuthorized(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return sendJson(res, 200, {
      ok: true,
      childPid: child?.pid,
      childGeneration,
      childHost,
      childPort,
      tunnel: tunnelName
        ? {
            name: tunnelName,
            port: tunnelPort,
            allow: tunnelAllow || null,
            pid: tunnel?.pid,
            generation: tunnelGeneration,
          }
        : null,
    });
  }

  trustedOrigin(req, process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`);
  sanitizeProxyHeaders(req);
  proxyHttpRequest(req, res, { host: childHost, port: childPort, preserveHost: true });
});

function sanitizeProxyHeaders(req: IncomingMessage) {
  const authority = forwardedHost(req);
  if (authority) req.headers.host = authority;
  if (!trustedProxyPeer(req)) delete req.headers["x-forwarded-for"];
  // Resolve trust at the public socket, never at the supervisor's loopback hop.
  delete req.headers["x-forwarded-host"];
}

supervisor.on("upgrade", (req, socket, head) => {
  if (!trustedOrigin(req, process.env.PI_WEB_AUTH_ORIGIN || `http://localhost:${publicPort}`)) {
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(originFailureHint)}\r\n\r\n${originFailureHint}`);
    return;
  }
  sanitizeProxyHeaders(req);
  const upstream = net.connect(childPort, childHost);
  let closed = false;

  const closeBoth = (error?: Error) => {
    if (closed) return;
    closed = true;
    destroyQuietly(socket, error);
    destroyQuietly(upstream, error);
  };

  socket.on("error", (error) => closeBoth(error));
  upstream.on("error", (error) => closeBoth(error));
  socket.on("close", () => closeBoth());
  upstream.on("close", () => closeBoth());

  upstream.on("connect", () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) upstream.write(`${name}: ${item}\r\n`);
      } else if (value !== undefined) {
        upstream.write(`${name}: ${value}\r\n`);
      }
    }
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
});

supervisor.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[supervisor] shutting down");
  supervisor.close();
  void Promise.all([stopChild(), stopTunnel()]).finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startChild();
supervisor.listen(publicPort, publicHost, () => {
  console.log(`[supervisor] listening on http://${publicHost}:${publicPort}`);
  console.log(`[supervisor] child target http://${childHost}:${childPort}`);
  console.log("[supervisor] restart/status endpoints use canonical persistent auth policy");
  if (tunnelName) {
    console.log(`[supervisor] tunnel enabled: name=${tunnelName} port=${tunnelPort}${tunnelAllow ? ` allow=${tunnelAllow}` : ""}`);
    startTunnel();
  } else {
    console.log("[supervisor] tunnel disabled (set PI_WEB_TUNNEL_NAME to enable)");
  }
});
