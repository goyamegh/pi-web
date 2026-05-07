import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") throw new Error("Could not allocate port");
  return address.port;
}

async function waitForServer(baseUrl: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/state`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${baseUrl}`);
}

describe("pi-web mock API", () => {
  let child: ChildProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      env: { ...process.env, PI_WEB_MOCK: "1", PI_WEB_DEV: "1", HOST: "127.0.0.1", PORT: String(port), PI_WEB_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (data) => process.stderr.write(data));
    await waitForServer(baseUrl);
  }, 20_000);

  afterAll(() => {
    child?.kill();
  });

  it("returns state, models, messages, and sessions", async () => {
    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    expect(state.sessionId).toBe("mock-current");
    expect(state.model.provider).toBe("mock");

    const models = await (await fetch(`${baseUrl}/api/models`)).json();
    expect(models.models).toHaveLength(1);
    expect(models.thinkingLevels).toContain("medium");

    const messages = await (await fetch(`${baseUrl}/api/messages`)).json();
    expect(messages.messages[0].text).toContain("image attachments");

    const sessions = await (await fetch(`${baseUrl}/api/sessions`)).json();
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions[0].isCurrent).toBe(true);
  });

  it("accepts text and image prompts", async () => {
    const res = await fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "describe this",
        images: [{ type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64"), name: "tiny.png" }],
      }),
    });
    expect(res.status).toBe(202);

    const messages = await (await fetch(`${baseUrl}/api/messages`)).json();
    expect(messages.messages.at(-2).text).toContain("describe this");
    expect(messages.messages.at(-1).text).toContain("with image");
  });

  it("rejects empty prompts", async () => {
    const res = await fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("executes supported slash commands", async () => {
    const reloadRes = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/reload" }),
    });
    expect(reloadRes.status).toBe(200);
    expect((await reloadRes.json()).message).toContain("Reloaded");

    const modelListRes = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/model" }),
    });
    expect(modelListRes.status).toBe(200);
    expect((await modelListRes.json()).message).toContain("mock/model");

    const thinkingRes = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/thinking low" }),
    });
    expect(thinkingRes.status).toBe(200);
    const thinking = await thinkingRes.json();
    expect(thinking.message).toContain("low");
    expect(thinking.state.thinkingLevel).toBe("low");

    const invalidRes = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/does-not-exist" }),
    });
    expect(invalidRes.status).toBe(500);
  });

  it("creates and opens sessions through validated session APIs", async () => {
    const newRes = await fetch(`${baseUrl}/api/sessions/new`, { method: "POST" });
    expect(newRes.status).toBe(200);
    expect((await newRes.json()).sessionId).toMatch(/^mock-/);

    const openRes = await fetch(`${baseUrl}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "mock-older" }),
    });
    expect(openRes.status).toBe(200);
    expect((await openRes.json()).sessionId).toBe("mock-older");

    const invalid = await fetch(`${baseUrl}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/tmp/not-allowed.jsonl" }),
    });
    expect(invalid.status).toBe(404);
  });
});
