import hljs from "highlight.js/lib/common";
import { renderEditDiff } from "../components/editDiff.js";
import { textFromRawContent } from "../messages/content.js";

export type ToolCards = {
  addToolCard: (toolName: string, args: Record<string, unknown>) => HTMLDivElement;
  updateToolCard: (card: HTMLDivElement, toolName: string, isError: boolean, result?: unknown) => void;
  addToolHistoryCard: (toolName: string, isError: boolean, result: string, args?: Record<string, unknown>) => void;
  startTool: (toolCallId: string | undefined, toolName: string, args: Record<string, unknown>) => void;
  endTool: (toolCallId: string | undefined, toolName: string, isError: boolean, result?: unknown) => void;
  clearActiveToolCards: () => void;
};

function toolSubtitle(toolName: string, args: Record<string, unknown>): string {
  if (!args) return "";
  const order = ["path", "command", "pattern", "query", "url"];
  for (const key of order) {
    if (typeof args[key] === "string") return args[key] as string;
  }
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

  const label = document.createElement("span");
  label.className = "toolCardLabel";

  const name = document.createElement("span");
  name.className = "toolCardName";
  name.textContent = toolName;
  label.append(name);

  if (args) {
    const sub = toolSubtitle(toolName, args);
    if (sub) {
      const subtitle = document.createElement("span");
      subtitle.className = "toolCardSubtitle";
      subtitle.textContent = sub;
      label.append(subtitle);
      label.addEventListener("click", () => label.classList.toggle("expanded"));
    }
  }

  header.append(statusIcon, label);
  card.append(header);
}

function highlightToolResult(pre: HTMLPreElement, text: string) {
  const code = document.createElement("code");
  code.classList.add("hljs");
  const result = hljs.highlightAuto(text);
  code.innerHTML = result.value;
  pre.append(code);
}

function shouldCollapseToolResult(text: string) {
  return text.length > 600 || text.split("\n").length > 10;
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
    toggle.className = "toolCardCollapseToggle";
    const setCollapsed = (collapsed: boolean) => {
      body.classList.toggle("collapsed", collapsed);
      toggle.textContent = collapsed ? "▾" : "▴";
      toggle.setAttribute("aria-label", collapsed ? "Show more" : "Show less");
      toggle.title = collapsed ? "Show more" : "Show less";
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

export function createToolCards(messagesEl: HTMLDivElement): ToolCards {
  const activeToolCards = new Map<string, HTMLDivElement>();

  function addToolCard(toolName: string, args: Record<string, unknown>): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "toolCard toolCard--running";
    addToolHeader(card, toolName, args);
    if (toolName === "edit") renderEditDiff(card, args);
    card.dataset.toolName = toolName;
    messagesEl.append(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return card;
  }

  function updateToolCard(card: HTMLDivElement, toolName: string, isError: boolean, result?: unknown) {
    card.classList.remove("toolCard--running");
    card.classList.add(isError ? "toolCard--error" : "toolCard--success");

    card.querySelector(".toolCardBadge")?.remove();
    card.querySelector(".toolCardDetails")?.remove();

    const resultStr = textFromToolResult(result);
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

  function startTool(toolCallId: string | undefined, toolName: string, args: Record<string, unknown>) {
    const cardKey = toolCallId || toolName;
    const card = addToolCard(toolName, args);
    activeToolCards.set(cardKey, card);
  }

  function endTool(toolCallId: string | undefined, toolName: string, isError: boolean, result?: unknown) {
    const cardKey = toolCallId || toolName;
    const card = activeToolCards.get(cardKey);
    if (!card) return;
    updateToolCard(card, toolName, isError, result);
    activeToolCards.delete(cardKey);
  }

  return {
    addToolCard,
    updateToolCard,
    addToolHistoryCard,
    startTool,
    endTool,
    clearActiveToolCards() {
      activeToolCards.clear();
    },
  };
}
