import { createHash } from 'crypto';
import { GeminiPart, InlineData } from './gemini';
import { signatureStore } from './signatureStore';

/**
 * Images the image models generate.
 *
 * None of the client protocols has an image an assistant can answer with, so
 * an image goes out as markdown carrying a data URI — the one form every chat
 * client renders. A client sends that markdown back as text with the rest of
 * the history, and a ~1 MB base64 blob replayed as text is several hundred
 * thousand tokens, so on the way back in it is turned into an image again.
 *
 * The Gemini 3 image models sign every image they return and refuse a later
 * turn that replays one without its signature, so the signature is kept by the
 * image's bytes. An image whose signature is gone is retold as a short note.
 */

const IMAGE_MARKDOWN = /!\[[^\]]*\]\(data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)\)/g;

/** What an image is retold as when it can no longer be replayed. */
export const IMAGE_RETOLD = '[image generated earlier]';

/** True for an image the model generated as its answer, not while reasoning. */
export function isAnswerImage(part: GeminiPart): part is GeminiPart & { inlineData: InlineData } {
  return !part.thought && typeof part.inlineData?.data === 'string' && part.inlineData.data !== '';
}

/** The markdown a generated image is sent to the client as. */
export function imageMarkdown(part: GeminiPart & { inlineData: InlineData }, model: string): string {
  const { mimeType, data } = part.inlineData;
  signatureStore.set(imageKey(data), part.thoughtSignature, model);
  return `\n\n![image](data:${mimeType || 'image/png'};base64,${data})\n\n`;
}

/**
 * A model part from the client's history, with any image markdown in its text
 * turned back into an image: signed when its signature is known, retold
 * otherwise.
 */
export function replayImages(part: GeminiPart, model: string): GeminiPart[] {
  const text = part.text;
  if (part.thought || typeof text !== 'string' || !text.includes('base64,')) {
    return [part];
  }

  const parts: GeminiPart[] = [];
  // Every piece borders an image, and the blank lines around it are ours.
  const pushText = (value: string) => {
    const trimmed = value.trim();
    if (trimmed !== '') {
      parts.push({ text: trimmed });
    }
  };

  let last = 0;
  for (const match of text.matchAll(IMAGE_MARKDOWN)) {
    pushText(text.slice(last, match.index));
    last = match.index! + match[0].length;
    const [, mimeType, data] = match;
    const thoughtSignature = signatureStore.get(imageKey(data), model);
    parts.push(thoughtSignature ? { inlineData: { mimeType, data }, thoughtSignature } : { text: IMAGE_RETOLD });
  }
  if (last === 0) {
    return [part];
  }
  pushText(text.slice(last));
  return parts;
}

function imageKey(data: string): string {
  return `image:${createHash('sha256').update(data).digest('hex')}`;
}
