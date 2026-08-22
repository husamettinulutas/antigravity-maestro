/** OpenAI Responses + Chat Completions shapes, limited to what Codex uses. */

export interface ResponsesTool {
  type: 'function' | string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  /** Older clients nest the definition under `function`. */
  function?: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ResponsesInputItem {
  type?: string;
  role?: 'user' | 'assistant' | 'system' | 'developer';
  content?: string | ResponsesContentPart[];
  /** function_call */
  name?: string;
  arguments?: string;
  call_id?: string;
  /** function_call_output */
  output?: string | ResponsesContentPart[];
  /** reasoning */
  summary?: { type: string; text: string }[];
  encrypted_content?: string;
  id?: string;
}

export interface ResponsesContentPart {
  type: string;
  text?: string;
  image_url?: string | { url: string };
  /** input_image with inline data. */
  detail?: string;
}

export interface ResponsesRequest {
  model: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: string | { type: string; name?: string };
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string };
  store?: boolean;
  include?: string[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'developer';
  content?: string | ChatContentPart[] | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  tools?: { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
  tool_choice?: string | { type: string; function?: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

/** Map a Gemini finishReason onto an OpenAI finish_reason. */
export function toFinishReason(finishReason: string | undefined, usedTool: boolean): string {
  if (usedTool) {
    return 'tool_calls';
  }
  return (finishReason ?? '').toUpperCase() === 'MAX_TOKENS' ? 'length' : 'stop';
}
