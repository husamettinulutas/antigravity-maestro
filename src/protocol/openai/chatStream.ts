import { GeminiPart, GeminiResponse, UsageMetadata } from '../gemini';
import { signatureStore } from '../signatureStore';
import { prefixedId } from '../../utils/ids';
import { ChatToolCall, toFinishReason } from './types';

/**
 * Chat Completions mapper. Codex uses the Responses protocol, but generic
 * OpenAI clients (and quick curl checks) speak this one, so the gateway serves
 * both from the same upstream stream.
 */
export class ChatStreamMapper {
  private readonly id = prefixedId('chatcmpl');
  private readonly created = Math.floor(Date.now() / 1000);
  private toolIndex = -1;
  private usedTool = false;
  private finishReason: string | undefined;
  private usage: UsageMetadata = {};
  private roleSent = false;

  constructor(private readonly model: string) {}

  push(chunk: GeminiResponse): string {
    let out = '';
    const candidate = chunk.candidates?.[0];

    for (const part of candidate?.content?.parts ?? []) {
      out += this.pushPart(part);
    }
    if (candidate?.finishReason) {
      this.finishReason = candidate.finishReason;
    }
    if (chunk.usageMetadata) {
      this.usage = { ...this.usage, ...chunk.usageMetadata };
    }
    return out;
  }

  finish(includeUsage: boolean): string {
    let out = this.chunk({ delta: {}, finish_reason: toFinishReason(this.finishReason, this.usedTool) });
    if (includeUsage) {
      out += this.chunk(undefined, {
        prompt_tokens: this.usage.promptTokenCount ?? 0,
        completion_tokens: this.usage.candidatesTokenCount ?? 0,
        total_tokens:
          this.usage.totalTokenCount ??
          (this.usage.promptTokenCount ?? 0) + (this.usage.candidatesTokenCount ?? 0),
      });
    }
    return `${out}data: [DONE]\n\n`;
  }

  error(message: string): string {
    return `${this.chunk({ delta: { content: `\n\n[error] ${message}` }, finish_reason: 'stop' })}data: [DONE]\n\n`;
  }

  usageMetadata(): UsageMetadata {
    return this.usage;
  }

  private pushPart(part: GeminiPart): string {
    if (part.functionCall?.name) {
      // Reuse the upstream id when there is one, so the replayed call keeps it.
      const id = part.functionCall.id || prefixedId('call');
      signatureStore.rememberToolCall(id, part.thoughtSignature);
      this.usedTool = true;
      this.toolIndex += 1;
      return this.chunk({
        delta: {
          ...this.rolePrefix(),
          tool_calls: [
            {
              index: this.toolIndex,
              id,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              },
            },
          ],
        },
      });
    }

    if (typeof part.text !== 'string' || part.text === '') {
      return '';
    }

    // Reasoning is exposed under the field OpenAI-compatible gateways use for
    // it; clients that do not know the field simply ignore it.
    const delta = part.thought
      ? { ...this.rolePrefix(), reasoning_content: part.text }
      : { ...this.rolePrefix(), content: part.text };
    return this.chunk({ delta });
  }

  private rolePrefix(): { role?: string } {
    if (this.roleSent) {
      return {};
    }
    this.roleSent = true;
    return { role: 'assistant' };
  }

  private chunk(
    choice: { delta: Record<string, unknown>; finish_reason?: string } | undefined,
    usage?: Record<string, number>,
  ): string {
    const payload = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: choice
        ? [{ index: 0, delta: choice.delta, finish_reason: choice.finish_reason ?? null }]
        : [],
      usage: usage ?? undefined,
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }
}

/** Build a non-streaming Chat Completions response. */
export function toChatCompletion(response: GeminiResponse, model: string) {
  const toolCalls: ChatToolCall[] = [];
  let content = '';
  let reasoning = '';

  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.functionCall?.name) {
      // Reuse the upstream id when there is one, so the replayed call keeps it.
      const id = part.functionCall.id || prefixedId('call');
      signatureStore.rememberToolCall(id, part.thoughtSignature);
      toolCalls.push({
        id,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
      continue;
    }
    if (typeof part.text !== 'string' || part.text === '') {
      continue;
    }
    if (part.thought) {
      reasoning += part.text;
    } else {
      content += part.text;
    }
  }

  const usage = response.usageMetadata ?? {};
  return {
    id: prefixedId('chatcmpl'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content === '' ? null : content,
          reasoning_content: reasoning === '' ? undefined : reasoning,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toFinishReason(response.candidates?.[0]?.finishReason, toolCalls.length > 0),
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens:
        usage.totalTokenCount ?? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0),
    },
  };
}
