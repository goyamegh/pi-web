import type { PiWebSession } from "../types.js";
import type { AgentAdapter, AgentCapabilities, AgentKind, AgentSlashCommand } from "./types.js";

/**
 * Capabilities for the first-party pi agent. Mirrors the feature set already
 * surfaced by pi-web today; if you add a UI affordance that ought to be gated
 * for non-pi agents, add a corresponding flag here AND default it to false on
 * AgentCapabilities (in ./types.ts) so unaware adapters opt out implicitly.
 */
export const PI_CAPABILITIES: AgentCapabilities = {
  compaction: true,
  conversationTree: true,
  extensionDialogs: true,
  multiProviderModels: true,
  imageInput: true,
  permissionPrompts: false,
  thinkingLevels: true,
  promptTemplates: true,
  reload: true,
  branchSummaries: true,
};

/**
 * Capabilities for the deterministic mock harness (PI_WEB_MOCK=1). The mock
 * mimics pi behavior for visual/regression tests, so it advertises the same
 * surface as pi.
 */
export const MOCK_CAPABILITIES: AgentCapabilities = { ...PI_CAPABILITIES };

const CAPABILITIES_BY_KIND: Record<Exclude<AgentKind, "claude-code">, AgentCapabilities> = {
  pi: PI_CAPABILITIES,
  mock: MOCK_CAPABILITIES,
};

/**
 * Read agent-sourced slash commands from a pi (or pi-shaped mock) session by
 * inspecting its extensionRunner, promptTemplates, and resourceLoader. The
 * mock harness exposes the same shape, so this function works for both kinds.
 */
function collectPiAgentSlashCommands(session: PiWebSession): AgentSlashCommand[] {
  const commands: AgentSlashCommand[] = [];

  for (const command of session.extensionRunner?.getRegisteredCommands?.() || []) {
    const c = command as { invocationName?: string; name?: string; description?: string; sourceInfo?: unknown };
    const name = c.invocationName || c.name;
    if (!name) continue;
    commands.push({ name, description: c.description, source: "extension", sourceInfo: c.sourceInfo });
  }

  for (const template of session.promptTemplates || session.resourceLoader?.getPrompts?.().prompts || []) {
    const t = template as { name?: string; description?: string; sourceInfo?: unknown };
    if (!t.name) continue;
    commands.push({ name: t.name, description: t.description, source: "prompt", sourceInfo: t.sourceInfo });
  }

  for (const skill of session.resourceLoader?.getSkills?.().skills || []) {
    const s = skill as { name?: string; description?: string; sourceInfo?: unknown };
    if (!s.name) continue;
    commands.push({ name: `skill:${s.name}`, description: s.description, source: "skill", sourceInfo: s.sourceInfo });
  }

  return commands;
}

/**
 * Tag a pi/mock session with the AgentAdapter contract.
 *
 * The pi session shape already structurally satisfies AgentAdapter; this helper
 * only attaches the `kind` discriminator, a `getCapabilities()` accessor, and
 * a `getAgentSlashCommands()` reader. All three properties are non-enumerable
 * so they do not appear in `JSON.stringify(session)` output and cannot leak
 * into wire payloads. The function is idempotent — calling it twice on the
 * same session is a no-op and returns the same reference.
 */
export function wrapPiSession(session: PiWebSession, kind: "pi" | "mock" = "pi"): AgentAdapter {
  const existing = session as Partial<AgentAdapter>;
  if (existing.kind === kind && typeof existing.getCapabilities === "function" && typeof existing.getAgentSlashCommands === "function") {
    return session as AgentAdapter;
  }

  Object.defineProperty(session, "kind", {
    value: kind,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  Object.defineProperty(session, "getCapabilities", {
    value: () => CAPABILITIES_BY_KIND[kind],
    enumerable: false,
    configurable: true,
    writable: false,
  });
  Object.defineProperty(session, "getAgentSlashCommands", {
    value: () => collectPiAgentSlashCommands(session),
    enumerable: false,
    configurable: true,
    writable: false,
  });

  return session as AgentAdapter;
}
