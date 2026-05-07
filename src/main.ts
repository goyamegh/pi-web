import "./style.css";
import { CornerDownRight, createElement, Gauge, KeyRound, Menu, Paperclip, Route, SendHorizontal, Square, X } from "lucide";

function syncAppHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}

syncAppHeight();
window.addEventListener("resize", syncAppHeight);
window.visualViewport?.addEventListener("resize", syncAppHeight);
window.visualViewport?.addEventListener("scroll", syncAppHeight);

type Role = "user" | "assistant" | "tool" | "system";

type PiEvent = {
  type: string;
  [key: string]: any;
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required DOM node: ${selector}`);
  return element;
}

const messagesEl = requiredElement<HTMLDivElement>("#messages");
const metaEl = requiredElement<HTMLParagraphElement>("#meta");
const formEl = requiredElement<HTMLFormElement>("#promptForm");
const promptEl = requiredElement<HTMLTextAreaElement>("#prompt");
const primaryButton = requiredElement<HTMLButtonElement>("#primaryButton");
const tokenButton = requiredElement<HTMLButtonElement>("#tokenButton");
const sessionButton = requiredElement<HTMLButtonElement>("#sessionButton");
const sessionDrawer = requiredElement<HTMLElement>("#sessionDrawer");
const sessionBackdrop = requiredElement<HTMLDivElement>("#sessionBackdrop");
const sessionCloseButton = requiredElement<HTMLButtonElement>("#sessionCloseButton");
const sessionNewButton = requiredElement<HTMLButtonElement>("#sessionNewButton");
const sessionListEl = requiredElement<HTMLDivElement>("#sessionList");
const queueToggle = requiredElement<HTMLButtonElement>("#queueToggle");
const attachButton = requiredElement<HTMLButtonElement>("#attachButton");
const imageInput = requiredElement<HTMLInputElement>("#imageInput");
const attachmentsEl = requiredElement<HTMLDivElement>("#attachments");
const modelSelectEl = requiredElement<HTMLSelectElement>("#modelSelect");
const thinkingSelectEl = requiredElement<HTMLSelectElement>("#thinkingSelect");
const thinkingButton = requiredElement<HTMLButtonElement>("#thinkingButton");

let token = localStorage.getItem("pi-web-token") || "";
let streamingAssistant: HTMLDivElement | null = null;
let currentModelKey = "";
let currentThinkingLevel = "off";
let isStreaming = false;
let queueMode: "steer" | "followUp" = "steer";

type ImageAttachment = {
  type: "image";
  data: string;
  mimeType: string;
  name: string;
};

type SessionInfo = {
  id: string;
  path: string;
  name?: string;
  firstMessage?: string;
  created: string;
  modified: string;
  messageCount: number;
  isCurrent: boolean;
};

let attachedImages: ImageAttachment[] = [];

const iconNodes = {
  "corner-down-right": CornerDownRight,
  gauge: Gauge,
  "key-round": KeyRound,
  menu: Menu,
  paperclip: Paperclip,
  route: Route,
  "send-horizontal": SendHorizontal,
  square: Square,
  x: X,
} as const;

function setIcon(button: HTMLButtonElement, name: keyof typeof iconNodes) {
  button.textContent = "";
  const svg = createElement(iconNodes[name], { "aria-hidden": "true" });
  button.append(svg);
}

function updatePrimaryAction() {
  primaryButton.disabled = !isStreaming && !promptEl.value.trim() && attachedImages.length === 0;
  primaryButton.classList.toggle("dangerAction", isStreaming);
  primaryButton.title = isStreaming ? "Stop streaming" : "Send";
  primaryButton.setAttribute("aria-label", primaryButton.title);
  setIcon(primaryButton, isStreaming ? "square" : "send-horizontal");
}

function updateQueueToggle() {
  const isSteer = queueMode === "steer";
  queueToggle.setAttribute("aria-pressed", String(isSteer));
  queueToggle.title = isSteer ? "Queue mode: steer while running" : "Queue mode: follow up after running";
  queueToggle.setAttribute("aria-label", queueToggle.title);
  setIcon(queueToggle, isSteer ? "route" : "corner-down-right");
}

function updateThinkingButton() {
  const level = thinkingSelectEl.value || currentThinkingLevel || "off";
  thinkingButton.title = `Thinking level: ${level}`;
  thinkingButton.setAttribute("aria-label", thinkingButton.title);
  setIcon(thinkingButton, "gauge");
}

function renderAttachments() {
  attachmentsEl.textContent = "";
  attachmentsEl.hidden = attachedImages.length === 0;
  attachedImages.forEach((image, index) => {
    const chip = document.createElement("div");
    chip.className = "attachmentChip";

    const preview = document.createElement("img");
    preview.src = `data:${image.mimeType};base64,${image.data}`;
    preview.alt = "";

    const name = document.createElement("span");
    name.textContent = image.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "removeAttachment";
    remove.title = `Remove ${image.name}`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => {
      attachedImages.splice(index, 1);
      renderAttachments();
      updatePrimaryAction();
    });
    setIcon(remove, "x");

    chip.append(preview, name, remove);
    attachmentsEl.append(chip);
  });
}

function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      const data = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
      resolve({ type: "image", data, mimeType: file.type, name: file.name });
    });
    reader.addEventListener("error", () => reject(reader.error || new Error(`Could not read ${file.name}`)));
    reader.readAsDataURL(file);
  });
}

function apiHeaders() {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function wsUrl() {
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (token) url.searchParams.set("token", token);
  return url;
}

function shouldCollapseMessage(text: string) {
  return text.length > 1800 || text.split("\n").length > 28;
}

function addMessage(role: Role, text: string, extraClass = "") {
  const div = document.createElement("div");
  const collapsible = shouldCollapseMessage(text);
  div.className = `message ${role} ${extraClass}${collapsible ? " collapsible collapsed" : ""}`.trim();
  const label = document.createElement("span");
  label.className = "role";
  label.textContent = role;
  const body = document.createElement("span");
  body.className = "body";
  body.textContent = text || "";
  div.append(label, body);

  if (collapsible) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "messageToggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      const collapsed = div.classList.toggle("collapsed");
      toggle.textContent = collapsed ? "Show more" : "Show less";
    });
    div.append(toggle);
  }

  messagesEl.append(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function textFromRawContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const value = part as Record<string, unknown>;
    if (value.type === "text") return typeof value.text === "string" ? value.text : "";
    if (value.type === "image") return "[image]";
    if (value.type === "toolCall") return `[tool call: ${String(value.toolName || "tool")}]`;
    return "";
  }).filter(Boolean).join("\n");
}

function messageText(message: any): string {
  return message?.text || textFromRawContent(message?.raw?.content || message?.content) || "";
}

function modelKey(model: any): string {
  return model ? `${model.provider}/${model.id}` : "";
}

function modelLabel(model: any): string {
  const name = model?.name && model.name !== model.id ? ` (${model.name})` : "";
  return `${model.provider}/${model.id}${name}`;
}

function updateMeta(data: any) {
  currentModelKey = modelKey(data.model);
  currentThinkingLevel = data.thinkingLevel || "off";
  const model = currentModelKey || "no model";
  metaEl.textContent = `${data.cwd} · ${model} · ${currentThinkingLevel}`;
  updateThinkingButton();
}

function updateThinkingOptions(levels: string[] = [currentThinkingLevel]) {
  const options = levels.length ? levels : [currentThinkingLevel];
  thinkingSelectEl.textContent = "";
  for (const level of options) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    thinkingSelectEl.append(option);
  }
  thinkingSelectEl.value = options.includes(currentThinkingLevel) ? currentThinkingLevel : options[0] || "off";
  updateThinkingButton();
}

async function refreshModels() {
  const res = await fetch("/api/models", { headers: apiHeaders() });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  updateMeta({ cwd: data.cwd || "", model: data.current, thinkingLevel: data.thinkingLevel });
  modelSelectEl.textContent = "";

  for (const model of data.models || []) {
    if (!model) continue;
    const option = document.createElement("option");
    option.value = modelKey(model);
    option.textContent = modelLabel(model);
    modelSelectEl.append(option);
  }

  modelSelectEl.value = currentModelKey;
  if (!modelSelectEl.value && currentModelKey) {
    const option = document.createElement("option");
    option.value = currentModelKey;
    option.textContent = currentModelKey;
    modelSelectEl.prepend(option);
    modelSelectEl.value = currentModelKey;
  }
  updateThinkingOptions(data.thinkingLevels || [currentThinkingLevel]);
}

async function refreshMessages() {
  const res = await fetch("/api/messages", { headers: apiHeaders() });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  messagesEl.textContent = "";
  streamingAssistant = null;
  for (const message of data.messages || []) {
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "system";
    const text = messageText(message);
    if (text) addMessage(role, text);
  }
}

function formatSessionDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function sessionTitle(session: SessionInfo) {
  return session.name || session.firstMessage?.trim() || "New session";
}

function setSessionDrawerOpen(open: boolean) {
  sessionDrawer.hidden = !open;
  sessionBackdrop.hidden = !open;
  document.body.classList.toggle("sessionDrawerOpen", open);
  if (open) refreshSessions().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
}

async function refreshSessions() {
  const res = await fetch("/api/sessions", { headers: apiHeaders() });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const sessions: SessionInfo[] = data.sessions || [];
  sessionListEl.textContent = "";

  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sessionEmpty";
    empty.textContent = "No saved sessions yet.";
    sessionListEl.append(empty);
    return;
  }

  for (const item of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `sessionItem${item.isCurrent ? " current" : ""}`;
    button.disabled = item.isCurrent;

    const title = document.createElement("span");
    title.className = "sessionItemTitle";
    title.textContent = sessionTitle(item);

    const meta = document.createElement("span");
    meta.className = "sessionItemMeta";
    meta.textContent = `${formatSessionDate(item.modified)} · ${item.messageCount} message${item.messageCount === 1 ? "" : "s"}`;

    button.append(title, meta);
    button.addEventListener("click", async () => {
      try {
        const openRes = await fetch("/api/sessions/open", {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify({ id: item.id }),
        });
        if (!openRes.ok) throw new Error(await openRes.text());
        setSessionDrawerOpen(false);
        await refreshState();
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      }
    });
    sessionListEl.append(button);
  }
}

async function refreshState() {
  const res = await fetch("/api/state", { headers: apiHeaders() });
  if (res.status === 401) {
    metaEl.textContent = "Token required. Click Token to enter it.";
    return;
  }
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  updateMeta(data);
  isStreaming = Boolean(data.isStreaming);
  updatePrimaryAction();
  await Promise.all([refreshModels(), refreshMessages()]);
}

function handlePiEvent(event: PiEvent) {
  switch (event.type) {
    case "agent_start":
      isStreaming = true;
      updatePrimaryAction();
      streamingAssistant = addMessage("assistant", "");
      break;
    case "message_update": {
      const deltaEvent = event.assistantMessageEvent;
      if (deltaEvent?.type === "text_delta") {
        if (!streamingAssistant) streamingAssistant = addMessage("assistant", "");
        const body = streamingAssistant.querySelector<HTMLSpanElement>(".body");
        if (body) body.textContent += deltaEvent.delta || "";
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      break;
    }
    case "tool_execution_start":
      addMessage("tool", `▶ ${event.toolName}\n${JSON.stringify(event.args || {}, null, 2)}`);
      break;
    case "tool_execution_end":
      addMessage("tool", `✓ ${event.toolName}${event.isError ? " failed" : ""}`);
      break;
    case "agent_end":
      isStreaming = false;
      updatePrimaryAction();
      streamingAssistant = null;
      refreshMessages().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
      break;
    case "thinking_level_changed":
      currentThinkingLevel = event.level || currentThinkingLevel;
      thinkingSelectEl.value = currentThinkingLevel;
      updateThinkingButton();
      refreshState().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
      break;
  }
}

function connect() {
  const ws = new WebSocket(wsUrl());
  ws.addEventListener("open", () => addMessage("system", "Connected"));
  ws.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.type === "hello" || data.type === "state_changed") {
      updateMeta(data);
      isStreaming = Boolean(data.isStreaming);
      updatePrimaryAction();
      if (data.thinkingLevels) updateThinkingOptions(data.thinkingLevels);
      if (modelSelectEl.options.length) modelSelectEl.value = currentModelKey;
      if (data.type === "state_changed") {
        refreshMessages().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
        if (!sessionDrawer.hidden) refreshSessions().catch(() => undefined);
      }
      return;
    }
    if (data.type === "pi_event") handlePiEvent(data.event);
    if (data.type === "server_error") addMessage("system", data.error, "error");
  });
  ws.addEventListener("close", () => {
    addMessage("system", "Disconnected. Reconnecting…");
    setTimeout(connect, 1500);
  });
}

async function runSlashCommand(command: string) {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ command }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok || data.ok === false) throw new Error(data.error || text);
  if (data.state) {
    updateMeta(data.state);
    isStreaming = Boolean(data.state.isStreaming);
    updatePrimaryAction();
    if (data.state.thinkingLevels) updateThinkingOptions(data.state.thinkingLevels);
  }
  await refreshModels();
  const name = command.trim().replace(/^\/+/, "").split(/\s+/, 1)[0]?.toLowerCase();
  if (name === "new" || name === "new-chat" || name === "clear") await refreshMessages();
  if (data.message) addMessage("system", data.message);
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isStreaming) {
    await fetch("/api/abort", { method: "POST", headers: apiHeaders() });
    return;
  }

  const message = promptEl.value.trim();
  const images = attachedImages.map(({ type, data, mimeType, name }) => ({ type, data, mimeType, name }));
  if (!message && images.length === 0) return;

  if (message.startsWith("/") && images.length === 0) {
    promptEl.value = "";
    updatePrimaryAction();
    addMessage("system", `› ${message}`);
    try {
      await runSlashCommand(message);
    } catch (error) {
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
    } finally {
      promptEl.focus();
    }
    return;
  }

  promptEl.value = "";
  attachedImages = [];
  renderAttachments();
  updatePrimaryAction();
  addMessage("user", `${message || "[image]"}${images.length ? `\n📎 ${images.length} image${images.length === 1 ? "" : "s"}` : ""}`);

  try {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ message, mode: queueMode, images }),
    });
    if (!res.ok) throw new Error(await res.text());
  } catch (error) {
    addMessage("system", error instanceof Error ? error.message : String(error), "error");
  } finally {
    promptEl.focus();
  }
});

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    formEl.requestSubmit();
  }
});

promptEl.addEventListener("input", updatePrimaryAction);

attachButton.addEventListener("click", () => imageInput.click());

imageInput.addEventListener("change", async () => {
  const files = Array.from(imageInput.files || []).filter((file) => file.type.startsWith("image/"));
  imageInput.value = "";
  try {
    const images = await Promise.all(files.map(fileToImageAttachment));
    attachedImages.push(...images);
    renderAttachments();
    updatePrimaryAction();
  } catch (error) {
    addMessage("system", error instanceof Error ? error.message : String(error), "error");
  }
});

queueToggle.addEventListener("click", () => {
  queueMode = queueMode === "steer" ? "followUp" : "steer";
  updateQueueToggle();
});

sessionButton.addEventListener("click", () => setSessionDrawerOpen(true));
sessionCloseButton.addEventListener("click", () => setSessionDrawerOpen(false));
sessionBackdrop.addEventListener("click", () => setSessionDrawerOpen(false));
sessionNewButton.addEventListener("click", async () => {
  const res = await fetch("/api/sessions/new", { method: "POST", headers: apiHeaders() });
  if (!res.ok) return addMessage("system", await res.text(), "error");
  setSessionDrawerOpen(false);
  messagesEl.textContent = "";
  streamingAssistant = null;
  await refreshState();
  addMessage("system", "New session");
});

async function setModelFromControls() {
  const [provider, ...idParts] = modelSelectEl.value.split("/");
  const id = idParts.join("/");
  if (!provider || !id) return;

  modelSelectEl.disabled = true;
  thinkingSelectEl.disabled = true;
  thinkingButton.disabled = true;
  try {
    const res = await fetch("/api/model", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ provider, id, thinkingLevel: thinkingSelectEl.value }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    updateMeta(data);
    updateThinkingOptions(data.thinkingLevels || [data.thinkingLevel]);
    await refreshModels();
  } catch (error) {
    addMessage("system", error instanceof Error ? error.message : String(error), "error");
    await refreshModels().catch(() => undefined);
  } finally {
    modelSelectEl.disabled = false;
    thinkingSelectEl.disabled = false;
    thinkingButton.disabled = false;
  }
}

modelSelectEl.addEventListener("change", setModelFromControls);
thinkingButton.addEventListener("click", () => {
  const options = Array.from(thinkingSelectEl.options);
  if (options.length < 2) return;
  const nextIndex = (thinkingSelectEl.selectedIndex + 1) % options.length;
  thinkingSelectEl.selectedIndex = nextIndex;
  currentThinkingLevel = thinkingSelectEl.value;
  updateThinkingButton();
  setModelFromControls();
});

tokenButton.addEventListener("click", async () => {
  const next = prompt("PI_WEB_TOKEN", token);
  if (next === null) return;
  token = next.trim();
  if (token) localStorage.setItem("pi-web-token", token);
  else localStorage.removeItem("pi-web-token");
  location.reload();
});

setIcon(sessionButton, "menu");
setIcon(tokenButton, "key-round");
setIcon(attachButton, "paperclip");
updateQueueToggle();
updatePrimaryAction();
refreshState().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
connect();
