/// <reference types="vite/client" />
import "./style.css";
import "./components/diff.css";
import "./git/git.css";
import "highlight.js/styles/github-dark.css";
import { createApiClient } from "./app/api.js";
import { getAppElements, initAppHeightSync } from "./app/elements.js";
import { setIcon } from "./app/icons.js";
import { createAppState } from "./app/types.js";
import { createComposer, type ComposerController } from "./composer/composer.js";
import { createContextMeter, type ContextMeterController } from "./composer/contextMeter.js";
import { initGitPanel } from "./git/panel.js";
import { createMarkdownRenderer } from "./markdown/render.js";
import { createMessageList } from "./messages/messageList.js";
import { createModelSettings, modelKey, modelLabel, type ModelSettings } from "./models/modelSettings.js";
import { createRealtime } from "./realtime/realtime.js";
import { createSessions, type SessionsController } from "./sessions/sessionDrawer.js";
import { createSettings, type SettingsController } from "./settings/settings.js";
import { createStatusBar, type StatusBar } from "./status/statusBar.js";
import { createToolCards } from "./tools/toolCards.js";
import { createConversationTree, type ConversationTreeController } from "./tree/conversationTree.js";

initAppHeightSync();

// Dev-mode hygiene: vite-plugin-pwa registers a Service Worker for production
// builds only (devOptions.enabled defaults to false), but browsers persist any
// SW once registered — if this origin ever served a production build (e.g. via
// `npm run start` or a deployed tunnel URL), that SW is still active and will
// keep intercepting asset requests with stale precached bundles, racing the
// fresh dev modules from Vite. A hard reload does NOT unregister SWs (it only
// bypasses the HTTP cache), so the only reliable way to recover is for the page
// itself to actively unregister any lingering registration on dev startup.
//
// This mirrors create-react-app's `serviceWorkerRegistration.ts` pattern and
// is recommended in vite-plugin-pwa's FAQ for the same reason. It is a no-op
// in production where the SW is the canonical asset source, and idempotent so
// safe to run on every dev page load.
if (import.meta.env.DEV && "serviceWorker" in navigator) {
  void (async () => {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      if (registrations.length === 0) return;
      await Promise.all(registrations.map((registration) => registration.unregister()));
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      // Reload once after the cleanup so the page no longer races a half-active
      // SW. We mark the reload via a sessionStorage flag so we never loop.
      const reloadKey = "pi-web:dev-sw-reload";
      if (!sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, "1");
        location.reload();
      }
    } catch {
      // Browsers without SW support, private mode quirks, etc. — nothing to do.
    }
  })();
}

const elements = getAppElements();
const state = createAppState();
const api = createApiClient(state);
const markdown = createMarkdownRenderer(elements.messagesEl);
const messages = createMessageList({ messagesEl: elements.messagesEl, markdown });
const tools = createToolCards(elements.messagesEl, messages.scrollToBottom);

let composer: ComposerController;
let contextMeter: ContextMeterController;
let modelSettings: ModelSettings;
let sessions: SessionsController;
let settings: SettingsController;
let statusBar: StatusBar;
let conversationTree: ConversationTreeController;

function showSystemError(error: unknown) {
  messages.addMessage("system", error instanceof Error ? error.message : String(error), "error");
}

function updateMeta(data: any) {
  state.currentModelKey = modelKey(data.model);
  state.currentModelDisplay = data.model ? modelLabel(data.model) : "No model";
  state.currentThinkingLevel = data.thinkingLevel || "off";
  state.currentSessionId = data.sessionId || state.currentSessionId;
  state.currentCwd = data.cwd || state.currentCwd;
  if (data.agent === "pi" || data.agent === "claude-code" || data.agent === "mock") {
    state.currentAgent = data.agent;
  }
  if (data.capabilities && typeof data.capabilities === "object") {
    state.currentCapabilities = { ...state.currentCapabilities, ...data.capabilities };
    // Hide affordances for capabilities the active agent does not support.
    elements.conversationTreeButton.hidden = !state.currentCapabilities.conversationTree;
  }
  if ("stats" in data) contextMeter.update(data.stats);
  if ("sessionTitle" in data) statusBar.setStatusTitle(data.sessionTitle?.trim() || "New session");
  else if ("sessionName" in data) statusBar.setStatusTitle(data.sessionName?.trim() || "New session");
  elements.statusPathEl.textContent = state.currentCwd;
  modelSettings.updateSummary();
  if (sessions) sessions.renderSessionBar();
}

function updateSessionStats(stats: any) {
  contextMeter.update(stats);
}

async function refreshMessages() {
  await messages.refreshMessages({
    sessionId: state.currentSessionId,
    headers: api.headers,
    addToolHistoryCard: tools.addToolHistoryCard,
    addPendingToolCard: tools.startTool,
    addRuntimeErrorCard: tools.addRuntimeErrorCard,
    clearActiveToolCards: tools.clearActiveToolCards,
    isStreaming: state.isStreaming,
    updateEmptyCwdChooser: () => sessions.updateEmptyCwdChooser(),
  });
}

async function refreshState() {
  const res = await fetch("/api/state", { headers: api.headers() });
  if (res.status === 401) {
    elements.tokenOverlay.hidden = false;
    elements.tokenInput.focus();
    return;
  }
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  updateMeta(data);
  state.isStreaming = Boolean(data.isStreaming);
  composer.updatePrimaryAction();
  await Promise.all([settings.refreshSettings(), modelSettings.refreshModels(), refreshMessages()]);
}

function initStaticIcons() {
  setIcon(elements.sessionButton, "menu");
  setIcon(elements.newSessionHeaderButton, "square-pen");
  setIcon(elements.conversationTreeButton, "git-fork");
  setIcon(elements.attachButton, "paperclip");
  setIcon(elements.primaryButton, "send-horizontal");
  setIcon(elements.expandButton, "maximize-2");
  setIcon(elements.gitButton, "git-branch");
  setIcon(elements.settingsButton, "settings");
  setIcon(elements.stopButton, "square");
}

modelSettings = createModelSettings({
  state,
  elements,
  api,
  updateMeta,
  addMessage: messages.addMessage,
});

statusBar = createStatusBar({
  state,
  elements,
  api,
  updateMeta,
  addMessage: messages.addMessage,
  refreshSessions: () => sessions.refreshSessions(),
  refreshState,
});

settings = createSettings({
  state,
  elements,
  api,
  addMessage: messages.addMessage,
  onNavPinnedChange: (pinned) => {
    if (pinned && window.innerWidth > 700) {
      sessions.setSessionDrawerOpen(true);
    } else if (!pinned) {
      sessions.setSessionDrawerOpen(false, true);
    }
  },
});

contextMeter = createContextMeter({ state, elements });

sessions = createSessions({
  state,
  elements,
  api,
  isNavPinned: () => settings.isNavPinned(),
  updateMeta,
  updateThinkingOptions: (levels) => modelSettings.updateThinkingOptions(levels),
  refreshModels: () => modelSettings.refreshModels(),
  refreshMessages,
  refreshState,
  refreshSessionTitle: () => statusBar.refreshSessionTitle(),
  clearMessages: () => messages.clear(),
  addMessage: messages.addMessage,
});

composer = createComposer({
  state,
  elements,
  api,
  addMessage: messages.addMessage,
  updateMeta,
  updateThinkingOptions: (levels) => modelSettings.updateThinkingOptions(levels),
  refreshModels: () => modelSettings.refreshModels(),
  refreshMessages,
  refreshState,
  beginStreamFollow: messages.beginStreamFollow,
  endStreamFollow: messages.endStreamFollow,
});

conversationTree = createConversationTree({
  state,
  elements,
  api,
  composer,
  updateMeta,
  refreshMessages,
  addMessage: messages.addMessage,
});

const realtime = createRealtime({
  state,
  elements,
  api,
  composer,
  messages,
  models: modelSettings,
  sessions,
  status: statusBar,
  tools,
  settings,
  conversationTree,
  updateMeta,
  updateSessionStats,
  refreshMessages,
  refreshState,
  addMessage: messages.addMessage,
});

initStaticIcons();
statusBar.init();
sessions.init();
contextMeter.init();
composer.init();
conversationTree.init();
modelSettings.init();
settings.init();
composer.updateQueueToggle();
initGitPanel({ button: elements.gitButton, panel: elements.gitPanel, apiHeaders: api.headers });
composer.updatePrimaryAction();
refreshState().catch(showSystemError);
realtime.connect();
