import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import type { AppState } from "../app/types.js";
import { connectionLostDelayMs, reconnectDelayMs, reconnectNoticeDelayMs } from "../app/types.js";


export type StatusBar = {
  init: () => void;
  setStatusTitle: (title: string) => void;
  refreshSessionTitle: (sessionId?: string) => Promise<void>;
  markWebSocketOpen: () => void;
  markWebSocketClosed: () => void;
  markSyncRequired: () => void;
};

export function createStatusBar(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  updateMeta: (data: any) => void;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
  refreshSessions: () => Promise<void>;
  refreshState: () => Promise<void>;
}): StatusBar {
  const { state, elements, api, updateMeta, addMessage, refreshSessions, refreshState } = options;

  function setStatusTitle(title: string) {
    const value = title.trim() || "New session";
    state.currentSessionTitle = value;
    elements.statusTitleEl.title = "Rename session";
    elements.statusTitleEl.setAttribute("aria-label", `Session: ${value}. Click to rename.`);
    if (!state.statusTitleEditing) elements.statusTitleEl.textContent = value;
  }

  async function renameCurrentSession(name: string) {
    const previous = state.currentSessionTitle;
    setStatusTitle(name || "New session");
    try {
      const res = await fetch("/api/session/name", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId: state.currentSessionId, name }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok || data.ok === false) throw new Error(data.error || text);
      updateMeta(data);
      if (!elements.sessionDrawer.hidden) refreshSessions().catch(() => undefined);
    } catch (error) {
      setStatusTitle(previous);
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    }
  }

  function beginRenameSessionTitle() {
    if (state.statusTitleEditing || !state.currentSessionId) return;
    state.statusTitleEditing = true;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "statusTitleInput";
    input.value = state.currentSessionTitle === "New session" ? "" : state.currentSessionTitle;
    input.placeholder = "New session";
    input.maxLength = 200;
    input.setAttribute("aria-label", "Session name");
    const originalValue = input.value.trim();

    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      state.statusTitleEditing = false;
      const next = input.value.trim();
      if (save && next !== originalValue) void renameCurrentSession(next);
      else setStatusTitle(state.currentSessionTitle);
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));

    elements.statusTitleEl.textContent = "";
    elements.statusTitleEl.append(input);
    input.focus();
    input.select();
  }

  function clearConnectionTimers() {
    if (state.reconnectNoticeTimer !== undefined) window.clearTimeout(state.reconnectNoticeTimer);
    if (state.connectionLostTimer !== undefined) window.clearTimeout(state.connectionLostTimer);
    state.reconnectNoticeTimer = undefined;
    state.connectionLostTimer = undefined;
  }

  function clearReconnectedTimer() {
    if (state.reconnectedClearTimer !== undefined) window.clearTimeout(state.reconnectedClearTimer);
    state.reconnectedClearTimer = undefined;
  }

  function setConnectionStatus(kind: "reconnecting" | "offline" | "reconnected" | "syncRequired", text: string, title = text) {
    clearReconnectedTimer();
    elements.connectionStatusEl.className = `connectionStatus ${kind}`;
    elements.connectionStatusEl.textContent = text;
    elements.connectionStatusEl.title = title;
    elements.connectionStatusEl.hidden = false;
  }

  function hideConnectionStatus() {
    clearReconnectedTimer();
    elements.connectionStatusEl.hidden = true;
    elements.connectionStatusEl.textContent = "";
    elements.connectionStatusEl.title = "";
    elements.connectionStatusEl.className = "connectionStatus";
  }

  function scheduleConnectionStatus() {
    if (state.reconnectNoticeTimer === undefined) {
      state.reconnectNoticeTimer = window.setTimeout(() => {
        state.reconnectNoticeTimer = undefined;
        if (state.wsDisconnected && elements.tokenOverlay.hidden && !elements.connectionStatusEl.classList.contains("offline")) {
          setConnectionStatus("reconnecting", "Live updates reconnecting…");
        }
      }, reconnectNoticeDelayMs);
    }
    if (state.connectionLostTimer === undefined) {
      state.connectionLostTimer = window.setTimeout(() => {
        state.connectionLostTimer = undefined;
        if (state.wsDisconnected && elements.tokenOverlay.hidden) {
          setConnectionStatus("offline", "Live updates unavailable", "Connection lost. Messages may still send, but live updates are unavailable.");
        }
      }, connectionLostDelayMs);
    }
  }

  function markWebSocketOpen() {
    const isReconnect = state.wsHasOpened && state.wsDisconnected;
    const hadVisibleStatus = !elements.connectionStatusEl.hidden;
    state.wsHasOpened = true;
    state.wsDisconnected = false;
    clearConnectionTimers();

    if (!isReconnect) {
      hideConnectionStatus();
      return;
    }

    if (!hadVisibleStatus) {
      hideConnectionStatus();
      return;
    }

    setConnectionStatus("reconnected", "Reconnected");
    state.reconnectedClearTimer = window.setTimeout(() => {
      state.reconnectedClearTimer = undefined;
      if (!state.wsDisconnected) hideConnectionStatus();
    }, reconnectDelayMs);
  }

  function markWebSocketClosed() {
    state.wsDisconnected = true;
    clearReconnectedTimer();
    scheduleConnectionStatus();
  }

  function markSyncRequired() {
    setConnectionStatus("syncRequired", "Sync needed", "Some live updates were missed. Click to sync when you are ready.");
  }

  async function refreshSessionTitle(sessionId = state.currentSessionId) {
    try {
      const res = await fetch("/api/state", { headers: api.headers() });
      if (!res.ok || sessionId !== state.currentSessionId) return;
      const data = await res.json();
      if (sessionId !== state.currentSessionId || data.sessionId !== sessionId) return;
      updateMeta(data);
    } catch (_e) { /* best-effort */ }
  }

  function init() {
    elements.statusTitleEl.setAttribute("role", "button");
    elements.statusTitleEl.tabIndex = 0;
    setStatusTitle(state.currentSessionTitle);
    elements.statusTitleEl.addEventListener("click", beginRenameSessionTitle);
    elements.statusTitleEl.addEventListener("keydown", (event) => {
      if (event.target !== elements.statusTitleEl || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      beginRenameSessionTitle();
    });
    elements.connectionStatusEl.addEventListener("click", () => {
      if (!elements.connectionStatusEl.classList.contains("syncRequired")) return;
      void refreshState().then(hideConnectionStatus).catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
    });
  }

  return {
    init,
    setStatusTitle,
    refreshSessionTitle,
    markWebSocketOpen,
    markWebSocketClosed,
    markSyncRequired,
  };
}
