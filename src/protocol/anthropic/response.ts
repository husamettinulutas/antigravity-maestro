import { GeminiResponse } from '../gemini';
import { signatureStore } from '../signatureStore';
import { prefixedId } from '../../utils/ids';
import { AnthropicContentBlock, AnthropicResponse, toStopReason } from './types';

/** Convert a complete Gemini response into an Anthropic message. */
export function toAnthropicResponse(response: GeminiResponse, model: string): AnthropicResponse {
  const candidate = response.candidates?.[0];
  const content: AnthropicContentBlock[] = [];
  let usedTool = false;

  for (const part of candidate?.content?.parts ?? []) {
    if (part.functionCall?.name) {
      // Reuse the upstream id when there is one, so replaying this call on the
      // next turn carries the id the upstream itself issued.
      const id = part.functionCall.id || prefixedId('toolu');
      signatureStore.rememberToolCall(id, part.thoughtSignature);
      content.push({
        type: 'tool_use',
        id,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
      usedTool = true;
      continue;
    }

    if (typeof part.text !== 'string' || part.text === '') {
      continue;
    }

    if (part.thought) {
      // A thinking block without a signature is rejected when replayed, so it
      // is downgraded to plain text rather than dropped.
      if (part.thoughtSignature) {
        content.push({
          type: 'thinking',
          thinking: part.text,
          signature: part.thoughtSignature,
        });
      } else {
        content.push({ type: 'text', text: part.text });
      }
      continue;
    }

    const last = content[content.length - 1];
    if (last?.type === 'text') {
      (last as any).text += part.text;
    } else {
      content.push({ type: 'text', text: part.text });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    id: prefixedId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: toStopReason(candidate?.finishReason, usedTool),
    stop_sequence: null,
    usage: {
      input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      cache_read_input_tokens: response.usageMetadata?.cachedContentTokenCount,
    },
  };
}
