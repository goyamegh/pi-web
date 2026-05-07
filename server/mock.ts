import { join } from "node:path";
import type { PiWebSession, PiWebSessionInfo } from "./types.js";

interface MockSessionOptions {
  piCwd: string;
  broadcast(value: unknown): void;
  isCurrentSession(session: PiWebSession): boolean;
  currentState(): unknown;
}

export function createMockHarness(options: MockSessionOptions) {
  const { piCwd, broadcast, isCurrentSession, currentState } = options;
  const mockModel = { provider: "mock", id: "model", name: "Mock Model", reasoning: true, contextWindow: 128000, maxTokens: 4096 };

  const mockSessions: PiWebSessionInfo[] = [
    {
      id: "mock-current",
      path: join(piCwd, ".mock-sessions/current.jsonl"),
      name: "Current mock session",
      firstMessage: "Can you add image attachments?",
      created: new Date("2026-05-01T10:00:00Z"),
      modified: new Date("2026-05-07T10:00:00Z"),
      messageCount: 2,
      allMessagesText: "Can you add image attachments?",
      cwd: piCwd,
    },
    {
      id: "mock-older",
      path: join(piCwd, ".mock-sessions/older.jsonl"),
      name: "Older mock session",
      firstMessage: "Review the mobile composer layout",
      created: new Date("2026-05-01T09:00:00Z"),
      modified: new Date("2026-05-06T09:00:00Z"),
      messageCount: 4,
      allMessagesText: "Review the mobile composer layout",
      cwd: piCwd,
    },
  ];

  function initialMessages(path: string): unknown[] {
    return path === mockSessions[1].path
      ? [
        { role: "user", content: "Review the mobile composer layout", timestamp: "2026-05-06T09:00:00Z" },
        { role: "assistant", content: "Resumed older session.", timestamp: "2026-05-06T09:01:00Z" },
      ]
      : [
        { role: "user", content: "Can you add image attachments?", timestamp: "2026-05-07T10:00:00Z" },
        { role: "assistant", content: ("## Image attachment support\n\nImage attachment support is **enabled**.\n\n- Upload images\n- Preview images\n\n```ts\nconst enabled = true;\n```\n\n").repeat(18), timestamp: "2026-05-07T10:01:00Z" },
      ];
  }

  function createMockSession(path = mockSessions[0].path): PiWebSession {
    const mockMessages = initialMessages(path);
    let mockSession: PiWebSession;
    const mockSessionManager = {
      newSession() {
        mockSession.sessionId = `mock-${Date.now()}`;
        mockSession.sessionFile = join(piCwd, `.mock-sessions/${mockSession.sessionId}.jsonl`);
        mockMessages.length = 0;
      },
      setSessionFile(path: string) {
        mockSession.sessionFile = path;
        mockSession.sessionId = mockSessions.find((info) => info.path === path)?.id || "mock-opened";
        mockMessages.length = 0;
        mockMessages.push(...initialMessages(path));
      },
      buildSessionContext() { return { messages: mockMessages }; },
      getSessionDir() { return join(piCwd, ".mock-sessions"); },
    };

    mockSession = {
      sessionId: mockSessions.find((info) => info.path === path)?.id || "mock-current",
      sessionFile: path,
      isStreaming: false,
      model: mockModel,
      thinkingLevel: "medium",
      messages: mockMessages,
      agent: { state: { messages: mockMessages } },
      sessionManager: mockSessionManager,
      modelRegistry: {
        getAvailable: () => [mockModel],
        find: (provider: string, id: string) => provider === mockModel.provider && id === mockModel.id ? mockModel : undefined,
      },
      getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
      setModel: async (model: unknown) => { mockSession.model = model as typeof mockModel; },
      setThinkingLevel: (level: string) => { mockSession.thinkingLevel = level; },
      reload: async () => undefined,
      prompt: async (message: string, promptOptions?: { images?: unknown[] }) => {
        mockMessages.push({ role: "user", content: message, timestamp: new Date().toISOString() });
        const slow = /slow|running/i.test(message);
        const withShowcase = /showcase/i.test(message);
        const withMalformedEditTool = /malformed edit/i.test(message);
        const withEditTool = !withShowcase && !withMalformedEditTool && /edit diff/i.test(message);
        const withTools = !withShowcase && !withEditTool && !withMalformedEditTool && /tool|interleav/i.test(message);
        mockSession.isStreaming = true;
        broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "agent_start" } });
        if (slow) await new Promise((resolve) => setTimeout(resolve, 750));
        if (withShowcase) {
          const editArgs = { path: "/Users/ashwin/projects/pi-web/src/style.css", edits: [{ oldText: ".sessionItem {\n  min-height: 40px;\n}", newText: ".sessionItem {\n  height: auto;\n  min-height: 0;\n}\n\n@media (max-width: 700px) {\n  .sessionDrawer { width: 100vw; }\n}" }] };
          mockMessages.push({ role: "assistant", content: [
            { type: "text", text: "## Mobile-first coding UI\n\nI reviewed the session drawer, checked the CSS, and tightened the responsive layout.\n\n```ts\nawait runVisualRegression({ projects: [\"mobile\", \"desktop\"] });\n```" },
            { type: "toolCall", id: "call-showcase-read", toolName: "read", arguments: { path: "/Users/ashwin/projects/pi-web/src/style.css" } },
            { type: "text", text: "The global button height was constraining session rows, so I patched the drawer-specific styles." },
            { type: "toolCall", id: "call-showcase-edit", toolName: "edit", arguments: editArgs },
            { type: "text", text: "Visual snapshots now cover the polished desktop and mobile states.\n\n![pi-web workflow](/api/artifacts/e2e-test.png)" },
          ], timestamp: new Date().toISOString() });
          mockMessages.push({ role: "toolResult", toolCallId: "call-showcase-read", toolName: "read", content: "session drawer CSS and responsive composer styles", timestamp: new Date().toISOString() });
          mockMessages.push({ role: "toolResult", toolCallId: "call-showcase-edit", toolName: "edit", toolArgs: editArgs, content: "Successfully replaced 1 block(s) in /Users/ashwin/projects/pi-web/src/style.css.", timestamp: new Date().toISOString() });
        } else if (withEditTool || withMalformedEditTool) {
          const editArgs = withMalformedEditTool
            ? { path: "/some/file.ts", edits: [{ newText: "const answer = 42;" }, { oldText: "console.log(answer);" }] }
            : { path: "/some/file.ts", edits: [{ oldText: "const answer = 41;\nconsole.log(answer);", newText: "const answer = 42;\nconsole.info(answer);" }] };
          broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "tool_execution_start", toolName: "edit", toolCallId: "call-edit", args: editArgs } });
          await new Promise((resolve) => setTimeout(resolve, 80));
          broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "tool_execution_end", toolName: "edit", toolCallId: "call-edit", isError: false, result: "Successfully replaced 1 block(s) in /some/file.ts." } });
          mockMessages.push({ role: "assistant", content: [{ type: "toolCall", id: "call-edit", toolName: "edit", arguments: editArgs }], timestamp: new Date().toISOString() });
          mockMessages.push({ role: "toolResult", toolCallId: "call-edit", toolName: "edit", toolArgs: editArgs, content: "Successfully replaced 1 block(s) in /some/file.ts.", timestamp: new Date().toISOString() });
        } else if (withTools) {
          broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me check that for you. " } } });
          await new Promise((resolve) => setTimeout(resolve, 80));
          broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "tool_execution_start", toolName: "read", toolCallId: "call-1", args: { path: "/some/file" } } });
          await new Promise((resolve) => setTimeout(resolve, 150));
          broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "tool_execution_end", toolName: "read", toolCallId: "call-1", isError: false, result: "file contents here" } });
          await new Promise((resolve) => setTimeout(resolve, 80));
          broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done reading." } } });
          await new Promise((resolve) => setTimeout(resolve, 80));
          mockMessages.push({ role: "assistant", content: [
            { type: "text", text: "Let me check that for you. " },
            { type: "toolCall", id: "call-1", toolName: "read", arguments: { path: "/some/file" } },
            { type: "text", text: "Done reading." },
          ], timestamp: new Date().toISOString() });
          mockMessages.push({ role: "toolResult", toolCallId: "call-1", toolName: "read", content: "file contents here", timestamp: new Date().toISOString() });
        } else if (/artifact/i.test(message)) {
          mockMessages.push({ role: "assistant", content: "Here is a screenshot:\n\n![e2e-test](/api/artifacts/e2e-test.png)", timestamp: new Date().toISOString() });
        } else if (/markdown/i.test(message)) {
          mockMessages.push({ role: "assistant", content: "Here is **bold** markdown.\n\n- one\n- two\n\n```ts\nconst answer = 42;\n```", timestamp: new Date().toISOString() });
        } else {
          mockMessages.push({ role: "assistant", content: `Mock response${promptOptions?.images?.length ? " with image" : ""}.`, timestamp: new Date().toISOString() });
        }
        mockSession.isStreaming = false;
        broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "agent_end" } });
        if (isCurrentSession(mockSession)) broadcast({ type: "state_changed", ...currentState() as object });
      },
      abort: async () => { mockSession.isStreaming = false; },
      clearQueue: () => undefined,
      subscribe: () => undefined,
    };
    return mockSession;
  }

  return { mockSessions, createMockSession };
}
