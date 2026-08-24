/** Gemini wire types, limited to the fields the Antigravity endpoints use. */

export interface FunctionCall {
  /**
   * Client-side call id. The Claude models are served by translating this
   * request into the Anthropic format, and that translation rejects a tool call
   * with no id, so it has to survive the round trip.
   */
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface FunctionResponse {
  /** Matches the `id` of the call this responds to. */
  id?: string;
  name: string;
  response: Record<string, unknown>;
}

export interface InlineData {
  mimeType: string;
  /** base64-encoded bytes. */
  data: string;
}

export interface GeminiPart {
  text?: string;
  /** True when the text is model reasoning rather than user-visible output. */
  thought?: boolean;
  /** Opaque signature that must be echoed back with the thought on later turns. */
  thoughtSignature?: string;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  inlineData?: InlineData;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface ThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: string;
}

export interface GenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  thinkingConfig?: ThinkingConfig;
  responseMimeType?: string;
}

export interface FunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations?: FunctionDeclaration[];
  googleSearch?: Record<string, never>;
}

export interface SafetySetting {
  category: string;
  threshold: string;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: GeminiTool[];
  toolConfig?: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } };
  generationConfig?: GenerationConfig;
  safetySettings?: SafetySetting[];
}

/** The body the v1internal endpoints expect. */
export interface GeminiInternalRequest {
  project?: string;
  requestId: string;
  request: GeminiRequest;
  model: string;
  userAgent: string;
  requestType?: string;
  enabledCreditTypes?: string[];
}

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: UsageMetadata;
  modelVersion?: string;
  responseId?: string;
  promptFeedback?: { blockReason?: string };
}

/**
 * Antigravity always sends these — the Cloud Code endpoint applies stricter
 * defaults when they are absent, which trips over ordinary coding content.
 */
export const SAFETY_SETTINGS: SafetySetting[] = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

/** Text of every non-thought part, concatenated. */
export function textOf(parts: GeminiPart[] | undefined): string {
  return (parts ?? [])
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('');
}

/** Drop keys with undefined values so the upstream never sees `"x": null`. */
export function pruneUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined) {
      delete value[key];
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      pruneUndefined(item);
    }
  }
  return value;
}
