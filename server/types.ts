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
    getLeafId?(): string | null;
    getEntry?(id: string): unknown;
    getBranch?(fromId?: string): unknown[];
    getTree?(): unknown[];
    getLabel?(id: string): string | undefined;
    branch?(entryId: string): void;
    resetLeaf?(): void;
    appendLabelChange?(targetId: string, label: string | undefined): string;
  };
  modelRegistry: {
    getAvailable(): PiWebModel[];
    find(provider: string, id: string): PiWebModel | undefined;
  };
  getAvailableThinkingLevels(): string[];
  getSessionName?(): string | undefined;
  setSessionName?(name: string): void;
  setModel(model: unknown): Promise<void>;
  setThinkingLevel(level: string): void;
  reload?(): Promise<void>;
  navigateTree?(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: unknown }>;
  abortBranchSummary?(): void;
  abortCompaction?(): void;
  prompt(message: string, options?: { images?: unknown[]; streamingBehavior?: string }): Promise<void>;
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
