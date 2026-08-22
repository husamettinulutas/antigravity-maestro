import { GeminiPart, GeminiResponse, UsageMetadata } from '../gemini';
import { signatureStore } from '../signatureStore';
import { prefixedId } from '../../utils/ids';
import { formatSse } from '../../utils/sse';

type ItemKind = 'message' | 'reasoning' | 'function_call';

interface OutputItem {
  id: string;
  type: ItemKind;
  status: string;
  role?: string;
  content?: { type: string; text: string; annotations: unknown[] }[];
  summary?: { type: string; text: string }[];
  name?: string;
  arguments?: string;
  call_id?: string;
}

/**
 * Emits the OpenAI Responses event stream that Codex consumes.
 *
 * Codex renders text from `response.output_text.delta`, reasoning from the
 * *summary* events (it ignores raw reasoning deltas), and executes tools from
 * completed `function_call` items — so each Gemini part is materialised as a
 * full output item with its own added/delta/done sequence.
 */
export class ResponsesStreamMapper {
  private sequence = 0;
  private outputIndex = -1;
  private current: OutputItem | undefined;
  private buffer = '';
  private readonly output: OutputItem[] = [];
  private usage: UsageMetadata = {};
  private readonly responseId = prefixedId('resp');

  constructor(private readonly model: string) {}

  start(): string {
    return (
      this.emit('response.created', { response: this.snapshot('in_progress') }) +
      this.emit('response.in_progress', { response: this.snapshot('in_progress') })
    );
  }

  push(chunk: GeminiResponse): string {
    let out = '';
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      out += this.pushPart(part);
    }
    if (chunk.usageMetadata) {
      this.usage = { ...this.usage, ...chunk.usageMetadata };
    }
    return out;
  }

  finish(): string {
    return (
      this.closeItem() +
      this.emit('response.completed', { response: this.snapshot('completed') })
    );
  }

  error(message: string): string {
    return (
      this.closeItem() +
      this.emit('response.failed', {
        response: { ...this.snapshot('failed'), error: { code: 'server_error', message } },
      })
    );
  }

  usageMetadata(): UsageMetadata {
    return this.usage;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private pushPart(part: GeminiPart): string {
    if (part.functionCall?.name) {
      return this.emitFunctionCall(part);
    }
    if (typeof part.text !== 'string' || part.text === '') {
      return '';
    }
    return part.thought ? this.pushReasoning(part.text) : this.pushText(part.text);
  }

  private pushText(text: string): string {
    let out = this.openItem('message', () => ({
      id: prefixedId('msg'),
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    }));

    if (out !== '') {
      out += this.emit('response.content_part.added', {
        item_id: this.current!.id,
        output_index: this.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }

    this.buffer += text;
    out += this.emit('response.output_text.delta', {
      item_id: this.current!.id,
      output_index: this.outputIndex,
      content_index: 0,
      delta: text,
    });
    return out;
  }

  private pushReasoning(text: string): string {
    let out = this.openItem('reasoning', () => ({
      id: prefixedId('rs'),
      type: 'reasoning',
      status: 'in_progress',
      summary: [],
    }));

    if (out !== '') {
      out += this.emit('response.reasoning_summary_part.added', {
        item_id: this.current!.id,
        output_index: this.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
    }

    this.buffer += text;
    out += this.emit('response.reasoning_summary_text.delta', {
      item_id: this.current!.id,
      output_index: this.outputIndex,
      summary_index: 0,
      delta: text,
    });
    return out;
  }

  private emitFunctionCall(part: GeminiPart): string {
    const callId = prefixedId('call');
    signatureStore.rememberToolCall(callId, part.thoughtSignature);
    const args = JSON.stringify(part.functionCall!.args ?? {});

    let out = this.closeItem();
    this.outputIndex += 1;
    this.current = {
      id: prefixedId('fc'),
      type: 'function_call',
      status: 'in_progress',
      name: part.functionCall!.name,
      arguments: '',
      call_id: callId,
    };
    this.buffer = args;

    out += this.emit('response.output_item.added', {
      output_index: this.outputIndex,
      item: this.current,
    });
    // Gemini delivers complete arguments, so the whole blob arrives at once.
    out += this.emit('response.function_call_arguments.delta', {
      item_id: this.current.id,
      output_index: this.outputIndex,
      delta: args,
    });
    out += this.closeItem();
    return out;
  }

  /** Start a new item of `kind`, closing any other item first. */
  private openItem(kind: ItemKind, create: () => OutputItem): string {
    if (this.current?.type === kind) {
      return '';
    }
    let out = this.closeItem();
    this.outputIndex += 1;
    this.current = create();
    this.buffer = '';
    out += this.emit('response.output_item.added', {
      output_index: this.outputIndex,
      item: this.current,
    });
    return out;
  }

  private closeItem(): string {
    const item = this.current;
    if (!item) {
      return '';
    }
    this.current = undefined;
    let out = '';

    if (item.type === 'message') {
      item.content = [{ type: 'output_text', text: this.buffer, annotations: [] }];
      out += this.emit('response.output_text.done', {
        item_id: item.id,
        output_index: this.outputIndex,
        content_index: 0,
        text: this.buffer,
      });
      out += this.emit('response.content_part.done', {
        item_id: item.id,
        output_index: this.outputIndex,
        content_index: 0,
        part: item.content[0],
      });
    } else if (item.type === 'reasoning') {
      item.summary = [{ type: 'summary_text', text: this.buffer }];
      out += this.emit('response.reasoning_summary_text.done', {
        item_id: item.id,
        output_index: this.outputIndex,
        summary_index: 0,
        text: this.buffer,
      });
      out += this.emit('response.reasoning_summary_part.done', {
        item_id: item.id,
        output_index: this.outputIndex,
        summary_index: 0,
        part: item.summary[0],
      });
    } else {
      item.arguments = this.buffer;
      out += this.emit('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: this.outputIndex,
        arguments: this.buffer,
      });
    }

    item.status = 'completed';
    this.output.push(item);
    this.buffer = '';
    out += this.emit('response.output_item.done', {
      output_index: this.outputIndex,
      item,
    });
    return out;
  }

  private snapshot(status: string) {
    return {
      id: this.responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: this.model,
      output: this.output,
      parallel_tool_calls: true,
      tool_choice: 'auto',
      tools: [],
      usage: toResponsesUsage(this.usage),
    };
  }

  private emit(type: string, payload: Record<string, unknown>): string {
    this.sequence += 1;
    return formatSse(type, { type, sequence_number: this.sequence, ...payload });
  }
}

/** Build the non-streaming Responses payload from a complete Gemini response. */
export function toResponsesResponse(response: GeminiResponse, model: string) {
  const output: OutputItem[] = [];
  let text = '';
  let reasoning = '';

  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.functionCall?.name) {
      const callId = prefixedId('call');
      signatureStore.rememberToolCall(callId, part.thoughtSignature);
      output.push({
        id: prefixedId('fc'),
        type: 'function_call',
        status: 'completed',
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
        call_id: callId,
      });
      continue;
    }
    if (typeof part.text !== 'string' || part.text === '') {
      continue;
    }
    if (part.thought) {
      reasoning += part.text;
    } else {
      text += part.text;
    }
  }

  if (reasoning !== '') {
    output.unshift({
      id: prefixedId('rs'),
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }
  if (text !== '') {
    output.push({
      id: prefixedId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  return {
    id: prefixedId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: toResponsesUsage(response.usageMetadata ?? {}),
  };
}

function toResponsesUsage(usage: UsageMetadata) {
  const input = usage.promptTokenCount ?? 0;
  const output = usage.candidatesTokenCount ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cachedContentTokenCount ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage.thoughtsTokenCount ?? 0 },
    total_tokens: usage.totalTokenCount ?? input + output,
  };
}
