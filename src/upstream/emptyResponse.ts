import { GeminiResponse, UsageMetadata } from '../protocol/gemini';

/** Rough characters-per-token ratio, the same one the token count estimate uses. */
const CHARS_PER_TOKEN = 3.7;

/**
 * A stream that ended without producing a single word, tool call or thought.
 *
 * The upstream does this without ever failing: the request is accepted, the
 * SSE stream opens, a chunk or two of bookkeeping goes by, and the stream
 * closes with no content in it. Every client reads that as the model having
 * nothing to say — Copilot Chat prints "Sorry, no response was returned", and
 * the agents retry until they give up — so it is turned into a failure here,
 * where it can be retried or reported for what it is.
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
  'LANGUAGE',
  'MALFORMED_FUNCTION_CALL',
  'MAX_TOKENS',
]);

/**
 * Follows a stream and, if it turns out to have carried no content, says why.
 *
 * The reason is worth keeping: a response cut short by `MAX_TOKENS` and one
 * that simply arrived empty look identical to the caller, and only the second
 * is worth asking again.
 */
export class EmptyResponseWatch {
  private produced = false;
  private finishReason: string | undefined;
  private blockReason: string | undefined;
  private chunks = 0;

  /** Record what a chunk carried. */
  note(chunk: GeminiResponse): void {
    this.chunks += 1;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) {
      this.finishReason = candidate.finishReason;
    }
    if (chunk.promptFeedback?.blockReason) {
      this.blockReason = chunk.promptFeedback.blockReason;
    }
    if (hasContent(chunk)) {
      this.produced = true;
    }
  }

  /** Called when the caller emits content the chunks alone do not show. */
  markProduced(): void {
    this.produced = true;
  }

  get sawContent(): boolean {
    return this.produced;
  }

  /**
   * The failure for a stream that ended empty, or `undefined` when it did
   * produce something.
   */
  failure(): EmptyResponseError | undefined {
    if (this.produced) {
      return undefined;
    }

    if (this.blockReason) {
      return new EmptyResponseError(
        `Antigravity blocked the prompt (${this.blockReason}) and returned no response.`,
        false,
      );
    }

    if (this.finishReason && DELIBERATE.has(this.finishReason)) {
      return new EmptyResponseError(
        `Antigravity returned no response (finish reason: ${this.finishReason}).`,
        false,
      );
    }

    const detail = this.finishReason
      ? `finish reason: ${this.finishReason}`
      : `${this.chunks} chunk${this.chunks === 1 ? '' : 's'}, none with content`;
    return new EmptyResponseError(
      `Antigravity returned an empty response (${detail}).`,
      true,
    );
  }
}

/** True when a chunk carries something a user would see. */
export function hasContent(chunk: GeminiResponse): boolean {
  for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
    if (part.functionCall?.name) {
      return true;
    }
    if (typeof part.text === 'string' && part.text !== '') {
      return true;
    }
  }
  return false;
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
