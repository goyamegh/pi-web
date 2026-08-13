import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PiWebSession, PiWebModel } from "../../types.js";
import type { AgentAdapter, AgentCapabilities, AgentSlashCommand } from "../types.js";
import { discoverCCSlashCommands } from "./commands.js";
import { pickInitialCCModel, resolveCCModels } from "./models.js";
import { ccProjectDir, ccSessionFile, loadCCMessages } from "./sessions.js";
import { translateCCMessage } from "./translator.js";
import type { CCContentBlock, CCEffort, CCMessage, CCStreamEvent } from "./types.js";

/**
 * Capabilities advertised by the Claude Code adapter. Differs from pi:
 *   - compaction: true         (bridged: adapter.compact() sends /compact to the
 *                              persistent CC child and maps compact_boundary
 *                              frames onto pi's compaction_start/end events)
 *   - conversationTree: false  (CC has no branch navigation; transcript is linear)
 *   - extensionDialogs: false  (CC has no pi-style extension UI surface)
 *   - multiProviderModels: false (CC talks to exactly one provider per run:
 *                              anthropic API or Bedrock, chosen by env)
 *   - permissionPrompts: false (we run CC with --permission-mode bypassPermissions
 *                              by default so behavior matches a normal terminal
 *                              `claude` invocation; surfacing canUseTool prompts
 *                              through the WS channel is a future iteration)
 *   - promptTemplates: false   (CC's .claude/commands/*.md not bridged in v1)
 *   - reload: false            (no equivalent SDK call)
 *   - branchSummaries: false   (sub-feature of tree)
 */
export const CC_CAPABILITIES: AgentCapabilities = {
  compaction: true,
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

/**
 * Every live CC child across all adapters, so a process-level exit (normal
 * shutdown or supervised restart) can reap them. CC children also self-exit
 * on stdin EOF when the parent dies uncleanly, so this is belt-and-braces
 * rather than the only defense against orphans.
 */
const liveCCChildren = new Set<ChildProcessWithoutNullStreams>();
let exitReaperInstalled = false;
function installExitReaper() {
  if (exitReaperInstalled) return;
  exitReaperInstalled = true;
  process.on("exit", () => {
    for (const child of liveCCChildren) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });
}

/**
 * How long abort() waits for an interrupted turn's `result` frame before
 * giving up on the stream-json interrupt and killing the child instead.
 */
const INTERRUPT_GRACE_MS = 3000;

export interface CreateClaudeCodeAdapterOptions {
  cwd: string;
  /** Existing session id to resume; if omitted, a new UUID is minted. */
  sessionId?: string;
  /** Bytes of system-prompt context to append (e.g. pi-web's web-ui.md). */
  appendSystemPrompt?: string;
  /**
   * Initial model to use. Ignored when it is not one of the models CC declares
   * as available, in which case the first available model is used instead.
   */
  initialModel?: PiWebModel;
  /** Initial thinking level; defaults to "medium". */
  initialThinkingLevel?: string;
}

/**
 * Build a fully populated AgentAdapter that speaks Claude Code via the local
 * `claude` CLI binary in --print --input-format/--output-format stream-json
 * mode. One persistent subprocess serves the whole session: stdin stays open
 * and each prompt is written as a user frame; the turn boundary is CC's
 * terminal `result` frame, not process exit. The child is respawned lazily
 * (with --resume <session-id>) after a crash, an abort escalation, or a
 * spawn-time flag change (model / effort). Transcripts are persisted by CC
 * under ~/.claude/projects/<slug>/<session-id>.jsonl.
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

  // A requested initialModel is validated against CC's own list rather than
  // trusted: pi-web persists the last model pick globally (including picks made
  // in a pi session), so an id CC cannot accept must not reach `--model`.
  let model: PiWebModel = pickInitialCCModel(opts.initialModel, resolveCCModels(opts.cwd));
  let thinkingLevel = opts.initialThinkingLevel || "medium";
  let sessionName: string | undefined;
  let isStreaming = false;
  // Tracks whether an `agent_end` event has been emitted for the current turn.
  // Starts true (no turn in flight); flipped to false at prompt() entry and
  // back to true on every code path that emits agent_end. handleChildGone()
  // uses it to synthesize a terminal event when the CC child dies without one.
  let agentEndEmitted = true;
  let activeChild: ChildProcessWithoutNullStreams | undefined;
  // Once abort() is invoked we must stop forwarding stream events for the
  // CURRENT turn only: the child stays alive and its stdout can hold queued
  // frames from the interrupted turn. Without this guard the UI would keep
  // receiving assistant / tool_execution events after the user clicked Stop.
  // Cleared when the interrupted turn's `result` frame arrives (or the child
  // is killed), so subsequent turns stream normally.
  let turnAborted = false;
  // The prompt/compact turn currently awaiting its terminal `result` frame.
  // At most one turn is in flight at a time (prompt() and compact() guard).
  let pendingTurn: {
    kind: "prompt" | "compact";
    resolve: () => void;
    reject: (err: Error) => void;
    sawAssistantMessage: boolean;
  } | undefined;
  let compacting = false;
  // pre_tokens captured from the live compact_boundary frame of the current
  // compaction turn; also the "did CC actually compact?" signal (a /compact
  // that was a no-op never emits a boundary).
  let compactBoundary: { preTokens?: number } | undefined;
  // Set when setModel/setThinkingLevel changes a spawn-time flag while a child
  // is alive; the child is retired so the next turn respawns with new flags.
  let spawnFlagsDirty = false;
  // Escalation timer armed by abort(): if the interrupt doesn't yield the
  // turn's result frame promptly, the child is killed instead.
  let interruptFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  // Slash-command names reported by the CC process itself in its init frame
  // (~hundreds incl. plugin skills). Preferred over disk scraping once known.
  let initCommandNames: string[] | undefined;
  let lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
  let activeCwd: string | undefined;

  const toolNamesById = new Map<string, string>();

  // Matches PiWebSession.modelRuntime's surface (getAvailableSnapshot/getModel)
  // so upstream session services can query CC models transparently. Resolved
  // fresh on each call so edits to ~/.claude/settings.json (or a newly added
  // project-level allowlist) surface without restarting pi-web.
  const modelRuntime = {
    getAvailableSnapshot: () => resolveCCModels(opts.cwd),
    getModel: (provider: string, id: string) => resolveCCModels(opts.cwd).find((m) => m.provider === provider && m.id === id),
  };

  // Minimal sessionManager. Tree/branch features are unsupported (capabilities
  // gate them off); other accessors return safe defaults.
  const sessionManager = {
    newSession() {
      retireChild();
      messages.length = 0;
      firstTurnCompleted = false;
      lastUsage = undefined;
      toolNamesById.clear();
    },
    setSessionFile(_path: string) { /* CC owns the path; no-op. */ },
    // sessionCwd() in server.ts resolves a session's home folder via
    // sessionManager.getCwd() and otherwise falls back to the server-global
    // piCwd. Without this accessor every CC session reported the boot cwd,
    // so picking a folder (drawer "new session in folder", folder picker)
    // appeared to have no effect for Claude Code sessions.
    getCwd: () => opts.cwd,
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
   * Infer the active working directory from a tool_use block's input. Supports:
   * - Bash: `cd <path>`, `git -C <path>`, explicit `-C` flag
   * - Edit/Write/Read/Glob/Grep: `file_path` or `path` argument
   * Returns undefined if no signal found.
   */
  function inferCwdFromToolUse(name: string, input: Record<string, unknown>): string | undefined {
    if (name === "Bash" || name === "bash") {
      const cmd = typeof input.command === "string" ? input.command : "";
      // `cd <path>` at the start or after && / ;
      const cdMatch = cmd.match(/(?:^|&&|;)\s*cd\s+["']?([^\s;"'&]+)/);
      if (cdMatch?.[1] && isAbsolute(cdMatch[1])) return cdMatch[1];
      if (cdMatch?.[1]) return resolve(opts.cwd, cdMatch[1]);
      // `git -C <path>` or `git --git-dir=... -C <path>`
      const gitCMatch = cmd.match(/git\s[^|;]*?-C\s+["']?([^\s;"'&]+)/);
      if (gitCMatch?.[1] && isAbsolute(gitCMatch[1])) return gitCMatch[1];
      if (gitCMatch?.[1]) return resolve(opts.cwd, gitCMatch[1]);
      return undefined;
    }
    // File-based tools: Extract directory from file_path or path
    const filePath = typeof input.file_path === "string" ? input.file_path
      : typeof input.path === "string" ? input.path
      : undefined;
    if (filePath && isAbsolute(filePath)) return dirname(filePath);
    return undefined;
  }

  function updateActiveCwd(content: CCContentBlock[]) {
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      const tu = block as { name: string; input?: Record<string, unknown> };
      const inferred = inferCwdFromToolUse(tu.name, tu.input || {});
      if (inferred && inferred !== activeCwd) {
        activeCwd = inferred;
        emit({ type: "active_cwd_changed", activeCwd });
      }
    }
  }

  /**
   * Apply a single CC stream-json event to in-memory state and emit the
   * matching pi event(s). Returns true once a `result` event terminates the
   * turn so the caller can resolve the prompt promise.
   */
  function applyStreamEvent(event: CCStreamEvent): boolean {
    if (!event || typeof event !== "object") return false;
    if (event.type === "system") {
      const sys = event as {
        subtype?: string;
        session_id?: string;
        cwd?: string;
        slash_commands?: unknown;
        compact_metadata?: { pre_tokens?: number };
      };
      // Manual /compact emits a compact_boundary frame before its result; the
      // metadata (pre_tokens) feeds the compaction_end event and its presence
      // distinguishes a real compaction from a "not enough messages" no-op.
      if (sys.subtype === "compact_boundary") {
        compactBoundary = { preTokens: sys.compact_metadata?.pre_tokens };
        return false;
      }
      // First emission of a turn carries session_id; surface as session_info_changed
      // when CC mints a fresh id (e.g. on the very first turn).
      if (sys.session_id && sys.session_id !== sessionId) {
        emit({ type: "session_info_changed", sessionId: sys.session_id });
      }
      // The init frame lists every command the CC process itself honors
      // (built-ins, plugins, skills) — authoritative over disk scraping.
      if (Array.isArray(sys.slash_commands)) {
        const names = sys.slash_commands.filter((n): n is string => typeof n === "string" && Boolean(n.trim()));
        if (names.length) initCommandNames = names;
      }
      // CC reports its shell cwd on each system/init — use it as the active cwd.
      if (sys.cwd && sys.cwd !== activeCwd) {
        activeCwd = sys.cwd;
        emit({ type: "active_cwd_changed", activeCwd });
      }
      return false;
    }

    if (event.type === "assistant") {
      const ev = event as { message: CCMessage };
      if (pendingTurn) pendingTurn.sawAssistantMessage = true;
      const piMessages = translateCCMessage(ev.message, { toolNamesById });
      for (const m of piMessages) messages.push(m);
      // Emit tool_execution_start for any new tool_use blocks.
      const content = Array.isArray(ev.message.content) ? ev.message.content : [];
      updateActiveCwd(content as CCContentBlock[]);
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
      finishTurn(event as { is_error?: boolean; result?: string; total_cost_usd?: number; subtype?: string });
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
  function makeLineBuffer(onEvent: (e: CCStreamEvent) => void): { push(chunk: Buffer | string): void; flush(): void } {
    let buffer = "";
    function feedLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        onEvent(JSON.parse(trimmed) as CCStreamEvent);
      } catch {
        // Non-JSON stdout noise is ignored; CC's protocol lines are JSONL.
      }
    }
    return {
      push(chunk) {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          feedLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
        }
      },
      flush() {
        if (buffer.trim()) feedLine(buffer);
        buffer = "";
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

  function buildSpawnArgs(): string[] {
    return [
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
  }

  function clearInterruptFallback() {
    if (interruptFallbackTimer) {
      clearTimeout(interruptFallbackTimer);
      interruptFallbackTimer = undefined;
    }
  }

  /**
   * Settle the pending turn without a `result` frame (child died, abort
   * escalation, dispose). Synthesizes the terminal event the UI needs so the
   * streaming/compacting indicators never get stuck: agent_end for prompt
   * turns, compaction_end for compaction turns. No error means "treat as
   * aborted"; an error rejects the turn's promise.
   */
  function settlePendingTurn(err?: Error) {
    const turn = pendingTurn;
    pendingTurn = undefined;
    clearInterruptFallback();
    isStreaming = false;
    turnAborted = false;
    if (!turn) return;
    if (turn.kind === "compact") {
      if (compacting) {
        compacting = false;
        compactBoundary = undefined;
        emit({ type: "compaction_end", reason: "manual", aborted: true });
      }
      if (err) turn.reject(err); else turn.resolve();
      return;
    }
    if (!agentEndEmitted) {
      agentEndEmitted = true;
      emit({ type: "agent_end", isError: Boolean(err), aborted: !err, errorMessage: err?.message });
    }
    if (err) turn.reject(err); else turn.resolve();
  }

  /**
   * Kill the current child. Callers settle any pending turn first (or rely on
   * settlePendingTurn here); the session itself survives \u2014 the next turn
   * respawns with --resume against the transcript CC already persisted.
   */
  function retireChild() {
    const child = activeChild;
    if (!child) return;
    activeChild = undefined;
    if (pendingTurn) settlePendingTurn();
    try { child.stdin.end(); } catch { /* already closed */ }
    try { if (!child.killed) child.kill("SIGTERM"); } catch { /* already gone */ }
    // CC may not respond to SIGTERM promptly mid-tool-call; escalate so a
    // retired child can never linger in the background.
    const killTimer = setTimeout(() => {
      try { if (!child.killed) child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 2000);
    killTimer.unref?.();
    child.once("exit", () => clearTimeout(killTimer));
  }

  /**
   * Spawn the persistent CC child if one is not already running. stdin stays
   * open across turns; stdout is parsed by one line buffer for the child's
   * whole lifetime. A child made stale by a spawn-time flag change (model /
   * effort) is retired here, at the start of the next turn.
   */
  function ensureChild(): ChildProcessWithoutNullStreams {
    if (activeChild && spawnFlagsDirty) retireChild();
    if (activeChild) return activeChild;
    spawnFlagsDirty = false;
    installExitReaper();
    const child = spawn(CC_BIN, buildSpawnArgs(), {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChild = child;
    liveCCChildren.add(child);

    const buf = makeLineBuffer((event) => {
      // A retired child can still drain queued frames; only the current child
      // may touch session state.
      if (activeChild !== child) return;
      // Drop the remainder of an interrupted turn \u2014 the user has already seen
      // agent_end and the UI has cleared its streaming state. The turn's own
      // `result` frame still passes through so finishTurn can reset state.
      if (turnAborted && (event as { type?: string })?.type !== "result") return;
      applyStreamEvent(event);
    });
    child.stdout.on("data", (chunk) => buf.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (activeChild !== child) return;
      // CC stderr is mostly diagnostic; surface as server_error-shaped events
      // via the subscribe channel so server.ts broadcasts them.
      const text = chunk.toString("utf-8");
      if (text.trim()) emit({ type: "server_diagnostic", message: text });
    });
    child.once("error", (err) => {
      liveCCChildren.delete(child);
      if (activeChild !== child) return;
      activeChild = undefined;
      settlePendingTurn(err instanceof Error ? err : new Error(String(err)));
    });
    child.once("close", (code) => {
      liveCCChildren.delete(child);
      buf.flush();
      if (activeChild !== child) return;
      activeChild = undefined;
      if (pendingTurn) {
        // A crash can land after CC persisted (part of) the turn; if the
        // transcript exists the respawn must --resume, not --session-id.
        firstTurnCompleted = firstTurnCompleted || existsSync(sessionFile);
        settlePendingTurn(code === 0 || code === null ? undefined : new Error(`Claude Code exited with code ${code}`));
      }
    });
    return child;
  }

  /**
   * Write one user frame to the persistent child and wait for that turn's
   * terminal `result` frame (see finishTurn). Rejects if the child dies
   * before the frame arrives.
   */
  function startTurn(kind: "prompt" | "compact", text: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = ensureChild();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      pendingTurn = { kind, resolve, reject, sawAssistantMessage: false };
      const frame = JSON.stringify({ type: "user", message: { role: "user", content: text } });
      try {
        child.stdin.write(`${frame}\n`);
      } catch (err) {
        // stdin already broken: if the child is still attached its close
        // handler settles the turn; otherwise settle now.
        if (activeChild !== child) settlePendingTurn(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Handle a turn's terminal `result` frame from the child. */
  function finishTurn(ev: { is_error?: boolean; result?: string; total_cost_usd?: number; subtype?: string }) {
    firstTurnCompleted = true;
    clearInterruptFallback();
    const turn = pendingTurn;
    pendingTurn = undefined;
    isStreaming = false;
    const wasAborted = turnAborted;
    turnAborted = false;
    if (!turn) return;
    if (turn.kind === "compact") {
      // abortCompaction() already emitted compaction_end when compacting is
      // no longer set; otherwise finalize (async: reads the summary CC wrote
      // to the transcript) before resolving so isCompacting stays accurate.
      if (!compacting) { turn.resolve(); return; }
      void finalizeCompaction(ev).then(turn.resolve, turn.reject);
      return;
    }
    if (wasAborted) { turn.resolve(); return; }
    if (!turn.sawAssistantMessage && typeof ev.result === "string" && ev.result.trim()) {
      // Result-only turn: CC handled a slash command itself (e.g. /cost) and
      // put the reply in the result frame \u2014 surface it as a message.
      const message = { role: "assistant", content: ev.result, timestamp: new Date().toISOString() };
      messages.push(message);
      emit({ type: "message_end", message });
    }
    agentEndEmitted = true;
    emit({ type: "agent_end", isError: Boolean(ev.is_error), result: ev.result, cost: ev.total_cost_usd, subtype: ev.subtype });
    turn.resolve();
  }

  /**
   * Reload the transcript and return the latest compaction summary text, or
   * undefined if CC has not written it yet. Also refreshes the in-memory
   * message list so the UI's next fetch reflects the compacted transcript.
   */
  async function reloadSummaryFromTranscript(): Promise<string | undefined> {
    const reloaded = await loadCCMessages(sessionFile);
    messages.length = 0;
    messages.push(...reloaded);
    for (let i = reloaded.length - 1; i >= 0; i -= 1) {
      const m = reloaded[i] as { role?: string; summary?: unknown; content?: unknown };
      if (m?.role !== "compactionSummary") continue;
      if (typeof m.summary === "string") return m.summary;
      return typeof m.content === "string" ? m.content : "";
    }
    return undefined;
  }

  async function finalizeCompaction(ev: { result?: string }): Promise<void> {
    try {
      if (!compactBoundary) {
        // No boundary frame means CC declined to compact (e.g. "Not enough
        // messages to compact.") \u2014 surface its reply so the user learns why
        // nothing happened.
        if (typeof ev.result === "string" && ev.result.trim()) {
          const message = { role: "assistant", content: ev.result, timestamp: new Date().toISOString() };
          messages.push(message);
          emit({ type: "message_end", message });
        }
        emit({ type: "compaction_end", reason: "manual" });
        return;
      }
      const tokensBefore = compactBoundary.preTokens;
      // The summary text is not in the stream; CC persists it to the
      // transcript (isCompactSummary entry \u2192 compactionSummary role via
      // loadCCMessages), and that write can trail the result frame slightly.
      let summary = await reloadSummaryFromTranscript();
      if (summary === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        summary = await reloadSummaryFromTranscript();
      }
      emit({ type: "compaction_end", reason: "manual", result: { tokensBefore, summary: summary ?? "Context compacted." } });
    } finally {
      compacting = false;
      compactBoundary = undefined;
    }
  }

  /**
   * Interrupt the in-flight turn without losing the warm child: CC accepts a
   * control_request frame on stdin and keeps serving later turns. Falls back
   * to killing the child when the interrupt cannot be written or the turn's
   * result frame never arrives.
   */
  function interruptOrKill() {
    const child = activeChild;
    let wrote = false;
    if (child) {
      try {
        child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`);
        wrote = true;
      } catch { /* stdin gone; kill below */ }
    }
    if (!wrote) {
      settlePendingTurn();
      retireChild();
      return;
    }
    clearInterruptFallback();
    interruptFallbackTimer = setTimeout(() => {
      interruptFallbackTimer = undefined;
      if (pendingTurn) {
        settlePendingTurn();
        retireChild();
      }
    }, INTERRUPT_GRACE_MS);
    interruptFallbackTimer.unref?.();
  }

  /**
   * --model / --effort are spawn-time flags: retire an idle child immediately
   * so the change applies on the next turn. A busy child finishes its turn
   * first (retiring under a pending turn would abort the user's response);
   * ensureChild() retires it lazily via spawnFlagsDirty.
   */
  function markSpawnFlagsChanged() {
    spawnFlagsDirty = true;
    if (!pendingTurn && !compacting) retireChild();
  }

  function abortCompactionInternal() {
    if (!compacting) return;
    compacting = false;
    compactBoundary = undefined;
    turnAborted = true;
    emit({ type: "compaction_end", reason: "manual", aborted: true });
    interruptOrKill();
  }

  // Build the PiWebSession-compatible adapter object. Properties are real
  // class-style methods (not arrow lambdas in an object literal) so `this`
  // resolves to the adapter when used via getCapabilities()/getAgentSlashCommands().
  const adapter = {
    sessionId,
    sessionFile,
    get isCompacting() { return compacting; },
    messages,
    agent: { state: { messages } },
    sessionManager,
    modelRuntime,
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
    get activeCwd() { return activeCwd; },
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
      const found = modelRuntime.getModel(m.provider, m.id);
      if (!found) throw new Error(`Model not available in Claude Code: ${m.provider}/${m.id}`);
      model = found;
      markSpawnFlagsChanged();
    },
    setThinkingLevel(level: string) {
      if (!CC_THINKING_LEVELS.includes(level)) throw new Error(`Unknown thinking level: ${level}`);
      thinkingLevel = level;
      markSpawnFlagsChanged();
    },
    async prompt(messageText: string, options?: { images?: unknown[]; streamingBehavior?: string }) {
      if (options?.images?.length) {
        // Image attachments are not yet wired through the CC CLI. The pi-web
        // server currently appends image-file paths to the message text via
        // persistPromptImages(); CC will pick those up as plain references.
      }
      if (compacting) throw new Error("Wait for compaction to finish before prompting.");
      if (isStreaming || pendingTurn) throw new Error("Claude Code session is already processing a prompt.");
      isStreaming = true;
      agentEndEmitted = false;
      turnAborted = false;
      emit({ type: "agent_start" });
      // Push the user message into our local store immediately so the UI
      // shows it before the assistant streams in.
      messages.push({ role: "user", content: messageText, timestamp: new Date().toISOString() });
      try {
        await startTurn("prompt", messageText);
      } catch (err) {
        isStreaming = false;
        if (!agentEndEmitted) {
          agentEndEmitted = true;
          emit({ type: "agent_end", isError: true, errorMessage: err instanceof Error ? err.message : String(err) });
        }
        throw err;
      }
    },
    async compact(customInstructions?: string) {
      if (isStreaming || pendingTurn) throw new Error("Wait for the current response to finish before compacting.");
      if (compacting) throw new Error("Compaction is already running.");
      compacting = true;
      compactBoundary = undefined;
      turnAborted = false;
      emit({ type: "compaction_start", reason: "manual", startedAt: new Date().toISOString() });
      // CC owns the actual compaction: the command travels to the child as a
      // user frame and the compact_boundary / result frames drive the
      // compaction_end emission (see finishTurn / finalizeCompaction).
      const instructions = customInstructions?.trim();
      try {
        await startTurn("compact", instructions ? `/compact ${instructions}` : "/compact");
      } catch (err) {
        if (compacting) {
          compacting = false;
          compactBoundary = undefined;
          emit({ type: "compaction_end", reason: "manual", aborted: true });
        }
        throw err;
      }
    },
    abortCompaction() {
      abortCompactionInternal();
    },
    async abort() {
      // Stop during compaction routes to the compaction abort path so the
      // UI's compacting indicator clears with a compaction_end, not agent_end.
      if (compacting) {
        abortCompactionInternal();
        return;
      }
      if (!pendingTurn && !isStreaming) return;
      // Order matters: flip `turnAborted` BEFORE interrupting so queued
      // frames from the interrupted turn are dropped. Otherwise the UI shows
      // agent_end and then keeps receiving assistant text deltas /
      // tool_execution events (the post-stop "ghost streaming" bug).
      turnAborted = true;
      isStreaming = false;
      if (!agentEndEmitted) {
        agentEndEmitted = true;
        emit({ type: "agent_end", aborted: true });
      }
      interruptOrKill();
    },
    dispose() {
      // Called by server.ts disposeLiveSession() on idle/reset/delete. The
      // transcript on disk is the durable state; the warm child is expendable.
      retireChild();
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
      // visible without a server restart. Once the child has reported its own
      // command list (init frame), those names are merged in as the
      // authoritative source for commands disk scraping cannot see.
      const discovered = discoverCCSlashCommands(opts.cwd, initCommandNames);
      const builtinNames = new Set(builtins.map((c) => c.name));
      return [...builtins, ...discovered.filter((c) => !builtinNames.has(c.name))];
    },
    enumerable: false,
    configurable: true,
  });

  return adapter as unknown as AgentAdapter;
}
