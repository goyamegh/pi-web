import type { CCContentBlock, CCMessage, CCTranscriptEntry } from "./types.js";

/**
 * Convert a Claude Code on-disk or live message into the pi-shaped message
 * format that pi-web's frontend (src/messages/, src/tools/) renders. The
 * frontend treats messages as a flat list of three role types:
 *
 *   - user:        { role: "user", content: <string|blocks>, timestamp }
 *   - assistant:   { role: "assistant", content: <text|toolCall blocks>, usage, timestamp }
 *   - toolResult:  { role: "toolResult", toolCallId, toolName, content: <string>, isError, timestamp }
 *
 * CC's content blocks differ in name (tool_use vs toolCall, tool_result is a
 * USER content block in CC but a top-level role in pi). We translate accordingly.
 */

function flattenTextish(content: string | Array<{ type: string; text?: string; content?: unknown }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "tool_result") {
        const inner = (part as { content?: unknown }).content;
        if (typeof inner === "string") return inner;
        if (Array.isArray(inner)) return flattenTextish(inner as Array<{ type: string; text?: string }>);
        return "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Translate a single CC message into one or more pi-shaped messages. A CC
 * assistant message containing tool_use blocks becomes a single pi assistant
 * message with toolCall content parts. A CC user message containing
 * tool_result blocks becomes one pi toolResult message per tool_use_id and
 * (if any plain text remains) optionally a user message.
 */
export function translateCCMessage(
  message: CCMessage,
  meta: { timestamp?: string; toolNamesById?: Map<string, string> } = {},
): unknown[] {
  const timestamp = meta.timestamp || new Date().toISOString();
  const toolNamesById = meta.toolNamesById || new Map<string, string>();
  const out: unknown[] = [];

  if (message.role === "user") {
    if (typeof message.content === "string") {
      out.push({ role: "user", content: message.content, timestamp });
      return out;
    }
    const toolResults: CCContentBlock[] = [];
    const otherBlocks: CCContentBlock[] = [];
    for (const block of message.content as CCContentBlock[]) {
      if (block?.type === "tool_result") toolResults.push(block);
      else otherBlocks.push(block);
    }

    for (const result of toolResults) {
      const r = result as { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };
      out.push({
        role: "toolResult",
        toolCallId: r.tool_use_id,
        toolName: toolNamesById.get(r.tool_use_id) || "tool",
        content: typeof r.content === "string"
          ? r.content
          : Array.isArray(r.content)
            ? flattenTextish(r.content as Array<{ type: string; text?: string }>)
            : "",
        isError: Boolean(r.is_error),
        timestamp,
      });
    }

    const remainingText = flattenTextish(otherBlocks as Array<{ type: string; text?: string }>);
    if (remainingText && toolResults.length === 0) {
      out.push({ role: "user", content: remainingText, timestamp });
    }
    return out;
  }

  if (message.role === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
    const piContent: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
        piContent.push({ type: "text", text: (block as { text: string }).text });
      } else if (block.type === "thinking") {
        const text = (block as { thinking?: string; text?: string }).thinking
          || (block as { text?: string }).text
          || "";
        if (text) piContent.push({ type: "thinking", text });
      } else if (block.type === "tool_use") {
        const tu = block as { id: string; name: string; input?: Record<string, unknown> };
        toolNamesById.set(tu.id, tu.name);
        piContent.push({
          type: "toolCall",
          id: tu.id,
          toolName: tu.name,
          arguments: tu.input || {},
        });
      }
    }

    const usage = message.usage
      ? {
        input: message.usage.input_tokens || 0,
        output: message.usage.output_tokens || 0,
        cacheRead: message.usage.cache_read_input_tokens || 0,
        cacheWrite: message.usage.cache_creation_input_tokens || 0,
      }
      : undefined;

    out.push({
      role: "assistant",
      content: piContent,
      ...(usage ? { usage } : {}),
      ...(message.model ? { model: message.model } : {}),
      ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
      timestamp,
    });
    return out;
  }

  // Skip system / unknown roles \u2014 they have no rendering in pi-web today.
  return out;
}

/**
 * Replay a complete CC JSONL transcript into pi-shaped messages. Skips
 * sidechain entries (subagent activity) and meta entries (CC's own internal
 * notes), preserving the linear ordering the user actually saw.
 */
export function translateCCTranscript(entries: CCTranscriptEntry[]): unknown[] {
  const messages: unknown[] = [];
  const toolNamesById = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const e = entry as Extract<CCTranscriptEntry, { type: "user" | "assistant" }>;
    if (e.isSidechain || e.isMeta) continue;
    if (!e.message) continue;
    const piMessages = translateCCMessage(e.message, { timestamp: e.timestamp, toolNamesById });
    for (const m of piMessages) messages.push(m);
  }
  return messages;
}
