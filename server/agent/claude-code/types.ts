/**
 * Minimal types for the on-disk and live stream-json representations of a
 * Claude Code conversation. Defined locally rather than imported from
 * @anthropic-ai/claude-code because we drive the CLI directly via subprocess
 * and only consume a subset of fields.
 */

export type CCContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string; text?: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | Array<{ type: string; text?: string }>; is_error?: boolean }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: string; [key: string]: unknown };

export interface CCMessage {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string | CCContentBlock[];
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  stop_reason?: string;
}

/**
 * On-disk JSONL transcript entries written by the CC CLI under
 * ~/.claude/projects/<slug>/<session-id>.jsonl. Many entry shapes exist; we
 * only consume `user`, `assistant`, and lightweight metadata entries here.
 */
export type CCTranscriptEntry =
  | {
    type: "user" | "assistant";
    parentUuid: string | null;
    uuid: string;
    sessionId: string;
    timestamp?: string;
    message: CCMessage;
    isSidechain?: boolean;
    promptId?: string;
    isMeta?: boolean;
  }
  | {
    type: "summary" | "last-prompt" | "permission-mode" | "attachment" | "file-history-snapshot" | string;
    [key: string]: unknown;
  };

/**
 * Live stream-json events emitted by `claude -p --output-format stream-json`.
 * Event shapes follow Anthropic's Messages API streaming contract with
 * `--include-partial-messages` adding `stream_event` envelopes.
 */
export type CCStreamEvent =
  | { type: "system"; subtype: string; session_id: string; model?: string; cwd?: string; tools?: string[]; permission_mode?: string }
  | { type: "user"; message: CCMessage; parent_tool_use_id?: string }
  | { type: "assistant"; message: CCMessage; parent_tool_use_id?: string }
  | { type: "result"; subtype: string; session_id: string; total_cost_usd?: number; usage?: CCMessage["usage"]; result?: string; is_error?: boolean }
  | { type: "stream_event"; event: CCRawStreamEvent }
  | { type: string; [key: string]: unknown };

export type CCRawStreamEvent =
  | { type: "message_start"; message: { id: string; model?: string; usage?: CCMessage["usage"] } }
  | { type: "message_delta"; delta: { stop_reason?: string }; usage?: CCMessage["usage"] }
  | { type: "message_stop" }
  | { type: "content_block_start"; index: number; content_block: CCContentBlock }
  | { type: "content_block_delta"; index: number; delta: { type: string; text?: string; partial_json?: string; thinking?: string } }
  | { type: "content_block_stop"; index: number }
  | { type: string; [key: string]: unknown };

/**
 * Effort level supported by the CC CLI's --effort flag. Mapped from pi's
 * thinking-level vocabulary in claude-code/index.ts.
 */
export type CCEffort = "low" | "medium" | "high" | "xhigh" | "max";
