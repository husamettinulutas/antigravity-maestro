import { GeminiResponse } from '../protocol/gemini';

/**
 * The upstream's answer for a model it has withdrawn, e.g. "Gemini 3.5 Flash
 * is no longer available. Please switch to Gemini 3.7 Flash in the latest
 * version of Antigravity."
 *
 * It comes back as an ordinary answer, not an error, and the model table keeps
 * listing the model with a full quota reading — nothing in the model list
 * marks it — so this sentence is the only notice the withdrawal ever gets.
 *
 * Each name is held to what a model name is made of — "Gemini 3.5 Flash" —
 * so an answer that quotes the notice inside a sentence of its own is still
 * an answer.
 */
const NOTICE =
  /^\s*([A-Za-z][\w .()-]{0,60}?) is no longer available\.(?:\s*Please switch to ([A-Za-z][\w .()-]{0,60}?)(?: in the latest version of Antigravity)?\.?)?\s*$/i;

/** Longer than any notice; past this a text is an answer, not a notice. */
const MAX_NOTICE_LENGTH = 400;

/** How much text is held back before an answer is known not to be a notice. */
const NOTICE_LEAD = 120;

export interface RetirementNotice {
  retiredName: string;
  successorName?: string;
  text: string;
}

/** The notice in a complete answer's text, if that is all the answer is. */
export function retirementNotice(text: string): RetirementNotice | undefined {
  if (text.length > MAX_NOTICE_LENGTH) {
    return undefined;
  }
  const match = NOTICE.exec(text);
  if (!match) {
    return undefined;
  }
  return { retiredName: match[1].trim(), successorName: match[2]?.trim(), text: text.trim() };
}

/**
 * True while an answer that has so far produced `text` could still turn out
 * to be the notice — the stream holds it back until it knows.
 */
export function couldBeNotice(text: string): boolean {
  if (text.length > MAX_NOTICE_LENGTH) {
    return false;
  }
  return text.length < NOTICE_LEAD || /is no longer available/i.test(text);
}

/**
 * The answer's text when it is nothing but visible text — no reasoning, no
 * tool call — or undefined when it carries anything a notice never does.
 */
export function plainTextOf(response: GeminiResponse): string | undefined {
  let text = '';
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text !== 'string' || part.thought) {
        return undefined;
      }
      text += part.text;
    }
  }
  return text;
}
