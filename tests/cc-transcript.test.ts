import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Compaction handling in the CC transcript translator and session lister.
 *
 * When CC compacts (manually via /compact or automatically when context
 * fills), its JSONL transcript gains a `system`/`compact_boundary` marker plus
 * a user entry flagged `isCompactSummary` whose body is a multi-KB summary.
 * Untranslated, that summary rendered as a giant user message nobody typed,
 * and it hijacked session display names and inflated turn counts. These tests
 * pin the mapping to pi's `compactionSummary` role — a contract the live
 * adapter's compact() depends on (it reloads via loadCCMessages and reads the
 * last compactionSummary message) — and the session-listing exclusions.
 */

const { loadCCMessages, listCCSessions, ccSessionFile } = await import("../server/agent/claude-code/sessions.js");

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const SUMMARY_TEXT = "This session is being continued from a previous conversation that ran out of context. "
  + "The summary below covers the earlier discussion.";

let originalHome: string | undefined;
let homeDir = "";
let projectDir = "";

beforeEach(async () => {
  originalHome = process.env.HOME;
  homeDir = await mkdtemp(join(tmpdir(), "pi-web-cc-transcript-home-"));
  projectDir = await mkdtemp(join(tmpdir(), "pi-web-cc-transcript-proj-"));
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(homeDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

function userEntry(text: string, uuid: string, timestamp: string) {
  return {
    type: "user",
    parentUuid: null,
    isSidechain: false,
    uuid,
    sessionId: SESSION_ID,
    timestamp,
    message: { role: "user", content: text },
  };
}

function assistantEntry(text: string, uuid: string, timestamp: string) {
  return {
    type: "assistant",
    parentUuid: null,
    isSidechain: false,
    uuid,
    sessionId: SESSION_ID,
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
  };
}

// Mirrors the boundary entry CC v2.1.222 writes: camelCase compactMetadata,
// isMeta explicitly false (it is skipped only because its type is "system").
function boundaryEntry(trigger: "manual" | "auto", preTokens: number, uuid: string, timestamp: string) {
  return {
    type: "system",
    subtype: "compact_boundary",
    parentUuid: null,
    isSidechain: false,
    content: "Conversation compacted",
    isMeta: false,
    timestamp,
    uuid,
    level: "info",
    compactMetadata: { trigger, preTokens, durationMs: 27958, postTokens: 5406, cumulativeDroppedTokens: 35171 },
    sessionId: SESSION_ID,
    version: "2.1.222",
  };
}

// The summary entry carries NO isMeta flag — before the fix it leaked through
// translation as a plain user message.
function summaryEntry(uuid: string, timestamp: string, content: unknown = SUMMARY_TEXT) {
  return {
    type: "user",
    parentUuid: null,
    isSidechain: false,
    message: { role: "user", content },
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    uuid,
    timestamp,
  };
}

async function writeSession(entries: unknown[]): Promise<string> {
  const path = ccSessionFile(projectDir, SESSION_ID);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  return path;
}

function compactedFixture(trigger: "manual" | "auto" = "manual", preTokens = 40577) {
  return [
    userEntry("Please refactor the widget module", "u1", "2026-08-06T01:00:00.000Z"),
    assistantEntry("Done — widget module refactored.", "a1", "2026-08-06T01:01:00.000Z"),
    boundaryEntry(trigger, preTokens, "b1", "2026-08-06T02:15:08.713Z"),
    summaryEntry("s1", "2026-08-06T02:15:08.712Z"),
    userEntry("Now add tests", "u2", "2026-08-06T02:20:00.000Z"),
    assistantEntry("Tests added.", "a2", "2026-08-06T02:21:00.000Z"),
  ];
}

describe("translateCCTranscript — compaction summaries (via loadCCMessages)", () => {
  it("maps a manual compaction to a compactionSummary message carrying the boundary's preTokens", async () => {
    const path = await writeSession(compactedFixture("manual", 40577));
    const messages = await loadCCMessages(path) as Array<Record<string, unknown>>;

    expect(messages.map((m) => m.role)).toEqual([
      "user", "assistant", "compactionSummary", "user", "assistant",
    ]);

    const summary = messages[2];
    expect(summary).toMatchObject({
      role: "compactionSummary",
      content: SUMMARY_TEXT,
      tokensBefore: 40577,
      summary: SUMMARY_TEXT,
      timestamp: "2026-08-06T02:15:08.712Z",
    });

    // The bug being fixed: the 4.6KB summary rendered as a plain user message.
    const userTexts = messages.filter((m) => m.role === "user").map((m) => String(m.content));
    expect(userTexts.some((t) => t.includes("This session is being continued"))).toBe(false);
  });

  it("maps an auto-compaction boundary identically", async () => {
    const path = await writeSession(compactedFixture("auto", 187654));
    const messages = await loadCCMessages(path) as Array<Record<string, unknown>>;

    const summary = messages.find((m) => m.role === "compactionSummary");
    expect(summary).toBeDefined();
    expect(summary!.tokensBefore).toBe(187654);
    expect(summary!.summary).toBe(SUMMARY_TEXT);
  });

  it("maps a summary with no preceding boundary, leaving tokensBefore unset", async () => {
    // Block-array content also exercises the string-or-first-text-block rule.
    const path = await writeSession([
      summaryEntry("s1", "2026-08-06T02:15:08.712Z", [{ type: "text", text: SUMMARY_TEXT }]),
      userEntry("Now add tests", "u1", "2026-08-06T02:20:00.000Z"),
    ]);
    const messages = await loadCCMessages(path) as Array<Record<string, unknown>>;

    expect(messages.map((m) => m.role)).toEqual(["compactionSummary", "user"]);
    expect(messages[0].tokensBefore).toBeUndefined();
    expect(messages[0].content).toBe(SUMMARY_TEXT);
    expect(messages[0].summary).toBe(SUMMARY_TEXT);
  });
});

describe("listCCSessions — compacted sessions", () => {
  it("names the session from the real first user message and excludes summaries from turn counts", async () => {
    await writeSession(compactedFixture());

    const sessions = await listCCSessions(projectDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe("Please refactor the widget module");
    expect(sessions[0].firstMessage.startsWith("Please refactor the widget module")).toBe(true);
    // user + assistant + user + assistant; boundary and summary excluded.
    expect(sessions[0].messageCount).toBe(4);
  });

  it("skips a leading summary when a session resumes straight from compaction", async () => {
    await writeSession([
      summaryEntry("s1", "2026-08-06T02:15:08.712Z"),
      userEntry("Now add tests", "u1", "2026-08-06T02:20:00.000Z"),
      assistantEntry("Tests added.", "a1", "2026-08-06T02:21:00.000Z"),
    ]);

    const sessions = await listCCSessions(projectDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe("Now add tests");
    expect(sessions[0].messageCount).toBe(2);
  });
});

describe("CC local-command records", () => {
  it("hides slash-command bookkeeping entries from messages and session names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-cc-cmdrec-"));
    const process_home = process.env.HOME;
    process.env.HOME = dir;
    try {
      const cwd = join(dir, "proj");
      const sessionId = "11111111-2222-3333-4444-555555555555";
      const path = ccSessionFile(cwd, sessionId);
      await mkdir(dirname(path), { recursive: true });
      const entries = [
        // A session whose FIRST entry is command bookkeeping must not be named after it.
        { type: "user", message: { role: "user", content: "<command-name>/compact</command-name> <command-message>compact</command-message>" }, uuid: "c1", timestamp: "2026-08-06T00:00:00Z" },
        { type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" }, uuid: "c2", timestamp: "2026-08-06T00:00:01Z" },
        { type: "user", message: { role: "user", content: "real question" }, uuid: "u1", timestamp: "2026-08-06T00:00:02Z" },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "real answer" }] }, uuid: "a1", timestamp: "2026-08-06T00:00:03Z" },
      ];
      await writeFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

      const messages = await loadCCMessages(path) as Array<{ role?: string; content?: unknown }>;
      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages)).not.toContain("command-name");

      const sessions = await listCCSessions(cwd);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].firstMessage).toBe("real question");
    } finally {
      if (process_home === undefined) delete process.env.HOME; else process.env.HOME = process_home;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
