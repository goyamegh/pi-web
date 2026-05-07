import "./style.css";
import "highlight.js/styles/github-dark.css";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { Check, Columns2, CornerDownRight, createElement, Copy, Download, ExternalLink, Gauge, KeyRound, Maximize2, Menu, Paperclip, Route, Rows2, SendHorizontal, Square, X } from "lucide";

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

marked.setOptions({
  async: false,
  breaks: true,
  gfm: true,
});

const markdownCache = new Map<string, string>();
const maxCachedMarkdown = 160;
const allowedMarkdownTags = new Set([
  "a", "blockquote", "br", "code", "del", "div", "em", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "img",
  "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
]);
const allowedMarkdownAttributes = new Set(["alt", "class", "href", "rel", "src", "target", "title"]);

function sanitizeMarkdownHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;

  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (!allowedMarkdownTags.has(tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!allowedMarkdownAttributes.has(name) || name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "href") {
        const href = attribute.value.trim();
        if (!/^(https?:|mailto:|#|\/)/i.test(href)) element.removeAttribute(attribute.name);
      }

      if (name === "src") {
        const src = attribute.value.trim();
        if (!/^(https?:|data:image\/(png|jpeg|jpg|gif|webp);base64,|\/api\/artifacts\/)/i.test(src)) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    if (tagName === "a") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }

    if (tagName === "img" && !element.getAttribute("src")) {
      element.remove();
    }
  }

  return template.innerHTML;
}

function highlightMarkdownCode(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;

  for (const code of Array.from(template.content.querySelectorAll("pre code"))) {
    const languageClass = Array.from(code.classList).find((className) => className.startsWith("language-"));
    const language = languageClass?.slice("language-".length);
    const source = code.textContent || "";

    const highlighted = language && hljs.getLanguage(language)
      ? hljs.highlight(source, { language }).value
      : hljs.highlightAuto(source).value;

    code.innerHTML = highlighted;
    code.classList.add("hljs");
    if (language) code.classList.add(`language-${language}`);
  }

  return template.innerHTML;
}

function markdownHtml(text: string) {
  const cached = markdownCache.get(text);
  if (cached !== undefined) {
    markdownCache.delete(text);
    markdownCache.set(text, cached);
    return cached;
  }

  const html = highlightMarkdownCode(sanitizeMarkdownHtml(marked.parse(text) as string));
  markdownCache.set(text, html);
  if (markdownCache.size > maxCachedMarkdown) markdownCache.delete(markdownCache.keys().next().value as string);
  return html;
}

function imageActionIcon(name: "download" | "external-link" | "maximize-2") {
  const icons = { Download, ExternalLink, Maximize2 } as const;
  const icon = name === "download" ? icons.Download : name === "external-link" ? icons.ExternalLink : icons.Maximize2;
  return createElement(icon, { "aria-hidden": "true" });
}

function attachImageActions(img: HTMLImageElement) {
  if (img.closest(".imageFrame")) return;

  const frame = document.createElement("span");
  frame.className = "imageFrame";

  const toolbar = document.createElement("span");
  toolbar.className = "imageActions";

  const fullScreen = document.createElement("button");
  fullScreen.type = "button";
  fullScreen.className = "imageAction";
  fullScreen.title = "Fullscreen";
  fullScreen.setAttribute("aria-label", fullScreen.title);
  fullScreen.append(imageActionIcon("maximize-2"));
  fullScreen.addEventListener("click", () => {
    const overlay = document.createElement("div");
    overlay.className = "imageOverlay";
    const full = document.createElement("img");
    full.src = img.currentSrc || img.src;
    full.alt = img.alt || "image";
    overlay.append(full);
    overlay.addEventListener("click", () => overlay.remove());
    document.body.append(overlay);
  });

  const download = document.createElement("a");
  download.className = "imageAction";
  download.title = "Download";
  download.setAttribute("aria-label", download.title);
  download.href = img.currentSrc || img.src;
  download.download = img.alt || "image";
  download.append(imageActionIcon("download"));

  const open = document.createElement("a");
  open.className = "imageAction";
  open.title = "Open in new tab";
  open.setAttribute("aria-label", open.title);
  open.href = img.currentSrc || img.src;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.append(imageActionIcon("external-link"));

  toolbar.append(fullScreen, download, open);
  img.before(frame);
  frame.append(img, toolbar);
}

function enhanceCodeBlocks(root: ParentNode) {
  for (const pre of Array.from(root.querySelectorAll<HTMLPreElement>("pre"))) {
    if (pre.querySelector(".copyCode")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copyCode";
    btn.title = "Copy code";
    btn.setAttribute("aria-label", btn.title);
    btn.append(createElement(Copy, { "aria-hidden": "true" }));
    btn.dataset.icon = "copy";
    btn.addEventListener("click", () => {
      btn.innerHTML = "";
      btn.append(createElement(Check, { "aria-hidden": "true" }));
      btn.dataset.icon = "check";
      setTimeout(() => {
        btn.innerHTML = "";
        btn.append(createElement(Copy, { "aria-hidden": "true" }));
        btn.dataset.icon = "copy";
      }, 1500);
      const code = pre.querySelector("code");
      navigator.clipboard.writeText(code?.textContent || pre.textContent || "").catch(() => {});
    });
    pre.style.position = "relative";
    pre.append(btn);
  }
}

function enhanceImages(root: ParentNode) {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) attachImageActions(img);
}

function renderAssistantMarkdown(body: HTMLElement, text: string) {
  body.classList.add("markdownBody");
  body.innerHTML = markdownHtml(text);
  enhanceCodeBlocks(body);
  enhanceImages(body);
  body.dataset.markdownRendered = "true";
  delete body.dataset.markdownText;
}

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
const stopButton = requiredElement<HTMLButtonElement>("#stopButton");
const tokenOverlay = requiredElement<HTMLDivElement>("#tokenOverlay");
const tokenForm = requiredElement<HTMLFormElement>("#tokenForm");
const tokenInput = requiredElement<HTMLInputElement>("#tokenInput");
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

const requestIdle = window.requestIdleCallback || ((callback: IdleRequestCallback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 1));
const markdownRenderObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const body = entry.target as HTMLElement;
      observer.unobserve(body);
      const text = body.dataset.markdownText || "";
      requestIdle(() => {
        if (body.isConnected && text && !body.dataset.markdownRendered) renderAssistantMarkdown(body, text);
      });
    }
  }, { root: messagesEl, rootMargin: "600px 0px" })
  : null;

function queueAssistantMarkdownRender(body: HTMLElement, text: string) {
  body.dataset.markdownText = text;
  if (markdownRenderObserver) markdownRenderObserver.observe(body);
  else requestIdle(() => {
    if (body.isConnected && !body.dataset.markdownRendered) renderAssistantMarkdown(body, text);
  });
}

{
  const urlToken = new URLSearchParams(location.search).get("token");
  if (urlToken) {
    localStorage.setItem("pi-web-token", urlToken);
    const url = new URL(location.href);
    url.searchParams.delete("token");
    history.replaceState(null, "", url.toString());
  }
}
let token = localStorage.getItem("pi-web-token") || "";
let streamingAssistant: HTMLDivElement | null = null;
const activeToolCards = new Map<string, HTMLDivElement>();
let currentModelKey = "";
let currentThinkingLevel = "off";
let currentSessionId = "";
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
  name?: string;
  firstMessage?: string;
  created: string;
  modified: string;
  messageCount: number;
  isCurrent: boolean;
  runtime?: {
    loaded: boolean;
    isRunning: boolean;
    isStreaming: boolean;
    isCompacting: boolean;
    pendingMessageCount: number;
  };
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
  const hasInput = !!promptEl.value.trim() || attachedImages.length > 0;
  primaryButton.disabled = !hasInput;
  stopButton.style.display = isStreaming ? "" : "none";
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

interface AttachedImage {
  data?: string;
  mimeType?: string;
  path?: string;
}

function imagesFromRawContent(content: unknown): AttachedImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part): part is Record<string, unknown> => !!part && typeof part === "object" && (part as any).type === "image")
    .map((part) => ({ data: part.data as string | undefined, mimeType: part.mimeType as string | undefined }));
}

function stripImagePathNote(text: string): { text: string; paths: string[] } {
  const match = text.match(/(\n\nAttached image files?:\n(?:- .+\n?)+)/s);
  if (!match) return { text, paths: [] };
  const noteBlock = match[1];
  const paths = [...noteBlock.matchAll(/^- (.+)$/gm)].map((m) => m[1].trim());
  return { text: text.replace(noteBlock, "").trimEnd(), paths };
}

function addMessage(role: Role, text: string, extraClass = "", images: AttachedImage[] = []) {
  const div = document.createElement("div");
  const collapsible = shouldCollapseMessage(text);
  div.className = `message ${role} ${extraClass}${collapsible ? " collapsible collapsed" : ""}`.trim();
  const label = document.createElement("span");
  label.className = "role";
  label.textContent = role;
  const body = document.createElement("div");
  body.className = "body";

  if (role === "user" && images.length > 0) {
    // Render text (stripping the server-appended path note since we show images inline)
    const { text: cleanText } = stripImagePathNote(text);
    if (cleanText) {
      const textNode = document.createElement("span");
      textNode.className = "messageText";
      textNode.textContent = cleanText;
      body.append(textNode);
    }
    // Render image previews
    const imgWrap = document.createElement("div");
    imgWrap.className = "messageImages";
    for (const img of images) {
      if (img.data && img.mimeType) {
        const el = document.createElement("img");
        el.className = "messageImageThumb";
        el.src = `data:${img.mimeType};base64,${img.data}`;
        el.alt = img.path ? img.path.split("/").pop() || "image" : "image";
        imgWrap.append(el);
        attachImageActions(el);
      } else {
        const missing = document.createElement("span");
        missing.className = "messageImageMissing";
        missing.title = img.path || "unknown path";
        missing.textContent = `🖼️ ${img.path ? img.path.split("/").pop() : "missing image"}`;
        imgWrap.append(missing);
      }
    }
    body.append(imgWrap);
  } else if (role === "assistant" && text) {
    body.textContent = text;
    if (collapsible) queueAssistantMarkdownRender(body, text);
    else renderAssistantMarkdown(body, text);
  } else {
    body.textContent = text || "";
  }

  div.append(label, body);

  if (collapsible) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "messageToggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      const collapsed = div.classList.toggle("collapsed");
      if (!collapsed && role === "assistant" && text && !body.dataset.markdownRendered) {
        markdownRenderObserver?.unobserve(body);
        renderAssistantMarkdown(body, text);
      }
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
    // toolCall parts are rendered as tool cards — skip them in text bubbles
    return "";
  }).filter(Boolean).join("\n");
}

function messageText(message: any): string {
  // Prefer server-precomputed text, but fall back to raw content parsing.
  // Also reparse from raw if the precomputed text looks like a pure tool-call placeholder.
  const precomputed: string = message?.text || "";
  if (precomputed && !/^(\[tool call: [^\]]+\]\n?)+$/.test(precomputed.trim())) {
    return precomputed;
  }
  return textFromRawContent(message?.raw?.content || message?.content) || "";
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
  currentSessionId = data.sessionId || currentSessionId;
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

function populateModelSelect(models: any[], activeKey: string) {
  modelSelectEl.textContent = "";
  for (const model of models) {
    if (!model) continue;
    const option = document.createElement("option");
    option.value = modelKey(model);
    option.textContent = modelLabel(model);
    modelSelectEl.append(option);
  }
  modelSelectEl.value = activeKey;
  if (!modelSelectEl.value && activeKey) {
    const option = document.createElement("option");
    option.value = activeKey;
    option.textContent = activeKey;
    modelSelectEl.prepend(option);
    modelSelectEl.value = activeKey;
  }
}

async function refreshModels() {
  const res = await fetch("/api/models", { headers: apiHeaders() });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  updateMeta({ cwd: data.cwd || "", model: data.current, thinkingLevel: data.thinkingLevel });
  populateModelSelect(data.models || [], currentModelKey);
  updateThinkingOptions(data.thinkingLevels || [currentThinkingLevel]);
}

async function refreshMessages() {
  const query = currentSessionId ? `?sessionId=${encodeURIComponent(currentSessionId)}` : "";
  const res = await fetch(`/api/messages${query}`, { headers: apiHeaders() });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  messagesEl.textContent = "";
  streamingAssistant = null;
  activeToolCards.clear();
  for (const message of data.messages || []) {
    if (message.role === "toolResult") {
      // Render tool result messages as collapsed history cards
      const toolName = message.toolName || message.raw?.toolName || message.name || "tool";
      const isError = Boolean(message.isError);
      const resultText = messageText(message);
      addToolHistoryCard(toolName, isError, resultText, message.toolArgs);
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "system";
    const text = messageText(message);
    // Skip assistant messages that are purely tool-call placeholders (no real text)
    if (!text) continue;
    const rawImages = role === "user" ? imagesFromRawContent(message.raw?.content || message.content) : [];
    addMessage(role, text, "", rawImages);
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
      titleRow.append(spinner);
    }

    const meta = document.createElement("span");
    meta.className = "sessionItemMeta";
    meta.textContent = `${formatSessionDate(item.modified)} · ${item.messageCount} message${item.messageCount === 1 ? "" : "s"}`;

    button.append(titleRow, meta);
    button.addEventListener("click", async () => {
      try {
        const openRes = await fetch("/api/sessions/open", {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify({ sessionId: item.id }),
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
    tokenOverlay.hidden = false;
    tokenInput.focus();
    return;
  }
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  updateMeta(data);
  isStreaming = Boolean(data.isStreaming);
  updatePrimaryAction();
  await Promise.all([refreshModels(), refreshMessages()]);
}

function toolSubtitle(toolName: string, args: Record<string, unknown>): string {
  if (!args) return "";
  // Prefer the most meaningful arg per tool
  const order = ["path", "command", "pattern", "query", "url"];
  for (const key of order) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  // Fall back to first string value
  for (const val of Object.values(args)) {
    if (typeof val === "string") return val;
  }
  return "";
}

function addToolHeader(card: HTMLDivElement, toolName: string, args?: Record<string, unknown>) {
  const header = document.createElement("div");
  header.className = "toolCardHeader";

  const statusIcon = document.createElement("span");
  statusIcon.className = "toolCardIcon";
  statusIcon.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "toolCardName";
  name.textContent = toolName;

  header.append(statusIcon, name);

  if (args) {
    const sub = toolSubtitle(toolName, args);
    if (sub) {
      const subtitle = document.createElement("span");
      subtitle.className = "toolCardSubtitle";
      subtitle.textContent = sub;
      header.append(subtitle);
    }
  }

  card.append(header);
}

interface EditHunk { oldText: string; newText: string; }
type DiffOp = "same" | "del" | "add";
interface LineDiff { op: DiffOp; oldLine?: string; newLine?: string; }

function asText(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value); }
function splitLines(text: unknown) {
  const value = asText(text);
  return value === "" ? [""] : value.split("\n");
}
function tokenize(text: unknown) {
  const value = asText(text);
  return value.match(/\s+|\w+|[^\s\w]+/g) || [""];
}
function normalizeEditHunks(edits: unknown): EditHunk[] {
  if (!Array.isArray(edits)) return [];
  return edits
    .filter((hunk): hunk is Record<string, unknown> => !!hunk && typeof hunk === "object")
    .map((hunk) => ({ oldText: asText(hunk.oldText), newText: asText(hunk.newText) }));
}

function lcsPairs<T>(a: T[], b: T[]) {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { pairs.push([i++, j++]); }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return pairs;
}

function lineDiff(oldText: unknown, newText: unknown): LineDiff[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const pairs = lcsPairs(oldLines, newLines);
  const out: LineDiff[] = [];
  let oi = 0, ni = 0;
  for (const [oldMatch, newMatch] of pairs) {
    while (oi < oldMatch || ni < newMatch) {
      if (oi < oldMatch && ni < newMatch) out.push({ op: "del", oldLine: oldLines[oi++] }, { op: "add", newLine: newLines[ni++] });
      else if (oi < oldMatch) out.push({ op: "del", oldLine: oldLines[oi++] });
      else out.push({ op: "add", newLine: newLines[ni++] });
    }
    out.push({ op: "same", oldLine: oldLines[oi++], newLine: newLines[ni++] });
  }
  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length) out.push({ op: "del", oldLine: oldLines[oi++] }, { op: "add", newLine: newLines[ni++] });
    else if (oi < oldLines.length) out.push({ op: "del", oldLine: oldLines[oi++] });
    else out.push({ op: "add", newLine: newLines[ni++] });
  }
  return out;
}

function appendWordDiff(cell: HTMLElement, oldLine: unknown, newLine: unknown, side: "old" | "new") {
  const oldTokens = tokenize(oldLine), newTokens = tokenize(newLine);
  const matches = new Set(lcsPairs(oldTokens, newTokens).map(([i, j]) => side === "old" ? i : j));
  const tokens = side === "old" ? oldTokens : newTokens;
  tokens.forEach((token, i) => {
    const span = document.createElement("span");
    span.textContent = token;
    if (!matches.has(i)) span.className = `diffWord diffWord--${side === "old" ? "del" : "add"}`;
    cell.append(span);
  });
}

function appendDiffLine(table: HTMLTableElement, op: DiffOp, oldLine = "", newLine = "") {
  const tr = document.createElement("tr");
  tr.className = `diffLine diffLine--${op}`;
  const oldGutter = document.createElement("td");
  oldGutter.className = "diffGutter";
  oldGutter.textContent = op === "add" ? "" : op === "same" ? " " : "-";
  const oldCell = document.createElement("td");
  oldCell.className = "diffCode diffCode--old";
  const newGutter = document.createElement("td");
  newGutter.className = "diffGutter";
  newGutter.textContent = op === "del" ? "" : op === "same" ? " " : "+";
  const newCell = document.createElement("td");
  newCell.className = "diffCode diffCode--new";
  if (op === "del") oldCell.textContent = oldLine;
  else if (op === "add") newCell.textContent = newLine;
  else { oldCell.textContent = oldLine; newCell.textContent = newLine; }
  tr.append(oldGutter, oldCell, newGutter, newCell);
  table.append(tr);
}

function renderEditDiff(card: HTMLDivElement, args: Record<string, unknown>) {
  const edits = normalizeEditHunks(args.edits);
  if (edits.length === 0) return;

  const toolbar = document.createElement("div");
  toolbar.className = "diffToolbar";
  const label = document.createElement("span");
  label.textContent = `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
  const layout = document.createElement("button");
  layout.type = "button";
  layout.className = "diffLayoutToggle";
  layout.setAttribute("aria-label", "Switch to top/bottom diff view");
  layout.title = "Switch to top/bottom diff view";
  layout.append(createElement(Rows2, { "aria-hidden": "true" }));
  toolbar.append(label, layout);

  const container = document.createElement("div");
  container.className = "diffContainer diffContainer--sideBySide";
  layout.addEventListener("click", () => {
    const stacked = container.classList.toggle("diffContainer--stacked");
    container.classList.toggle("diffContainer--sideBySide", !stacked);
    layout.replaceChildren(createElement(stacked ? Columns2 : Rows2, { "aria-hidden": "true" }));
    const label = stacked ? "Switch to side-by-side diff view" : "Switch to top/bottom diff view";
    layout.setAttribute("aria-label", label);
    layout.title = label;
  });

  edits.forEach((hunk, i) => {
    if (i > 0) {
      const sep = document.createElement("div");
      sep.className = "diffSep";
      container.append(sep);
    }
    const table = document.createElement("table");
    table.className = "diffTable";
    lineDiff(hunk.oldText, hunk.newText).forEach((line, index, lines) => {
      if (line.op === "del" && lines[index + 1]?.op === "add") {
        const add = lines[index + 1];
        const tr = document.createElement("tr");
        tr.className = "diffLine diffLine--changed";
        const oldGutter = document.createElement("td"); oldGutter.className = "diffGutter"; oldGutter.textContent = "-";
        const oldCell = document.createElement("td"); oldCell.className = "diffCode diffCode--old";
        const newGutter = document.createElement("td"); newGutter.className = "diffGutter"; newGutter.textContent = "+";
        const newCell = document.createElement("td"); newCell.className = "diffCode diffCode--new";
        appendWordDiff(oldCell, line.oldLine || "", add.newLine || "", "old");
        appendWordDiff(newCell, line.oldLine || "", add.newLine || "", "new");
        tr.append(oldGutter, oldCell, newGutter, newCell);
        table.append(tr);
      } else if (!(line.op === "add" && lines[index - 1]?.op === "del")) {
        appendDiffLine(table, line.op, line.oldLine, line.newLine);
      }
    });
    container.append(table);
  });

  const totalLines = edits.reduce((n, h) => n + splitLines(h.oldText).length + splitLines(h.newText).length, 0);
  const collapsible = totalLines > 20;
  if (collapsible) container.classList.add("collapsed");
  card.append(toolbar, container);

  if (collapsible) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "messageToggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      const isCollapsed = container.classList.toggle("collapsed");
      toggle.textContent = isCollapsed ? "Show more" : "Show less";
    });
    card.append(toggle);
  }
}

function addToolCard(toolName: string, args: Record<string, unknown>): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "toolCard toolCard--running";
  addToolHeader(card, toolName, args);
  if (toolName === "edit") renderEditDiff(card, args);
  // Store toolName for updateToolCard
  card.dataset.toolName = toolName;
  messagesEl.append(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return card;
}

function highlightToolResult(pre: HTMLPreElement, text: string) {
  const code = document.createElement("code");
  code.classList.add("hljs");
  const result = hljs.highlightAuto(text);
  code.innerHTML = result.value;
  pre.append(code);
}

function addToolResultBody(card: HTMLDivElement, result: string) {
  const truncated = result.length > 2000 ? result.slice(0, 2000) + "\n…" : result;
  const collapsible = shouldCollapseToolResult(truncated);
  const body = document.createElement("pre");
  body.className = `toolCardBody${collapsible ? " collapsed" : ""}`;
  highlightToolResult(body, truncated);
  card.append(body);
  if (collapsible) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "messageToggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      const isCollapsed = body.classList.toggle("collapsed");
      toggle.textContent = isCollapsed ? "Show more" : "Show less";
    });
    card.append(toggle);
  }
}

function shouldCollapseToolResult(text: string) {
  return text.length > 600 || text.split("\n").length > 10;
}

function textFromToolResult(result: unknown): string {
  if (typeof result === "string") {
    const trimmed = result.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        const text = textFromToolResult(parsed);
        if (text) return text;
      } catch {
        // Plain text that only looks like JSON; render it as-is.
      }
    }
    return result;
  }

  if (!result || typeof result !== "object") return result == null ? "" : String(result);
  const value = result as Record<string, unknown>;
  return textFromRawContent(value.content) || textFromRawContent(value.raw) || JSON.stringify(result, null, 2);
}

function updateToolCard(card: HTMLDivElement, toolName: string, isError: boolean, result?: unknown) {
  card.classList.remove("toolCard--running");
  card.classList.add(isError ? "toolCard--error" : "toolCard--success");

  // Remove badge and args details — icon + background convey the state
  card.querySelector(".toolCardBadge")?.remove();
  card.querySelector(".toolCardDetails")?.remove();

  const resultStr = textFromToolResult(result);
  // For edit tool, diff is already shown; just show error result if any
  if (resultStr && (isError || card.dataset.toolName !== "edit")) addToolResultBody(card, resultStr);

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addToolHistoryCard(toolName: string, isError: boolean, result: string, args?: Record<string, unknown>) {
  const card = document.createElement("div");
  card.className = `toolCard ${isError ? "toolCard--error" : "toolCard--success"}`;
  addToolHeader(card, toolName, args);
  if (toolName === "edit" && args) renderEditDiff(card, args);
  else if (result) addToolResultBody(card, result);
  messagesEl.append(card);
}

function handlePiEvent(event: PiEvent) {
  switch (event.type) {
    case "agent_start":
      isStreaming = true;
      updatePrimaryAction();
      streamingAssistant = null;
      break;
    case "message_update": {
      const deltaEvent = event.assistantMessageEvent;
      if (deltaEvent?.type === "text_delta") {
        // Text after a tool result belongs in a new assistant segment. Otherwise all
        // deltas keep appending to the first assistant bubble, so live rendering loses
        // the same interleaving that static history gets from the saved message parts.
        if (!streamingAssistant || messagesEl.lastElementChild !== streamingAssistant) {
          streamingAssistant = addMessage("assistant", "");
        }
        const body = streamingAssistant.querySelector<HTMLElement>(".body");
        if (body) body.textContent += deltaEvent.delta || "";
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      break;
    }
    case "tool_execution_start": {
      const cardKey = event.toolCallId || event.toolName;
      const card = addToolCard(event.toolName, event.args || {});
      activeToolCards.set(cardKey, card);
      break;
    }
    case "tool_execution_end": {
      const cardKey = event.toolCallId || event.toolName;
      const card = activeToolCards.get(cardKey);
      if (card) {
        updateToolCard(card, event.toolName, Boolean(event.isError), event.result);
        activeToolCards.delete(cardKey);
      }
      break;
    }
    case "agent_end":
      isStreaming = false;
      updatePrimaryAction();
      streamingAssistant = null;
      activeToolCards.clear();
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
    if (data.type === "session_runtime_changed") {
      if (!sessionDrawer.hidden) refreshSessions().catch(() => undefined);
      return;
    }
    if (data.type === "models_updated") {
      populateModelSelect(data.models || [], currentModelKey);
      return;
    }
    if (data.type === "pi_event") {
      if (!sessionDrawer.hidden) refreshSessions().catch(() => undefined);
      if (!data.sessionId || data.sessionId === currentSessionId) handlePiEvent(data.event);
      return;
    }
    if (data.type === "server_error" && (!data.sessionId || data.sessionId === currentSessionId)) addMessage("system", data.error, "error");
  });
  ws.addEventListener("close", () => {
    addMessage("system", "Disconnected. Reconnecting…");
    setTimeout(connect, 1500);
  });
}

async function runSlashCommand(command: string) {
  const name = command.trim().replace(/^\/+/, "").split(/\s+/, 1)[0]?.toLowerCase();
  if (name === "logout") {
    token = "";
    localStorage.removeItem("pi-web-token");
    tokenInput.value = "";
    tokenOverlay.hidden = false;
    tokenInput.focus();
    return;
  }
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
  if (name === "new" || name === "new-chat" || name === "clear") await refreshMessages();
  if (data.message) addMessage("system", data.message);
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isStreaming && !promptEl.value.trim() && attachedImages.length === 0) return;

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
  addMessage("user", message || "", "", images.map((img) => ({ data: img.data, mimeType: img.mimeType })));

  try {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ sessionId: currentSessionId, message, mode: queueMode, images }),
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

stopButton.addEventListener("click", async () => {
  await fetch("/api/abort", { method: "POST", headers: apiHeaders(), body: JSON.stringify({ sessionId: currentSessionId }) });
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

tokenForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const val = tokenInput.value.trim();
  if (!val) return;
  token = val;
  localStorage.setItem("pi-web-token", token);
  tokenOverlay.hidden = true;
  refreshState().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
});

setIcon(sessionButton, "menu");
setIcon(attachButton, "paperclip");
setIcon(primaryButton, "send-horizontal");
setIcon(stopButton, "square");
updateQueueToggle();
updatePrimaryAction();
refreshState().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
connect();
