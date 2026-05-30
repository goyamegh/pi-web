import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { PiWebSession, PiWebModel } from "../../types.js";
import type { AgentAdapter, AgentCapabilities, AgentSlashCommand } from "../types.js";
import { discoverCCSlashCommands } from "./commands.js";
import { ccProjectDir, ccSessionFile, loadCCMessages } from "./sessions.js";
import { translateCCMessage } from "./translator.js";
import type { CCContentBlock, CCEffort, CCMessage, CCStreamEvent } from "./types.js";

/**
 * Capabilities advertised by the Claude Code adapter. Differs from pi:
 *   - compaction: false        (CC has /compact internally; not bridged in v1)
 *   - conversationTree: false  (CC has no branch navigation; transcript is linear)
 *   - extensionDialogs: false  (CC has no pi-style extension UI surface)
 *   - multiProviderModels: false (CC's model selection is fixed: anthropic API or Bedrock)
 *   - permissionPrompts: false (we run CC with --permission-mode bypassPermissions
 *                              by default so behavior matches a normal terminal
 *                              `claude` invocation; surfacing canUseTool prompts
 *                              through the WS channel is a future iteration)
 *   - promptTemplates: false   (CC's .claude/commands/*.md not bridged in v1)
 *   - reload: false            (no equivalent SDK call)
 *   - branchSummaries: false   (sub-feature of tree)
 */
export const CC_CAPABILITIES: AgentCapabilities = {
  compaction: false,
  conversationTree: false,
  extensionDialogs: false,
  multiProviderModels: false,
  imageInput: true,
  permissionPrompts: false,
  thinkingLevels: true,
  promptTemplates: false,
  reload: false,
  branchSummaries: false,
};

/** pi-shaped thinking level → CC --effort flag. */
const THINKING_TO_EFFORT: Record<string, CCEffort | null> = {
  off: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const CC_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];

/**
 * Resolve the effective list of selectable models given CC's runtime config.
 * When CLAUDE_CODE_USE_BEDROCK=1 we return the Bedrock model IDs the CLI
 * accepts via --model; otherwise the Anthropic API aliases. The provider name
 * matches the Bedrock vs anthropic distinction so the existing settings store
 * (which keys defaults by provider/id) round-trips correctly.
 */
function resolveModels(): PiWebModel[] {
  const useBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === "1" || process.env.CLAUDE_CODE_USE_BEDROCK === "true";
  if (useBedrock) {
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

const CC_BIN = process.env.CLAUDE_CODE_BIN || "claude";

/**
 * Permission mode passed to `claude --permission-mode <mode>` for every turn.
 *
 * In CC's --print mode (which we use for streaming subprocess turns) there is
 * no TTY, so any tool call that would normally prompt the user gets silently
 * denied under the CLI's default mode. That makes Edit / Write / risky Bash
 * effectively unusable inside pi-web. We default to "bypassPermissions" so
 * sessions inside pi-web behave like a normal local `claude` invocation in a
 * trusted cwd — the same trust model pi sessions already operate under.
 *
 * Power users can override via the PI_WEB_CC_PERMISSION_MODE env var. Valid
 * values come from the CC CLI: acceptEdits, auto, bypassPermissions, default,
 * dontAsk, plan. Surfacing canUseTool prompts to the pi-web UI is a future
 * enhancement; once that lands the default here can shift to "default".
 */
const CC_PERMISSION_MODE: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan" = (() => {
  const value = (process.env.PI_WEB_CC_PERMISSION_MODE || "").trim();
  const allowed = new Set(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);
  if (value && allowed.has(value)) return value as typeof CC_PERMISSION_MODE;
  return "bypassPermissions";
})();

export interface CreateClaudeCodeAdapterOptions {
  cwd: string;
  /** Existing session id to resume; if omitted, a new UUID is minted. */
  sessionId?: string;
  /** Bytes of system-prompt context to append (e.g. pi-web's web-ui.md). */
  appendSystemPrompt?: string;
  /** Initial model to use; defaults to the first entry from resolveModels(). */
  initialModel?: PiWebModel;
  /** Initial thinking level; defaults to "medium". */
  initialThinkingLevel?: string;
}

/**
 * Build a fully populated AgentAdapter that speaks Claude Code via the local
 * `claude` CLI binary in --print --output-format stream-json mode. Each prompt
 * spawns a one-shot subprocess that resumes the session (after the first turn)
 * via --resume <session-id>; transcripts are persisted by CC under
 * ~/.claude/projects/<slug>/<session-id>.jsonl.
 */
export async function createClaudeCodeAdapter(opts: CreateClaudeCodeAdapterOptions): Promise<AgentAdapter> {
  const sessionId = opts.sessionId || randomUUID();
  const sessionFile = ccSessionFile(opts.cwd, sessionId);
  // Ensure project dir exists so CC has somewhere to write the transcript on first turn.
  await mkdir(ccProjectDir(opts.cwd), { recursive: true });

  const initialMessages = await loadCCMessages(sessionFile);
  const messages: unknown[] = [...initialMessages];

  // Best-effort: if the JSONL already exists, we have a resumable session;
  // otherwise the first prompt creates it.
  let firstTurnCompleted = existsSync(sessionFile) && initialMessages.length > 0;

  const subscribers = new Set<(event: unknown) => void>();
  function emit(event: unknown) {
    for (const cb of subscribers) {
      try { cb(event); } catch { /* listener errors should not break the stream */ }
    }
  }

  let model: PiWebModel = opts.initialModel || resolveModels()[0];
  let thinkingLevel = opts.initialThinkingLevel || "medium";
  let sessionName: string | undefined;
  let isStreaming = false;
  // Tracks whether an `agent_end` event has been emitted for the current turn.
  // Starts true (no turn in flight); flipped to false at runTurn() entry and
  // back to true on every code path that emits agent_end. settle() uses it to
  // synthesize a terminal event when the CC subprocess exits without one.
  let agentEndEmitted = true;
  let activeChild: ChildProcessWithoutNullStreams | undefined;
  // Once abort() is invoked we must stop forwarding any further stream events
  // from the (possibly still-alive) CC subprocess: stdout buffering can have
  // queued partial JSONL frames that arrive after the SIGTERM but before the
  // child has actually exited. Without this guard the UI would keep receiving
  // assistant / tool_execution events long after the user clicked Stop.
  let aborted = false;
  let lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;

  const toolNamesById = new Map<string, string>();

  const modelRegistry = {
    getAvailable: () => resolveModels(),
    find: (provider: string, id: string) => resolveModels().find((m) => m.provider === provider && m.id === id),
  };

  // Minimal sessionManager. Tree/branch features are unsupported (capabilities
  // gate them off); other accessors return safe defaults.
  const sessionManager = {
    newSession() {
      messages.length = 0;
      firstTurnCompleted = false;
      lastUsage = undefined;
      toolNamesById.clear();
    },
    setSessionFile(_path: string) { /* CC owns the path; no-op. */ },
    buildSessionContext: () => ({ messages }),
    getSessionName: () => sessionName,
    getSessionDir: () => ccProjectDir(opts.cwd),
    getLeafId: () => null,
    getEntry: () => undefined,
    getBranch: () => messages.map((message) => ({ type: "message", message })),
    getTree: () => [],
    getLabel: () => undefined,
  };

  /**
   * Apply a single CC stream-json event to in-memory state and emit the
   * matching pi event(s). Returns true once a `result` event terminates the
   * turn so the caller can resolve the prompt promise.
   */
  function applyStreamEvent(event: CCStreamEvent): boolean {
    if (!event || typeof event !== "object") return false;
    if (event.type === "system") {
      // First emission of a turn carries session_id; surface as session_info_changed
      // when CC mints a fresh id (e.g. on the very first turn).
      const sys = event as { session_id?: string };
      if (sys.session_id && sys.session_id !== sessionId) {
        emit({ type: "session_info_changed", sessionId: sys.session_id });
      }
      return false;
    }

    if (event.type === "assistant") {
      const ev = event as { message: CCMessage };
      const piMessages = translateCCMessage(ev.message, { toolNamesById });
      for (const m of piMessages) messages.push(m);
      // Emit tool_execution_start for any new tool_use blocks.
      const content = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const block of content) {
        const b = block as CCContentBlock;
        if (b.type === "tool_use") {
          const tu = b as { id: string; name: string; input?: Record<string, unknown> };
          emit({ type: "tool_execution_start", toolName: tu.name, toolCallId: tu.id, args: tu.input || {} });
        }
      }
      // Capture usage so getContextUsage can report token totals.
      if (ev.message.usage) {
        lastUsage = {
          input: ev.message.usage.input_tokens || 0,
          output: ev.message.usage.output_tokens || 0,
          cacheRead: ev.message.usage.cache_read_input_tokens || 0,
          cacheWrite: ev.message.usage.cache_creation_input_tokens || 0,
        };
      }
      emit({ type: "message_end", message: piMessages[piMessages.length - 1] });
      return false;
    }

    if (event.type === "user") {
      const ev = event as { message: CCMessage };
      const piMessages = translateCCMessage(ev.message, { toolNamesById });
      for (const m of piMessages) messages.push(m);
      // Emit tool_execution_end for tool_result blocks.
      const content = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const block of content) {
        const b = block as CCContentBlock;
        if (b.type === "tool_result") {
          const tr = b as { tool_use_id: string; content: unknown; is_error?: boolean };
          emit({
            type: "tool_execution_end",
            toolName: toolNamesById.get(tr.tool_use_id) || "tool",
            toolCallId: tr.tool_use_id,
            isError: Boolean(tr.is_error),
            result: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
          });
        }
      }
      return false;
    }

    if (event.type === "result") {
      const ev = event as { is_error?: boolean; result?: string; total_cost_usd?: number; subtype?: string };
      agentEndEmitted = true;
      emit({ type: "agent_end", isError: Boolean(ev.is_error), result: ev.result, cost: ev.total_cost_usd, subtype: ev.subtype });
      return true;
    }

    // stream_event with text deltas \u2014 surface as message_update so the UI can
    // animate partial text. We do NOT mutate `messages` here; the final
    // `assistant` event carries the complete content and is the source of
    // truth for persisted messages.
    if (event.type === "stream_event") {
      const sub = (event as { event: { type: string; delta?: { type: string; text?: string } } }).event;
      if (sub?.type === "content_block_delta" && sub.delta?.type === "text_delta" && sub.delta.text) {
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: sub.delta.text } });
      }
      return false;
    }

    return false;
  }

  /**
   * Buffer stdout JSONL lines and dispatch them as discrete CCStreamEvents.
   * CC may flush partial lines, so we accumulate until \n boundaries and
   * tolerate trailing data on close.
   */
  function makeLineBuffer(onEvent: (e: CCStreamEvent) => boolean): { push(chunk: Buffer | string): boolean; flush(): boolean } {
    let buffer = "";
    let terminated = false;
    function feedLine(line: string): boolean {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        const parsed = JSON.parse(trimmed) as CCStreamEvent;
        return onEvent(parsed);
      } catch {
        return false;
      }
    }
    return {
      push(chunk) {
        if (terminated) return true;
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (feedLine(line)) terminated = true;
          if (terminated) return true;
          idx = buffer.indexOf("\n");
        }
        return false;
      },
      flush() {
        if (!buffer.trim()) return terminated;
        const result = feedLine(buffer);
        buffer = "";
        if (result) terminated = true;
        return terminated;
      },
    };
  }

  function thinkingArgs(): string[] {
    const effort = THINKING_TO_EFFORT[thinkingLevel];
    if (!effort) return [];
    return ["--effort", effort];
  }

  function modelArg(): string[] {
    if (!model?.id) return [];
    return ["--model", model.id];
  }

  /**
   * Spawn a one-shot CC subprocess for a single user turn. Returns a promise
   * that resolves once CC emits a terminal `result` event (or rejects on
   * spawn / exit error).
   */
  async function runTurn(messageText: string, _images?: unknown[]): Promise<void> {
    if (isStreaming) throw new Error("Claude Code session is already processing a prompt.");
    isStreaming = true;
    agentEndEmitted = false;
    aborted = false;
    emit({ type: "agent_start" });

    const args = [
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode", CC_PERMISSION_MODE,
      ...(firstTurnCompleted ? ["--resume", sessionId] : ["--session-id", sessionId]),
      "--add-dir", opts.cwd,
      ...modelArg(),
      ...thinkingArgs(),
      ...(opts.appendSystemPrompt ? ["--append-system-prompt", opts.appendSystemPrompt] : []),
    ];

    return new Promise<void>((resolve, reject) => {
      const child = spawn(CC_BIN, args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      activeChild = child;

      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        isStreaming = false;
        activeChild = undefined;
        // If the CC subprocess exited without emitting a terminal `result`
        // event (crash, kill, network drop, etc.) the UI's streaming
        // indicator would otherwise stay stuck on. Synthesize an agent_end
        // here so clients un-stick on the next websocket flush.
        if (!agentEndEmitted) {
          agentEndEmitted = true;
          emit({ type: "agent_end", isError: Boolean(err), aborted: !err, errorMessage: err?.message });
        }
        if (err) reject(err); else resolve();
      };

      const buf = makeLineBuffer((event) => {
        // Drop everything that comes in after abort() \u2014 the user has already
        // seen agent_end and the UI has cleared its streaming state. Letting
        // queued assistant / tool events through here causes the post-stop
        // "ghost streaming" the user reported.
        if (aborted) return false;
        return applyStreamEvent(event);
      });
      child.stdout.on("data", (chunk) => {
        if (aborted) return;
        if (buf.push(chunk)) {
          // Terminal result seen \u2014 mark first turn done, but keep stream open
          // until child exits to drain trailing events.
          firstTurnCompleted = true;
        }
      });
      child.stderr.on("data", (chunk) => {
        if (aborted) return;
        // CC stderr is mostly diagnostic; surface as server_error-shaped events
        // via the subscribe channel so server.ts broadcasts them.
        const text = chunk.toString("utf-8");
        if (text.trim()) emit({ type: "server_diagnostic", message: text });
      });
      child.once("error", (err) => settle(err));
      child.once("close", (code) => {
        buf.flush();
        firstTurnCompleted = true;
        if (code === 0 || code === null) settle();
        else settle(new Error(`Claude Code exited with code ${code}`));
      });

      // Send the user message as a single stream-json input frame and close
      // stdin so CC processes one turn and exits.
      const userFrame = JSON.stringify({
        type: "user",
        message: { role: "user", content: messageText },
      });
      child.stdin.write(`${userFrame}\n`);
      child.stdin.end();

      // Push the user message into our local store immediately so the UI
      // shows it before the assistant streams in.
      messages.push({ role: "user", content: messageText, timestamp: new Date().toISOString() });
    });
  }

  // Build the PiWebSession-compatible adapter object. Properties are real
  // class-style methods (not arrow lambdas in an object literal) so `this`
  // resolves to the adapter when used via getCapabilities()/getAgentSlashCommands().
  const adapter = {
    sessionId,
    sessionFile,
    isCompacting: false,
    messages,
    agent: { state: { messages } },
    sessionManager,
    modelRegistry,
    promptTemplates: [] as unknown[],
    resourceLoader: {
      getPrompts: () => ({ prompts: [] }),
      getSkills: () => ({ skills: [] }),
    },
    // isStreaming and pendingMessageCount must be getters so server-side
    // reads (currentState(), runtimeForPath(), the WS hello envelope) see
    // the live closure value rather than a snapshot taken at construction.
    get isStreaming() { return isStreaming; },
    get pendingMessageCount() { return 0; },
    get model() { return model; },
    get thinkingLevel() { return thinkingLevel; },
    get sessionName() { return sessionName; },
    getAvailableThinkingLevels(): string[] { return CC_THINKING_LEVELS; },
    getSessionName(): string | undefined { return sessionName; },
    getContextUsage() {
      if (!lastUsage) return undefined;
      const tokens = lastUsage.input + lastUsage.cacheRead;
      const contextWindow = model?.contextWindow || 200_000;
      return {
        tokens,
        contextWindow,
        percent: Math.round((tokens / contextWindow) * 1000) / 10,
      };
    },
    setSessionName(name: string) {
      sessionName = name.trim() || undefined;
      emit({ type: "session_info_changed", name: sessionName });
    },
    async setModel(next: unknown) {
      const m = next as PiWebModel;
      const found = modelRegistry.find(m.provider, m.id);
      if (!found) throw new Error(`Model not available in Claude Code: ${m.provider}/${m.id}`);
      model = found;
    },
    setThinkingLevel(level: string) {
      if (!CC_THINKING_LEVELS.includes(level)) throw new Error(`Unknown thinking level: ${level}`);
      thinkingLevel = level;
    },
    async prompt(messageText: string, options?: { images?: unknown[]; streamingBehavior?: string }) {
      if (options?.images?.length) {
        // Image attachments are not yet wired through the CC CLI. The pi-web
        // server currently appends image-file paths to the message text via
        // persistPromptImages(); CC will pick those up as plain references.
      }
      await runTurn(messageText, options?.images);
    },
    async abort() {
      // Order matters: flip `aborted` BEFORE killing the child so the stdout
      // / stderr listeners installed in runTurn() drop any frames the CC
      // subprocess emits between SIGTERM and actual exit. Otherwise the UI
      // shows agent_end and then keeps receiving assistant text deltas /
      // tool_execution events from the dying child.
      aborted = true;
      isStreaming = false;
      const child = activeChild;
      activeChild = undefined;
      if (!agentEndEmitted) {
        agentEndEmitted = true;
        emit({ type: "agent_end", aborted: true });
      }
      if (child && !child.killed) {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        // CC may not respond to SIGTERM promptly when it's mid-tool-call;
        // escalate to SIGKILL after a short grace so the child can't keep
        // running in the background after the user hit Stop.
        const killTimer = setTimeout(() => {
          try { if (!child.killed) child.kill("SIGKILL"); } catch { /* already gone */ }
        }, 2000);
        child.once("exit", () => clearTimeout(killTimer));
      }
    },
    async bindExtensions(_bindings: unknown) {
      // CC has no pi-style extension surface; intentionally a no-op so server.ts
      // can bindWebExtensions(adapter) without branching on agent kind.
    },
    subscribe(listener: (event: unknown) => void): () => void {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  } satisfies Partial<PiWebSession>;

  // Attach AgentAdapter contract (kind / capabilities / slash commands).
  Object.defineProperty(adapter, "kind", { value: "claude-code", enumerable: false, configurable: true });
  Object.defineProperty(adapter, "getCapabilities", { value: () => CC_CAPABILITIES, enumerable: false, configurable: true });
  Object.defineProperty(adapter, "getAgentSlashCommands", {
    value: (): AgentSlashCommand[] => {
      // CC's built-in slash commands. These are not on disk; we hardcode them so
      // the picker can offer them even before any user-level / plugin commands
      // are discovered.
      const builtins: AgentSlashCommand[] = [
        ["clear", "Clear conversation history"],
        ["compact", "Compact context (use /compact <instructions>)"],
        ["cost", "Show session cost"],
        ["model", "Show or change model"],
        ["help", "Show built-in commands"],
        ["review", "Review the current diff"],
        ["init", "Initialize a CLAUDE.md from this project"],
      ].map(([name, description]) => ({
        name,
        description,
        source: "claude-code",
        sourceInfo: { path: "<claude-code>", source: "claude-code", scope: "agent", origin: "top-level" },
      }));

      // User-level (~/.claude/commands), project-level (<cwd>/.claude/commands),
      // and plugin commands (~/.claude/plugins/installed_plugins.json) — read
      // fresh on every call so newly installed plugins / new command files are
      // visible without a server restart.
      const discovered = discoverCCSlashCommands(opts.cwd);
      const builtinNames = new Set(builtins.map((c) => c.name));
      return [...builtins, ...discovered.filter((c) => !builtinNames.has(c.name))];
    },
    enumerable: false,
    configurable: true,
  });

  return adapter as unknown as AgentAdapter;
}
