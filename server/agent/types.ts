import type { PiWebSession } from "../types.js";

/**
 * Underlying agent runtime. Used as a discriminator on AgentAdapter so server
 * code (and, in later phases, the frontend) can branch on the active agent
 * without inspecting transcript shapes or presence of optional methods.
 *
 * - "pi"          — @mariozechner/pi-coding-agent
 * - "claude-code" — @anthropic-ai/claude-code (planned)
 * - "mock"        — pi-web's deterministic mock harness (PI_WEB_MOCK=1)
 */
export type AgentKind = "pi" | "claude-code" | "mock";

/**
 * A slash command surfaced through the agent. Mirrors the shape of
 * SlashCommandInfo from pi but tolerates additional source labels ("claude-code",
 * etc.) emitted by other adapters. The pi-web overlay ("web" source: /help,
 * /new, /abort, ...) is added on top of these by server.ts and is not part of
 * the agent's own surface.
 */
export interface AgentSlashCommand {
  name: string;
  description?: string;
  source: string;
  sourceInfo?: unknown;
}

/**
 * Per-agent capability flags. Each flag describes a feature surface that the
 * pi-web frontend already supports for pi but may not be available on other
 * agents. The frontend uses these to gate UI affordances (e.g. hide the
 * conversation-tree drawer when an agent does not support branching).
 *
 * All current pi behavior maps to PI_CAPABILITIES in ./pi.ts. New flags should
 * default to the most conservative value (false) so that adding a flag never
 * silently enables UI for agents that have not been updated.
 */
export interface AgentCapabilities {
  /** Manual context compaction supported (e.g. /compact). */
  compaction: boolean;
  /** Branching conversation tree with navigation supported. */
  conversationTree: boolean;
  /** Extension-driven UI dialogs (notify, setStatus, setWidget, confirm, input, editor). */
  extensionDialogs: boolean;
  /** Multi-provider model registry exposed; if false the UI shows a fixed list. */
  multiProviderModels: boolean;
  /** Image attachments supported in prompts. */
  imageInput: boolean;
  /** Agent may surface tool-use approval prompts (e.g. claude-code's canUseTool). */
  permissionPrompts: boolean;
  /** Reasoning/thinking level selection supported. */
  thinkingLevels: boolean;
  /** Agent exposes prompt templates / skill / extension slash command resources. */
  promptTemplates: boolean;
  /** /reload supported. */
  reload: boolean;
  /** Branch-summary generation/abort supported (a sub-feature of conversationTree). */
  branchSummaries: boolean;
}

/**
 * Agent-agnostic surface consumed by pi-web's server. The first-party pi
 * adapter extends PiWebSession verbatim (its shape is already a structural
 * superset of what AgentAdapter requires); future Claude Code adapter will
 * implement the same interface with its own concrete shape.
 *
 * Phase 0 keeps PiWebSession intact and only adds a discriminator and a
 * capability getter on top, so existing call sites that work against
 * PiWebSession remain valid.
 */
export interface AgentAdapter extends PiWebSession {
  /** Discriminator for the underlying agent runtime. */
  readonly kind: AgentKind;
  /** Per-agent capability flags consumed by the frontend. */
  getCapabilities(): AgentCapabilities;
  /**
   * Slash commands sourced from the agent itself — pi extensions/prompts/skills
   * for the pi adapter, claude-code's native + project commands for the CC
   * adapter. Excludes pi-web's own /help, /new, /abort overlay (those are
   * stitched in by server.ts so they are available regardless of agent).
   */
  getAgentSlashCommands(): AgentSlashCommand[];
}
