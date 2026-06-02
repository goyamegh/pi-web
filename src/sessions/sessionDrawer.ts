import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { setIcon } from "../app/icons.js";
import { createTracker, type PerfTracker } from "../app/perf.js";
import type { AppState, SessionInfo } from "../app/types.js";
import { maxPinnedSessions, persistCollapsedSessionFolders, persistPinnedSessions, sessionFolderPreviewLimit } from "../app/types.js";

const pinnedFoldersStorageKey = "pi-web-pinned-session-folders";

function readPinnedFolders(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(pinnedFoldersStorageKey) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function persistPinnedFolders(folders: Set<string>) {
  localStorage.setItem(pinnedFoldersStorageKey, JSON.stringify([...folders]));
}

export type SessionsController = {
  init: () => void;
  refreshSessions: () => Promise<void>;
  setSessionDrawerOpen: (open: boolean, skipRefresh?: boolean) => void;
  startNewSession: (cwd?: string) => Promise<void>;
  updateSessionRuntime: (sessionId: string, runtime: SessionInfo["runtime"]) => void;
  updateEmptyCwdChooser: () => void;
  renderSessionBar: () => void;
};

function formatRelativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function sessionTitle(session: SessionInfo) {
  return session.name || session.firstMessage?.trim() || "New session";
}

function folderName(path: string) {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || path || "Folder";
}

function shouldCloseDrawerAfterSessionSwitch() {
  return window.matchMedia("(max-width: 700px)").matches;
}

const knownSessionCwdsStorageKey = "pi-web-known-session-cwds";

function readKnownSessionCwds() {
  try {
    const raw = JSON.parse(localStorage.getItem(knownSessionCwdsStorageKey) || "[]");
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function rememberSessionCwd(cwd?: string) {
  const value = cwd?.trim();
  if (!value) return;
  const cwds = new Set(readKnownSessionCwds());
  cwds.add(value);
  localStorage.setItem(knownSessionCwdsStorageKey, JSON.stringify(Array.from(cwds)));
}

export function createSessions(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  isNavPinned: () => boolean;
  updateMeta: (data: any) => void;
  updateThinkingOptions: (levels?: string[]) => void;
  refreshModels: () => Promise<void>;
  refreshMessages: (opts?: { prefetchedMessages?: any[] }) => Promise<void>;
  refreshState: () => Promise<void>;
  refreshSessionTitle: () => Promise<void>;
  clearMessages: () => void;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
}): SessionsController {
  const {
    state,
    elements,
    api,
    updateMeta,
    updateThinkingOptions,
    refreshModels,
    refreshMessages,
    refreshState,
    refreshSessionTitle,
    clearMessages,
    addMessage,
  } = options;

  let cachedSessions: SessionInfo[] = [];
  // Tracks runtime state for pinned sessions independently of cachedSessions so
  // session_runtime_changed events can update the bar even before the first
  // refreshSessions() completes.
  const pinnedRuntimes = new Map<string, SessionInfo["runtime"]>();
  // When the user is inline-renaming a session, we must not rebuild the list
  // row underneath them — otherwise removing the focused <input> from the DOM
  // fires `blur`, which triggers a save with the in-progress text. While a
  // session is streaming, runtime events fire frequently and would otherwise
  // clobber the rename input on every tick. Set while editing is active.
  let activeRenameSessionId: string | null = null;

  // Apply the state payload returned by /api/sessions/open without the extra
  // /api/state round-trip refreshState() does. The POST response already carries
  // the new session's full state — and now its full transcript — so we can render
  // immediately without GET /api/messages, and defer GET /api/models to idle time
  // since the model dropdown is not visible during the switch. The marker on
  // AppState lets the WS state_changed echo skip its own refresh.
  async function applySwitchedSessionState(data: any, perf?: PerfTracker | null) {
    if (data && typeof data === "object") {
      updateMeta(data);
      state.isStreaming = Boolean(data.isStreaming);
      if (data.thinkingLevels) updateThinkingOptions(data.thinkingLevels);
      if (data.sessionId) state.lastSwitchedSession = { sessionId: data.sessionId, ts: Date.now() };
    }
    perf?.mark("meta");
    if (Array.isArray(data?.messages)) {
      await refreshMessages({ prefetchedMessages: data.messages });
    } else {
      await refreshMessages();
    }
    perf?.mark("render");
    const idle = (window as any).requestIdleCallback || ((cb: () => void) => window.setTimeout(cb, 50));
    idle(() => { void refreshModels().catch(() => undefined); });
  }

  function updateEmptyCwdChooser() {
    elements.emptyCwdPathEl.textContent = state.currentCwd;
    elements.emptyCwdChooserEl.hidden = elements.messagesEl.children.length > 0 || state.isStreaming;
  }

  async function selectSessionCwd(cwd: string) {
    const res = await fetch("/api/session/cwd", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ cwd }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());
    rememberSessionCwd(cwd);
    updateMeta(data);
    if (data.thinkingLevels) updateThinkingOptions(data.thinkingLevels);
    await refreshModels();
    await refreshMessages();
    refreshSessionTitle();
  }

  async function openFolderPicker(startPath: string) {
    const backdrop = document.createElement("div");
    backdrop.className = "folderPickerBackdrop";
    const modal = document.createElement("div");
    modal.className = "folderPicker";
    const title = document.createElement("h2");
    title.textContent = "Select working directory";
    const input = document.createElement("input");
    input.className = "folderPickerInput";
    input.value = startPath;
    const list = document.createElement("div");
    list.className = "folderPickerList";
    const error = document.createElement("div");
    error.className = "folderPickerError";
    const actions = document.createElement("div");
    actions.className = "folderPickerActions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "primaryAction";
    select.textContent = "Select folder";
    actions.append(cancel, select);
    modal.append(title, input, list, error, actions);
    backdrop.append(modal);
    document.body.append(backdrop);

    async function load(path: string) {
      error.textContent = "";
      list.textContent = "Loading…";
      const res = await fetch(`/api/fs/dirs?path=${encodeURIComponent(path)}`, { headers: api.headers() });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || "Could not list directory");
      input.value = data.path;
      list.textContent = "";
      const up = document.createElement("button");
      up.type = "button";
      up.className = "folderPickerRow";
      up.textContent = "..";
      up.addEventListener("click", () => load(data.parent).catch((e) => { error.textContent = e.message; }));
      list.append(up);
      for (const dir of data.dirs || []) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "folderPickerRow";
        row.textContent = dir.name;
        row.addEventListener("click", () => load(dir.path).catch((e) => { error.textContent = e.message; }));
        list.append(row);
      }
    }

    cancel.addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) backdrop.remove(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") load(input.value).catch((e) => { error.textContent = e.message; });
    });
    select.addEventListener("click", async () => {
      try {
        select.disabled = true;
        await selectSessionCwd(input.value);
        backdrop.remove();
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        select.disabled = false;
      }
    });
    load(startPath).catch((e) => { error.textContent = e.message; list.textContent = ""; });
    if (!("ontouchstart" in window) && navigator.maxTouchPoints === 0) {
      input.focus();
    }
  }

  async function startNewSession(cwd?: string) {
    const res = await fetch("/api/sessions/new", {
      method: "POST",
      headers: api.headers(),
      body: cwd ? JSON.stringify({ cwd }) : undefined,
    });
    if (!res.ok) throw new Error(await res.text());
    rememberSessionCwd(cwd || state.currentCwd);
    setSessionDrawerOpen(false);
    clearMessages();
    await refreshState();
    updateEmptyCwdChooser();
  }

  function setSessionDrawerOpen(open: boolean, skipRefresh?: boolean) {
    elements.sessionDrawer.hidden = !open;
    elements.sessionBackdrop.hidden = !open;
    document.body.classList.toggle("sessionDrawerOpen", open);
    if (open && !skipRefresh) refreshSessions().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
  }

  async function refreshSessions() {
    rememberSessionCwd(state.currentCwd);
    const params = new URLSearchParams();
    for (const cwd of readKnownSessionCwds()) params.append("cwd", cwd);
    const url = params.toString() ? `/api/sessions?${params}` : "/api/sessions";
    const res = await fetch(url, { headers: api.headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    cachedSessions = data.sessions || [];
    // Freshen labels for any pinned sessions we now have data for
    let labelsChanged = false;
    state.pinnedSessions = state.pinnedSessions.map((pinned) => {
      const live = cachedSessions.find((s) => s.id === pinned.id);
      if (live && sessionTitle(live) !== pinned.label) { labelsChanged = true; return { ...pinned, label: sessionTitle(live) }; }
      return pinned;
    });
    if (labelsChanged) persistPinnedSessions(state.pinnedSessions);
    // Skip list rebuild while inline-renaming so the focused input survives.
    // The active rename's `finish` will re-render once it completes.
    if (activeRenameSessionId === null) renderSessionList(cachedSessions);
    renderSessionBar();
  }

  function markCachedCurrentSession(sessionId: string, cwd: string) {
    cachedSessions = cachedSessions.map((session) => ({
      ...session,
      isCurrent: session.id === sessionId && (session.cwd || cwd) === cwd,
    }));
    // Skip the (potentially large) drawer DOM rebuild while it's hidden —
    // refreshSessions() will rebuild lazily when the drawer is next opened.
    // The pinned-tab bar is cheap (≤4 tabs) and stays in sync.
    if (!elements.sessionDrawer.hidden && activeRenameSessionId === null) {
      renderSessionList(cachedSessions);
    }
    renderSessionBar();
  }

  function updateSessionRuntime(sessionId: string, runtime: SessionInfo["runtime"]) {
    if (!sessionId) return;
    // Always cache runtime for pinned sessions — this lets renderSessionBar show
    // the running state even before cachedSessions is populated.
    const isPinned = state.pinnedSessions.some((p) => p.id === sessionId);
    if (isPinned) pinnedRuntimes.set(sessionId, runtime);
    if (cachedSessions.length === 0) {
      if (isPinned) renderSessionBar();
      return;
    }
    let changed = false;
    cachedSessions = cachedSessions.map((session) => {
      if (session.id !== sessionId) return session;
      changed = true;
      return { ...session, runtime };
    });
    if (!changed) {
      // Session not in cachedSessions yet but is pinned — still re-render bar.
      if (isPinned) renderSessionBar();
      return;
    }
    // Don't rebuild the list while the user is inline-renaming — it would
    // remove the focused <input>, fire blur, and save unintentionally.
    if (!elements.sessionDrawer.hidden && activeRenameSessionId === null) renderSessionList(cachedSessions);
    renderSessionBar();
  }

  // ── Pinning ────────────────────────────────────────────────────────────────

  function isPinned(id: string) {
    return state.pinnedSessions.some((p) => p.id === id);
  }

  function togglePin(item: SessionInfo) {
    if (isPinned(item.id)) {
      state.pinnedSessions = state.pinnedSessions.filter((p) => p.id !== item.id);
      pinnedRuntimes.delete(item.id);
    } else {
      if (state.pinnedSessions.length >= maxPinnedSessions) return;
      state.pinnedSessions = [...state.pinnedSessions, { id: item.id, label: sessionTitle(item) }];
    }
    persistPinnedSessions(state.pinnedSessions);
    document.body.classList.toggle("hasPinnedSessions", state.pinnedSessions.length > 0);
    renderSessionList(cachedSessions);
    renderSessionBar();
  }

  // ── Session bar ────────────────────────────────────────────────────────────

  function renderSessionBar() {
    const bar = elements.sessionBarEl;
    const pinned = state.pinnedSessions;

    if (pinned.length === 0) {
      bar.hidden = true;
      document.body.classList.remove("hasPinnedSessions");
      return;
    }

    bar.hidden = false;
    document.body.classList.add("hasPinnedSessions");
    bar.textContent = "";

    for (const pinnedEntry of pinned) {
      const live = cachedSessions.find((s) => s.id === pinnedEntry.id);
      const isActive = state.currentSessionId === pinnedEntry.id;
      const isRunning = (live?.runtime ?? pinnedRuntimes.get(pinnedEntry.id))?.isRunning ?? false;

      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `sessionBarTab${isActive ? " active" : ""}${isRunning ? " running" : ""}`;
      if (isActive) tab.setAttribute("aria-current", "page");
      tab.title = live ? sessionTitle(live) : pinnedEntry.label;

      const labelEl = document.createElement("span");
      labelEl.className = "sessionBarTabLabel";
      labelEl.textContent = live ? sessionTitle(live) : pinnedEntry.label;
      tab.append(labelEl);

      if (live) {
        tab.addEventListener("click", async () => {
          const perf = createTracker("session-switch:bar");
          // Optimistic update: switch the active tab highlight immediately before any
          // network round-trips so the UI feels instant even during streaming.
          const previousSessionId = state.currentSessionId;
          if (state.currentSessionId !== live.id) {
            state.currentSessionId = live.id;
            renderSessionBar();
          }
          // Mark the switch BEFORE the fetch so the broadcast WS state_changed
          // echo is recognized as our own (and thus skips its own
          // refreshMessages) even if it races the HTTP response and arrives
          // first — which it can, because the server broadcasts the echo on the
          // same tick it sends the HTTP reply.
          state.lastSwitchedSession = { sessionId: live.id, ts: Date.now() };
          perf?.mark("optimistic");
          try {
            const cwd = live.cwd || state.currentCwd;
            const openRes = await fetch("/api/sessions/open", {
              method: "POST",
              headers: api.headers(),
              body: JSON.stringify({ sessionId: live.id, cwd }),
            });
            if (!openRes.ok) throw new Error(await openRes.text());
            const openData = await openRes.json().catch(() => ({}));
            perf?.mark("network");
            rememberSessionCwd(cwd);
            markCachedCurrentSession(live.id, cwd);
            await applySwitchedSessionState(openData, perf);
            perf?.end({
              embedded: Array.isArray(openData?.messages),
              messages: Array.isArray(openData?.messages) ? openData.messages.length : 0,
            });
          } catch (error) {
            // Revert the optimistic highlight if the switch failed.
            state.currentSessionId = previousSessionId;
            renderSessionBar();
            addMessage("system", error instanceof Error ? error.message : String(error), "error");
          }
        });
      }

      bar.append(tab);
    }
  }

  // ── Filtering ───────────────────────────────────────────────────────────────

  function filterSessionItems(items: SessionInfo[]): SessionInfo[] {
    let result = items;
    if (state.hideInactiveSessions) result = result.filter(i => !i.inactive);
    if (state.showSavedOnly) result = result.filter(i => i.saved);
    return result;
  }

  function renderFilterBar() {
    const bar = document.createElement("div");
    bar.className = "sessionFilterBar";

    const hideInactiveLabel = document.createElement("label");
    hideInactiveLabel.className = "sessionFilterToggle";
    const hideInactiveCheckbox = document.createElement("input");
    hideInactiveCheckbox.type = "checkbox";
    hideInactiveCheckbox.checked = state.hideInactiveSessions;
    hideInactiveCheckbox.addEventListener("change", () => {
      state.hideInactiveSessions = hideInactiveCheckbox.checked;
      localStorage.setItem("pi-web:hideInactiveSessions", String(state.hideInactiveSessions));
      renderSessionList(cachedSessions);
    });
    const hideInactiveText = document.createElement("span");
    hideInactiveText.textContent = "Hide inactive";
    hideInactiveLabel.append(hideInactiveCheckbox, hideInactiveText);

    const savedOnlyLabel = document.createElement("label");
    savedOnlyLabel.className = "sessionFilterToggle";
    const savedOnlyCheckbox = document.createElement("input");
    savedOnlyCheckbox.type = "checkbox";
    savedOnlyCheckbox.checked = state.showSavedOnly;
    savedOnlyCheckbox.addEventListener("change", () => {
      state.showSavedOnly = savedOnlyCheckbox.checked;
      localStorage.setItem("pi-web:showSavedOnly", String(state.showSavedOnly));
      renderSessionList(cachedSessions);
    });
    const savedOnlyText = document.createElement("span");
    savedOnlyText.textContent = "Saved only";
    savedOnlyLabel.append(savedOnlyCheckbox, savedOnlyText);

    bar.append(hideInactiveLabel, savedOnlyLabel);
    return bar;
  }

  // ── Session list ───────────────────────────────────────────────────────────

  function renderSessionList(sessions: SessionInfo[]) {
    elements.sessionListEl.textContent = "";

    // Add filter bar
    elements.sessionListEl.append(renderFilterBar());

    if (sessions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sessionEmpty";
      empty.textContent = "No saved sessions yet.";
      elements.sessionListEl.append(empty);
      return;
    }

    const groups = new Map<string, SessionInfo[]>();
    for (const item of sessions) {
      const cwd = item.cwd || state.currentCwd || "";
      groups.set(cwd, [...(groups.get(cwd) || []), item]);
    }

    const pinnedFolders = readPinnedFolders();
    const sortedGroups = [...groups.entries()].sort((a, b) => {
      const aPinned = pinnedFolders.has(a[0]) ? 0 : 1;
      const bPinned = pinnedFolders.has(b[0]) ? 0 : 1;
      return aPinned - bPinned;
    });

    for (const [cwd, items] of sortedGroups) {
      const group = document.createElement("section");
      group.className = `sessionFolderGroup${pinnedFolders.has(cwd) ? " pinned" : ""}`;

      const header = document.createElement("div");
      header.className = "sessionFolderHeader";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "sessionFolderToggle";
      toggle.setAttribute("aria-expanded", String(!state.collapsedSessionFolders.has(cwd)));
      toggle.title = state.collapsedSessionFolders.has(cwd) ? "Expand folder" : "Collapse folder";
      const chevron = document.createElement("span");
      chevron.className = "sessionFolderChevron";
      chevron.textContent = state.collapsedSessionFolders.has(cwd) ? "▸" : "▾";
      const labels = document.createElement("span");
      labels.className = "sessionFolderLabels";
      const name = document.createElement("span");
      name.className = "sessionFolderName";
      name.textContent = folderName(cwd);
      const path = document.createElement("span");
      path.className = "sessionFolderPath";
      path.textContent = cwd;
      labels.append(name, path);
      toggle.append(chevron, labels);
      toggle.addEventListener("click", () => {
        if (state.collapsedSessionFolders.has(cwd)) state.collapsedSessionFolders.delete(cwd);
        else state.collapsedSessionFolders.add(cwd);
        persistCollapsedSessionFolders(state.collapsedSessionFolders);
        renderSessionList(cachedSessions);
      });

      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.className = `iconButton sessionFolderPinButton${pinnedFolders.has(cwd) ? " pinned" : ""}`;
      pinButton.title = pinnedFolders.has(cwd) ? "Unpin folder" : "Pin folder to top";
      pinButton.setAttribute("aria-label", pinButton.title);
      setIcon(pinButton, "bookmark");
      pinButton.addEventListener("click", () => {
        const current = readPinnedFolders();
        if (current.has(cwd)) current.delete(cwd);
        else current.add(cwd);
        persistPinnedFolders(current);
        refreshSessions().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
      });

      const newButton = document.createElement("button");
      newButton.type = "button";
      newButton.className = "iconButton sessionFolderNewButton";
      newButton.title = `New session in ${folderName(cwd)}`;
      newButton.setAttribute("aria-label", newButton.title);
      setIcon(newButton, "square-pen");
      newButton.addEventListener("click", async () => {
        try {
          await startNewSession(cwd);
        } catch (error) {
          addMessage("system", error instanceof Error ? error.message : String(error), "error");
        }
      });
      header.append(toggle, pinButton, newButton);
      group.append(header);

      if (state.collapsedSessionFolders.has(cwd)) {
        elements.sessionListEl.append(group);
        continue;
      }

      const folderExpanded = state.expandedSessionFolders.has(cwd);
      const filteredItems = filterSessionItems(items);
      const visibleItems = folderExpanded ? filteredItems : filteredItems.slice(0, sessionFolderPreviewLimit);

      for (const item of visibleItems) {
        group.append(buildSessionItem(item, cwd));
      }

      if (filteredItems.length > sessionFolderPreviewLimit) {
        const moreButton = document.createElement("button");
        moreButton.type = "button";
        moreButton.className = "sessionFolderMoreButton";
        moreButton.textContent = folderExpanded
          ? "Show fewer"
          : `Show all ${filteredItems.length} sessions`;
        moreButton.addEventListener("click", () => {
          if (folderExpanded) state.expandedSessionFolders.delete(cwd);
          else state.expandedSessionFolders.add(cwd);
          renderSessionList(cachedSessions);
        });
        group.append(moreButton);
      }

      elements.sessionListEl.append(group);
    }
  }

  function beginInlineRename(row: HTMLElement, navBtn: HTMLElement, item: SessionInfo) {
    // Mark this session as being renamed so list re-renders triggered by
    // streaming runtime updates don't yank the input out from under the user.
    activeRenameSessionId = item.id;
    // Hide the nav button and show an inline input for renaming
    const input = document.createElement("input");
    input.type = "text";
    input.className = "sessionRenameInput";
    input.value = item.name || "";
    input.placeholder = item.firstMessage?.trim() || "New session";
    input.maxLength = 200;
    input.setAttribute("aria-label", "Session name");

    const originalDisplay = navBtn.style.display;
    navBtn.style.display = "none";
    // Hide action buttons during rename
    const actionBtns = row.querySelectorAll<HTMLElement>(".sessionRenameBtn, .sessionActiveToggle, .sessionBookmarkBtn");
    actionBtns.forEach(btn => btn.style.display = "none");

    row.insertBefore(input, navBtn.nextSibling);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save: boolean) => {
      if (finished) return;
      finished = true;
      activeRenameSessionId = null;
      const newName = input.value.trim();
      input.remove();
      navBtn.style.display = originalDisplay;
      actionBtns.forEach(btn => btn.style.display = "");

      if (save && newName !== (item.name || "")) {
        try {
          const res = await fetch("/api/session/name", {
            method: "POST",
            headers: api.headers(),
            body: JSON.stringify({ sessionId: item.id, name: newName }),
          });
          const text = await res.text();
          const data = text ? JSON.parse(text) : {};
          if (!res.ok || data.ok === false) throw new Error(data.error || text);
          item.name = newName;
          // Update pinned session label if pinned
          const pinnedIdx = state.pinnedSessions.findIndex(p => p.id === item.id);
          if (pinnedIdx >= 0) {
            state.pinnedSessions[pinnedIdx] = { ...state.pinnedSessions[pinnedIdx], label: sessionTitle(item) };
            persistPinnedSessions(state.pinnedSessions);
          }
          // If this is the current session, update the status bar title
          if (item.isCurrent) {
            updateMeta(data);
          }
          renderSessionList(cachedSessions);
          renderSessionBar();
        } catch (error) {
          addMessage("system", error instanceof Error ? error.message : String(error), "error");
        }
      }
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  function buildSessionItem(item: SessionInfo, cwd: string): HTMLElement {
    // Use a div so we can have two sibling buttons (pin + navigate) without nesting buttons
    const row = document.createElement("div");
    row.className = `sessionItem${item.isCurrent ? " current" : ""}${isPinned(item.id) ? " pinned" : ""}${item.inactive ? " inactive" : ""}`;
    if (item.isCurrent) row.setAttribute("aria-current", "page");

    // ── Pin button (always visible, works on touch) ────────────────────────
    const pinned = isPinned(item.id);
    const barFull = state.pinnedSessions.length >= maxPinnedSessions;
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = `sessionItemPinBtn${pinned ? " pinned" : ""}`;
    pinBtn.disabled = !pinned && barFull;
    pinBtn.title = pinned
      ? "Remove from quick bar"
      : barFull
        ? "Quick bar is full (max 4)"
        : "Add to quick bar";
    pinBtn.setAttribute("aria-label", pinBtn.title);
    pinBtn.setAttribute("aria-pressed", String(pinned));
    setIcon(pinBtn, "star");
    pinBtn.addEventListener("click", () => togglePin(item));

    // ── Navigate button ────────────────────────────────────────────────────
    const navBtn = document.createElement("button");
    navBtn.type = "button";
    navBtn.className = "sessionItemNavBtn";

    const titleRow = document.createElement("span");
    titleRow.className = "sessionItemTitleRow";
    // Per-session agent badge so a unified pi+claude-code list is scannable.
    if (item.agent === "claude-code" || item.agent === "pi") {
      const badge = document.createElement("span");
      badge.className = `sessionAgentBadge sessionAgentBadge-${item.agent}`;
      badge.textContent = item.agent === "claude-code" ? "cc" : "pi";
      badge.title = item.agent === "claude-code" ? "Claude Code session" : "pi session";
      titleRow.append(badge);
    }
    const title = document.createElement("span");
    title.className = "sessionItemTitle";
    title.textContent = sessionTitle(item);
    titleRow.append(title);

    if (item.runtime?.isRunning) {
      const spinner = document.createElement("span");
      spinner.className = "sessionSpinner";
      spinner.title = item.runtime.isCompacting ? "Compacting" : "Running";
      spinner.setAttribute("aria-label", spinner.title);
      spinner.style.animationDelay = `-${Date.now() % 800}ms`;
      titleRow.append(spinner);
    }

    const meta = document.createElement("span");
    meta.className = "sessionItemMeta";
    meta.textContent = `${formatRelativeTime(item.modified)} · ${item.messageCount}`;

    navBtn.append(titleRow, meta);
    navBtn.addEventListener("click", async () => {
      const perf = createTracker("session-switch:drawer");
      // See bar-tab handler for rationale: prevents a WS state_changed echo
      // from racing the HTTP response and triggering a redundant
      // refreshMessages on the critical path.
      state.lastSwitchedSession = { sessionId: item.id, ts: Date.now() };
      try {
        const openRes = await fetch("/api/sessions/open", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ sessionId: item.id, cwd: item.cwd || cwd }),
        });
        if (!openRes.ok) throw new Error(await openRes.text());
        const openData = await openRes.json().catch(() => ({}));
        perf?.mark("network");
        const nextCwd = item.cwd || cwd;
        rememberSessionCwd(nextCwd);
        markCachedCurrentSession(item.id, nextCwd);
        if (shouldCloseDrawerAfterSessionSwitch()) setSessionDrawerOpen(false);
        await applySwitchedSessionState(openData, perf);
        perf?.end({
          embedded: Array.isArray(openData?.messages),
          messages: Array.isArray(openData?.messages) ? openData.messages.length : 0,
        });
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
        if (!elements.sessionDrawer.hidden) refreshSessions().catch(() => undefined);
      }
    });

    // ── Rename button ─────────────────────────────────────────────────────────
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "sessionRenameBtn";
    renameBtn.title = "Rename session";
    renameBtn.setAttribute("aria-label", "Rename session");
    setIcon(renameBtn, "pencil");
    renameBtn.addEventListener("click", () => {
      beginInlineRename(row, navBtn, item);
    });

    // ── Active/Inactive toggle ──────────────────────────────────────────────
    const activeToggle = document.createElement("button");
    activeToggle.type = "button";
    activeToggle.className = `sessionActiveToggle${item.inactive ? " inactive" : ""}`;
    activeToggle.title = item.inactive ? "Mark as active" : "Mark as inactive";
    activeToggle.setAttribute("aria-label", activeToggle.title);
    activeToggle.textContent = item.inactive ? "●" : "●";
    activeToggle.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/session/active", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ sessionId: item.id, inactive: !item.inactive }),
        });
        if (!res.ok) throw new Error(await res.text());
        item.inactive = !item.inactive;
        renderSessionList(cachedSessions);
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      }
    });

    // ── Bookmark/Saved toggle ──────────────────────────────────────────────
    const bookmarkBtn = document.createElement("button");
    bookmarkBtn.type = "button";
    bookmarkBtn.className = `sessionBookmarkBtn${item.saved ? " saved" : ""}`;
    bookmarkBtn.title = item.saved ? "Remove bookmark" : "Bookmark session";
    bookmarkBtn.setAttribute("aria-label", bookmarkBtn.title);
    setIcon(bookmarkBtn, "bookmark");
    bookmarkBtn.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/session/saved", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ sessionId: item.id, saved: !item.saved }),
        });
        if (!res.ok) throw new Error(await res.text());
        item.saved = !item.saved;
        renderSessionList(cachedSessions);
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      }
    });

    row.append(pinBtn, navBtn, renameBtn, activeToggle, bookmarkBtn);
    return row;
  }

  function init() {
    new MutationObserver(updateEmptyCwdChooser).observe(elements.messagesEl, { childList: true });
    elements.emptyCwdButton.addEventListener("click", () => openFolderPicker(state.currentCwd));
    elements.sessionButton.addEventListener("click", () => setSessionDrawerOpen(true));
    elements.newSessionHeaderButton.addEventListener("click", async () => {
      try {
        await startNewSession();
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      }
    });
    elements.sessionCloseButton.addEventListener("click", () => setSessionDrawerOpen(false));
    elements.sessionBackdrop.addEventListener("click", () => setSessionDrawerOpen(false));
    elements.sessionNewButton.addEventListener("click", async () => {
      try {
        await startNewSession();
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      }
    });

    // Render bar immediately from stored pins (labels from localStorage)
    renderSessionBar();
    // Background-fetch session list so tab click handlers are always wired up,
    // even if the drawer has never been opened.
    if (state.pinnedSessions.length > 0) {
      refreshSessions().catch(() => undefined);
    }
  }

  return {
    init,
    refreshSessions,
    setSessionDrawerOpen,
    startNewSession,
    updateEmptyCwdChooser,
    updateSessionRuntime,
    renderSessionBar,
  };
}
