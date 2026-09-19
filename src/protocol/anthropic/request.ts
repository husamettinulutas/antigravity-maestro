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
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from './types';

export interface AnthropicConversion {
  request: GeminiRequest;
  /** Requested thinking budget, before the model's own limits are applied. */
  requestedThinkingBudget?: number;
}

/**
 * Translate an Anthropic Messages request into the Gemini request the Cloud
 * Code endpoints expect.
 *
 * The subtle part is thought signatures: the upstream issues one with every
 * reasoning block and tool call, and rejects a follow-up turn that replays the
 * tool call without it. Claude Code round-trips signatures on `thinking`
 * blocks but not on `tool_use`, so they are recovered from the signature store.
 *
 * `model` is the upstream model the request is bound for. It decides which
 * stored signatures may be replayed — one family's signature is not valid for
 * another — and which calls have to be retold as text because none survives.
 */
export function toGeminiRequest(
  anthropic: AnthropicRequest,
  model = 'gemini',
  requiresSignature = false,
): AnthropicConversion {
  const toolNames = collectToolNames(anthropic.messages);
  const unsigned = unsignedToolUseIds(anthropic.messages, model, requiresSignature);
  const contents: GeminiContent[] = [];

  for (const message of anthropic.messages) {
    const parts =
      message.role === 'assistant'
        ? convertAssistantContent(message, model, unsigned)
        : convertUserContent(message, toolNames, unsigned);

    if (parts.length === 0) {
      continue;
    }

    const role: GeminiContent['role'] = message.role === 'assistant' ? 'model' : 'user';
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
      temperature: anthropic.temperature,
      topP: anthropic.top_p,
      topK: anthropic.top_k,
      maxOutputTokens: anthropic.max_tokens,
      stopSequences: anthropic.stop_sequences?.length ? anthropic.stop_sequences : undefined,
    },
  };

  const systemText = extractSystemText(anthropic.system);
  if (systemText !== '') {
    request.systemInstruction = { parts: [{ text: systemText }] };
  }

  if (anthropic.tools && anthropic.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: anthropic.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: sanitizeToolSchema(tool.input_schema),
        })),
      },
    ];
    request.toolConfig = { functionCallingConfig: toolChoiceOf(anthropic) };
  }

  const requestedThinkingBudget =
    anthropic.thinking?.type === 'enabled' ? (anthropic.thinking.budget_tokens ?? -1) : undefined;

  return { request: pruneUndefined(request), requestedThinkingBudget };
}

// ── Content conversion ────────────────────────────────────────────────────────

function convertAssistantContent(
  message: AnthropicMessage,
  model: string,
  unsigned: ReadonlySet<string>,
): GeminiPart[] {
  const blocks = asBlocks(message.content);
  const parts: GeminiPart[] = [];
  /** Signature from the most recent thinking block, reused for tool calls. */
  let pendingSignature: string | undefined;

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        const text = String((block as any).text ?? '');
        if (text !== '') {
          parts.push({ text });
        }
        break;
      }
      case 'thinking': {
        const thinking = String((block as any).thinking ?? '');
        const signature = (block as any).signature as string | undefined;
        pendingSignature = signature ?? pendingSignature;
        if (thinking === '') {
          break;
        }
        // The upstream rejects a replayed thought whose signature is missing,
        // so an unsigned one is degraded to plain text instead of dropped.
        if (signature && signature.length >= 10) {
          parts.push({ text: thinking, thought: true, thoughtSignature: signature });
        } else {
          parts.push({ text: thinking });
        }
        break;
      }
      case 'redacted_thinking':
        // Nothing usable upstream; the signature it carried is already gone.
        break;
      case 'tool_use': {
        const toolUse = block as AnthropicToolUseBlock;
        if (unsigned.has(toolUse.id)) {
          // No signature this model would accept. Retold rather than replayed:
          // see `unsignedToolUseIds`.
          const args = JSON.stringify(toolUse.input ?? {});
          parts.push({ text: `[tool call] ${toolUse.name}(${args})` });
          break;
        }
        parts.push({
          // The id is required: for the Claude models the upstream turns this
          // back into an Anthropic `tool_use` block and rejects the whole
          // request when it has none.
          functionCall: { id: toolUse.id, name: toolUse.name, args: toolUse.input ?? {} },
          thoughtSignature: signatureStore.forToolCall(toolUse.id, model) ?? pendingSignature,
        });
        break;
      }
      default:
        break;
    }
  }

  return parts;
}

function convertUserContent(
  message: AnthropicMessage,
  toolNames: Map<string, string>,
  unsigned: ReadonlySet<string>,
): GeminiPart[] {
  const parts: GeminiPart[] = [];

  for (const block of asBlocks(message.content)) {
    switch (block.type) {
      case 'text': {
        const text = String((block as any).text ?? '');
        if (text !== '') {
          parts.push({ text });
        }
        break;
      }
      case 'image': {
        const source = (block as any).source;
        if (source?.type === 'base64' && source.data) {
          parts.push({
            inlineData: { mimeType: source.media_type ?? 'image/png', data: source.data },
          });
        }
        break;
      }
      case 'tool_result': {
        const result = block as AnthropicToolResultBlock;
        const name = toolNames.get(result.tool_use_id) ?? 'tool';
        const output = flattenToolResult(result.content);
        // The call it answers was retold as text, and a functionResponse with
        // no functionCall before it is rejected just as hard as the bare call.
        if (unsigned.has(result.tool_use_id)) {
          parts.push({ text: `[tool result] ${name}: ${output}` });
          break;
        }
        parts.push({
          functionResponse: {
            id: result.tool_use_id,
            name,
            response: result.is_error ? { error: output } : { output },
          },
        });
        break;
      }
      default:
        break;
    }
  }

  return parts;
}

/**
 * The tool calls that cannot be replayed to `model` as tool calls.
 *
 * Gemini 3 rejects the whole request — HTTP 400, "Function call is missing a
 * thought_signature" — when a replayed `functionCall` carries no signature it
 * issued. Claude Code round-trips the signature on the `thinking` block that
 * preceded the call, and the store keeps the rest, but neither survives a
 * switch to another model family, a gateway restart, or an hour of idling.
 *
 * Dropping those calls would orphan their results; sending them bare fails the
 * turn. So they are retold as text, which keeps the history readable and the
 * request valid. The set is computed up front because a call and its result
 * are converted in separate passes and the two decisions have to agree.
 *
 * Only Gemini needs this: the Claude and GPT models are served by translating
 * the request back out of the Gemini shape, and an unsigned call survives it.
 */
function unsignedToolUseIds(
  messages: AnthropicMessage[],
  model: string,
  requiresSignature: boolean,
): ReadonlySet<string> {
  const unsigned = new Set<string>();
  if (!requiresSignature || signatureFamilyOf(model) !== 'gemini') {
    return unsigned;
  }

  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    // Mirrors the walk in `convertAssistantContent`: a tool call falls back to
    // the signature of the thinking block ahead of it in the same turn.
    let pendingSignature: string | undefined;
    for (const block of asBlocks(message.content)) {
      if (block.type === 'thinking') {
        const signature = (block as any).signature as string | undefined;
        pendingSignature = signature ?? pendingSignature;
        continue;
      }
      if (block.type !== 'tool_use') {
        continue;
      }
      const toolUse = block as AnthropicToolUseBlock;
      if (!signatureStore.forToolCall(toolUse.id, model) && !pendingSignature) {
        unsigned.add(toolUse.id);
      }
    }
  }
  return unsigned;
}

/** tool_use_id → tool name, so tool results can be named for Gemini. */
function collectToolNames(messages: AnthropicMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of asBlocks(message.content)) {
      if (block.type === 'tool_use') {
        const toolUse = block as AnthropicToolUseBlock;
        names.set(toolUse.id, toolUse.name);
      }
    }
  }
  return names;
}

function flattenToolResult(content: AnthropicToolResultBlock['content']): string {
  if (typeof content === 'string') {
    return content || '(no output)';
  }
  if (!Array.isArray(content)) {
    return '(no output)';
  }

  const text = content
    .map((block) => {
      if (block.type === 'text') {
        return String((block as any).text ?? '');
      }
      if (block.type === 'image') {
        return '[image omitted]';
      }
      return '';
    })
    .filter((value) => value !== '')
    .join('\n');

  return text === '' ? '(no output)' : text;
}

function extractSystemText(system: AnthropicRequest['system']): string {
  if (!system) {
    return '';
  }
  if (typeof system === 'string') {
    return system;
  }
  return system
    .map((block) => (block.type === 'text' ? String((block as any).text ?? '') : ''))
    .filter((value) => value !== '')
    .join('\n\n');
}

function toolChoiceOf(anthropic: AnthropicRequest): {
  mode: string;
  allowedFunctionNames?: string[];
} {
  switch (anthropic.tool_choice?.type) {
    case 'any':
      return { mode: 'ANY' };
    case 'tool':
      return {
        mode: 'ANY',
        allowedFunctionNames: anthropic.tool_choice.name ? [anthropic.tool_choice.name] : undefined,
      };
    case 'none':
      return { mode: 'NONE' };
    default:
      return { mode: 'AUTO' };
  }
}

function asBlocks(content: AnthropicMessage['content']): AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? content : [];
}
