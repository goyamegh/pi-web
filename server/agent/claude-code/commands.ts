import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { AgentSlashCommand } from "../types.js";

/**
 * Discover slash commands the Claude Code CLI would expose for `cwd`. CC has
 * several command surfaces; we mirror its lookup order so the pi-web composer's
 * picker matches what `claude` itself would resolve when a user types `/foo`:
 *
 *   1. Built-in CC commands (e.g. /clear, /compact, /init) — fixed list,
 *      added by the caller.
 *   2. User-level commands at `~/.claude/commands/<...>/<name>.md`.
 *   3. Project-level commands at `<cwd>/.claude/commands/<...>/<name>.md`.
 *   4. Plugin commands at `<plugin.installPath>/commands/<...>/<name>.md`,
 *      enumerated via `~/.claude/plugins/installed_plugins.json`.
 *   5. Skills, which CC also surfaces as slash commands:
 *      - User-level: `~/.claude/skills/<name>.md` (frontmatter has name+description).
 *      - Plugin-level: `<plugin>/skills/<name>/SKILL.md`.
 *      Plugin skills are namespaced as `<plugin-slug>:<skill-name>`; user-level
 *      skills use the bare name (matching CC's terminal picker, where
 *      `local-AESOncallClaudeCode-cp-oncall:cp-oncall-investigate` and
 *      `cp-oncall` co-exist).
 *
 * Subdirectories within `commands/` are namespaced with `:` (CC's convention) —
 * `commands/foo/bar.md` becomes `/foo:bar`. The description is taken from YAML
 * frontmatter (`description: "..."`) when present; otherwise the first non-empty
 * body line is used as a fallback so files without frontmatter still get a
 * useful one-liner in the picker.
 */
export function discoverCCSlashCommands(cwd: string): AgentSlashCommand[] {
  const out: AgentSlashCommand[] = [];

  const userCommandsDir = join(homedir(), ".claude", "commands");
  for (const cmd of scanCommandsDir(userCommandsDir)) {
    out.push({
      name: cmd.name,
      description: cmd.description,
      source: "claude-code",
      sourceInfo: { path: cmd.path, source: "claude-code", scope: "user", origin: "user-commands" },
    });
  }

  const projectCommandsDir = join(cwd, ".claude", "commands");
  for (const cmd of scanCommandsDir(projectCommandsDir)) {
    out.push({
      name: cmd.name,
      description: cmd.description,
      source: "claude-code",
      sourceInfo: { path: cmd.path, source: "claude-code", scope: "project", origin: "project-commands" },
    });
  }

  // User-level skills: flat directory of `<name>.md` files at ~/.claude/skills.
  const userSkillsDir = join(homedir(), ".claude", "skills");
  for (const cmd of scanCommandsDir(userSkillsDir)) {
    out.push({
      name: cmd.name,
      description: cmd.description,
      source: "claude-code",
      sourceInfo: { path: cmd.path, source: "claude-code", scope: "user", origin: "user-skills" },
    });
  }

  for (const plugin of readInstalledPlugins()) {
    for (const cmd of scanCommandsDir(join(plugin.installPath, "commands"))) {
      out.push({
        name: `${plugin.slug}:${cmd.name}`,
        description: cmd.description,
        source: "claude-code",
        sourceInfo: { path: cmd.path, source: "claude-code", scope: "plugin", origin: plugin.slug },
      });
    }
    for (const cmd of scanPluginSkills(join(plugin.installPath, "skills"))) {
      out.push({
        name: `${plugin.slug}:${cmd.name}`,
        description: cmd.description,
        source: "claude-code",
        sourceInfo: { path: cmd.path, source: "claude-code", scope: "plugin", origin: plugin.slug },
      });
    }
  }

  // De-dupe on `name` — CC itself resolves later sources as overrides; we keep
  // the first occurrence so user-level shadows nothing and plugins lose to
  // explicit user/project commands of the same name.
  const seen = new Set<string>();
  return out.filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}

/**
 * Plugin skills live at `<skills-root>/<skill-name>/SKILL.md`. The directory
 * name is the canonical skill name; we use it verbatim (after the plugin-slug
 * prefix) so the slash-command name matches what CC itself surfaces.
 */
function scanPluginSkills(root: string): ParsedCommandFile[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: ParsedCommandFile[] = [];
  for (const entry of entries) {
    const skillFile = join(root, entry, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    out.push({ name: entry, description: extractDescription(skillFile), path: skillFile });
  }
  return out;
}

interface ParsedCommandFile {
  name: string;
  description?: string;
  path: string;
}

function scanCommandsDir(root: string): ParsedCommandFile[] {
  if (!existsSync(root)) return [];
  const entries: ParsedCommandFile[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of names) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      // Map subdir/foo.md → "subdir:foo" matching CC's namespace convention.
      const rel = relative(root, full).replace(/\.md$/, "");
      const name = rel.split(sep).join(":");
      entries.push({ name, description: extractDescription(full), path: full });
    }
  }
  return entries;
}

/**
 * Pull a one-line description from a CC command file. CC commands optionally
 * begin with a YAML frontmatter block (`---\n...\n---\n`); when present we
 * read its `description:` field. Otherwise we fall back to the first non-empty
 * body line so the picker is still useful for plain-prose command files (like
 * the user's hand-written `~/.claude/commands/cp-oncall.md`).
 */
function extractDescription(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }

  if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
    const after = text.slice(4);
    const end = after.indexOf("\n---");
    if (end >= 0) {
      const frontmatter = after.slice(0, end);
      const match = frontmatter.match(/^description\s*:\s*(.+?)\s*$/m);
      if (match) {
        let v = match[1].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (v) return truncate(v);
      }
      // Fall through to body if frontmatter has no description.
      const body = after.slice(end + 4);
      return firstBodyLine(body);
    }
  }
  return firstBodyLine(text);
}

function firstBodyLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    return truncate(line);
  }
  return undefined;
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

interface InstalledPlugin {
  slug: string;
  installPath: string;
}

/**
 * Resolve every installed plugin to a directory on disk. The shape we read:
 *   ~/.claude/plugins/installed_plugins.json
 *     { "plugins": { "<slug>@<marketplace>": [{ installPath, ... }, ...] } }
 *   ~/.claude/plugins/known_marketplaces.json
 *     { "<marketplace>": { "installLocation": "...", ... } }
 *
 * For each entry we first try the `installPath` field — github/cache-style
 * marketplaces (claude-plugins-official) populate this with the cached copy
 * under `~/.claude/plugins/cache/<market>/<slug>/<ver>`. Directory-style AIM
 * marketplaces leave `installPath` pointing at a non-existent cache path
 * because CC reads them in-place from the marketplace's `installLocation`;
 * we fall back to `<installLocation>/<slug>` so those plugins are still seen.
 */
function readInstalledPlugins(): InstalledPlugin[] {
  const installedFile = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(installedFile)) return [];
  let installedParsed: unknown;
  try {
    installedParsed = JSON.parse(readFileSync(installedFile, "utf-8"));
  } catch {
    return [];
  }
  const plugins = (installedParsed as { plugins?: Record<string, Array<{ installPath?: string }>> })?.plugins;
  if (!plugins || typeof plugins !== "object") return [];

  const marketplaces = readMarketplaces();
  const out: InstalledPlugin[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    const first = Array.isArray(entries) ? entries[0] : undefined;
    const at = key.indexOf("@");
    const slug = at >= 0 ? key.slice(0, at) : key;
    const market = at >= 0 ? key.slice(at + 1) : undefined;
    const candidates: string[] = [];
    if (first?.installPath) candidates.push(first.installPath);
    if (market && marketplaces[market]) candidates.push(join(marketplaces[market], slug));
    const resolved = candidates.find((p) => existsSync(p));
    if (!resolved) continue;
    out.push({ slug, installPath: resolved });
  }
  return out;
}

function readMarketplaces(): Record<string, string> {
  const file = join(homedir(), ".claude", "plugins", "known_marketplaces.json");
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, { installLocation?: string }>)) {
    if (value?.installLocation) out[name] = value.installLocation;
  }
  return out;
}
