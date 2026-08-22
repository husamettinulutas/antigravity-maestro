/** Anthropic Messages API shapes, limited to what Claude Code sends and reads. */

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
  metadata?: { user_id?: string };
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** Map a Gemini finishReason onto an Anthropic stop_reason. */
export function toStopReason(finishReason: string | undefined, usedTool: boolean): string {
  if (usedTool) {
    return 'tool_use';
  }
  switch ((finishReason ?? '').toUpperCase()) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'STOP':
    case 'FINISH_REASON_STOP':
      return 'end_turn';
    case '':
      return 'end_turn';
    default:
      // SAFETY, RECITATION, OTHER — the turn ended, just not cleanly.
      return 'end_turn';
  }
}
