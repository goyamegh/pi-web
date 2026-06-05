import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";

const publicHost = process.env.HOST || "127.0.0.1";
const publicPort = Number(process.env.PORT || 8787);
const childHost = process.env.PI_WEB_CHILD_HOST || "127.0.0.1";
const childPort = Number(process.env.PI_WEB_CHILD_PORT || 8788);
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

function requestToken(req: IncomingMessage): string {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  return url.searchParams.get("token") || "";
}

function isAuthorized(req: IncomingMessage): boolean {
  return !token || requestToken(req) === token;
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
    if (!current || current.killed) return resolve();

    expectedExit = true;

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

function proxyHttp(req: IncomingMessage, res: ServerResponse): void {
  const headers = { ...req.headers, host: `${childHost}:${childPort}` };
  const upstream = request({
    host: childHost,
    port: childPort,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (error) => {
    if (!res.headersSent && !res.destroyed) {
      sendJson(res, 502, { ok: false, error: `pi-web child unavailable: ${error.message}` });
    } else {
      destroyQuietly(res, error);
    }
  });

  req.on("error", (error) => destroyQuietly(upstream, error));
  res.on("error", (error) => destroyQuietly(upstream, error));
  req.pipe(upstream);
}

const supervisor = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/restart" || url.pathname === "/__supervisor/restart") {
    if (!isAuthorized(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    sendJson(res, 202, { ok: true, message: "Restarting pi-web child" });
    void restartChild();
    return;
  }

  if (url.pathname === "/__supervisor/status") {
    if (!isAuthorized(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
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

  proxyHttp(req, res);
});

supervisor.on("upgrade", (req, socket, head) => {
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
  console.log(token ? "[supervisor] restart/status endpoints require token" : "[supervisor] auth disabled");
  if (tunnelName) {
    console.log(`[supervisor] tunnel enabled: name=${tunnelName} port=${tunnelPort}${tunnelAllow ? ` allow=${tunnelAllow}` : ""}`);
    startTunnel();
  } else {
    console.log("[supervisor] tunnel disabled (set PI_WEB_TUNNEL_NAME to enable)");
  }
});
