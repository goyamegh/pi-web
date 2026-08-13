import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Spinner / runtime lifecycle coverage for the Claude Code adapter.
 *
 * The pi-web UI shows a per-session spinner (left-side navigation) and
 * activates the composer's stop button while runtimeForPath() reports
 * isRunning: true \u2014 which it derives from `liveSession.isStreaming`. For the
 * spinner to ever turn on for a CC session, the adapter's `isStreaming`
 * property must reflect the live closure variable rather than a snapshot
 * taken at object-literal construction.
 *
 * This test mocks node:child_process.spawn so we can drive a fake CC
 * subprocess deterministically (without consuming real Bedrock tokens) and
 * lock down the four key transitions:
 *
 *   1. before prompt():        adapter.isStreaming === false
 *   2. inside runTurn() body:  adapter.isStreaming === true and an
 *                              `agent_start` event has been broadcast,
 *   3. on `result` stream-json: an `agent_end` event is broadcast,
 *   4. after subprocess close: adapter.isStreaming === false again.
 *
 * Also exercises the safety net introduced for crashed / killed children:
 * if the subprocess closes WITHOUT emitting `result`, the adapter must still
 * synthesize a single `agent_end` so the UI un-sticks. (The original
 * \"spinner stuck on\" failure mode.)
 */

// vi.mock factory captures spawn calls; tests can read the most recent.
const spawnInvocations: Array<{ bin: string; args: string[]; child: FakeChild }> = [];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  kill = vi.fn();
}

vi.mock("node:child_process", () => ({
  spawn: (bin: string, args: string[]) => {
    const child = new FakeChild();
    spawnInvocations.push({ bin, args, child });
    return child;
  },
}));

// Imported AFTER vi.mock so the module under test sees the mocked spawn.
const { createClaudeCodeAdapter } = await import("../server/agent/claude-code/index.js");

let originalHome: string | undefined;
let homeDir = "";

beforeEach(async () => {
  spawnInvocations.length = 0;
  originalHome = process.env.HOME;
  homeDir = await mkdtemp(join(tmpdir(), "pi-web-cc-runtime-"));
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (homeDir) await rm(homeDir, { recursive: true, force: true });
});

function captureEvents(adapter: { subscribe?: (cb: (e: unknown) => void) => unknown }): unknown[] {
  const events: unknown[] = [];
  adapter.subscribe?.((event) => events.push(event));
  return events;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Claude Code adapter runtime lifecycle (spinner contract)", () => {
  it("flips isStreaming and emits agent_start synchronously when a prompt begins", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-spinner-test" });
    expect(adapter.isStreaming).toBe(false);

    const events = captureEvents(adapter);
    const promptPromise = adapter.prompt("hello");

    // The contract pi-web depends on: by the time `prompt()` has returned a
    // pending promise (i.e. yielded once), agent_start has been emitted and
    // the adapter is reporting isStreaming: true. server.ts's
    // session_runtime_changed broadcast reads this property via getter to
    // populate runtime.isRunning for the spinner.
    expect(adapter.isStreaming).toBe(true);
    expect(events).toContainEqual({ type: "agent_start" });
    expect(spawnInvocations).toHaveLength(1);

    // Settle the fake subprocess so the test promise resolves.
    spawnInvocations[0].child.emit("close", 0);
    await promptPromise;
  });

  it("flips isStreaming back to false on a clean `result` + close sequence", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-spinner-test" });
    const events = captureEvents(adapter);

    const promptPromise = adapter.prompt("hello");
    expect(adapter.isStreaming).toBe(true);

    const child = spawnInvocations[0].child;
    // Emulate CC's terminal `result` event over stdout (one JSONL line).
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      total_cost_usd: 0,
      result: "ok",
    }) + "\n"));
    await nextTick();
    child.emit("close", 0);
    await promptPromise;

    expect(adapter.isStreaming).toBe(false);
    // Exactly one agent_end event \u2014 the result-driven one. The settle()
    // safety net must NOT double-emit when the result event already fired.
    const agentEnds = events.filter((e) => (e as { type?: string }).type === "agent_end");
    expect(agentEnds).toHaveLength(1);
  });

  it("synthesizes agent_end when the subprocess closes without a result event (safety net)", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-spinner-test" });
    const events = captureEvents(adapter);

    const promptPromise = adapter.prompt("hello");
    const child = spawnInvocations[0].child;
    // No `result` line is emitted; child crashes/exits with non-zero code.
    child.emit("close", 1);
    await promptPromise.catch(() => {
      // The promise rejects on non-zero exit; that's the contract.
    });

    expect(adapter.isStreaming).toBe(false);
    // The synthetic agent_end un-sticks the UI's spinner.
    const agentEnds = events.filter((e) => (e as { type?: string }).type === "agent_end");
    expect(agentEnds).toHaveLength(1);
    const synthetic = agentEnds[0] as { type: string; isError: boolean; aborted?: boolean };
    expect(synthetic.isError).toBe(true);
    expect(synthetic.aborted).toBe(false);
  });

  it("synthesizes agent_end on abort() so the spinner clears immediately", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-spinner-test" });
    const events = captureEvents(adapter);

    const promptPromise = adapter.prompt("hello");
    expect(adapter.isStreaming).toBe(true);

    await adapter.abort();
    expect(adapter.isStreaming).toBe(false);
    // Drive the subprocess close so the promise settles.
    spawnInvocations[0].child.emit("close", 143);
    await promptPromise.catch(() => undefined);

    // At minimum one agent_end was emitted (the abort path). The settle()
    // safety net is allowed to add another but UIs that handle agent_end
    // idempotently will be fine; the contract is just that *some* agent_end
    // fires so the spinner does not get stuck.
    const agentEnds = events.filter((e) => (e as { type?: string }).type === "agent_end");
    expect(agentEnds.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a re-entrant prompt() while a turn is already in flight", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-spinner-test" });
    const promptPromise = adapter.prompt("first");
    expect(adapter.isStreaming).toBe(true);

    await expect(adapter.prompt("second")).rejects.toThrow(/already processing/i);

    spawnInvocations[0].child.emit("close", 0);
    await promptPromise;
  });

  it("subscribe() returns an unsubscribe function that detaches the listener", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-spinner-test" });
    const events: unknown[] = [];
    const unsubscribe = adapter.subscribe?.((event) => events.push(event));
    expect(typeof unsubscribe).toBe("function");

    const promptPromise = adapter.prompt("hello");
    expect(events.some((e) => (e as { type?: string }).type === "agent_start")).toBe(true);

    (unsubscribe as Mock | (() => void))?.();
    spawnInvocations[0].child.emit("close", 0);
    await promptPromise;

    // After unsubscribe, no further events are recorded. The agent_end from
    // the safety net would otherwise have appeared.
    expect(events.some((e) => (e as { type?: string }).type === "agent_end")).toBe(false);
  });
});

/**
 * The adapter forwards its active model to the CC subprocess via `--model`.
 * pi-web persists the last model pick globally (`defaults.model`) and passes it
 * in as `initialModel`, including picks made in a *pi* session — so the adapter
 * must validate it against CC's own `availableModels` instead of trusting it.
 */
describe("Claude Code adapter initial model validation", () => {
  // Pinned explicitly so the expected provider does not depend on whether the
  // developer's shell happens to export CLAUDE_CODE_USE_BEDROCK.
  let originalUseBedrock: string | undefined;
  beforeEach(() => {
    originalUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  });
  afterEach(() => {
    if (originalUseBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = originalUseBedrock;
  });

  async function writeCCSettings(models: string[]) {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude", "settings.json"),
      JSON.stringify({ availableModels: models, enforceAvailableModels: true }),
      "utf-8",
    );
  }

  function modelArgFrom(args: string[]): string | undefined {
    const i = args.indexOf("--model");
    return i >= 0 ? args[i + 1] : undefined;
  }

  it("offers every model CC declares, not a hardcoded subset", async () => {
    await writeCCSettings(["claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);

    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-model-test" });
    const ids = (adapter as any).modelRuntime.getAvailableSnapshot().map((m: any) => m.id);
    expect(ids).toEqual(["claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
  });

  it("does not forward an unavailable persisted default to --model", async () => {
    await writeCCSettings(["claude-opus-4-8", "claude-sonnet-5"]);

    const adapter = await createClaudeCodeAdapter({
      cwd: "/tmp/cc-model-test",
      // A stale/cross-agent pick that CC would reject.
      initialModel: { provider: "amazon-bedrock", id: "us.anthropic.claude-fable-5" },
    });

    // The phantom never becomes the active model...
    expect(adapter.model.id).toBe("claude-opus-4-8");

    // ...nor reaches the subprocess.
    const promptPromise = adapter.prompt("hello");
    expect(modelArgFrom(spawnInvocations[0].args)).toBe("claude-opus-4-8");
    spawnInvocations[0].child.emit("close", 0);
    await promptPromise;
  });

  it("honours a persisted default that CC does offer", async () => {
    await writeCCSettings(["claude-opus-4-8", "claude-sonnet-5"]);

    const adapter = await createClaudeCodeAdapter({
      cwd: "/tmp/cc-model-test",
      initialModel: { provider: "amazon-bedrock", id: "claude-sonnet-5" },
    });
    expect(adapter.model.id).toBe("claude-sonnet-5");

    const promptPromise = adapter.prompt("hello");
    expect(modelArgFrom(spawnInvocations[0].args)).toBe("claude-sonnet-5");
    spawnInvocations[0].child.emit("close", 0);
    await promptPromise;
  });

  it("allows setModel() to any CC-declared model", async () => {
    await writeCCSettings(["claude-opus-4-8", "claude-opus-5"]);

    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-model-test" });
    await adapter.setModel({ provider: "amazon-bedrock", id: "claude-opus-5" });
    expect(adapter.model.id).toBe("claude-opus-5");

    await expect(
      adapter.setModel({ provider: "amazon-bedrock", id: "claude-nonexistent-9" }),
    ).rejects.toThrow(/not available in Claude Code/i);
  });
});

describe("Claude Code adapter activeCwd tracking", () => {
  it("infers activeCwd from CC system event cwd field", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-cwd-test" });
    const events = captureEvents(adapter);

    const promptPromise = adapter.prompt("hello");
    const child = spawnInvocations[0].child;

    // CC emits a system/init event with the shell's cwd
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-cwd",
      cwd: "/workspace/my-project",
    }) + "\n"));
    await nextTick();

    expect(events).toContainEqual({ type: "active_cwd_changed", activeCwd: "/workspace/my-project" });
    expect((adapter as any).activeCwd).toBe("/workspace/my-project");

    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", session_id: "sess-cwd" }) + "\n"));
    child.emit("close", 0);
    await promptPromise;
  });

  it("infers activeCwd from Bash tool_use with cd command", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-cwd-test" });
    const events = captureEvents(adapter);

    const promptPromise = adapter.prompt("hello");
    const child = spawnInvocations[0].child;

    child.stdout.emit("data", Buffer.from(JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "cd /workspace/other-project && ls" } }],
      },
    }) + "\n"));
    await nextTick();

    expect(events).toContainEqual({ type: "active_cwd_changed", activeCwd: "/workspace/other-project" });
    expect((adapter as any).activeCwd).toBe("/workspace/other-project");

    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", session_id: "x" }) + "\n"));
    child.emit("close", 0);
    await promptPromise;
  });

  it("infers activeCwd from Bash tool_use with git -C flag", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-cwd-test" });
    const events = captureEvents(adapter);

    const promptPromise = adapter.prompt("hello");
    const child = spawnInvocations[0].child;

    child.stdout.emit("data", Buffer.from(JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "git -C /local/home/user/workplace/agent-health/agent-health-pr-206 status" } }],
      },
    }) + "\n"));
    await nextTick();

    expect(events).toContainEqual({ type: "active_cwd_changed", activeCwd: "/local/home/user/workplace/agent-health/agent-health-pr-206" });

    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", session_id: "x" }) + "\n"));
    child.emit("close", 0);
    await promptPromise;
  });

  it("infers activeCwd from Edit/Write/Read tool_use file_path", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-cwd-test" });
    const events = captureEvents(adapter);

    const promptPromise = adapter.prompt("hello");
    const child = spawnInvocations[0].child;

    child.stdout.emit("data", Buffer.from(JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu3", name: "Edit", input: { file_path: "/workspace/project/src/main.ts", old_string: "a", new_string: "b" } }],
      },
    }) + "\n"));
    await nextTick();

    expect(events).toContainEqual({ type: "active_cwd_changed", activeCwd: "/workspace/project/src" });

    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", session_id: "x" }) + "\n"));
    child.emit("close", 0);
    await promptPromise;
  });

  it("does not emit active_cwd_changed when cwd has not changed", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-cwd-test" });
    const events = captureEvents(adapter);

    const promptPromise = adapter.prompt("hello");
    const child = spawnInvocations[0].child;

    // First tool call sets activeCwd
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu4", name: "Bash", input: { command: "cd /workspace/project && make" } }] },
    }) + "\n"));
    await nextTick();

    // Second tool call with same dir — no new event
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu5", name: "Edit", input: { file_path: "/workspace/project/foo.ts", old_string: "x", new_string: "y" } }] },
    }) + "\n"));
    await nextTick();

    const cwdEvents = events.filter((e) => (e as any).type === "active_cwd_changed");
    expect(cwdEvents).toHaveLength(1);

    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", session_id: "x" }) + "\n"));
    child.emit("close", 0);
    await promptPromise;
  });
});

/**
 * `getAgentSlashCommands()` is the integration seam between the CC adapter
 * and pi-web's `/api/commands` endpoint. The composer's picker calls
 * /api/commands → server.ts merges these with web overlay → frontend renders.
 *
 * These tests pin the contract that the adapter:
 *   - always emits CC's built-in slash commands (clear, compact, ...);
 *   - bridges user-level command files at $HOME/.claude/commands;
 *   - bridges plugin commands and skills via installed_plugins.json;
 *   - reads fresh from disk on each call (newly added files are picked up
 *     without restarting the adapter), since pi-web caches results for
 *     5s in the composer but expects the server to be authoritative.
 */
async function writeFileEnsuringDir(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf-8");
}

describe("Claude Code adapter slash command discovery integration", () => {
  it("merges built-ins, user-level commands, and plugin commands into getAgentSlashCommands()", async () => {
    // User-level command — the case from `~/.claude/commands/cp-oncall.md`.
    await writeFileEnsuringDir(
      join(homeDir, ".claude", "commands", "cp-oncall.md"),
      "CP Oncall diagnostic assistant for AWS OpenSearch Service.\n",
    );

    // Plugin with both a command file and a skill — covers the two surfaces
    // CC itself exposes as slash commands for a plugin install.
    const pluginRoot = join(homeDir, ".claude", "plugins", "cache", "official", "demo-plugin", "1.0.0");
    await writeFileEnsuringDir(
      join(pluginRoot, "commands", "do-thing.md"),
      "---\ndescription: Do a thing\n---\nbody",
    );
    await writeFileEnsuringDir(
      join(pluginRoot, "skills", "investigate", "SKILL.md"),
      "---\nname: investigate\ndescription: Investigate a ticket\n---\nbody",
    );
    await writeFileEnsuringDir(
      join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "demo-plugin@official": [{ scope: "project", installPath: pluginRoot }] },
      }),
    );

    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-discovery" });
    const cmds = (adapter as unknown as { getAgentSlashCommands(): Array<{ name: string; description?: string }> })
      .getAgentSlashCommands();
    const names = cmds.map((c) => c.name);

    // Built-ins — must always be present so the picker never goes empty.
    expect(names).toContain("clear");
    expect(names).toContain("compact");
    expect(names).toContain("init");

    // User-level discovery surfaces /cp-oncall.
    expect(names).toContain("cp-oncall");
    const cp = cmds.find((c) => c.name === "cp-oncall");
    expect(cp?.description).toMatch(/CP Oncall diagnostic/);

    // Plugin commands and skills are namespaced as <plugin>:<name>, matching
    // CC's own terminal picker layout.
    expect(names).toContain("demo-plugin:do-thing");
    expect(names).toContain("demo-plugin:investigate");
  });

  it("re-reads disk on every call so newly installed plugins appear without restart", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-discovery" });
    const reader = adapter as unknown as { getAgentSlashCommands(): Array<{ name: string }> };

    const before = reader.getAgentSlashCommands().map((c) => c.name);
    expect(before).not.toContain("late:hello");

    // After the adapter is constructed, "install" a plugin by writing files.
    const pluginRoot = join(homeDir, ".claude", "plugins", "cache", "official", "late", "1.0.0");
    await writeFileEnsuringDir(
      join(pluginRoot, "commands", "hello.md"),
      "---\ndescription: Late-bound\n---\nbody",
    );
    await writeFileEnsuringDir(
      join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "late@official": [{ installPath: pluginRoot }] } }),
    );

    const after = reader.getAgentSlashCommands().map((c) => c.name);
    expect(after).toContain("late:hello");
  });
});

/**
 * Persistent-process semantics: one CC child serves the whole session. Turn
 * boundaries are `result` frames (not process exit), abort prefers a
 * stream-json interrupt over killing the child, and /compact is bridged onto
 * pi's compaction_start / compaction_end events.
 */
describe("Claude Code adapter persistent runtime", () => {
  function emitLine(child: FakeChild, frame: object) {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  }
  function resultFrame(overrides: object = {}) {
    return { type: "result", subtype: "success", session_id: "s", ...overrides };
  }
  function stdinFrames(child: FakeChild): Array<Record<string, unknown>> {
    return (child.stdin.write as Mock).mock.calls.map(([line]) => JSON.parse(String(line)));
  }

  it("reuses one child across turns; result frames end turns while the process lives on", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-persist-test" });
    const events = captureEvents(adapter);

    const first = adapter.prompt("one");
    expect(spawnInvocations).toHaveLength(1);
    const child = spawnInvocations[0].child;
    emitLine(child, resultFrame({ result: "" }));
    await first;
    expect(adapter.isStreaming).toBe(false);

    const second = adapter.prompt("two");
    // Same warm child: no new spawn, second user frame written to the same stdin.
    expect(spawnInvocations).toHaveLength(1);
    const userFrames = stdinFrames(child).filter((f) => f.type === "user");
    expect(userFrames).toHaveLength(2);
    expect((child.stdin.end as Mock)).not.toHaveBeenCalled();
    emitLine(child, resultFrame({ result: "" }));
    await second;

    const agentEnds = events.filter((e) => (e as { type?: string }).type === "agent_end");
    expect(agentEnds).toHaveLength(2);
  });

  it("abort() interrupts via control_request and keeps the child for later turns", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-persist-test" });
    const events = captureEvents(adapter);

    const first = adapter.prompt("long task");
    const child = spawnInvocations[0].child;
    await adapter.abort();

    // Interrupt frame written; the child is NOT killed while the interrupt is pending.
    const interrupts = stdinFrames(child).filter((f) => f.type === "control_request");
    expect(interrupts).toHaveLength(1);
    expect((interrupts[0].request as { subtype?: string }).subtype).toBe("interrupt");
    expect(child.kill).not.toHaveBeenCalled();
    expect(adapter.isStreaming).toBe(false);
    expect(events.filter((e) => (e as { type?: string }).type === "agent_end")).toHaveLength(1);

    // Frames still queued from the interrupted turn are dropped...
    emitLine(child, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ghost" }] } });
    expect(events.some((e) => (e as { type?: string }).type === "message_end")).toBe(false);
    // ...until the turn's own result frame arrives and resets state.
    emitLine(child, resultFrame({ result: "" }));
    await first;

    // The warm child then serves the next turn without a respawn.
    const second = adapter.prompt("next");
    expect(spawnInvocations).toHaveLength(1);
    emitLine(child, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } });
    emitLine(child, resultFrame({ result: "reply" }));
    await second;
    expect(events.some((e) => (e as { type?: string }).type === "message_end")).toBe(true);
  });

  it("crash mid-turn rejects, synthesizes agent_end, and the next prompt respawns", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-persist-test" });
    const events = captureEvents(adapter);

    const first = adapter.prompt("one");
    spawnInvocations[0].child.emit("close", 1);
    await expect(first).rejects.toThrow(/exited with code 1/);
    expect(events.filter((e) => (e as { type?: string }).type === "agent_end")).toHaveLength(1);

    const second = adapter.prompt("two");
    expect(spawnInvocations).toHaveLength(2);
    emitLine(spawnInvocations[1].child, resultFrame({ result: "" }));
    await second;
  });

  it("setModel retires the idle child so the next turn respawns with the new --model", async () => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude", "settings.json"),
      JSON.stringify({ availableModels: ["claude-opus-4-8", "claude-sonnet-5"] }),
      "utf-8",
    );
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-persist-test" });

    const first = adapter.prompt("one");
    const child = spawnInvocations[0].child;
    emitLine(child, resultFrame({ result: "" }));
    await first;

    await adapter.setModel({ provider: (adapter as any).model.provider, id: "claude-sonnet-5" });
    expect(child.kill).toHaveBeenCalled();

    const second = adapter.prompt("two");
    expect(spawnInvocations).toHaveLength(2);
    const args = spawnInvocations[1].args;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    // The session itself survives the respawn: same id, resumed not re-created.
    expect(args).toContain("--resume");
    emitLine(spawnInvocations[1].child, resultFrame({ result: "" }));
    await second;
  });

  it("surfaces result-only turns (CC-handled slash commands) as a message", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-persist-test" });
    const events = captureEvents(adapter);

    const turn = adapter.prompt("/cost");
    emitLine(spawnInvocations[0].child, resultFrame({ num_turns: 0, result: "Total cost: $0.42" }));
    await turn;

    const ends = events.filter((e) => (e as { type?: string }).type === "message_end") as Array<{ message: { role: string; content: string } }>;
    expect(ends).toHaveLength(1);
    expect(ends[0].message.content).toBe("Total cost: $0.42");
    expect(events.some((e) => (e as { type?: string }).type === "agent_end")).toBe(true);
  });

  it("dispose() kills the child and clears a pending turn", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-persist-test" });
    const events = captureEvents(adapter);

    const turn = adapter.prompt("one");
    const child = spawnInvocations[0].child;
    (adapter as unknown as { dispose(): void }).dispose();

    expect(child.kill).toHaveBeenCalled();
    expect(adapter.isStreaming).toBe(false);
    expect(events.some((e) => (e as { type?: string }).type === "agent_end")).toBe(true);
    await turn;
  });

  it("caches init-frame slash_commands and offers them in getAgentSlashCommands", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-persist-test" });

    const turn = adapter.prompt("hello");
    const child = spawnInvocations[0].child;
    emitLine(child, { type: "system", subtype: "init", session_id: "s", slash_commands: ["cost", "superpowers:brainstorming"] });
    emitLine(child, resultFrame({ result: "" }));
    await turn;

    const names = (adapter as unknown as { getAgentSlashCommands(): Array<{ name: string; source: string }> })
      .getAgentSlashCommands().map((c) => c.name);
    expect(names).toContain("superpowers:brainstorming");
  });
});

describe("Claude Code adapter compaction bridge", () => {
  function emitLine(child: FakeChild, frame: object) {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  }

  async function writeTranscript(adapter: { sessionId: string }, cwd: string, entries: object[]) {
    const { ccSessionFile } = await import("../server/agent/claude-code/sessions.js");
    const path = ccSessionFile(cwd, adapter.sessionId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  }

  const CWD = "/tmp/cc-compact-test";

  it("bridges /compact onto compaction_start / compaction_end with the transcript summary", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: CWD });
    const events = captureEvents(adapter);

    const compactPromise = (adapter as unknown as { compact(i?: string): Promise<unknown> }).compact("keep the codewords");
    expect(adapter.isCompacting).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "compaction_start", reason: "manual" }));
    // No phantom assistant turn while compacting.
    expect(events.some((e) => (e as { type?: string }).type === "agent_start")).toBe(false);

    const child = spawnInvocations[0].child;
    const frames = (child.stdin.write as Mock).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(frames[0].message.content).toBe("/compact keep the codewords");

    // CC persists the summary to the transcript before/around the result frame.
    await writeTranscript(adapter, CWD, [
      { type: "user", message: { role: "user", content: "real question" }, uuid: "u1", timestamp: "2026-08-06T00:00:00Z" },
      { type: "system", subtype: "compact_boundary", isMeta: false, compactMetadata: { trigger: "manual", preTokens: 40577, postTokens: 5406 }, uuid: "b1", timestamp: "2026-08-06T00:01:00Z" },
      { type: "user", message: { role: "user", content: "Summary of the earlier conversation." }, isCompactSummary: true, isVisibleInTranscriptOnly: true, uuid: "s1", timestamp: "2026-08-06T00:01:01Z" },
    ]);

    emitLine(child, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 40577, post_tokens: 5406 } });
    emitLine(child, { type: "result", subtype: "success", num_turns: 0, result: "" });
    await compactPromise;

    expect(adapter.isCompacting).toBe(false);
    const end = events.find((e) => (e as { type?: string }).type === "compaction_end") as
      { result?: { tokensBefore?: number; summary?: string } };
    expect(end.result?.tokensBefore).toBe(40577);
    expect(end.result?.summary).toBe("Summary of the earlier conversation.");
    // In-memory messages now reflect the compacted transcript.
    expect((adapter.messages as Array<{ role?: string }>).some((m) => m.role === "compactionSummary")).toBe(true);
  });

  it("surfaces a no-op /compact (no boundary frame) instead of faking success", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: CWD });
    const events = captureEvents(adapter);

    const compactPromise = (adapter as unknown as { compact(): Promise<unknown> }).compact();
    emitLine(spawnInvocations[0].child, { type: "result", subtype: "success", num_turns: 0, result: "Not enough messages to compact." });
    await compactPromise;

    expect(adapter.isCompacting).toBe(false);
    const end = events.find((e) => (e as { type?: string }).type === "compaction_end") as { result?: unknown };
    expect(end.result).toBeUndefined();
    const ends = events.filter((e) => (e as { type?: string }).type === "message_end") as Array<{ message: { content: string } }>;
    expect(ends.some((e) => e.message.content.includes("Not enough messages"))).toBe(true);
  });

  it("abortCompaction() emits an aborted compaction_end and interrupts the child", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: CWD });
    const events = captureEvents(adapter);

    const compactPromise = (adapter as unknown as { compact(): Promise<unknown> }).compact();
    (adapter as unknown as { abortCompaction(): void }).abortCompaction();

    expect(adapter.isCompacting).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "compaction_end", aborted: true }));
    const child = spawnInvocations[0].child;
    const interrupts = (child.stdin.write as Mock).mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((f) => f.type === "control_request");
    expect(interrupts).toHaveLength(1);

    emitLine(child, { type: "result", subtype: "success", num_turns: 0, result: "" });
    await compactPromise;
    // Exactly one compaction_end: the finalize path must not double-emit after an abort.
    expect(events.filter((e) => (e as { type?: string }).type === "compaction_end")).toHaveLength(1);
  });

  it("rejects prompt() while compacting and compact() while streaming", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: CWD });

    const compactPromise = (adapter as unknown as { compact(): Promise<unknown> }).compact();
    await expect(adapter.prompt("hi")).rejects.toThrow(/compaction/i);
    emitLine(spawnInvocations[0].child, { type: "result", subtype: "success", num_turns: 0, result: "" });
    await compactPromise;

    const turn = adapter.prompt("hi");
    await expect((adapter as unknown as { compact(): Promise<unknown> }).compact()).rejects.toThrow(/current response/i);
    emitLine(spawnInvocations[0].child, { type: "result", subtype: "success", result: "" });
    await turn;
  });
});

describe("Claude Code adapter cwd reporting", () => {
  // Regression: sessionCwd() in server.ts resolves a session's folder via
  // sessionManager.getCwd() and falls back to the server-global piCwd. The CC
  // adapter used to omit getCwd, so every CC session reported the server boot
  // cwd — picking a folder from the drawer or folder picker appeared to do
  // nothing (status bar, session grouping, and repo-info all showed the old
  // folder).
  it("exposes its construction cwd via sessionManager.getCwd()", async () => {
    const adapter = await createClaudeCodeAdapter({ cwd: "/tmp/cc-folder-select-test" });
    expect(adapter.sessionManager.getCwd()).toBe("/tmp/cc-folder-select-test");
  });
});
