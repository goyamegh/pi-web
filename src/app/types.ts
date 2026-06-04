export type AgentKind = "pi" | "claude-code" | "mock";

export type AgentCapabilities = {
  compaction: boolean;
  conversationTree: boolean;
  extensionDialogs: boolean;
  multiProviderModels: boolean;
  imageInput: boolean;
  permissionPrompts: boolean;
  thinkingLevels: boolean;
  promptTemplates: boolean;
  reload: boolean;
  branchSummaries: boolean;
};

export const defaultAgentCapabilities: AgentCapabilities = {
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

export type Role = "user" | "assistant" | "tool" | "system";

export type PiEvent = {
  type: string;
  [key: string]: any;
};

export type QueueMode = "steer" | "followUp";

export type SlashCommandSource = "web" | "extension" | "prompt" | "skill" | "claude-code";

export type SlashCommand = {
  name: string;
  description?: string;
  source: SlashCommandSource;
  sourceInfo?: {
    path?: string;
    source?: string;
    scope?: string;
    origin?: string;
    baseDir?: string;
  };
};

export type ImageAttachment = {
  type: "image";
  data: string;
  mimeType: string;
  name: string;
};

export type PiWebModelSetting = {
  provider: string;
  id: string;
};

export type ContextUsage = {
  tokens?: number | null;
  contextWindow?: number | null;
  percent?: number | null;
};

export type SessionStats = {
  userMessages?: number;
  assistantMessages?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextUsage?: ContextUsage | null;
};

export type PiWebSettings = {
  version: 1;
  appearance: {
    density: "comfortable" | "compact";
    navPinned: boolean;
    navWidth: number;
  };
  composer: {
    queueMode: QueueMode;
    expanded: boolean;
  };
  defaults: {
    model?: PiWebModelSetting;
    thinkingLevel?: string;
  };
};

export type AttachedImage = {
  data?: string;
  mimeType?: string;
  path?: string;
};

export type PinnedSession = { id: string; label: string };
export const maxPinnedSessions = 4;

const pinnedSessionsKey = "pi-web-pinned-sessions";

export function readPinnedSessions(): PinnedSession[] {
  try {
    const raw = JSON.parse(localStorage.getItem(pinnedSessionsKey) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is PinnedSession => typeof v?.id === "string" && typeof v?.label === "string");
  } catch { return []; }
}

export function persistPinnedSessions(sessions: PinnedSession[]) {
  localStorage.setItem(pinnedSessionsKey, JSON.stringify(sessions));
}

export type SessionInfo = {
  id: string;
  name?: string;
  firstMessage?: string;
  created: string;
  modified: string;
  messageCount: number;
  cwd?: string;
  agent?: AgentKind;
  isCurrent: boolean;
  inactive?: boolean;
  saved?: boolean;
  runtime?: {
    loaded: boolean;
    isRunning: boolean;
    isStreaming: boolean;
    isCompacting: boolean;
    pendingMessageCount: number;
  };
};

export type AppState = {
  token: string;
  currentModelKey: string;
  currentModelDisplay: string;
  currentThinkingLevel: string;
  currentSessionId: string;
  currentCwd: string;
  activeCwd: string;
  currentSessionTitle: string;
  statusTitleEditing: boolean;
  isStreaming: boolean;
  wsHasOpened: boolean;
  wsDisconnected: boolean;
  lastRealtimeSeq: number;
  reconnectNoticeTimer: number | undefined;
  connectionLostTimer: number | undefined;
  reconnectedClearTimer: number | undefined;
  pinnedSessions: PinnedSession[];
  currentAgent: AgentKind;
  currentCapabilities: AgentCapabilities;
  collapsedSessionFolders: Set<string>;
  expandedSessionFolders: Set<string>;
  hideInactiveSessions: boolean;
  showSavedOnly: boolean;
  queueMode: QueueMode;
  attachedImages: ImageAttachment[];
  editorExpanded: boolean;
  settings: PiWebSettings;
  stats?: SessionStats;
  // Marker set when the client initiates a session switch so the WS-triggered
  // state_changed echo can skip the redundant message refresh.
  lastSwitchedSession?: { sessionId: string; ts: number };
};

// Connection-status timing.
//
// When pi-web is served behind a reverse tunnel or proxy that periodically
// recycles the upstream connection, the client may briefly auto-reconnect
// (~1s on the server side). The browser then waits `reconnectDelayMs` (1.5s)
// before retrying its WebSocket, so the typical end-to-end gap during such a
// hiccup is ~2–3s. The "Live updates reconnecting…" pill should not flicker
// in this window — it's noise, not an outage. `reconnectNoticeDelayMs` is
// therefore set above that natural recovery window so brief hiccups stay
// completely silent and the pill only appears for genuine longer outages,
// after which `connectionLostDelayMs` escalates to "Live updates unavailable".
export const reconnectDelayMs = 1500;
export const reconnectNoticeDelayMs = 4000;
export const connectionLostDelayMs = 15000;
export const sessionFolderPreviewLimit = 8;

export const defaultPiWebSettings: PiWebSettings = {
  version: 1,
  appearance: { density: "comfortable", navPinned: false, navWidth: 360 },
  composer: { queueMode: "steer", expanded: false },
  defaults: {
    model: { provider: "amazon-bedrock", id: "us.anthropic.claude-opus-4-7" },
    thinkingLevel: "high",
  },
};

const tokenStorageKey = "pi-web-token";
const collapsedFoldersStorageKey = "pi-web-collapsed-session-folders";

function consumeUrlToken() {
  const urlToken = new URLSearchParams(location.search).get("token");
  if (!urlToken) return;

  localStorage.setItem(tokenStorageKey, urlToken);
  const url = new URL(location.href);
  url.searchParams.delete("token");
  history.replaceState(null, "", url.toString());
}

function readCollapsedSessionFolders() {
  try {
    const raw = JSON.parse(localStorage.getItem(collapsedFoldersStorageKey) || "[]");
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function persistCollapsedSessionFolders(folders: Set<string>) {
  localStorage.setItem(collapsedFoldersStorageKey, JSON.stringify(Array.from(folders)));
}

export function createAppState(): AppState {
  consumeUrlToken();

  return {
    token: localStorage.getItem(tokenStorageKey) || "",
    currentModelKey: "",
    currentModelDisplay: "No model",
    currentThinkingLevel: "off",
    currentSessionId: "",
    currentCwd: "",
    activeCwd: "",
    currentSessionTitle: "New session",
    statusTitleEditing: false,
    isStreaming: false,
    wsHasOpened: false,
    wsDisconnected: false,
    lastRealtimeSeq: 0,
    reconnectNoticeTimer: undefined,
    connectionLostTimer: undefined,
    reconnectedClearTimer: undefined,
    pinnedSessions: readPinnedSessions(),
    currentAgent: "pi",
    currentCapabilities: defaultAgentCapabilities,
    collapsedSessionFolders: new Set(readCollapsedSessionFolders()),
    expandedSessionFolders: new Set(),
    hideInactiveSessions: localStorage.getItem("pi-web:hideInactiveSessions") === "true",
    showSavedOnly: localStorage.getItem("pi-web:showSavedOnly") === "true",
    queueMode: "steer",
    attachedImages: [],
    editorExpanded: defaultPiWebSettings.composer.expanded,
    settings: defaultPiWebSettings,
    stats: undefined,
  };
}

export function saveToken(token: string) {
  localStorage.setItem(tokenStorageKey, token);
}

export function clearToken() {
  localStorage.removeItem(tokenStorageKey);
}
