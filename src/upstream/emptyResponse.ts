import { GeminiContent, GeminiRequest, GeminiResponse, UsageMetadata } from '../protocol/gemini';

/** Rough characters-per-token ratio, the same one the token count estimate uses. */
const CHARS_PER_TOKEN = 3.7;

/**
 * A turn that ended without an answer and cannot be closed as a finished one:
 * the upstream refused it, or the stream died before saying why it stopped.
 *
 * A model that simply had nothing to say is not one of these — see
 * `Silence` — because every client reads a failure as something to retry,
 * and retrying a model's decision to stop only buys the same silence again.
 */
export class EmptyResponseError extends Error {
  constructor(
    message: string,
    /** True when asking again could plausibly produce an answer. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmptyResponseError';
  }
}

/**
 * Finish reasons that explain the silence as a decision the upstream made.
 * Asking again would only reproduce it, so these are reported, not retried.
 */
const DELIBERATE = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
  'IMAGE_OTHER',
  'NO_IMAGE',
  'LANGUAGE',
  'MAX_TOKENS',
  'MISSING_THOUGHT_SIGNATURE',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
]);

/**
 * A tool call the model meant to make and got wrong. Unlike a deliberate stop
 * this is a slip in the sampling: asked again, and told what went wrong, the
 * model usually makes the call properly.
 */
const BROKEN_CALL = new Set(['MALFORMED_FUNCTION_CALL']);

/** How a stream that produced no answer ended, and so what it calls for. */
export type Silence =
  /**
   * The model stopped with nothing to say. After tool results this is how it
   * declares a task done: Anthropic documents the empty `end_turn` for Claude,
   * and Gemini 3 emits empty wrap-up turns on purpose. It is a finished turn,
   * not a fault, and the same request sent again gets the same decision.
   * `thought` is true when it reasoned before stopping.
   */
  | { kind: 'finished'; finishReason: string; thought: boolean }
  /** The model tried to call a tool and produced something unparseable. */
  | { kind: 'brokenCall'; message: string }
  /** The upstream declined to answer; asking again would reproduce it. */
  | { kind: 'refused'; message: string }
  /** The stream closed without a finish reason: cut off, not concluded. */
  | { kind: 'cutOff'; message: string };

/**
 * Follows a stream and, if it turns out to have carried no answer, says why.
 *
 * The reason decides everything that happens next. A response cut short by
 * `MAX_TOKENS`, one the model ended on purpose and one the connection dropped
 * all look the same to the caller — nothing arrived — and only the last is
 * worth sending again unchanged.
 */
export class EmptyResponseWatch {
  private answered = false;
  private thought = false;
  private finishReason: string | undefined;
  private finishMessage: string | undefined;
  private blockReason: string | undefined;
  private promptTokens = 0;
  private chunks = 0;

  /** Record what a chunk carried. */
  note(chunk: GeminiResponse): void {
    this.chunks += 1;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) {
      this.finishReason = candidate.finishReason;
    }
    if (candidate?.finishMessage) {
      this.finishMessage = candidate.finishMessage;
    }
    if (chunk.promptFeedback?.blockReason) {
      this.blockReason = chunk.promptFeedback.blockReason;
    }
    this.promptTokens = Math.max(this.promptTokens, chunk.usageMetadata?.promptTokenCount ?? 0);

    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall?.name) {
        this.answered = true;
      } else if (typeof part.text === 'string' && part.text !== '') {
        if (part.thought) {
          this.thought = true;
        } else {
          this.answered = true;
        }
      }
    }
  }

  /** True once the stream has carried text or a tool call. */
  get sawAnswer(): boolean {
    return this.answered;
  }

  /**
   * Why the stream ended without an answer, or `undefined` when it gave one.
   *
   * `model` lets an overlong prompt be told apart: the upstream answers one
   * with an ordinary-looking empty `STOP`, and only its own prompt token count
   * shows the silence has a cause no retry can remove.
   */
  silence(model?: { id: string; maxInputTokens: number }): Silence | undefined {
    if (this.answered) {
      return undefined;
    }

    if (this.blockReason) {
      return {
        kind: 'refused',
        message: `Antigravity blocked the prompt (${this.blockReason}) and returned no response.`,
      };
    }

    const tooLong = model && overlongResponse({ promptTokenCount: this.promptTokens }, model);
    if (tooLong) {
      return { kind: 'refused', message: tooLong };
    }

    const reason = this.finishReason;
    const explained = this.finishMessage ? `: ${this.finishMessage}` : '';
    if (reason && DELIBERATE.has(reason)) {
      return {
        kind: 'refused',
        message: `Antigravity returned no response (finish reason: ${reason}${explained}).`,
      };
    }
    if (reason && BROKEN_CALL.has(reason)) {
      return {
        kind: 'brokenCall',
        message: `Antigravity could not form a valid tool call (finish reason: ${reason}${explained}).`,
      };
    }
    if (reason) {
      return { kind: 'finished', finishReason: reason, thought: this.thought };
    }

    return {
      kind: 'cutOff',
      message:
        `Antigravity returned an empty response (${this.chunks} ` +
        `chunk${this.chunks === 1 ? '' : 's'}, none with content, no finish reason).`,
    };
  }
}

/**
 * What the model is told when it ended a turn with nothing to say.
 *
 * gemini-cli sends nearly the same words in the same situation; the escape
 * hatch at the end matters, because the usual reason for the silence is that
 * the work is done, and a bare "continue" would talk the model into more.
 */
export const CONTINUE_NUDGE =
  '[System: Your previous response was empty. Continue with the task: call a tool, ' +
  'or, if the task is complete, reply with a brief summary of what was done.]';

/** What the model is told when the tool call it made could not be parsed. */
export const BROKEN_CALL_NUDGE =
  '[System: Your previous tool call was malformed and could not be parsed. ' +
  'Call the tool again with valid arguments.]';

/**
 * The same request with `nudge` appended as a new user turn.
 *
 * A request that came back empty cannot be fixed by sending it again: the
 * model has already decided, and Anthropic's guidance for exactly this case is
 * to add a continuation prompt in a new user message rather than retry. After a
 * turn of tool results a short model turn goes in between, as gemini-cli does,
 * so the roles still alternate the way Gemini requires.
 *
 * Only the upstream sees the nudge; the client's history never contains it.
 */
export function withNudge(request: GeminiRequest, nudge: string): GeminiRequest {
  const contents: GeminiContent[] = [...request.contents];
  const last = contents[contents.length - 1];

  if (last?.role === 'user' && last.parts.some((part) => part.functionResponse)) {
    contents.push({ role: 'model', parts: [{ text: '[Tool execution completed.]' }] });
    contents.push({ role: 'user', parts: [{ text: nudge }] });
  } else if (last?.role === 'user') {
    contents[contents.length - 1] = { ...last, parts: [...last.parts, { text: nudge }] };
  } else {
    contents.push({ role: 'user', parts: [{ text: nudge }] });
  }

  return { ...request, contents };
}

/**
 * The request to send after a silence, or `undefined` when there is nothing to
 * gain from asking again.
 *
 * A finished turn is nudged once, and only when no reasoning was shown — the
 * thoughts would be shown a second time otherwise, for a model that has most
 * likely just said it is done. A cut-off stream is sent again unchanged,
 * because nothing was decided: the stream simply never finished.
 */
export function retryAfter(silence: Silence, request: GeminiRequest): GeminiRequest | undefined {
  switch (silence.kind) {
    case 'finished':
      return silence.thought ? undefined : withNudge(request, CONTINUE_NUDGE);
    case 'brokenCall':
      return withNudge(request, BROKEN_CALL_NUDGE);
    case 'cutOff':
      return request;
    case 'refused':
      return undefined;
  }
}

/** One line for the log: what the silence was, and what was asked. */
export function describeSilence(silence: Silence): string {
  switch (silence.kind) {
    case 'finished':
      return (
        `the model ended its turn with nothing to say (finish reason: ${silence.finishReason}` +
        `${silence.thought ? ', after thinking' : ''})`
      );
    case 'brokenCall':
    case 'refused':
    case 'cutOff':
      return silence.message;
  }
}

/**
 * How the conversation a request carries ends, e.g. `user[functionResponse:
 * task_complete]` — the part that decides whether a model has anything left to
 * say, and the first thing to look at when it has not.
 */
export function describeTail(request: GeminiRequest): string {
  const last = request.contents[request.contents.length - 1];
  if (!last) {
    return '(no contents)';
  }
  const parts = last.parts.map((part) => {
    if (part.functionResponse) {
      return `functionResponse:${part.functionResponse.name}`;
    }
    if (part.functionCall) {
      return `functionCall:${part.functionCall.name}`;
    }
    if (part.inlineData) {
      return 'inlineData';
    }
    return part.thought ? 'thought' : 'text';
  });
  return `${last.role}[${parts.join(', ')}]`;
}

/**
 * How far past its input limit a request has to measure before it is refused
 * unsent.
 *
 * `CHARS_PER_TOKEN` is a rough ratio, not a tokenizer, so this is deliberately
 * loose: it only stops a request that no estimation error could explain away.
 * A prompt a few percent over the limit is sent, and `overlongResponse` catches
 * it afterwards using the count the upstream itself reports — exact, where this
 * is a guess.
 */
const INPUT_LIMIT_MARGIN = 1.5;

/**
 * The reason to refuse a request outright, or `undefined` when it is worth
 * sending.
 *
 * A prompt past the model's input limit is not rejected upstream. The request
 * is accepted, billed in full, and the stream closes with `finishReason: STOP`
 * and nothing in it — so the client sees an empty answer, retries, and pays
 * again for the same silence.
 */
export function overlongPrompt(
  characters: number,
  model: { id: string; maxInputTokens: number },
): string | undefined {
  if (!(model.maxInputTokens > 0)) {
    return undefined;
  }

  const estimate = Math.ceil(characters / CHARS_PER_TOKEN);
  return estimate > model.maxInputTokens * INPUT_LIMIT_MARGIN
    ? tooLongMessage(estimate, model, 'was not sent')
    : undefined;
}

/**
 * The same failure, recognised after the fact from what the upstream counted.
 *
 * This is the one that catches the ordinary case: a conversation that has crept
 * a few percent past the limit, which the character estimate cannot tell from
 * one comfortably inside it. `promptTokenCount` is the upstream's own figure,
 * so when it exceeds the model's limit the silence is explained — and asking
 * again would only buy the same silence at the same price, which is why the
 * failure it produces is not retryable.
 */
export function overlongResponse(
  usage: UsageMetadata | undefined,
  model: { id: string; maxInputTokens: number },
): string | undefined {
  const counted = usage?.promptTokenCount;
  if (!counted || !(model.maxInputTokens > 0) || counted <= model.maxInputTokens) {
    return undefined;
  }
  return tooLongMessage(counted, model, 'was billed and answered with nothing');
}

function tooLongMessage(
  tokens: number,
  model: { id: string; maxInputTokens: number },
  outcome: string,
): string {
  return (
    `This conversation is ${thousands(tokens)} tokens, past what ${model.id} accepts ` +
    `(${thousands(model.maxInputTokens)}), so it ${outcome}. Start a new chat, or pick ` +
    'a model with a larger context.'
  );
}

function thousands(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}
