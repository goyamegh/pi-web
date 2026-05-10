import type { ApiHeaders } from "../app/api.js";
import type { AttachedImage, Role } from "../app/types.js";
import { attachImageActions } from "../components/imageActions.js";
import type { MarkdownRenderer } from "../markdown/render.js";
import { imageFileName, imagesFromRawContent, messageText, shouldCollapseMessage, stripImagePathNote } from "./content.js";

export type AddToolHistoryCard = (toolName: string, isError: boolean, result: string, args?: Record<string, unknown>) => void;
export type AddRuntimeErrorCard = (title: string, subtitle: string, body: string) => void;

export type MessageList = {
  addMessage: (role: Role, text: string, extraClass?: string, images?: AttachedImage[]) => HTMLDivElement;
  appendStreamingDelta: (delta: string) => void;
  clear: () => void;
  refreshMessages: (options: {
    sessionId: string;
    headers: ApiHeaders;
    addToolHistoryCard: AddToolHistoryCard;
    addRuntimeErrorCard: AddRuntimeErrorCard;
    clearActiveToolCards: () => void;
    updateEmptyCwdChooser?: () => void;
  }) => Promise<void>;
  resetStreamingAssistant: () => void;
  scrollToBottom: () => void;
};

function appendAttachedImage(container: HTMLElement, img: AttachedImage) {
  if (img.data && img.mimeType) {
    const el = document.createElement("img");
    el.className = "messageImageThumb";
    el.src = `data:${img.mimeType};base64,${img.data}`;
    el.alt = imageFileName(img.path);
    container.append(el);
    attachImageActions(el);
    return;
  }

  const missing = document.createElement("span");
  missing.className = "messageImageMissing";
  missing.title = img.path || "unknown path";
  missing.textContent = `🖼️ ${imageFileName(img.path, "missing image")}`;
  container.append(missing);
}

export function createMessageList(options: { messagesEl: HTMLDivElement; markdown: MarkdownRenderer }): MessageList {
  const { messagesEl, markdown } = options;
  let streamingAssistant: HTMLDivElement | null = null;

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(role: Role, text: string, extraClass = "", images: AttachedImage[] = []) {
    const div = document.createElement("div");
    const collapsible = shouldCollapseMessage(text);
    div.className = `message ${role} ${extraClass}${collapsible ? " collapsible collapsed" : ""}`.trim();
    const body = document.createElement("div");
    body.className = "body";

    if (role === "user" && images.length > 0) {
      const cleanText = stripImagePathNote(text);
      if (cleanText) {
        const textNode = document.createElement("span");
        textNode.className = "messageText";
        textNode.textContent = cleanText;
        body.append(textNode);
      }

      const imgWrap = document.createElement("div");
      imgWrap.className = "messageImages";
      for (const img of images) appendAttachedImage(imgWrap, img);
      body.append(imgWrap);
    } else if (role === "assistant" && text) {
      body.textContent = text;
      if (collapsible) markdown.queueAssistantMarkdownRender(body, text);
      else markdown.renderAssistantMarkdown(body, text);
    } else {
      body.textContent = text || "";
    }

    div.append(body);

    if (collapsible) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "messageToggle";
      toggle.textContent = "Show more";
      toggle.addEventListener("click", () => {
        const collapsed = div.classList.toggle("collapsed");
        if (!collapsed && role === "assistant" && text && !body.dataset.markdownRendered) {
          markdown.unobserve(body);
          markdown.renderAssistantMarkdown(body, text);
        }
        toggle.textContent = collapsed ? "Show more" : "Show less";
      });
      div.append(toggle);
    }

    messagesEl.append(div);
    scrollToBottom();
    return div;
  }

  function clear() {
    messagesEl.textContent = "";
    streamingAssistant = null;
  }

  function resetStreamingAssistant() {
    streamingAssistant = null;
  }

  function appendStreamingDelta(delta: string) {
    // Text after a tool result belongs in a new assistant segment. Otherwise all
    // deltas keep appending to the first assistant bubble, so live rendering loses
    // the same interleaving that static history gets from the saved message parts.
    if (!streamingAssistant || messagesEl.lastElementChild !== streamingAssistant) {
      streamingAssistant = addMessage("assistant", "");
    }
    const body = streamingAssistant.querySelector<HTMLElement>(".body");
    if (body) body.textContent += delta || "";
    scrollToBottom();
  }

  async function refreshMessages({ sessionId, headers, addToolHistoryCard, addRuntimeErrorCard, clearActiveToolCards, updateEmptyCwdChooser }: {
    sessionId: string;
    headers: ApiHeaders;
    addToolHistoryCard: AddToolHistoryCard;
    addRuntimeErrorCard: AddRuntimeErrorCard;
    clearActiveToolCards: () => void;
    updateEmptyCwdChooser?: () => void;
  }) {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const res = await fetch(`/api/messages${query}`, { headers: headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    clear();
    clearActiveToolCards();
    for (const message of data.messages || []) {
      if (message.role === "toolResult") {
        const toolName = message.toolName || message.raw?.toolName || message.name || "tool";
        const isError = Boolean(message.isError);
        const resultText = messageText(message);
        addToolHistoryCard(toolName, isError, resultText, message.toolArgs);
        continue;
      }
      const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "system";
      const text = messageText(message);
      if (!text) continue;
      if (role === "assistant" && message.isError) {
        const rawError = typeof message.raw?.errorMessage === "string" ? message.raw.errorMessage : typeof message.errorMessage === "string" ? message.errorMessage : text;
        addRuntimeErrorCard("assistant error", text, rawError);
        continue;
      }
      const rawImages = role === "user" ? imagesFromRawContent(message.raw?.content || message.content) : [];
      addMessage(role, text, message.isError ? "error" : "", rawImages);
    }
    updateEmptyCwdChooser?.();
  }

  return {
    addMessage,
    appendStreamingDelta,
    clear,
    refreshMessages,
    resetStreamingAssistant,
    scrollToBottom,
  };
}
