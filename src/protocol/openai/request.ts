import {
  GeminiContent,
  GeminiPart,
  GeminiRequest,
  SAFETY_SETTINGS,
  pruneUndefined,
} from '../gemini';
import { sanitizeToolSchema } from '../schema';
import { signatureFamilyOf, signatureStore } from '../signatureStore';
import {
  ChatCompletionsRequest,
  ChatMessage,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesTool,
} from './types';

/**
 * Convert an OpenAI Responses request (what the Codex CLI and IDE extension
 * send) into a Gemini request.
 *
 * Codex represents a turn as a flat list of items — messages, function_call,
 * function_call_output, reasoning — rather than nested message content, so the
 * conversion walks the list and groups consecutive items by speaker.
 */
export function responsesToGemini(
  body: ResponsesRequest,
  model = 'gemini',
  requiresSignature = false,
): GeminiRequest {
  const items = normalizeInput(body.input);
  const toolNames = collectToolNames(items);
  const unsigned = unsignedCallIds(responseSteps(items), model, requiresSignature);
  const contents: GeminiContent[] = [];

  for (const item of items) {
    const { role, parts } = convertItem(item, toolNames, model, unsigned);
    if (parts.length === 0) {
      continue;
    }
    const previous = contents[contents.length - 1];
    if (previous?.role === role) {
      previous.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  const request: GeminiRequest = {
    contents,
    safetySettings: [...SAFETY_SETTINGS],
    generationConfig: {
      temperature: body.temperature,
      topP: body.top_p,
      maxOutputTokens: body.max_output_tokens,
    },
  };

  if (body.instructions && body.instructions.trim() !== '') {
    request.systemInstruction = { parts: [{ text: body.instructions }] };
  }

  const declarations = toFunctionDeclarations(body.tools);
  if (declarations.length > 0) {
    request.tools = [{ functionDeclarations: declarations }];
    request.toolConfig = { functionCallingConfig: responsesToolChoice(body.tool_choice) };
  }

  return pruneUndefined(request);
}

/** Convert an OpenAI Chat Completions request into a Gemini request. */
export function chatToGemini(
  body: ChatCompletionsRequest,
  model = 'gemini',
  requiresSignature = false,
): GeminiRequest {
  const toolNames = new Map<string, string>();
  const steps: string[][] = [];
  for (const message of body.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      toolNames.set(call.id, call.function.name);
    }
    // One assistant message is one step: its calls were made together.
    if (message.tool_calls?.length) {
      steps.push(message.tool_calls.map((call) => call.id));
    }
  }
  const unsigned = unsignedCallIds(steps, model, requiresSignature);

  const contents: GeminiContent[] = [];
  const systemChunks: string[] = [];

  for (const message of body.messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') {
      systemChunks.push(chatText(message.content));
      continue;
    }

    const parts = convertChatMessage(message, toolNames, model, unsigned);
    if (parts.length === 0) {
      continue;
    }

    const role: GeminiContent['role'] =
      message.role === 'assistant' && !parts.some((part) => part.functionResponse) ? 'model' : 'user';
    const previous = contents[contents.length - 1];
    if (previous?.role === role) {
      previous.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  const request: GeminiRequest = {
    contents,
    safetySettings: [...SAFETY_SETTINGS],
    generationConfig: {
      temperature: body.temperature,
      topP: body.top_p,
      maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
      stopSequences: typeof body.stop === 'string' ? [body.stop] : body.stop,
    },
  };

  if (systemChunks.length > 0) {
    request.systemInstruction = { parts: [{ text: systemChunks.join('\n\n') }] };
  }

  if (body.tools && body.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: body.tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: sanitizeToolSchema(tool.function.parameters),
        })),
      },
    ];
    request.toolConfig = { functionCallingConfig: chatToolChoice(body.tool_choice) };
  }

  return pruneUndefined(request);
}

/**
 * The tool calls that cannot be replayed to `model` as tool calls.
 *
 * Gemini 3 rejects the whole request — HTTP 400, "Function call is missing a
 * thought_signature" — when a replayed `functionCall` carries no signature it
 * issued. The store holds the ones this gateway has seen, but nothing survives
 * a switch to another model family, a gateway restart, or an hour of idling.
 *
 * Dropping those calls would orphan their results; sending them bare fails the
 * turn. So they are retold as text, which keeps the history readable and the
 * request valid. The set is computed up front because a call and its result
 * are converted separately and the two decisions have to agree.
 *
 * `steps` holds the calls made together, in order, and the first call decides
 * for its step: Gemini signs only the first call of a parallel batch and checks
 * only that one. Judging each call on its own retold every parallel call after
 * the first as text.
 *
 * Only Gemini needs this: the Claude and GPT models are served by translating
 * the request back out of the Gemini shape, and an unsigned call survives it.
 */
function unsignedCallIds(
  steps: readonly (readonly string[])[],
  model: string,
  requiresSignature: boolean,
): ReadonlySet<string> {
  const unsigned = new Set<string>();
  if (!requiresSignature || signatureFamilyOf(model) !== 'gemini') {
    return unsigned;
  }

  for (const step of steps) {
    if (step.length > 0 && !signatureStore.forToolCall(step[0], model)) {
      step.forEach((callId) => unsigned.add(callId));
    }
  }
  return unsigned;
}

/**
 * The Responses history's tool calls grouped into steps. A step is a run of
 * `function_call` items with nothing between them — how a parallel batch
 * appears in the flat item list.
 */
function responseSteps(items: readonly ResponsesInputItem[]): string[][] {
  const steps: string[][] = [];
  let current: string[] | undefined;
  for (const item of items) {
    if (item.type !== 'function_call') {
      current = undefined;
      continue;
    }
    if (!current) {
      current = [];
      steps.push(current);
    }
    if (item.call_id) {
      current.push(item.call_id);
    }
  }
  return steps;
}

// ── Responses items ───────────────────────────────────────────────────────────

function convertItem(
  item: ResponsesInputItem,
  toolNames: Map<string, string>,
  model: string,
  unsigned: ReadonlySet<string>,
): { role: GeminiContent['role']; parts: GeminiPart[] } {
  switch (item.type) {
    case 'function_call': {
      const name = item.name ?? 'tool';
      const args = parseArguments(item.arguments);
      // No signature this model would accept: retold as text rather than sent
      // bare, which the upstream rejects. See `unsignedCallIds`.
      if (item.call_id && unsigned.has(item.call_id)) {
        return { role: 'model', parts: [{ text: `[tool call] ${name}(${JSON.stringify(args)})` }] };
      }
      return {
        role: 'model',
        parts: [
          {
            functionCall: { id: item.call_id, name, args },
            thoughtSignature: item.call_id
              ? signatureStore.forToolCall(item.call_id, model)
              : undefined,
          },
        ],
      };
    }
    case 'function_call_output': {
      const name = (item.call_id && toolNames.get(item.call_id)) || 'tool';
      const output = outputText(item.output);
      // The call it answers was retold as text, and a functionResponse with no
      // functionCall before it is rejected just as hard as the bare call.
      if (item.call_id && unsigned.has(item.call_id)) {
        return { role: 'user', parts: [{ text: `[tool result] ${name}: ${output}` }] };
      }
      return {
        role: 'user',
        parts: [{ functionResponse: { id: item.call_id, name, response: { output } } }],
      };
    }
    case 'reasoning':
      // Codex replays reasoning items, but their content is encrypted for
      // OpenAI's own service and carries nothing this upstream can use.
      return { role: 'model', parts: [] };
    default:
      break;
  }

  const role: GeminiContent['role'] = item.role === 'assistant' ? 'model' : 'user';
  return { role, parts: contentParts(item.content) };
}

function contentParts(content: ResponsesInputItem['content']): GeminiPart[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === 'input_image' || part.type === 'image_url') {
      const inline = toInlineData(part.image_url);
      if (inline) {
        parts.push({ inlineData: inline });
      }
      continue;
    }
    const text = part.text ?? '';
    if (text !== '') {
      parts.push({ text });
    }
  }
  return parts;
}

function normalizeInput(input: ResponsesRequest['input']): ResponsesInputItem[] {
  if (!input) {
    return [];
  }
  if (typeof input === 'string') {
    return [{ type: 'message', role: 'user', content: input }];
  }
  return input;
}

function collectToolNames(items: ResponsesInputItem[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const item of items) {
    if (item.type === 'function_call' && item.call_id && item.name) {
      names.set(item.call_id, item.name);
    }
  }
  return names;
}

function toFunctionDeclarations(tools: ResponsesTool[] | undefined) {
  return (tools ?? [])
    .map((tool) => {
      const name = tool.name ?? tool.function?.name;
      if (!name) {
        return undefined;
      }
      return {
        name,
        description: tool.description ?? tool.function?.description,
        parameters: sanitizeToolSchema(tool.parameters ?? tool.function?.parameters),
      };
    })
    .filter((declaration): declaration is NonNullable<typeof declaration> => declaration !== undefined);
}

function responsesToolChoice(choice: ResponsesRequest['tool_choice']) {
  if (typeof choice === 'string') {
    if (choice === 'required') {
      return { mode: 'ANY' };
    }
    if (choice === 'none') {
      return { mode: 'NONE' };
    }
    return { mode: 'AUTO' };
  }
  if (choice?.type === 'function' && choice.name) {
    return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  }
  return { mode: 'AUTO' };
}

// ── Chat Completions messages ─────────────────────────────────────────────────

function convertChatMessage(
  message: ChatMessage,
  toolNames: Map<string, string>,
  model: string,
  unsigned: ReadonlySet<string>,
): GeminiPart[] {
  if (message.role === 'tool') {
    const name = (message.tool_call_id && toolNames.get(message.tool_call_id)) || message.name || 'tool';
    const output = chatText(message.content);
    // The call it answers was retold as text, and a functionResponse with no
    // functionCall before it is rejected just as hard as the bare call.
    if (message.tool_call_id && unsigned.has(message.tool_call_id)) {
      return [{ text: `[tool result] ${name}: ${output}` }];
    }
    return [{ functionResponse: { id: message.tool_call_id, name, response: { output } } }];
  }

  const parts: GeminiPart[] = [];
  const text = chatText(message.content);
  if (text !== '') {
    parts.push({ text });
  }

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url') {
        const inline = toInlineData(part.image_url);
        if (inline) {
          parts.push({ inlineData: inline });
        }
      }
    }
  }

  for (const call of message.tool_calls ?? []) {
    const args = parseArguments(call.function.arguments);
    if (unsigned.has(call.id)) {
      parts.push({ text: `[tool call] ${call.function.name}(${JSON.stringify(args)})` });
      continue;
    }
    parts.push({
      functionCall: { id: call.id, name: call.function.name, args },
      thoughtSignature: signatureStore.forToolCall(call.id, model),
    });
  }

  return parts;
}

function chatToolChoice(choice: ChatCompletionsRequest['tool_choice']) {
  if (typeof choice === 'string') {
    if (choice === 'required') {
      return { mode: 'ANY' };
    }
    if (choice === 'none') {
      return { mode: 'NONE' };
    }
    return { mode: 'AUTO' };
  }
  if (choice?.function?.name) {
    return { mode: 'ANY', allowedFunctionNames: [choice.function.name] };
  }
  return { mode: 'AUTO' };
}

function chatText(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => part.text ?? '')
    .filter((text) => text !== '')
    .join('');
}

// ── Shared ────────────────────────────────────────────────────────────────────

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim() === '') {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A malformed argument blob is still worth forwarding as context.
    return { _raw: raw };
  }
}

function outputText(output: ResponsesInputItem['output']): string {
  if (typeof output === 'string') {
    return output || '(no output)';
  }
  if (!Array.isArray(output)) {
    return '(no output)';
  }
  const text = output
    .map((part) => part.text ?? '')
    .filter((value) => value !== '')
    .join('\n');
  return text === '' ? '(no output)' : text;
}

/** Accept both a bare data URL and the `{url}` object form. */
function toInlineData(
  value: string | { url: string } | undefined,
): { mimeType: string; data: string } | undefined {
  const url = typeof value === 'string' ? value : value?.url;
  const match = url?.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return undefined;
  }
  return { mimeType: match[1], data: match[2] };
}
