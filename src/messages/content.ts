import type { AttachedImage } from "../app/types.js";

export function shouldCollapseMessage(text: string) {
  return text.length > 1800 || text.split("\n").length > 28;
}

export function imagesFromRawContent(content: unknown): AttachedImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part): part is Record<string, unknown> => !!part && typeof part === "object" && (part as any).type === "image")
    .map((part) => ({ data: part.data as string | undefined, mimeType: part.mimeType as string | undefined }));
}

export function stripImagePathNote(text: string) {
  const match = text.match(/(\n\nAttached image files?:\n(?:- .+\n?)+)/s);
  return match ? text.replace(match[1], "").trimEnd() : text;
}

export function imageFileName(path: string | undefined, fallback = "image") {
  return path ? path.split("/").pop() || fallback : fallback;
}

export function textFromRawContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const value = part as Record<string, unknown>;
    if (value.type === "text") return typeof value.text === "string" ? value.text : "";
    if (value.type === "image") return "[image]";
    // toolCall and thinking parts are rendered as cards — skip them in text bubbles
    return "";
  }).filter(Boolean).join("\n");
}

export function thinkingFromRawContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const value = part as Record<string, unknown>;
    if (value.type !== "thinking") return "";
    if (typeof value.thinking === "string") return value.thinking;
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    return "";
  }).map((text) => text.trim()).filter(Boolean);
}

function errorTextFromRaw(message: any) {
  const raw = String(message?.raw?.errorMessage || message?.errorMessage || "").trim();
  if (!raw) return "";
  const jsonText = raw.replace(/^Codex error:\s*/, "");
  try {
    const parsed = JSON.parse(jsonText);
    const detail = parsed?.error?.message || parsed?.message || raw;
    return `Error: ${detail}`;
  } catch {
    return raw.length > 180 ? `${raw.slice(0, 179)}…` : raw;
  }
}

function stopReasonTextFromRaw(message: any) {
  const reason = String(message?.raw?.stopReason || message?.stopReason || "").trim();
  if (!reason || reason === "stop" || reason === "toolUse") return "";
  if (reason === "length") return "Response stopped because the model hit its output length limit.";
  if (reason === "aborted") return "Response was aborted.";
  return `Response stopped unexpectedly: ${reason}`;
}

export function messageText(message: any): string {
  if (message?.role === "compactionSummary" || message?.raw?.role === "compactionSummary") {
    const raw = message.raw || message;
    const tokenText = typeof raw.tokensBefore === "number" ? raw.tokensBefore.toLocaleString() : "unknown";
    const header = `Context compacted from ${tokenText} tokens.`;
    return raw.summary ? `${header}\n\n${raw.summary}` : header;
  }

  // Prefer server-precomputed text, but fall back to raw content parsing.
  // Also reparse from raw if the precomputed text looks like a pure tool-call placeholder.
  const precomputed: string = message?.text || "";
  if (precomputed && !/^(\[tool call: [^\]]+\]\n?)+$/.test(precomputed.trim())) {
    return precomputed;
  }
  const text = textFromRawContent(message?.raw?.content || message?.content);
  const error = errorTextFromRaw(message);
  const stopReason = stopReasonTextFromRaw(message);
  if (error) return error;
  if (text && stopReason) return `${text}\n\n${stopReason}`;
  return text || stopReason || "";
}
