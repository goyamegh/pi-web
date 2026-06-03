import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { setIcon, type IconName } from "../app/icons.js";
import type { AppState, SessionInfo, SessionMarkerBucketId } from "../app/types.js";
import { persistCollapsedSessionFolders, persistPinnedSessions, persistSessionMarkers, sessionFolderPreviewLimit, sessionMarkerBuckets } from "../app/types.js";

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
  let currentSessionPinButton: HTMLButtonElement | undefined;
  let sessionSearchInput: HTMLInputElement | undefined;
  let sessionFilterSelect: HTMLSelectElement | undefined;
  let sessionFilterMode: "all" | "marked" | "unmarked" | "running" | SessionMarkerBucketId = "all";
  const markerLongPressMs = 480;

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

  // ── Markers and pinning ────────────────────────────────────────────────────

  function markerForSession(sessionId: string) {
    return state.sessionMarkers.find((marker) => marker.sessionId === sessionId);
  }

  function bucketForMarker(bucketId?: string) {
    return sessionMarkerBuckets.find((bucket) => bucket.id === bucketId);
  }

  function setSessionMarker(sessionId: string, bucket: SessionMarkerBucketId) {
    const next = { sessionId, bucket, updatedAt: new Date().toISOString() };
    state.sessionMarkers = [next, ...state.sessionMarkers.filter((marker) => marker.sessionId !== sessionId)];
    persistSessionMarkers(state.sessionMarkers);
    renderSessionList(cachedSessions);
  }

  function clearSessionMarker(sessionId: string) {
    const count = state.sessionMarkers.length;
    state.sessionMarkers = state.sessionMarkers.filter((marker) => marker.sessionId !== sessionId);
    if (state.sessionMarkers.length === count) return;
    persistSessionMarkers(state.sessionMarkers);
    renderSessionList(cachedSessions);
  }

  function markerButtonTitle(markerBucket: { label: string } | undefined) {
    return markerBucket
      ? `Marked: ${markerBucket.label}. Click to clear. Press and hold to choose a different marker.`
      : "Mark session for later. Press and hold to choose marker.";
  }

  function shouldUseBottomSheetMenu() {
    return window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
  }

  function positionSessionMenu(menu: HTMLElement, anchor: HTMLElement, options: { bottomSheet?: boolean } = {}) {
    if (options.bottomSheet && shouldUseBottomSheetMenu()) {
      menu.classList.add("bottomSheet");
      return;
    }
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
  }

  function installSessionMenuCloseHandlers(menu: HTMLElement, anchor: HTMLElement) {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || anchor.contains(target))) return;
      closeOpenSessionActionsMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOpenSessionActionsMenu();
    };
    const onResize = () => closeOpenSessionActionsMenu();
    const installPointerListener = window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);
    closeSessionActionsMenu = () => {
      window.clearTimeout(installPointerListener);
      menu.remove();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
  }

  function openSessionMarkerMenu(anchor: HTMLButtonElement, item: SessionInfo) {
    closeOpenSessionActionsMenu();

    const marker = markerForSession(item.id);
    const menu = document.createElement("div");
    menu.className = "sessionMarkerMenu";
    menu.setAttribute("role", "menu");

    for (const bucket of sessionMarkerBuckets) {
      const selected = marker?.bucket === bucket.id;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `sessionMarkerMenuItem marker-${bucket.color}${selected ? " selected" : ""}`;
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(selected));
      button.title = selected ? `${bucket.label} marker selected` : `Mark as ${bucket.label}`;

      const swatch = document.createElement("span");
      swatch.className = "sessionMarkerMenuSwatch";
      swatch.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = bucket.label;
      button.append(swatch, label);
      button.addEventListener("click", () => {
        closeOpenSessionActionsMenu();
        setSessionMarker(item.id, bucket.id);
      });
      menu.append(button);
    }

    if (marker) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "sessionMarkerMenuItem clear";
      clear.setAttribute("role", "menuitem");
      clear.title = "Clear marker";
      setIcon(clear, "x");
      const label = document.createElement("span");
      label.textContent = "Clear marker";
      clear.append(label);
      clear.addEventListener("click", () => {
        closeOpenSessionActionsMenu();
        clearSessionMarker(item.id);
      });
      menu.append(clear);
    }

    document.body.append(menu);
    positionSessionMenu(menu, anchor, { bottomSheet: true });
    installSessionMenuCloseHandlers(menu, anchor);
  }

  function isPinned(id: string) {
    return state.pinnedSessions.some((p) => p.id === id);
  }

  function pinSession(item: SessionInfo) {
    if (isPinned(item.id)) return;
    state.pinnedSessions = [...state.pinnedSessions, { id: item.id, label: sessionTitle(item) }];
    persistPinnedSessions(state.pinnedSessions);
    document.body.classList.toggle("hasPinnedSessions", state.pinnedSessions.length > 0);
    renderSessionList(cachedSessions);
    renderSessionBar();
    updateCurrentSessionPinButton();
  }

  function unpinSession(sessionId: string) {
    const pinnedCount = state.pinnedSessions.length;
    state.pinnedSessions = state.pinnedSessions.filter((p) => p.id !== sessionId);
    if (state.pinnedSessions.length === pinnedCount) return;
    pinnedRuntimes.delete(sessionId);
    persistPinnedSessions(state.pinnedSessions);
    document.body.classList.toggle("hasPinnedSessions", state.pinnedSessions.length > 0);
    renderSessionList(cachedSessions);
    renderSessionBar();
    updateCurrentSessionPinButton();
  }

  function togglePin(item: SessionInfo) {
    if (isPinned(item.id)) unpinSession(item.id);
    else pinSession(item);
  }

  function titleForSessionId(sessionId: string) {
    const live = cachedSessions.find((s) => s.id === sessionId);
    const pinned = state.pinnedSessions.find((s) => s.id === sessionId);
    if (live) return sessionTitle(live);
    return pinned?.label || state.currentSessionTitle || "New session";
  }

  async function openSessionTab(sessionId: string, cwd: string) {
    const previousSessionId = state.currentSessionId;
    if (state.currentSessionId !== sessionId) {
      state.currentSessionId = sessionId;
      renderSessionBar();
    }
    try {
      const openRes = await fetch("/api/sessions/open", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ sessionId, cwd }),
      });
      if (!openRes.ok) throw new Error(await openRes.text());
      rememberSessionCwd(cwd);
      markCachedCurrentSession(sessionId, cwd);
      await refreshState();
    } catch (error) {
      state.currentSessionId = previousSessionId;
      renderSessionBar();
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    }
  }

  function updateCurrentSessionPinButton() {
    if (!currentSessionPinButton) return;
    const currentId = state.currentSessionId;
    const pinned = Boolean(currentId && isPinned(currentId));
    currentSessionPinButton.hidden = !currentId;
    currentSessionPinButton.disabled = false;
    currentSessionPinButton.classList.toggle("pinned", pinned);
    currentSessionPinButton.title = pinned
      ? "Unpin current session from tab bar"
      : "Pin current session to tab bar";
    currentSessionPinButton.setAttribute("aria-label", currentSessionPinButton.title);
    currentSessionPinButton.setAttribute("aria-pressed", String(pinned));
  }

  function toggleCurrentSessionPin() {
    const currentId = state.currentSessionId;
    if (!currentId) return;
    const live = cachedSessions.find((session) => session.id === currentId);
    if (live) {
      togglePin(live);
      return;
    }
    if (isPinned(currentId)) unpinSession(currentId);
    else {
      state.pinnedSessions = [...state.pinnedSessions, { id: currentId, label: state.currentSessionTitle || "New session" }];
      persistPinnedSessions(state.pinnedSessions);
      renderSessionBar();
      updateCurrentSessionPinButton();
    }
  }

  // ── Session bar ────────────────────────────────────────────────────────────

  function renderSessionBar() {
    const bar = elements.sessionBarEl;
    const pinned = state.pinnedSessions;

    const currentId = state.currentSessionId;
    const currentIsPinned = Boolean(currentId && isPinned(currentId));

    if (pinned.length === 0 && !currentId) {
      bar.hidden = true;
      document.body.classList.remove("hasPinnedSessions");
      updateCurrentSessionPinButton();
      return;
    }

    bar.hidden = false;
    document.body.classList.add("hasPinnedSessions");
    bar.textContent = "";

    updateCurrentSessionPinButton();

    let activeTab: HTMLElement | undefined;
    const appendTab = (sessionId: string, label: string, cwd: string, options: { pinned: boolean; running?: boolean }) => {
      const isActive = currentId === sessionId;
      const tab = document.createElement("div");
      tab.className = `sessionBarTab${isActive ? " active" : ""}${options.running ? " running" : ""}${options.pinned ? " pinned" : " temporary"}`;
      if (isActive) activeTab = tab;

      const open = document.createElement("button");
      open.type = "button";
      open.className = "sessionBarTabOpen";
      if (isActive) open.setAttribute("aria-current", "page");
      open.title = label;

      const labelEl = document.createElement("span");
      labelEl.className = "sessionBarTabLabel";
      labelEl.textContent = label;
      open.append(labelEl);
      open.addEventListener("click", () => void openSessionTab(sessionId, cwd));
      tab.append(open);

      if (options.pinned) {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "sessionBarTabAction";
        close.title = "Unpin tab";
        close.setAttribute("aria-label", `Unpin ${label}`);
        setIcon(close, "x");
        close.addEventListener("click", () => {
          if (!window.confirm(`Unpin “${label}”?`)) return;
          unpinSession(sessionId);
        });
        tab.append(close);
      } else {
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "sessionBarTabAction";
        pin.title = "Pin tab";
        pin.setAttribute("aria-label", `Pin ${label}`);
        setIcon(pin, "pin");
        pin.addEventListener("click", toggleCurrentSessionPin);
        tab.append(pin);
      }

      bar.append(tab);
    };

    for (const pinnedEntry of pinned) {
      const live = cachedSessions.find((s) => s.id === pinnedEntry.id);
      appendTab(
        pinnedEntry.id,
        live ? sessionTitle(live) : pinnedEntry.label,
        live?.cwd || state.currentCwd,
        { pinned: true, running: (live?.runtime ?? pinnedRuntimes.get(pinnedEntry.id))?.isRunning ?? false },
      );
    }

    if (currentId && !currentIsPinned) {
      const live = cachedSessions.find((s) => s.id === currentId);
      if (pinned.length > 0) {
        const separator = document.createElement("div");
        separator.className = "sessionBarSeparator";
        separator.setAttribute("aria-hidden", "true");
        bar.append(separator);
      }
      appendTab(currentId, live ? sessionTitle(live) : titleForSessionId(currentId), live?.cwd || state.currentCwd, {
        pinned: false,
        running: (live?.runtime ?? pinnedRuntimes.get(currentId))?.isRunning ?? state.isStreaming,
      });
    }

    if (activeTab) {
      requestAnimationFrame(() => activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" }));
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
    const marker = markerForSession(item.id);
    const markerActions: SessionAction[] = sessionMarkerBuckets.map((bucket) => ({
      id: `mark-${bucket.id}`,
      label: marker?.bucket === bucket.id ? `✓ ${bucket.label}` : `Mark as ${bucket.label}`,
      icon: "flag",
      run: () => setSessionMarker(item.id, bucket.id),
    }));
    return [
      ...markerActions,
      ...(marker ? [{
        id: "clear-marker",
        label: "Clear marker",
        icon: "x" as const,
        run: () => clearSessionMarker(item.id),
      }] : []),
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
    positionSessionMenu(menu, anchor);
    installSessionMenuCloseHandlers(menu, anchor);
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

    const query = sessionSearchInput?.value.trim().toLowerCase() || "";
    const visibleSessions = sessions.filter((item) => {
      const marker = markerForSession(item.id);
      const matchesFilter = sessionFilterMode === "all"
        || (sessionFilterMode === "marked" && Boolean(marker))
        || (sessionFilterMode === "unmarked" && !marker)
        || (sessionFilterMode === "running" && item.runtime?.isRunning)
        || marker?.bucket === sessionFilterMode;
      if (!matchesFilter) return false;
      if (!query) return true;
      return [sessionTitle(item), item.cwd || "", item.firstMessage || ""]
        .some((value) => value.toLowerCase().includes(query));
    });
    if (visibleSessions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sessionEmpty";
      empty.textContent = query ? "No matching sessions." : "No sessions in this bucket.";
      elements.sessionListEl.append(empty);
      return;
    }

    const groups = new Map<string, SessionInfo[]>();
    for (const item of visibleSessions) {
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
    // Use a div so we can have sibling buttons (navigate + actions) without nesting buttons
    const marker = markerForSession(item.id);
    const markerBucket = bucketForMarker(marker?.bucket);
    const row = document.createElement("div");
    row.className = `sessionItem${item.isCurrent ? " current" : ""}${isPinned(item.id) ? " pinned" : ""}${markerBucket ? ` marked marker-${markerBucket.color}` : ""}`;
    if (item.isCurrent) row.setAttribute("aria-current", "page");

    const markerButton = document.createElement("button");
    markerButton.type = "button";
    markerButton.className = "sessionItemMarkerBtn";
    markerButton.title = markerButtonTitle(markerBucket);
    markerButton.setAttribute("aria-label", markerButton.title);
    markerButton.setAttribute("aria-pressed", String(Boolean(markerBucket)));
    setIcon(markerButton, "flag");

    let longPressTimer: number | undefined;
    let suppressNextMarkerClick = false;
    const clearLongPressTimer = () => {
      if (longPressTimer === undefined) return;
      window.clearTimeout(longPressTimer);
      longPressTimer = undefined;
    };
    const suppressMarkerClickBriefly = () => {
      suppressNextMarkerClick = true;
      window.setTimeout(() => { suppressNextMarkerClick = false; }, markerLongPressMs * 2);
    };
    markerButton.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      clearLongPressTimer();
      longPressTimer = window.setTimeout(() => {
        longPressTimer = undefined;
        suppressMarkerClickBriefly();
        openSessionMarkerMenu(markerButton, item);
      }, markerLongPressMs);
    });
    markerButton.addEventListener("pointerup", clearLongPressTimer);
    markerButton.addEventListener("pointerleave", clearLongPressTimer);
    markerButton.addEventListener("pointercancel", clearLongPressTimer);
    markerButton.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      clearLongPressTimer();
      suppressMarkerClickBriefly();
      openSessionMarkerMenu(markerButton, item);
    });
    markerButton.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ContextMenu" && !(event.shiftKey && (event.key === "Enter" || event.key === " "))) return;
      event.preventDefault();
      clearLongPressTimer();
      openSessionMarkerMenu(markerButton, item);
    });
    markerButton.addEventListener("click", (event) => {
      if (suppressNextMarkerClick) {
        event.preventDefault();
        suppressNextMarkerClick = false;
        return;
      }
      if (markerBucket) clearSessionMarker(item.id);
      else setSessionMarker(item.id, "later");
    });

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

    row.append(markerButton, navBtn, actionsBtn);
    return row;
  }

  function init() {
    new MutationObserver(updateEmptyCwdChooser).observe(elements.messagesEl, { childList: true });
    elements.emptyCwdButton.addEventListener("click", () => openFolderPicker(state.currentCwd));
    const headerTitle = elements.sessionDrawer.querySelector(".sessionDrawerHeader h2");
    if (headerTitle) {
      const filterWrap = document.createElement("div");
      filterWrap.className = "sessionDrawerFilters";
      sessionSearchInput = document.createElement("input");
      sessionSearchInput.type = "search";
      sessionSearchInput.className = "sessionDrawerSearch";
      sessionSearchInput.placeholder = "Search sessions…";
      sessionSearchInput.setAttribute("aria-label", "Search sessions");
      sessionFilterSelect = document.createElement("select");
      sessionFilterSelect.className = "sessionDrawerFilterSelect";
      sessionFilterSelect.setAttribute("aria-label", "Session filter");
      for (const [value, label] of [["all", "All"], ["marked", "Marked"], ["unmarked", "Unmarked"], ["running", "Running"]] as const) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        sessionFilterSelect.append(option);
      }
      for (const bucket of sessionMarkerBuckets) {
        const option = document.createElement("option");
        option.value = bucket.id;
        option.textContent = bucket.label;
        sessionFilterSelect.append(option);
      }
      sessionFilterSelect.value = sessionFilterMode;
      sessionSearchInput.addEventListener("input", () => renderSessionList(cachedSessions));
      sessionFilterSelect.addEventListener("change", () => {
        sessionFilterMode = sessionFilterSelect?.value as typeof sessionFilterMode;
        renderSessionList(cachedSessions);
      });
      filterWrap.append(sessionSearchInput, sessionFilterSelect);
      headerTitle.replaceWith(filterWrap);
    }

    const footer = document.createElement("div");
    footer.className = "sessionDrawerFooter";
    elements.settingsButton.classList.add("sessionDrawerFooterButton");
    elements.settingsButton.textContent = "";
    setIcon(elements.settingsButton, "settings");
    elements.settingsButton.append(document.createTextNode("Settings"));
    elements.sessionNewButton.textContent = "+ New session";
    footer.append(elements.settingsButton, elements.sessionNewButton);
    elements.sessionDrawer.append(footer);

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
