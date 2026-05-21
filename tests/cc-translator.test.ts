import { describe, expect, it } from "vitest";
import { translateCCMessage, translateCCTranscript } from "../server/agent/claude-code/translator.js";
import type { CCTranscriptEntry } from "../server/agent/claude-code/types.js";

describe("Claude Code message translator", () => {
  it("translates a string-content user message into a single pi user message", () => {
    const out = translateCCMessage(
      { role: "user", content: "hello" },
      { timestamp: "2026-01-02T03:04:05Z" },
    );
    expect(out).toEqual([{ role: "user", content: "hello", timestamp: "2026-01-02T03:04:05Z" }]);
  });

  it("translates a CC user message containing tool_result blocks into pi toolResult messages", () => {
    const toolNamesById = new Map<string, string>([["call-1", "Read"]]);
    const out = translateCCMessage(
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "file contents", is_error: false },
        ],
      },
      { timestamp: "t1", toolNamesById },
    );
    expect(out).toEqual([
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "Read",
        content: "file contents",
        isError: false,
        timestamp: "t1",
      },
    ]);
  });

  it("flattens an array of structured tool_result content into a single string", () => {
    const out = translateCCMessage(
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
            ],
          },
        ],
      },
      { toolNamesById: new Map([["x", "Bash"]]) },
    );
    expect(out).toHaveLength(1);
    const result = out[0] as { content: string; toolName: string };
    expect(result.content).toBe("line one\nline two");
    expect(result.toolName).toBe("Bash");
  });

  it("translates a CC assistant message with text + tool_use into pi assistant content with toolCall blocks", () => {
    const toolNamesById = new Map<string, string>();
    const out = translateCCMessage(
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check that. " },
          { type: "tool_use", id: "tu-1", name: "Read", input: { path: "/etc/hosts" } },
          { type: "text", text: " Done." },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 10,
        },
        model: "claude-sonnet-4-5",
      },
      { timestamp: "t2", toolNamesById },
    );
    expect(out).toHaveLength(1);
    const message = out[0] as { role: string; content: any[]; usage: any; model: string };
    expect(message.role).toBe("assistant");
    expect(message.content).toEqual([
      { type: "text", text: "Let me check that. " },
      { type: "toolCall", id: "tu-1", toolName: "Read", arguments: { path: "/etc/hosts" } },
      { type: "text", text: " Done." },
    ]);
    expect(message.usage).toEqual({ input: 100, output: 20, cacheRead: 50, cacheWrite: 10 });
    expect(message.model).toBe("claude-sonnet-4-5");
    // Translator must register the tool name so subsequent tool_result lookups work.
    expect(toolNamesById.get("tu-1")).toBe("Read");
  });

  it("preserves thinking blocks", () => {
    const out = translateCCMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me think about this carefully" },
        { type: "text", text: "Here's my answer." },
      ],
    });
    const message = out[0] as { content: any[] };
    expect(message.content).toEqual([
      { type: "thinking", text: "let me think about this carefully" },
      { type: "text", text: "Here's my answer." },
    ]);
  });

  it("skips system messages and unknown roles", () => {
    const out = translateCCMessage({
      role: "system" as any,
      content: "you are helpful",
    });
    expect(out).toEqual([]);
  });

  it("translates a full transcript end-to-end while skipping sidechain & meta entries", () => {
    const entries: CCTranscriptEntry[] = [
      { type: "last-prompt", leafUuid: "x", sessionId: "s" } as any,
      { type: "permission-mode", permissionMode: "default", sessionId: "s" } as any,
      {
        type: "user",
        parentUuid: null,
        uuid: "u1",
        sessionId: "s",
        timestamp: "t1",
        message: { role: "user", content: "hi" },
      },
      // sidechain (subagent) — must be skipped
      {
        type: "assistant",
        parentUuid: "u1",
        uuid: "subagent",
        sessionId: "s",
        timestamp: "t2",
        message: { role: "assistant", content: [{ type: "text", text: "subagent thinking" }] },
        isSidechain: true,
      },
      // meta entry — must be skipped
      {
        type: "user",
        parentUuid: "u1",
        uuid: "meta",
        sessionId: "s",
        timestamp: "t3",
        message: { role: "user", content: "internal note" },
        isMeta: true,
      },
      {
        type: "assistant",
        parentUuid: "u1",
        uuid: "a1",
        sessionId: "s",
        timestamp: "t4",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        parentUuid: "a1",
        uuid: "u2",
        sessionId: "s",
        timestamp: "t5",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "a.txt b.txt" }],
        },
      },
    ];

    const messages = translateCCTranscript(entries);
    expect(messages).toHaveLength(3);
    expect((messages[0] as { role: string }).role).toBe("user");
    expect((messages[1] as { role: string; content: any[] }).content).toEqual([
      { type: "toolCall", id: "tu-1", toolName: "Bash", arguments: { command: "ls" } },
    ]);
    expect(messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "tu-1",
      toolName: "Bash",
      content: "a.txt b.txt",
      isError: false,
    });
  });
});
