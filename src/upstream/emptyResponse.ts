import { GeminiResponse } from '../protocol/gemini';

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
