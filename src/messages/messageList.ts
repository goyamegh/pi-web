import type { ApiHeaders } from "../app/api.js";
import type { AttachedImage, Role } from "../app/types.js";
import { attachImageActions } from "../components/imageActions.js";
import type { MarkdownRenderer } from "../markdown/render.js";
import { imageFileName, imagesFromRawContent, messageText, shouldCollapseMessage, stripImagePathNote } from "./content.js";

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
  startStreamingThinking: (contentIndex?: number | string) => void;
  appendStreamingThinkingDelta: (delta: string, contentIndex?: number | string) => void;
  endStreamingThinking: (content?: string, contentIndex?: number | string) => void;
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

function rawContent(message: any) {
  return message?.raw?.content ?? message?.content;
}

function partText(part: unknown) {
  if (!part || typeof part !== "object") return "";
  const value = part as Record<string, unknown>;
  return value.type === "text" && typeof value.text === "string" ? value.text : "";
}

function partThinkingText(part: unknown) {
  if (!part || typeof part !== "object") return "";
  const value = part as Record<string, unknown>;
  if (value.type !== "thinking") return "";
  if (typeof value.thinking === "string") return value.thinking.trim();
  if (typeof value.text === "string") return value.text.trim();
  if (typeof value.content === "string") return value.content.trim();
  return "";
}

function toolCallFromPart(part: unknown): ToolCallSummary | undefined {
  if (!part || typeof part !== "object") return undefined;
  const value = part as Record<string, unknown>;
  if (value.type !== "toolCall") return undefined;
  const args = value.arguments && typeof value.arguments === "object"
    ? value.arguments as Record<string, unknown>
    : value.args && typeof value.args === "object"
      ? value.args as Record<string, unknown>
      : {};
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    toolName: typeof value.toolName === "string" ? value.toolName : typeof value.name === "string" ? value.name : "tool",
    args,
  };
}

export function createMessageList(options: { messagesEl: HTMLDivElement; markdown: MarkdownRenderer }): MessageList {
  const { messagesEl, markdown } = options;
  let streamingAssistant: HTMLDivElement | null = null;
  const streamingThinkingCards = new Map<string, HTMLDivElement>();
  let currentStreamingThinkingKey = "current";
  let isStreaming = false;
  let shouldFollowStream = true;
  let programmaticScroll = false;
  let userScrollIntent = false;
  let refreshSerial = 0;
  let mutationSerial = 0;
  let applyingRefresh = false;
  const bottomThreshold = 48;
  const resumeBottomThreshold = 4;

  const jumpButton = document.createElement("button");
  jumpButton.type = "button";
  jumpButton.className = "jumpToLatestButton";
  jumpButton.textContent = "Jump to latest";
  jumpButton.setAttribute("aria-label", "Jump to latest message");
  jumpButton.hidden = true;
  document.querySelector(".app")?.append(jumpButton);

  function invalidatePendingRefreshes() {
    if (!applyingRefresh) mutationSerial++;
  }

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
    invalidatePendingRefreshes();
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
    invalidatePendingRefreshes();
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

  function thinkingWordCount(text: string) {
    return text.split(/\s+/).filter(Boolean).length;
  }

  function updateThinkingCardText(card: HTMLDivElement, text: string, streaming = false) {
    const body = card.querySelector<HTMLElement>(".toolCardBody");
    const subtitle = card.querySelector<HTMLElement>(".toolCardSubtitle");
    if (body) {
      body.textContent = text;
      if (!streaming && (text.length > 1200 || text.split("\n").length > 16)) body.classList.add("collapsed");
    }
    if (subtitle) {
      const words = thinkingWordCount(text);
      subtitle.textContent = streaming
        ? words > 0 ? `${words.toLocaleString()} words · streaming` : "streaming"
        : `${words.toLocaleString()} words`;
    }
  }

  function addThinkingCard(text: string, streaming = false) {
    invalidatePendingRefreshes();
    const card = document.createElement("div");
    card.className = `toolCard toolCard--thinking${streaming ? " toolCard--thinkingStreaming" : ""}`;

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

    label.append(name, subtitle);
    header.append(icon, label);

    const body = document.createElement("pre");
    body.className = `toolCardBody${!streaming && (text.length > 1200 || text.split("\n").length > 16) ? " collapsed" : ""}`;

    card.append(header, body);
    updateThinkingCardText(card, text, streaming);

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
    scrollToBottom();
    return card;
  }

  function clearInternal(invalidate = true) {
    if (invalidate) invalidatePendingRefreshes();
    messagesEl.textContent = "";
    streamingAssistant = null;
    streamingThinkingCards.clear();
    currentStreamingThinkingKey = "current";
    setJumpButtonVisible(false);
  }

  function clear() {
    clearInternal(true);
  }

  function resetStreamingAssistant() {
    streamingAssistant = null;
    streamingThinkingCards.clear();
    currentStreamingThinkingKey = "current";
  }

  function appendStreamingDelta(delta: string) {
    invalidatePendingRefreshes();
    // Text after a tool result/thinking card belongs in a new assistant segment.
    // Otherwise all deltas keep appending to the first assistant bubble, so live
    // rendering loses the same interleaving that static history gets from parts.
    if (!streamingAssistant || messagesEl.lastElementChild !== streamingAssistant) {
      streamingAssistant = addMessage("assistant", "");
    }
    const body = streamingAssistant.querySelector<HTMLElement>(".body");
    if (body) body.textContent += delta || "";
    scrollToBottom();
  }

  function thinkingKey(contentIndex?: number | string) {
    return contentIndex === undefined || contentIndex === null ? currentStreamingThinkingKey : String(contentIndex);
  }

  function startStreamingThinking(contentIndex?: number | string) {
    invalidatePendingRefreshes();
    const key = thinkingKey(contentIndex);
    currentStreamingThinkingKey = key;
    if (!streamingThinkingCards.get(key)?.isConnected) {
      streamingAssistant = null;
      streamingThinkingCards.set(key, addThinkingCard("", true));
    }
  }

  function appendStreamingThinkingDelta(delta: string, contentIndex?: number | string) {
    invalidatePendingRefreshes();
    const key = thinkingKey(contentIndex);
    currentStreamingThinkingKey = key;
    let card = streamingThinkingCards.get(key);
    if (!card?.isConnected) {
      streamingAssistant = null;
      card = addThinkingCard("", true);
      streamingThinkingCards.set(key, card);
    }
    const body = card.querySelector<HTMLElement>(".toolCardBody");
    updateThinkingCardText(card, `${body?.textContent || ""}${delta || ""}`, true);
    scrollToBottom();
  }

  function endStreamingThinking(content?: string, contentIndex?: number | string) {
    invalidatePendingRefreshes();
    const key = thinkingKey(contentIndex);
    const card = streamingThinkingCards.get(key);
    if (!card?.isConnected) return;
    card.classList.remove("toolCard--thinkingStreaming");
    if (typeof content === "string") updateThinkingCardText(card, content, false);
    else updateThinkingCardText(card, card.querySelector<HTMLElement>(".toolCardBody")?.textContent || "", false);
    streamingThinkingCards.delete(key);
    streamingAssistant = null;
    scrollToBottom();
  }

  function renderToolResultMessage(message: any, addToolHistoryCard: AddToolHistoryCard, argsOverride?: Record<string, unknown>) {
    const toolName = message.toolName || message.raw?.toolName || message.name || "tool";
    const isError = Boolean(message.isError);
    const resultText = messageText(message);
    addToolHistoryCard(toolName, isError, resultText, argsOverride || message.toolArgs);
  }

  function renderAssistantMessageParts(message: any, options: {
    addToolHistoryCard: AddToolHistoryCard;
    addPendingToolCard: AddPendingToolCard;
    addRuntimeErrorCard: AddRuntimeErrorCard;
    completedToolResults: Map<string, any>;
    renderedToolResultIds: Set<string>;
    isStreaming?: boolean;
  }) {
    const { addToolHistoryCard, addPendingToolCard, addRuntimeErrorCard, completedToolResults, renderedToolResultIds, isStreaming } = options;
    const content = rawContent(message);
    const text = messageText(message);

    if (message.isError) {
      const rawError = typeof message.raw?.errorMessage === "string" ? message.raw.errorMessage : typeof message.errorMessage === "string" ? message.errorMessage : text;
      addRuntimeErrorCard("assistant error", text, rawError);
      return;
    }

    if (!Array.isArray(content)) {
      if (text) addMessage("assistant", text, message.isError ? "error" : "");
      return;
    }

    const textParts = content.map(partText).filter(Boolean);
    const textPartsJoined = textParts.join("\n");
    let renderedAnyPart = false;
    for (const part of content) {
      const thinking = partThinkingText(part);
      if (thinking) {
        addThinkingCard(thinking);
        renderedAnyPart = true;
        continue;
      }

      const textPart = partText(part);
      if (textPart) {
        addMessage("assistant", textPart);
        renderedAnyPart = true;
        continue;
      }

      const call = toolCallFromPart(part);
      if (call) {
        renderedAnyPart = true;
        const result = call.id ? completedToolResults.get(call.id) : undefined;
        if (result) {
          renderToolResultMessage(result, addToolHistoryCard, call.args);
          renderedToolResultIds.add(call.id || "");
        } else if (isStreaming) {
          addPendingToolCard(call.id, call.toolName, call.args);
        }
      }
    }

    // If the server supplied text that did not correspond to individual text
    // parts (for example a stop-reason summary), keep it visible without
    // duplicating normal assistant text parts.
    if (!renderedAnyPart && text) addMessage("assistant", text, message.isError ? "error" : "");
    else if (text && textPartsJoined && text !== textPartsJoined && text.startsWith(textPartsJoined)) {
      const suffix = text.slice(textPartsJoined.length).trim();
      if (suffix) addMessage("assistant", suffix, message.isError ? "error" : "");
    }
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
    const refreshId = ++refreshSerial;
    const mutationAtStart = mutationSerial;
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const res = await fetch(`/api/messages${query}`, { headers: headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (refreshId !== refreshSerial || mutationAtStart !== mutationSerial) return;

    const wasFollowing = shouldFollowStream;
    const previousScrollTop = messagesEl.scrollTop;
    applyingRefresh = true;
    try {
      clearInternal(false);
      clearActiveToolCards();
      const allMessages = data.messages || [];
      const completedToolResults = new Map<string, any>();
      const renderedToolResultIds = new Set<string>();
      for (const message of allMessages) {
        const id = message?.toolCallId || message?.raw?.toolCallId;
        if (message?.role === "toolResult" && typeof id === "string") completedToolResults.set(id, message);
      }
      for (const message of allMessages) {
        const id = message?.toolCallId || message?.raw?.toolCallId;
        if (message.role === "toolResult") {
          if (typeof id === "string" && renderedToolResultIds.has(id)) continue;
          renderToolResultMessage(message, addToolHistoryCard);
          continue;
        }

        const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "system";
        if (role === "assistant") {
          renderAssistantMessageParts(message, { addToolHistoryCard, addPendingToolCard, addRuntimeErrorCard, completedToolResults, renderedToolResultIds, isStreaming });
          continue;
        }

        const text = messageText(message);
        if (text) {
          const rawImages = role === "user" ? imagesFromRawContent(rawContent(message)) : [];
          const extraClass = message.role === "compactionSummary" ? "compaction" : message.isError ? "error" : "";
          addMessage(role, text, extraClass, rawImages);
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
    } finally {
      applyingRefresh = false;
    }
  }

  return {
    addMessage,
    appendStreamingDelta,
    appendStreamingThinkingDelta,
    beginStreamFollow,
    clear,
    endStreamFollow,
    endStreamingThinking,
    refreshMessages,
    resetStreamingAssistant,
    scrollToBottom,
    startStreamingThinking,
  };
}
