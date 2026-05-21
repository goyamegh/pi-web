import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CCMessage, CCTranscriptEntry } from "./types.js";
import { translateCCTranscript } from "./translator.js";

/**
 * Convert a filesystem cwd into the slug Claude Code uses to organize its
 * transcripts under ~/.claude/projects/. CC's slug rule is: prefix with `-`
 * and replace every `/` with `-` (no length cap, no other escaping). This is
 * a stable, reversible mapping for the cwds we care about.
 */
export function ccProjectSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/** Absolute path to the JSONL transcript directory for a given cwd. */
export function ccProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", ccProjectSlug(cwd));
}

/** Absolute path to a specific session's JSONL transcript. */
export function ccSessionFile(cwd: string, sessionId: string): string {
  return join(ccProjectDir(cwd), `${sessionId}.jsonl`);
}

export interface CCSessionInfo {
  id: string;
  path: string;
  cwd: string;
  name: string;
  firstMessage: string;
  created: Date;
  modified: Date;
  messageCount: number;
}

function isUuidJsonlName(name: string): boolean {
  // Match the 36-char UUID + .jsonl filenames CC writes; ignore other artifacts
  // (e.g. CC sometimes writes auxiliary files; we only resume by UUID).
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(name);
}

async function readJsonlEntries(path: string): Promise<CCTranscriptEntry[]> {
  const text = await readFile(path, "utf-8");
  const entries: CCTranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as CCTranscriptEntry);
    } catch {
      // Tolerate partially written tail-of-file lines; CC writes JSONL
      // append-only and we may race with an in-progress session.
    }
  }
  return entries;
}

/**
 * Extract the first non-meta user-text message from a CC transcript. Used as
 * a session preview / fallback display name when no `summary` entry exists.
 */
function firstUserMessage(entries: CCTranscriptEntry[]): string {
  for (const entry of entries) {
    if ((entry as { type?: string })?.type !== "user") continue;
    const e = entry as Extract<CCTranscriptEntry, { type: "user" | "assistant" }>;
    if (e.isSidechain || e.isMeta) continue;
    const message = e.message as CCMessage | undefined;
    if (!message) continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "text" && typeof (block as { text?: unknown }).text === "string") {
          return (block as { text: string }).text;
        }
      }
    }
  }
  return "";
}

/**
 * Pick a display name for a CC session. Prefers an explicit `summary` entry
 * (CC's named-session feature), then the first user message, else "(empty)".
 */
function displayName(entries: CCTranscriptEntry[], sessionId: string): string {
  for (const entry of entries) {
    if ((entry as { type?: string })?.type === "summary") {
      const s = entry as { summary?: unknown; title?: unknown };
      if (typeof s.summary === "string" && s.summary.trim()) return s.summary.trim();
      if (typeof s.title === "string" && s.title.trim()) return s.title.trim();
    }
  }
  const first = firstUserMessage(entries).trim();
  return first ? first.split("\n")[0].slice(0, 80) : `(empty session ${sessionId.slice(0, 8)})`;
}

/**
 * Count the user-visible (non-meta, non-sidechain) message turns in a CC
 * transcript. Tool results count as user turns in CC, so we drop those to
 * match how pi reports messageCount.
 */
function countTurns(entries: CCTranscriptEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry?.type !== "user" && entry?.type !== "assistant") continue;
    const e = entry as Extract<CCTranscriptEntry, { type: "user" | "assistant" }>;
    if (e.isSidechain || e.isMeta) continue;
    const content = (e.message as CCMessage | undefined)?.content;
    if (Array.isArray(content) && content.every((b) => b?.type === "tool_result")) continue;
    count++;
  }
  return count;
}

/**
 * List every CC session whose transcript lives under the given cwd's project
 * directory. Returns an empty array if CC has never been run in this cwd.
 * Lightweight: parses each JSONL once for metadata (no replay).
 */
export async function listCCSessions(cwd: string): Promise<CCSessionInfo[]> {
  const dir = ccProjectDir(cwd);
  if (!existsSync(dir)) return [];

  const names = await readdir(dir);
  const out: CCSessionInfo[] = [];
  for (const name of names) {
    if (!isUuidJsonlName(name)) continue;
    const path = join(dir, name);
    const id = name.slice(0, 36);
    let entries: CCTranscriptEntry[];
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      [entries, st] = await Promise.all([readJsonlEntries(path), stat(path)]);
    } catch {
      continue;
    }
    out.push({
      id,
      path,
      cwd,
      name: displayName(entries, id),
      firstMessage: firstUserMessage(entries).slice(0, 200),
      created: st.birthtime || st.ctime,
      modified: st.mtime,
      messageCount: countTurns(entries),
    });
  }
  return out;
}

/**
 * Read and translate a CC session's transcript into pi-shaped messages.
 * Returns an empty array if the file does not yet exist (e.g. brand-new
 * session not yet flushed to disk by the CLI).
 */
export async function loadCCMessages(path: string): Promise<unknown[]> {
  if (!existsSync(path)) return [];
  const entries = await readJsonlEntries(path);
  return translateCCTranscript(entries);
}
