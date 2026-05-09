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
    // toolCall parts are rendered as tool cards — skip them in text bubbles
    return "";
  }).filter(Boolean).join("\n");
}

export function messageText(message: any): string {
  // Prefer server-precomputed text, but fall back to raw content parsing.
  // Also reparse from raw if the precomputed text looks like a pure tool-call placeholder.
  const precomputed: string = message?.text || "";
  if (precomputed && !/^(\[tool call: [^\]]+\]\n?)+$/.test(precomputed.trim())) {
    return precomputed;
  }
  return textFromRawContent(message?.raw?.content || message?.content) || "";
}
