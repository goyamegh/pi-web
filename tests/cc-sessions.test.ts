import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ccProjectSlug, ccProjectDir, listCCSessions, loadCCMessages } from "../server/agent/claude-code/sessions.js";

/**
 * sessions.ts derives transcript paths from $HOME, so we run these tests under
 * a throwaway $HOME that we control end-to-end. Each test sets up its own CC
 * project directory under that home, populates a JSONL fixture, then asserts
 * the listing/replay output against it.
 */
let originalHome: string | undefined;
let homeDir = "";

beforeAll(async () => {
  originalHome = process.env.HOME;
  homeDir = await mkdtemp(join(tmpdir(), "pi-web-cc-sessions-"));
  process.env.HOME = homeDir;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (homeDir) await rm(homeDir, { recursive: true, force: true });
});

describe("Claude Code sessions index", () => {
  it("derives the project slug from a cwd by replacing slashes with dashes", () => {
    expect(ccProjectSlug("/local/home/example/project")).toBe("-local-home-example-project");
  });

  it("returns an empty array when CC has never been run for a cwd", async () => {
    const list = await listCCSessions("/never/used/here");
    expect(list).toEqual([]);
  });

  it("lists CC sessions and replays them into pi-shaped messages", async () => {
    const cwd = "/imaginary/project";
    const projectDir = ccProjectDir(cwd);
    await mkdir(projectDir, { recursive: true });

    const sessionId = "12345678-1234-1234-1234-123456789abc";
    const file = join(projectDir, `${sessionId}.jsonl`);

    const lines = [
      // CC writes various metadata entries that we ignore for listing/replay.
      JSON.stringify({ type: "last-prompt", leafUuid: "x", sessionId }),
      JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId }),
      JSON.stringify({
        type: "user",
        parentUuid: null,
        uuid: "u1",
        sessionId,
        timestamp: "2026-01-02T03:04:05Z",
        message: { role: "user", content: "first user prompt" },
      }),
      JSON.stringify({
        type: "assistant",
        parentUuid: "u1",
        uuid: "a1",
        sessionId,
        timestamp: "2026-01-02T03:04:06Z",
        message: { role: "assistant", content: [{ type: "text", text: "ok!" }] },
      }),
    ];
    await writeFile(file, lines.join("\n") + "\n", "utf-8");

    const sessions = await listCCSessions(cwd);
    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    expect(session.id).toBe(sessionId);
    expect(session.path).toBe(file);
    expect(session.cwd).toBe(cwd);
    expect(session.firstMessage).toBe("first user prompt");
    expect(session.name.startsWith("first user prompt")).toBe(true);
    // Tool-result-only entries are excluded from messageCount; here we have
    // a single user + single assistant turn, both visible.
    expect(session.messageCount).toBe(2);

    const messages = await loadCCMessages(file);
    expect(messages).toHaveLength(2);
    expect((messages[0] as { role: string }).role).toBe("user");
    expect((messages[1] as { role: string }).role).toBe("assistant");
  });

  it("ignores files in the project dir whose names are not <uuid>.jsonl", async () => {
    const cwd = "/another/project";
    const projectDir = ccProjectDir(cwd);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "not-a-uuid.jsonl"), "{}\n", "utf-8");
    await writeFile(join(projectDir, "scratch.txt"), "hello", "utf-8");

    const sessions = await listCCSessions(cwd);
    expect(sessions).toEqual([]);
  });
});
