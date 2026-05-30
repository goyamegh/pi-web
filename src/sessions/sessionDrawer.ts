import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { setIcon, type IconName } from "../app/icons.js";
import type { AppState, SessionInfo } from "../app/types.js";
import { maxPinnedSessions, persistCollapsedSessionFolders, persistPinnedSessions, sessionFolderPreviewLimit } from "../app/types.js";

export type SessionsController = {
  init: () => void;
  refreshSessions: () => Promise<void>;
  setSessionDrawerOpen: (open: boolean) => void;
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
  updateMeta: (data: any) => void;
  updateThinkingOptions: (levels?: string[]) => void;
  refreshModels: () => Promise<void>;
  refreshMessages: () => Promise<void>;
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
  let closeSessionActionsMenu: (() => void) | undefined;

  type SessionAction = {
    id: string;
    label: string;
    icon?: IconName;
    danger?: boolean;
    disabled?: boolean;
    disabledReason?: string;
    run: () => Promise<void> | void;
  };

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
    const create = document.createElement("button");
    create.type = "button";
    create.textContent = "New folder";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "primaryAction";
    select.textContent = "Select folder";
    actions.append(create, cancel, select);
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

    create.addEventListener("click", async () => {
      const name = window.prompt("New folder name");
      if (name === null) return;
      try {
        create.disabled = true;
        error.textContent = "";
        const res = await fetch("/api/fs/dirs", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ parent: input.value, name }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || "Could not create folder");
        input.value = data.path;
        await load(data.path);
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
      } finally {
        create.disabled = false;
      }
    });
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

  function setSessionDrawerOpen(open: boolean) {
    if (!open) closeOpenSessionActionsMenu();
    elements.sessionDrawer.hidden = !open;
    elements.sessionBackdrop.hidden = !open;
    document.body.classList.toggle("sessionDrawerOpen", open);
    if (open) refreshSessions().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
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
    renderSessionList(cachedSessions);
    renderSessionBar();
  }

  function markCachedCurrentSession(sessionId: string, cwd: string) {
    cachedSessions = cachedSessions.map((session) => ({
      ...session,
      isCurrent: session.id === sessionId && (session.cwd || cwd) === cwd,
    }));
    renderSessionList(cachedSessions);
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
    if (!elements.sessionDrawer.hidden) renderSessionList(cachedSessions);
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
          // Optimistic update: switch the active tab highlight immediately before any
          // network round-trips so the UI feels instant even during streaming.
          const previousSessionId = state.currentSessionId;
          if (state.currentSessionId !== live.id) {
            state.currentSessionId = live.id;
            renderSessionBar();
          }
          try {
            const cwd = live.cwd || state.currentCwd;
            const openRes = await fetch("/api/sessions/open", {
              method: "POST",
              headers: api.headers(),
              body: JSON.stringify({ sessionId: live.id, cwd }),
            });
            if (!openRes.ok) throw new Error(await openRes.text());
            rememberSessionCwd(cwd);
            markCachedCurrentSession(live.id, cwd);
            await refreshState();
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

  // ── Session actions ───────────────────────────────────────────────────────

  function closeOpenSessionActionsMenu() {
    closeSessionActionsMenu?.();
    closeSessionActionsMenu = undefined;
  }

  async function deleteSession(item: SessionInfo, cwd: string) {
    if (item.isCurrent) throw new Error("Switch to another session before deleting the current session.");
    if (item.runtime?.isRunning) throw new Error("Wait for the session to finish before deleting it.");

    const title = sessionTitle(item);
    if (!window.confirm(`Delete session “${title}”?`)) return;

    const res = await fetch("/api/sessions/delete", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ sessionId: item.id, cwd: item.cwd || cwd }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || await res.text());

    cachedSessions = cachedSessions.filter((session) => session.id !== item.id);
    pinnedRuntimes.delete(item.id);
    const pinnedCount = state.pinnedSessions.length;
    state.pinnedSessions = state.pinnedSessions.filter((session) => session.id !== item.id);
    if (state.pinnedSessions.length !== pinnedCount) persistPinnedSessions(state.pinnedSessions);
    renderSessionList(cachedSessions);
    renderSessionBar();
    addMessage("system", data.disposition === "trashed" ? "Session moved to trash." : "Session deleted.");
  }

  function getSessionActions(item: SessionInfo, cwd: string): SessionAction[] {
    const deleteDisabledReason = item.isCurrent
      ? "Switch to another session before deleting the current session"
      : item.runtime?.isRunning
        ? "Wait for the session to finish before deleting it"
        : undefined;
    return [
      {
        id: "delete",
        label: "Delete",
        icon: "trash-2",
        danger: true,
        disabled: Boolean(deleteDisabledReason),
        disabledReason: deleteDisabledReason,
        run: () => deleteSession(item, cwd),
      },
    ];
  }

  function openSessionActionsMenu(anchor: HTMLButtonElement, item: SessionInfo, cwd: string) {
    closeOpenSessionActionsMenu();

    const menu = document.createElement("div");
    menu.className = "sessionActionsMenu";
    menu.setAttribute("role", "menu");

    for (const action of getSessionActions(item, cwd)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sessionActionsMenuItem${action.danger ? " danger" : ""}`;
      button.setAttribute("role", "menuitem");
      button.disabled = Boolean(action.disabled);
      button.title = action.disabledReason || action.label;
      if (action.icon) setIcon(button, action.icon);
      const label = document.createElement("span");
      label.textContent = action.label;
      button.append(label);
      button.addEventListener("click", async () => {
        closeOpenSessionActionsMenu();
        try {
          await action.run();
        } catch (error) {
          addMessage("system", error instanceof Error ? error.message : String(error), "error");
          if (!elements.sessionDrawer.hidden) refreshSessions().catch(() => undefined);
        }
      });
      menu.append(button);
    }

    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, rect.right - menuRect.width), window.innerWidth - menuRect.width - margin);
    const below = rect.bottom + 4;
    const top = below + menuRect.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, rect.top - menuRect.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || anchor.contains(target))) return;
      closeOpenSessionActionsMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOpenSessionActionsMenu();
    };
    const onResize = () => closeOpenSessionActionsMenu();
    closeSessionActionsMenu = () => {
      menu.remove();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
    setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
  }

  // ── Session list ───────────────────────────────────────────────────────────

  function renderSessionList(sessions: SessionInfo[]) {
    closeOpenSessionActionsMenu();
    elements.sessionListEl.textContent = "";

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

    for (const [cwd, items] of groups) {
      const group = document.createElement("section");
      group.className = "sessionFolderGroup";

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
      header.append(toggle, newButton);
      group.append(header);

      if (state.collapsedSessionFolders.has(cwd)) {
        elements.sessionListEl.append(group);
        continue;
      }

      const folderExpanded = state.expandedSessionFolders.has(cwd);
      const visibleItems = folderExpanded ? items : items.slice(0, sessionFolderPreviewLimit);

      for (const item of visibleItems) {
        group.append(buildSessionItem(item, cwd));
      }

      if (items.length > sessionFolderPreviewLimit) {
        const moreButton = document.createElement("button");
        moreButton.type = "button";
        moreButton.className = "sessionFolderMoreButton";
        moreButton.textContent = folderExpanded
          ? "Show fewer"
          : `Show all ${items.length} sessions`;
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

  function buildSessionItem(item: SessionInfo, cwd: string): HTMLElement {
    // Use a div so we can have two sibling buttons (pin + navigate) without nesting buttons
    const row = document.createElement("div");
    row.className = `sessionItem${item.isCurrent ? " current" : ""}${isPinned(item.id) ? " pinned" : ""}`;
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
      try {
        const openRes = await fetch("/api/sessions/open", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ sessionId: item.id, cwd: item.cwd || cwd }),
        });
        if (!openRes.ok) throw new Error(await openRes.text());
        const nextCwd = item.cwd || cwd;
        rememberSessionCwd(nextCwd);
        markCachedCurrentSession(item.id, nextCwd);
        if (shouldCloseDrawerAfterSessionSwitch()) setSessionDrawerOpen(false);
        await refreshState();
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
        if (!elements.sessionDrawer.hidden) refreshSessions().catch(() => undefined);
      }
    });

    const actionsBtn = document.createElement("button");
    actionsBtn.type = "button";
    actionsBtn.className = "sessionItemActionsBtn";
    actionsBtn.title = "Session actions";
    actionsBtn.setAttribute("aria-label", actionsBtn.title);
    actionsBtn.setAttribute("aria-haspopup", "menu");
    setIcon(actionsBtn, "more-vertical");
    actionsBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openSessionActionsMenu(actionsBtn, item, cwd);
    });

    row.append(pinBtn, navBtn, actionsBtn);
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
