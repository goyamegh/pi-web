import type { ApiHeaders } from "../app/api.js";
import type { AttachedImage, Role } from "../app/types.js";
import { attachImageActions } from "../components/imageActions.js";
import type { MarkdownRenderer } from "../markdown/render.js";
import { imageFileName, imagesFromRawContent, messageText, shouldCollapseMessage, stripImagePathNote, thinkingFromRawContent } from "./content.js";

export type AddToolHistoryCard = (toolName: string, isError: boolean, result: string, args?: Record<string, unknown>) => void;
export type AddPendingToolCard = (toolCallId: string | undefined, toolName: string, args: Record<string, unknown>) => void;
export type AddRuntimeErrorCard = (title: string, subtitle: string, body: string) => void;

type ToolCallSummary = {
  id?: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type MessageList = {
  addMessage: (role: Role, text: string, extraClass?: string, images?: AttachedImage[]) => HTMLDivElement;
  appendStreamingDelta: (delta: string) => void;
  clear: () => void;
  beginStreamFollow: () => void;
  endStreamFollow: () => void;
  refreshMessages: (options: {
    sessionId: string;
    headers: ApiHeaders;
    addToolHistoryCard: AddToolHistoryCard;
    addPendingToolCard: AddPendingToolCard;
    addRuntimeErrorCard: AddRuntimeErrorCard;
    clearActiveToolCards: () => void;
    isStreaming?: boolean;
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
  let isStreaming = false;
  let shouldFollowStream = true;
  let programmaticScroll = false;
  let userScrollIntent = false;
  const bottomThreshold = 48;
  const resumeBottomThreshold = 4;

  const jumpButton = document.createElement("button");
  jumpButton.type = "button";
  jumpButton.className = "jumpToLatestButton";
  jumpButton.textContent = "Jump to latest";
  jumpButton.setAttribute("aria-label", "Jump to latest message");
  jumpButton.hidden = true;
  document.querySelector(".app")?.append(jumpButton);

  function distanceFromBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  }

  function isNearBottom() {
    return distanceFromBottom() <= bottomThreshold;
  }

  function isAtBottom() {
    return distanceFromBottom() <= resumeBottomThreshold;
  }

  function setJumpButtonVisible(visible: boolean) {
    jumpButton.hidden = !visible;
  }

  function forceScrollToBottom() {
    programmaticScroll = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    window.setTimeout(() => {
      programmaticScroll = false;
    }, 0);
  }

  function scrollToBottom() {
    if (!shouldFollowStream) {
      setJumpButtonVisible(true);
      return;
    }
    forceScrollToBottom();
    setJumpButtonVisible(false);
  }

  function beginStreamFollow() {
    isStreaming = true;
    shouldFollowStream = true;
    userScrollIntent = false;
    forceScrollToBottom();
    setJumpButtonVisible(false);
  }

  function endStreamFollow() {
    isStreaming = false;
  }

  function pauseStreamFollow() {
    if (programmaticScroll) return;
    userScrollIntent = true;
    if (!isStreaming) return;
    shouldFollowStream = false;
    setJumpButtonVisible(true);
  }

  messagesEl.addEventListener("wheel", pauseStreamFollow, { passive: true });
  messagesEl.addEventListener("touchstart", pauseStreamFollow, { passive: true });
  messagesEl.addEventListener("pointerdown", pauseStreamFollow);
  messagesEl.addEventListener("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) pauseStreamFollow();
  });
  messagesEl.addEventListener("scroll", () => {
    if (programmaticScroll) return;
    if (shouldFollowStream && !isNearBottom()) {
      shouldFollowStream = false;
      setJumpButtonVisible(isStreaming);
      return;
    }
    if (!shouldFollowStream && isAtBottom()) {
      shouldFollowStream = true;
      userScrollIntent = false;
      setJumpButtonVisible(false);
    }
  }, { passive: true });
  jumpButton.addEventListener("click", () => {
    shouldFollowStream = true;
    userScrollIntent = false;
    forceScrollToBottom();
    setJumpButtonVisible(false);
  });

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

  function addThinkingCard(text: string) {
    const card = document.createElement("div");
    card.className = "toolCard toolCard--thinking";

    const header = document.createElement("div");
    header.className = "toolCardHeader";

    const icon = document.createElement("span");
    icon.className = "toolCardIcon";
    icon.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "toolCardLabel";

    const name = document.createElement("span");
    name.className = "toolCardName";
    name.textContent = "thinking";

    const subtitle = document.createElement("span");
    subtitle.className = "toolCardSubtitle";
    subtitle.textContent = `${text.split(/\s+/).filter(Boolean).length.toLocaleString()} words`;

    label.append(name, subtitle);
    header.append(icon, label);

    const body = document.createElement("pre");
    body.className = `toolCardBody${text.length > 1200 || text.split("\n").length > 16 ? " collapsed" : ""}`;
    body.textContent = text;

    card.append(header, body);

    if (body.classList.contains("collapsed")) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "toolCardCollapseToggle";
      const setCollapsed = (collapsed: boolean) => {
        body.classList.toggle("collapsed", collapsed);
        toggle.textContent = collapsed ? "▾" : "▴";
        toggle.setAttribute("aria-label", collapsed ? "Show thinking" : "Hide thinking");
        toggle.title = collapsed ? "Show thinking" : "Hide thinking";
        toggle.setAttribute("aria-expanded", String(!collapsed));
      };
      setCollapsed(true);
      body.addEventListener("click", () => setCollapsed(!body.classList.contains("collapsed")));
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        setCollapsed(!body.classList.contains("collapsed"));
      });
      card.append(toggle);
    }

    messagesEl.append(card);
  }

  function clear() {
    messagesEl.textContent = "";
    streamingAssistant = null;
    setJumpButtonVisible(false);
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

  function messageToolCalls(message: any): ToolCallSummary[] {
    const calls = Array.isArray(message?.toolCalls)
      ? message.toolCalls
      : Array.isArray(message?.raw?.content)
        ? message.raw.content.filter((part: any) => part?.type === "toolCall").map((part: any) => ({
          id: part.id,
          toolName: part.toolName || part.name || "tool",
          args: part.arguments || part.args || {},
        }))
        : [];

    return calls.map((call: any) => ({
      id: typeof call.id === "string" ? call.id : undefined,
      toolName: typeof call.toolName === "string" ? call.toolName : typeof call.name === "string" ? call.name : "tool",
      args: call.args && typeof call.args === "object" ? call.args : {},
    }));
  }

  async function refreshMessages({ sessionId, headers, addToolHistoryCard, addPendingToolCard, addRuntimeErrorCard, clearActiveToolCards, isStreaming, updateEmptyCwdChooser }: {
    sessionId: string;
    headers: ApiHeaders;
    addToolHistoryCard: AddToolHistoryCard;
    addPendingToolCard: AddPendingToolCard;
    addRuntimeErrorCard: AddRuntimeErrorCard;
    clearActiveToolCards: () => void;
    isStreaming?: boolean;
    updateEmptyCwdChooser?: () => void;
  }) {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const res = await fetch(`/api/messages${query}`, { headers: headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const wasFollowing = shouldFollowStream;
    const previousScrollTop = messagesEl.scrollTop;
    clear();
    clearActiveToolCards();
    const allMessages = data.messages || [];
    const completedToolCallIds = new Set<string>();
    for (const message of allMessages) {
      const id = message?.toolCallId || message?.raw?.toolCallId;
      if (message?.role === "toolResult" && typeof id === "string") completedToolCallIds.add(id);
    }
    for (const message of allMessages) {
      if (message.role === "toolResult") {
        const toolName = message.toolName || message.raw?.toolName || message.name || "tool";
        const isError = Boolean(message.isError);
        const resultText = messageText(message);
        addToolHistoryCard(toolName, isError, resultText, message.toolArgs);
        continue;
      }
      const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "system";
      if (role === "assistant") {
        for (const thinking of thinkingFromRawContent(message.raw?.content || message.content)) addThinkingCard(thinking);
      }
      const text = messageText(message);
      if (text) {
        if (role === "assistant" && message.isError) {
          const rawError = typeof message.raw?.errorMessage === "string" ? message.raw.errorMessage : typeof message.errorMessage === "string" ? message.errorMessage : text;
          addRuntimeErrorCard("assistant error", text, rawError);
          continue;
        }
        const rawImages = role === "user" ? imagesFromRawContent(message.raw?.content || message.content) : [];
        const extraClass = message.role === "compactionSummary" ? "compaction" : message.isError ? "error" : "";
        addMessage(role, text, extraClass, rawImages);
      }
      if (role === "assistant" && isStreaming) {
        for (const call of messageToolCalls(message)) {
          if (call.id && completedToolCallIds.has(call.id)) continue;
          addPendingToolCard(call.id, call.toolName, call.args);
        }
      }
    }
    if (wasFollowing) scrollToBottom();
    else {
      programmaticScroll = true;
      messagesEl.scrollTop = previousScrollTop;
      window.setTimeout(() => {
        programmaticScroll = false;
      }, 0);
      setJumpButtonVisible(true);
    }
    updateEmptyCwdChooser?.();
  }

  return {
    addMessage,
    appendStreamingDelta,
    beginStreamFollow,
    clear,
    endStreamFollow,
    refreshMessages,
    resetStreamingAssistant,
    scrollToBottom,
  };
}
