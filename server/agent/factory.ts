import { join } from "node:path";
import type { SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { PiWebSession, PiWebSessionInfo } from "../types.js";
import { ccProjectDir, createClaudeCodeAdapter, listCCSessions } from "./index.js";

/**
 * Fork harness glue: plugs the frozen Claude Code adapter into upstream's
 * self-contained LocalSessionService through the `harness` dependency hooks
 * (see LocalSessionServiceDependencies.harness). Inert in mockMode — the mock
 * sessionFactory takes precedence inside the service.
 *
 * Frozen per upstream RFC ashwin-pc/pi-web#92: bugfixes only until the
 * upstream Claude Code harness lands, then this file and server/agent/* are
 * dropped in favour of it.
 */

export interface HarnessHooks {
  /** True when the given session file path belongs to this harness. */
  ownsPath(path: string): boolean;
  /** True when a NEW session (no path) should be created on this harness. */
  wantsNew(sessionStartEvent?: SessionStartEvent): Promise<boolean>;
  /** Create an adapter session (path = resume, otherwise new). */
  create(input: { path?: string; cwd: string; sessionStartEvent?: SessionStartEvent }): Promise<{ session: PiWebSession; modelFallbackMessage?: string }>;
  /** Extra session rows for the unified list (agent-tagged). */
  list(cwd: string): Promise<PiWebSessionInfo[]>;
  /** Locate a harness session by id across candidate cwds. */
  locate(id: string, cwds: Iterable<string>): Promise<{ path: string; cwd: string } | undefined>;
  /** Directory that may legitimately contain harness session files for a cwd. */
  validDir(cwd: string): string;
  /** Called before opening a located harness session (cwd binding). */
  beforeOpen(location: { path: string; cwd: string }): Promise<void>;
}

export interface ForkHarnessFactoryOptions {
  globalCwd(): string;
  setGlobalCwd(cwd: string): Promise<void>;
  settings(): Promise<{ defaults: { agent?: "pi" | "claude-code"; model?: { provider: string; id: string }; thinkingLevel?: string } }>;
  patchDefaultAgent(agent: "pi" | "claude-code"): Promise<unknown>;
}

const CC_PROJECTS_ROOT = join(process.env.HOME || "", ".claude", "projects");

export function detectAgentForPath(path: string): "pi" | "claude-code" {
  return path.startsWith(CC_PROJECTS_ROOT) && path.endsWith(".jsonl") ? "claude-code" : "pi";
}

export function createForkHarnessFactory(opts: ForkHarnessFactoryOptions) {
  // One-shot explicit agent override for the next create (set by the
  // /api/sessions/new route when the request carries an `agent` field).
  let nextAgent: "pi" | "claude-code" | undefined;

  async function withNextAgent<T>(agent: "pi" | "claude-code" | undefined, run: () => Promise<T>): Promise<T> {
    nextAgent = agent;
    try { return await run(); }
    finally { nextAgent = undefined; }
  }

  async function makeClaudeCodeAdapter(sessionId?: string, cwd = opts.globalCwd()): Promise<PiWebSession> {
    const settings = await opts.settings();
    return await createClaudeCodeAdapter({
      cwd,
      sessionId,
      initialModel: settings.defaults.model && settings.defaults.agent === "claude-code"
        ? { provider: settings.defaults.model.provider, id: settings.defaults.model.id }
        : undefined,
      initialThinkingLevel: settings.defaults.thinkingLevel,
    }) as unknown as PiWebSession;
  }

  const hooks: HarnessHooks = {
    ownsPath: (path) => detectAgentForPath(path) === "claude-code",

    async wantsNew(sessionStartEvent) {
      if (nextAgent) return nextAgent === "claude-code";
      // A cwd switch recreates the session; preserve the previous agent.
      const previous = sessionStartEvent?.previousSessionFile;
      if (previous) return detectAgentForPath(previous) === "claude-code";
      const settings = await opts.settings();
      return settings.defaults.agent === "claude-code";
    },

    async create({ path, cwd }) {
      const sessionId = path ? path.match(/([0-9a-f-]{36})\.jsonl$/i)?.[1] : undefined;
      return { session: await makeClaudeCodeAdapter(sessionId, cwd) };
    },

    async list(cwd) {
      const sessions = await listCCSessions(cwd).catch(() => []);
      return sessions.map((info) => ({
        id: info.id,
        path: info.path,
        name: info.name,
        firstMessage: info.firstMessage,
        created: info.created,
        modified: info.modified,
        messageCount: info.messageCount,
        cwd: info.cwd || cwd,
        agent: "claude-code",
      }) as unknown as PiWebSessionInfo);
    },

    async locate(id, cwds) {
      for (const cwd of cwds) {
        const sessions = await listCCSessions(cwd).catch(() => []);
        const hit = sessions.find((info) => info.id === id);
        if (hit) return { path: hit.path, cwd };
      }
      return undefined;
    },

    validDir: (cwd) => ccProjectDir(cwd),

    async beforeOpen(location) {
      // The CC adapter binds --add-dir and its transcript path off the global
      // cwd at construction time; flip it so a new turn does not land in the
      // wrong project slug. No-op when the session lives in the active cwd.
      if (location.cwd !== opts.globalCwd()) await opts.setGlobalCwd(location.cwd);
    },
  };

  /** Persist the last-used agent so the next "+" defaults to the same kind. */
  async function persistLastUsedAgent(sessionId: string, resolve: (id: string) => PiWebSession | undefined) {
    const value = resolve(sessionId);
    if (!value?.sessionFile) return;
    const kind = detectAgentForPath(value.sessionFile) === "claude-code" ? "claude-code" : "pi";
    const settings = await opts.settings();
    if (settings.defaults.agent !== kind) await opts.patchDefaultAgent(kind);
  }

  return { hooks, withNextAgent, persistLastUsedAgent };
}
