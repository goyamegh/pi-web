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
