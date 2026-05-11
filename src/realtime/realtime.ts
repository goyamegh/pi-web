import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import type { AppState, PiEvent } from "../app/types.js";
import { reconnectDelayMs } from "../app/types.js";
import type { ComposerController } from "../composer/composer.js";
import type { MessageList } from "../messages/messageList.js";
import type { ModelSettings } from "../models/modelSettings.js";
import type { SessionsController } from "../sessions/sessionDrawer.js";
import type { SettingsController } from "../settings/settings.js";
import type { StatusBar } from "../status/statusBar.js";
import type { ToolCards } from "../tools/toolCards.js";
import type { ConversationTreeController } from "../tree/conversationTree.js";

export type RealtimeController = {
  connect: () => void;
  handlePiEvent: (event: PiEvent) => void;
};

export function createRealtime(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  composer: ComposerController;
  messages: MessageList;
  models: ModelSettings;
  sessions: SessionsController;
  settings: SettingsController;
  status: StatusBar;
  tools: ToolCards;
  conversationTree?: ConversationTreeController;
  updateMeta: (data: any) => void;
  refreshMessages: () => Promise<void>;
  refreshState: () => Promise<void>;
  addMessage: (role: "system", text: string, extraClass?: string) => HTMLDivElement;
}): RealtimeController {
  const { state, elements, api, composer, messages, models, sessions, settings, status, tools, conversationTree, updateMeta, refreshMessages, refreshState, addMessage } = options;
  let compactionMessage: HTMLDivElement | null = null;

  function formatTokenCount(tokens: unknown) {
    return typeof tokens === "number" && Number.isFinite(tokens) ? tokens.toLocaleString() : "unknown";
  }

  function compactionStartText(event: PiEvent) {
    if (event.reason === "manual") return "Compacting context…";
    if (event.reason === "overflow") return "Context overflow detected. Auto-compacting context…";
    return "Auto-compacting context…";
  }

  function compactionEndText(event: PiEvent) {
    if (event.aborted) return event.reason === "manual" ? "Compaction cancelled." : "Auto-compaction cancelled.";
    if (event.errorMessage) return `Compaction failed: ${event.errorMessage}`;
    const result = event.result || {};
    const header = `Context compacted from ${formatTokenCount(result.tokensBefore)} tokens.`;
    return result.summary ? `${header}\n\n${result.summary}` : header;
  }

  async function abortCompaction(button: HTMLButtonElement) {
    button.disabled = true;
    button.textContent = "Cancelling…";
    try {
      const res = await fetch("/api/compaction/abort", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId: state.currentSessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    } catch (error) {
      button.disabled = false;
      button.textContent = "Cancel";
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    }
  }

  function setCompactionMessage(text: string, extraClass = "compaction", cancellable = false) {
    const target = compactionMessage?.isConnected ? compactionMessage : addMessage("system", "", extraClass);
    compactionMessage = target;
    target.className = `message system ${extraClass}`.trim();
    target.querySelector(".compactionCancel")?.remove();
    const body = target.querySelector<HTMLElement>(".body");
    if (body) body.textContent = text;
    if (cancellable) {
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "compactionCancel";
      cancelButton.textContent = "Cancel";
      cancelButton.addEventListener("click", () => abortCompaction(cancelButton));
      target.append(cancelButton);
    }
    messages.scrollToBottom();
  }

  function handlePiEvent(event: PiEvent) {
    switch (event.type) {
      case "session_info_changed":
        if ("name" in event) status.setStatusTitle(event.name || "New session");
        break;
      case "agent_start":
        state.isStreaming = true;
        composer.updatePrimaryAction();
        messages.resetStreamingAssistant();
        break;
      case "message_update": {
        const deltaEvent = event.assistantMessageEvent;
        if (deltaEvent?.type === "text_delta") messages.appendStreamingDelta(deltaEvent.delta || "");
        break;
      }
      case "tool_execution_start":
        tools.startTool(event.toolCallId, event.toolName, event.args || {});
        break;
      case "tool_execution_end":
        tools.endTool(event.toolCallId, event.toolName, Boolean(event.isError), event.result);
        break;
      case "agent_end":
        state.isStreaming = false;
        composer.updatePrimaryAction();
        messages.resetStreamingAssistant();
        tools.clearActiveToolCards();
        refreshMessages().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        if (conversationTree?.isOpen()) conversationTree.refreshTree().catch(() => undefined);
        status.refreshSessionTitle();
        break;
      case "compaction_start":
        setCompactionMessage(compactionStartText(event), "compaction", true);
        break;
      case "compaction_end": {
        const extraClass = event.errorMessage && !event.aborted ? "compaction error" : "compaction";
        setCompactionMessage(compactionEndText(event), extraClass);
        compactionMessage = null;
        if (event.result) {
          refreshMessages().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
          if (conversationTree?.isOpen()) conversationTree.refreshTree().catch(() => undefined);
          status.refreshSessionTitle();
        }
        break;
      }
      case "thinking_level_changed":
        state.currentThinkingLevel = event.level || state.currentThinkingLevel;
        elements.thinkingSelectEl.value = state.currentThinkingLevel;
        models.updateSummary();
        refreshState().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        break;
    }
  }

  function connect() {
    const ws = new WebSocket(api.wsUrl());
    ws.addEventListener("open", status.markWebSocketOpen);
    ws.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data));
      if (data.type === "hello" || data.type === "state_changed") {
        updateMeta(data);
        state.isStreaming = Boolean(data.isStreaming);
        composer.updatePrimaryAction();
        if (data.thinkingLevels) models.updateThinkingOptions(data.thinkingLevels);
        if (elements.modelSelectEl.options.length) elements.modelSelectEl.value = state.currentModelKey;
        if (data.type === "state_changed") {
          refreshMessages().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
          if (conversationTree?.isOpen()) conversationTree.refreshTree().catch(() => undefined);
          status.refreshSessionTitle();
          if (!elements.sessionDrawer.hidden) sessions.refreshSessions().catch(() => undefined);
        }
        return;
      }
      if (data.type === "session_runtime_changed") {
        if (!elements.sessionDrawer.hidden) sessions.refreshSessions().catch(() => undefined);
        return;
      }
      if (data.type === "models_updated") {
        models.populateModelSelect(data.models || [], state.currentModelKey);
        return;
      }
      if (data.type === "settings_updated") {
        settings.applySettings(data.settings);
        return;
      }
      if (data.type === "pi_event") {
        if (!elements.sessionDrawer.hidden) sessions.refreshSessions().catch(() => undefined);
        if (!data.sessionId || data.sessionId === state.currentSessionId) handlePiEvent(data.event);
        return;
      }
      if (data.type === "server_error" && (!data.sessionId || data.sessionId === state.currentSessionId)) addMessage("system", data.error, "error");
    });
    ws.addEventListener("close", () => {
      status.markWebSocketClosed();
      window.setTimeout(connect, reconnectDelayMs);
    });
  }

  return { connect, handlePiEvent };
}
