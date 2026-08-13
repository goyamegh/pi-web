import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PiWebModel } from "../../types.js";

/**
 * Model discovery for the Claude Code adapter.
 *
 * CC's selectable models are declared in its own settings hierarchy as
 * `availableModels` — a list of the aliases the CLI accepts via `--model`
 * (e.g. "claude-opus-4-8", "claude-sonnet-5", "claude-opus-4-8[1m]"). When
 * `enforceAvailableModels` is set, that list is exactly what CC permits, so it
 * is the authoritative source for pi-web's model picker.
 *
 * Reading it here replaces a previously hardcoded three-entry list that went
 * stale as new models shipped (users with 14 declared models saw only 3, and
 * never saw Opus 5 / Sonnet 5 / Fable 5 at all).
 *
 * Aliases are passed through to `--model` verbatim: CC resolves them itself via
 * its `modelOverrides` map, so pi-web must NOT substitute the override target.
 */

/** CC settings files, lowest → highest precedence (matching CC's own order). */
function settingsFiles(cwd: string): string[] {
  return [
    join(homedir(), ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    "/etc/claude-code/managed-settings.json",
  ];
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    // A malformed settings file must not break the picker; fall through to the
    // next (lower-precedence) source.
    return undefined;
  }
}

/**
 * Highest-precedence `availableModels` declaration across the CC settings
 * hierarchy. Returns an empty array when no file declares one, which signals
 * the caller to use the built-in fallback list.
 */
function declaredModelIds(cwd: string): string[] {
  let ids: string[] = [];
  for (const file of settingsFiles(cwd)) {
    const raw = readJson(file)?.availableModels;
    if (!Array.isArray(raw)) continue;
    const cleaned = raw.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim());
    // A file that declares the key wins outright (no merging) — same as CC,
    // where a project-level allowlist replaces the user-level one.
    if (cleaned.length) ids = cleaned;
  }
  return ids;
}

const ONE_MILLION = 1_000_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Derive display metadata from a CC model alias. The `[1m]` suffix is CC's
 * explicit marker for the 1M-token context variant, so it drives
 * `contextWindow` (which feeds pi-web's context meter). `maxTokens` has no
 * effect on the CC subprocess — the adapter never forwards it — so a
 * family-level approximation is sufficient for display.
 */
function describeModelId(id: string): Pick<PiWebModel, "name" | "reasoning" | "contextWindow" | "maxTokens"> {
  const oneMillion = /\[1m\]$/i.test(id);
  const base = id.replace(/\[1m\]$/i, "");
  // Strip any region/vendor prefix: "us.anthropic.claude-opus-4-7" → "claude-opus-4-7".
  const lastDot = base.lastIndexOf(".");
  const stem = lastDot >= 0 ? base.slice(lastDot + 1) : base;

  const match = stem.match(/^claude-([a-z]+)-((?:\d+)(?:-\d+)*)/i);
  const contextWindow = oneMillion ? ONE_MILLION : DEFAULT_CONTEXT_WINDOW;
  if (!match) {
    // Unknown shape (a non-Claude or future alias): surface the raw id rather
    // than inventing a label, and keep conservative defaults.
    return { name: id, reasoning: true, contextWindow, maxTokens: 32_000 };
  }

  const family = match[1].toLowerCase();
  // Drop long numeric segments (date stamps like "20251001") so
  // "claude-haiku-4-5-20251001-v1:0" reads as "4.5" rather than "4.5.20251001".
  const version = match[2].split("-").filter((part) => part.length <= 2).join(".");
  const familyLabel = family.charAt(0).toUpperCase() + family.slice(1);
  const name = `Claude ${familyLabel}${version ? ` ${version}` : ""}${oneMillion ? " (1M)" : ""}`;

  const maxTokens = family === "haiku"
    ? 64_000
    : family === "sonnet"
      ? (oneMillion ? 128_000 : 64_000)
      : (oneMillion ? 128_000 : 32_000);

  return { name, reasoning: true, contextWindow, maxTokens };
}

function bedrockEnabled(): boolean {
  return process.env.CLAUDE_CODE_USE_BEDROCK === "1" || process.env.CLAUDE_CODE_USE_BEDROCK === "true";
}

/**
 * Built-in list used only when CC's settings declare no `availableModels`.
 * The provider name mirrors the Bedrock vs anthropic distinction so pi-web's
 * settings store (which keys defaults by provider/id) round-trips correctly.
 */
function fallbackModels(): PiWebModel[] {
  if (bedrockEnabled()) {
    return [
      { provider: "amazon-bedrock", id: "us.anthropic.claude-opus-4-7", name: "Claude Opus 4.7 (Bedrock)", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
      { provider: "amazon-bedrock", id: "us.anthropic.claude-sonnet-4-5", name: "Claude Sonnet 4.5 (Bedrock)", reasoning: true, contextWindow: 200_000, maxTokens: 16_000 },
      { provider: "amazon-bedrock", id: "us.anthropic.claude-haiku-4-5", name: "Claude Haiku 4.5 (Bedrock)", reasoning: true, contextWindow: 200_000, maxTokens: 8_000 },
    ];
  }
  return [
    { provider: "anthropic", id: "opus", name: "Claude Opus", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
    { provider: "anthropic", id: "sonnet", name: "Claude Sonnet", reasoning: true, contextWindow: 200_000, maxTokens: 16_000 },
    { provider: "anthropic", id: "haiku", name: "Claude Haiku", reasoning: true, contextWindow: 200_000, maxTokens: 8_000 },
  ];
}

/**
 * Resolve the effective list of selectable models for a CC session rooted at
 * `cwd`. Read fresh on every call (like `discoverCCSlashCommands`) so edits to
 * ~/.claude/settings.json show up without restarting pi-web.
 */
export function resolveCCModels(cwd: string): PiWebModel[] {
  const declared = declaredModelIds(cwd);
  if (!declared.length) return fallbackModels();

  const provider = bedrockEnabled() ? "amazon-bedrock" : "anthropic";
  const seen = new Set<string>();
  const models: PiWebModel[] = [];
  for (const id of declared) {
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ provider, id, ...describeModelId(id) });
  }
  return models;
}

/**
 * Pick the model a new session should start on. A requested model that is not
 * in the resolved list is discarded rather than trusted: pi-web persists the
 * last model pick globally (`defaults.model`), including picks made in a pi
 * session, so an id CC cannot accept can otherwise reach `--model` and be
 * shown as active despite never appearing in the picker.
 */
export function pickInitialCCModel(requested: PiWebModel | undefined, available: PiWebModel[]): PiWebModel {
  if (!requested) return available[0];
  return available.find((m) => m.provider === requested.provider && m.id === requested.id) || available[0];
}
