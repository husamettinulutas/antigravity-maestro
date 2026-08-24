import { GeminiPart, GeminiResponse, UsageMetadata } from '../gemini';
import { signatureStore } from '../signatureStore';
import { prefixedId } from '../../utils/ids';
import { formatSse } from '../../utils/sse';
import { toStopReason } from './types';

type BlockType = 'text' | 'thinking' | 'tool_use' | null;

/**
 * Turns the Gemini stream into the Anthropic SSE event sequence Claude Code
 * expects: message_start → (content_block_start → deltas → content_block_stop)*
 * → message_delta → message_stop.
 */
export class AnthropicStreamMapper {
  private blockIndex = -1;
  private openBlock: BlockType = null;
  private usedTool = false;
  private finishReason: string | undefined;
  private usage: UsageMetadata = {};
  private readonly messageId = prefixedId('msg');

  constructor(private readonly model: string) {}

  /** Opening events, sent before any upstream chunk arrives. */
  start(): string {
    return (
      formatSse('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }) + formatSse('ping', { type: 'ping' })
    );
  }

  /** Events for one upstream chunk. */
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

  /** Closing events. Safe to call once, after the upstream stream ends. */
  finish(): string {
    return (
      this.closeBlock() +
      formatSse('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: toStopReason(this.finishReason, this.usedTool),
          stop_sequence: null,
        },
        usage: { output_tokens: this.usage.candidatesTokenCount ?? 0 },
      }) +
      formatSse('message_stop', { type: 'message_stop' })
    );
  }

  /** An error event plus a clean close, so the client never hangs. */
  error(message: string, type = 'api_error'): string {
    return (
      this.closeBlock() +
      formatSse('error', { type: 'error', error: { type, message } }) +
      formatSse('message_stop', { type: 'message_stop' })
    );
  }

  /** Token usage seen so far, for the usage history. */
  usageMetadata(): UsageMetadata {
    return this.usage;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private pushPart(part: GeminiPart): string {
    if (part.functionCall?.name) {
      return this.emitToolCall(part);
    }

    if (typeof part.text !== 'string' || part.text === '') {
      // A signature can arrive on its own part, attached to the block in flight.
      return part.thoughtSignature && this.openBlock === 'thinking'
        ? this.emitDelta({ type: 'signature_delta', signature: part.thoughtSignature })
        : '';
    }

    if (part.thought) {
      let out = this.openBlockOfType('thinking', { type: 'thinking', thinking: '' });
      out += this.emitDelta({ type: 'thinking_delta', thinking: part.text });
      if (part.thoughtSignature) {
        // Must reach the client before the block closes.
        out += this.emitDelta({ type: 'signature_delta', signature: part.thoughtSignature });
      }
      return out;
    }

    let out = this.openBlockOfType('text', { type: 'text', text: '' });
    out += this.emitDelta({ type: 'text_delta', text: part.text });
    return out;
  }

  private emitToolCall(part: GeminiPart): string {
    // Reuse the upstream id when there is one, so replaying this call on the
    // next turn carries the id the upstream itself issued.
    const id = part.functionCall!.id || prefixedId('toolu');
    signatureStore.rememberToolCall(id, part.thoughtSignature);
    this.usedTool = true;

    // Gemini delivers complete arguments, so the block opens, streams its JSON
    // in one delta, and closes immediately.
    let out = this.closeBlock();
    this.blockIndex += 1;
    this.openBlock = 'tool_use';
    out += formatSse('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: { type: 'tool_use', id, name: part.functionCall!.name, input: {} },
    });
    out += this.emitDelta({
      type: 'input_json_delta',
      partial_json: JSON.stringify(part.functionCall!.args ?? {}),
    });
    out += this.closeBlock();
    return out;
  }

  private openBlockOfType(type: Exclude<BlockType, null>, contentBlock: unknown): string {
    if (this.openBlock === type) {
      return '';
    }
    let out = this.closeBlock();
    this.blockIndex += 1;
    this.openBlock = type;
    out += formatSse('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: contentBlock,
    });
    return out;
  }

  private emitDelta(delta: Record<string, unknown>): string {
    return formatSse('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta,
    });
  }

  private closeBlock(): string {
    if (this.openBlock === null) {
      return '';
    }
    this.openBlock = null;
    return formatSse('content_block_stop', {
      type: 'content_block_stop',
      index: this.blockIndex,
    });
  }
}
