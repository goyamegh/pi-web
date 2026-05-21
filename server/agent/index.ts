/**
 * Public surface of pi-web's agent abstraction. Always import AgentAdapter,
 * AgentKind, AgentCapabilities, etc. from "./agent/index.js" rather than from
 * the individual files so adapter modules stay swappable.
 */
export type { AgentAdapter, AgentCapabilities, AgentKind, AgentSlashCommand } from "./types.js";
export { PI_CAPABILITIES, MOCK_CAPABILITIES, wrapPiSession } from "./pi.js";
export { CC_CAPABILITIES, createClaudeCodeAdapter, type CreateClaudeCodeAdapterOptions } from "./claude-code/index.js";
export { ccProjectDir, ccSessionFile, listCCSessions, loadCCMessages, type CCSessionInfo } from "./claude-code/sessions.js";
