import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * File-system based discovery for Claude Code slash commands. The pi-web
 * composer's picker is fed by `discoverCCSlashCommands(cwd)`, which mirrors
 * CC's own resolution order for `/foo` lookups so the picker matches what
 * `claude` itself would do:
 *
 *   1. ~/.claude/commands/<...>/<name>.md  (user-level commands)
 *   2. <cwd>/.claude/commands/<...>/<name>.md  (project-level commands)
 *   3. ~/.claude/skills/<name>.md  (user-level skills, surfaced as /<name>)
 *   4. <plugin>/commands/<...>/<name>.md  (plugin commands, namespaced as /<plugin>:<name>)
 *   5. <plugin>/skills/<name>/SKILL.md  (plugin skills, namespaced as /<plugin>:<name>)
 *
 * Plugins are enumerated from ~/.claude/plugins/installed_plugins.json. When
 * the recorded `installPath` does not exist on disk (the directory-source AIM
 * marketplace case), we fall back to <marketplace.installLocation>/<plugin-slug>
 * per ~/.claude/plugins/known_marketplaces.json.
 */

const { discoverCCSlashCommands } = await import("../server/agent/claude-code/commands.js");

let originalHome: string | undefined;
let homeDir = "";
let projectDir = "";

beforeEach(async () => {
  originalHome = process.env.HOME;
  homeDir = await mkdtemp(join(tmpdir(), "pi-web-cc-commands-home-"));
  projectDir = await mkdtemp(join(tmpdir(), "pi-web-cc-commands-proj-"));
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (homeDir) await rm(homeDir, { recursive: true, force: true });
  if (projectDir) await rm(projectDir, { recursive: true, force: true });
});

async function writeCommand(path: string, body: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf-8");
}

describe("Claude Code slash command discovery", () => {
  it("returns an empty list when no command sources exist", async () => {
    const cmds = discoverCCSlashCommands(projectDir);
    expect(cmds).toEqual([]);
  });

  it("discovers user-level commands at ~/.claude/commands/<name>.md", async () => {
    await writeCommand(
      join(homeDir, ".claude", "commands", "cp-oncall.md"),
      "CP Oncall diagnostic assistant for AWS OpenSearch Service.\n\n# Body",
    );

    const cmds = discoverCCSlashCommands(projectDir);
    const cp = cmds.find((c) => c.name === "cp-oncall");
    expect(cp).toBeDefined();
    expect(cp?.source).toBe("claude-code");
    expect(cp?.description).toMatch(/CP Oncall diagnostic assistant/);
    expect((cp?.sourceInfo as { scope?: string }).scope).toBe("user");
  });

  it("discovers project-level commands and namespaces nested directories with `:`", async () => {
    await writeCommand(
      join(projectDir, ".claude", "commands", "deploy", "rollback.md"),
      "---\ndescription: Rollback the last deployment\n---\n\nbody",
    );

    const cmds = discoverCCSlashCommands(projectDir);
    const rollback = cmds.find((c) => c.name === "deploy:rollback");
    expect(rollback).toBeDefined();
    expect(rollback?.description).toBe("Rollback the last deployment");
    expect((rollback?.sourceInfo as { scope?: string }).scope).toBe("project");
  });

  it("parses YAML frontmatter `description:` and strips surrounding quotes", async () => {
    await writeCommand(
      join(homeDir, ".claude", "commands", "fancy.md"),
      "---\ndescription: \"Quoted description\"\nargument-hint: foo\n---\n\nBody text.",
    );

    const cmds = discoverCCSlashCommands(projectDir);
    const fancy = cmds.find((c) => c.name === "fancy");
    expect(fancy?.description).toBe("Quoted description");
  });

  it("falls back to the first non-heading body line when frontmatter has no description", async () => {
    await writeCommand(
      join(homeDir, ".claude", "commands", "plain.md"),
      "# Heading\n\nFirst real line of body content.\n\nMore.",
    );

    const cmds = discoverCCSlashCommands(projectDir);
    const plain = cmds.find((c) => c.name === "plain");
    expect(plain?.description).toBe("First real line of body content.");
  });

  it("discovers user-level skills as bare-name slash commands", async () => {
    await writeCommand(
      join(homeDir, ".claude", "skills", "code-review.md"),
      "---\nname: code-review\ndescription: Review the diff for issues\n---\n\nbody",
    );

    const cmds = discoverCCSlashCommands(projectDir);
    const skill = cmds.find((c) => c.name === "code-review");
    expect(skill).toBeDefined();
    expect(skill?.description).toBe("Review the diff for issues");
    expect((skill?.sourceInfo as { origin?: string }).origin).toBe("user-skills");
  });

  it("discovers plugin commands and skills from installed_plugins.json (installPath case)", async () => {
    const pluginRoot = join(homeDir, ".claude", "plugins", "cache", "official", "myplugin", "1.0.0");
    await writeCommand(
      join(pluginRoot, "commands", "do-thing.md"),
      "---\ndescription: Do a thing\n---\nbody",
    );
    await writeCommand(
      join(pluginRoot, "skills", "investigate", "SKILL.md"),
      "---\nname: investigate\ndescription: Investigate a ticket\n---\nbody",
    );

    await writeCommand(
      join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "myplugin@official": [{ scope: "project", installPath: pluginRoot, version: "1.0.0" }],
        },
      }),
    );

    const cmds = discoverCCSlashCommands(projectDir);
    const cmd = cmds.find((c) => c.name === "myplugin:do-thing");
    const skill = cmds.find((c) => c.name === "myplugin:investigate");
    expect(cmd?.description).toBe("Do a thing");
    expect(skill?.description).toBe("Investigate a ticket");
    expect((skill?.sourceInfo as { scope?: string }).scope).toBe("plugin");
    expect((skill?.sourceInfo as { origin?: string }).origin).toBe("myplugin");
  });

  it("falls back to <marketplace>/<slug> when installPath does not exist (AIM directory marketplace)", async () => {
    // Simulate the AIM layout: installed_plugins.json points to a cache path
    // that was never materialized; the real plugin lives under the
    // marketplace's installLocation.
    const marketRoot = join(projectDir, "aim-marketplace");
    const pluginRoot = join(marketRoot, "local-AESOncallClaudeCode-cp-oncall");
    await writeCommand(
      join(pluginRoot, "skills", "cp-oncall-investigate", "SKILL.md"),
      "---\nname: cp-oncall-investigate\ndescription: Ticket investigation skill\n---\nbody",
    );

    await writeCommand(
      join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "local-AESOncallClaudeCode-cp-oncall@aim": [
            { scope: "project", installPath: "/does/not/exist/cache/path", version: "1.0.0" },
          ],
        },
      }),
    );
    await writeCommand(
      join(homeDir, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({
        aim: { source: { source: "directory", path: marketRoot }, installLocation: marketRoot },
      }),
    );

    const cmds = discoverCCSlashCommands(projectDir);
    const skill = cmds.find((c) => c.name === "local-AESOncallClaudeCode-cp-oncall:cp-oncall-investigate");
    expect(skill).toBeDefined();
    expect(skill?.description).toBe("Ticket investigation skill");
  });

  it("skips plugin entries whose installPath does not exist and has no marketplace fallback", async () => {
    await writeCommand(
      join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ghost@nowhere": [{ scope: "project", installPath: "/does/not/exist", version: "1.0.0" }],
        },
      }),
    );

    const cmds = discoverCCSlashCommands(projectDir);
    expect(cmds.find((c) => c.name.startsWith("ghost:"))).toBeUndefined();
  });

  it("de-duplicates by name with first-source-wins ordering (user shadows plugin)", async () => {
    // User-level command takes precedence over a plugin command of the same name.
    await writeCommand(
      join(homeDir, ".claude", "commands", "shared.md"),
      "---\ndescription: User wins\n---\nbody",
    );

    const pluginRoot = join(homeDir, ".claude", "plugins", "cache", "official", "p", "1.0.0");
    await writeCommand(
      join(pluginRoot, "commands", "shared.md"),
      "---\ndescription: Plugin loses\n---\nbody",
    );
    await writeCommand(
      join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "p@official": [{ installPath: pluginRoot }] },
      }),
    );

    const cmds = discoverCCSlashCommands(projectDir);
    const shared = cmds.filter((c) => c.name === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0].description).toBe("User wins");
  });

  it("ignores non-.md files and tolerates malformed installed_plugins.json", async () => {
    await writeCommand(
      join(homeDir, ".claude", "commands", "README.txt"),
      "should be ignored",
    );
    await writeCommand(
      join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      "{ not valid json",
    );

    const cmds = discoverCCSlashCommands(projectDir);
    expect(cmds).toEqual([]);
  });
});
