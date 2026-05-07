export interface PiWebModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface PiWebSession {
  sessionId: string;
  sessionFile: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  pendingMessageCount?: number;
  model: PiWebModel;
  thinkingLevel: string;
  messages: unknown[];
  agent: { state: { messages: unknown[] } };
  sessionManager: {
    newSession(): void;
    setSessionFile?(path: string): void;
    buildSessionContext(): { messages: unknown[] };
    getSessionDir?(): string;
  };
  modelRegistry: {
    getAvailable(): PiWebModel[];
    find(provider: string, id: string): PiWebModel | undefined;
  };
  getAvailableThinkingLevels(): string[];
  getSessionName?(): string | undefined;
  setModel(model: unknown): Promise<void>;
  setThinkingLevel(level: string): void;
  reload?(): Promise<void>;
  prompt(message: string, options?: { images?: unknown[] }): Promise<void>;
  abort(): Promise<void>;
  clearQueue?(): void;
  subscribe?(listener: (event: unknown) => void): (() => void) | undefined;
}

export interface PiWebSessionInfo {
  id: string;
  path: string;
  name: string;
  firstMessage: string;
  created: Date;
  modified: Date;
  messageCount: number;
  allMessagesText: string;
  cwd: string;
}
