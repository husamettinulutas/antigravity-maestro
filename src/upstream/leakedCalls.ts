import { GeminiPart, GeminiRequest, GeminiResponse } from '../protocol/gemini';
import { Logger } from '../utils/logger';

/**
 * How Gemini writes a tool call in its own syntax, e.g.
 *
 *     call:default_api:rename_chat
 *     {"title": "General Greeting"}
 *     </call:default_api:rename_chat>
 *
 * Now and then a Gemini model puts a call into its answer as this text
 * instead of making it (#14). The client sees an answer, not a call: the text
 * lands in the chat, nothing runs, and the turn ends.
 */
const MARKER = 'call:default_api:';

/** Gemini's own string delimiter, which the leaked syntax sometimes carries. */
const QUOTE_TOKEN = /<ctrl46>/g;

/** The tool names a request declares; leaked calls are recovered only to these. */
export function declaredToolNames(request: GeminiRequest): string[] {
  return (request.tools ?? []).flatMap((tool) =>
    (tool.functionDeclarations ?? []).map((declaration) => declaration.name),
  );
}

/**
 * Turns a tool call Gemini wrote as text back into the call it meant to make.
 *
 * Visible text is passed on as it comes, except for a trailing fragment that
 * could be the start of the marker. From the marker on, the text is held to
 * the end of the answer, then handed on as a `functionCall` when it names a
 * declared tool and its arguments parse; anything else goes on as the text it
 * was, so nothing the model said is lost.
 */
export class LeakedCallFilter {
  /** Released text held back because it could be the start of the marker. */
  private pending = '';
  /** Everything from the marker on, once it has been seen. */
  private capture: string | undefined;
  /** Parts that came after the marker, kept in order behind the capture. */
  private trailing: GeminiPart[] = [];

  constructor(private readonly tools: readonly string[]) {}

  /** The chunk as it should reach the client. */
  push(chunk: GeminiResponse): GeminiResponse {
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!candidate || !parts) {
      return chunk;
    }

    const out: GeminiPart[] = [];
    for (const part of parts) {
      if (typeof part.text !== 'string' || part.thought) {
        if (this.capture !== undefined) {
          this.trailing.push(part);
          continue;
        }
        if (this.pending !== '') {
          out.push({ text: this.pending });
          this.pending = '';
        }
        out.push(part);
        continue;
      }

      if (this.capture !== undefined) {
        this.capture += part.text;
        continue;
      }

      const text = this.pending + part.text;
      this.pending = '';
      const at = text.indexOf(MARKER);
      if (at >= 0) {
        if (at > 0) {
          out.push({ ...part, text: text.slice(0, at) });
        }
        this.capture = text.slice(at);
        continue;
      }

      const held = markerPrefixLength(text);
      this.pending = text.slice(text.length - held);
      const shown = text.slice(0, text.length - held);
      if (shown !== '') {
        out.push({ ...part, text: shown });
      }
    }

    // The finishing chunk is the last that reaches the client's mapper with
    // content, so whatever was held goes out with it.
    if (candidate.finishReason) {
      out.push(...this.settle());
    }

    return {
      ...chunk,
      candidates: [
        { ...candidate, content: { ...candidate.content!, parts: out } },
        ...chunk.candidates!.slice(1),
      ],
    };
  }

  /** What is still held once the stream ended without a finishing chunk. */
  finish(): GeminiPart[] {
    return this.settle();
  }

  private settle(): GeminiPart[] {
    const parts: GeminiPart[] = [];
    if (this.pending !== '') {
      parts.push({ text: this.pending });
      this.pending = '';
    }
    if (this.capture !== undefined) {
      parts.push(...recoverCalls(this.capture, this.tools), ...this.trailing);
      this.capture = undefined;
      this.trailing = [];
    }
    return parts;
  }
}

/** Pass a stream through a {@link LeakedCallFilter}; untouched when no tools are declared. */
export async function* recoverLeakedCalls(
  tools: readonly string[],
  chunks: AsyncIterable<GeminiResponse>,
): AsyncGenerator<GeminiResponse> {
  if (tools.length === 0) {
    yield* chunks;
    return;
  }
  const filter = new LeakedCallFilter(tools);
  for await (const chunk of chunks) {
    yield filter.push(chunk);
  }
  const rest = filter.finish();
  if (rest.length > 0) {
    yield { candidates: [{ content: { role: 'model', parts: rest } }] };
  }
}

/** The same, for a whole response at once. */
export function recoverLeakedCallsIn(tools: readonly string[], response: GeminiResponse): GeminiResponse {
  if (tools.length === 0) {
    return response;
  }
  const filter = new LeakedCallFilter(tools);
  const out = filter.push(response);
  const rest = filter.finish();
  const candidate = out.candidates?.[0];
  if (rest.length > 0 && candidate?.content) {
    candidate.content.parts.push(...rest);
  }
  return out;
}

/**
 * The calls in `text`, which starts at the marker. Stops at the first call it
 * cannot read and leaves the rest as text.
 */
function recoverCalls(text: string, tools: readonly string[]): GeminiPart[] {
  const parts: GeminiPart[] = [];
  let rest = text;

  for (;;) {
    const at = rest.indexOf(MARKER);
    if (at < 0) {
      break;
    }
    const call = readCall(rest.slice(at + MARKER.length), tools);
    if (!call) {
      Logger.warn(
        `Gemini wrote a tool call as text that names no declared tool or does not parse: ${rest.slice(at, at + 200)}`,
      );
      break;
    }
    const lead = rest.slice(0, at);
    if (lead.trim() !== '') {
      parts.push({ text: lead });
    }
    Logger.warn(`Gemini wrote a call to ${call.name} as text; it goes on as a tool call.`);
    parts.push({ functionCall: { name: call.name, args: call.args } });
    rest = call.rest;
  }

  if (rest.trim() !== '') {
    parts.push({ text: parts.length === 0 ? rest : rest.trimStart() });
  }
  return parts;
}

function readCall(
  text: string,
  tools: readonly string[],
): { name: string; args: Record<string, unknown>; rest: string } | undefined {
  const head = /^([\w.-]+)\s*/.exec(text);
  const name = head && resolveTool(head[1], tools);
  if (!head || !name) {
    return undefined;
  }

  const body = text.slice(head[0].length).replace(QUOTE_TOKEN, '"');
  const end = body.startsWith('{') ? objectEnd(body) : -1;
  if (end < 0) {
    return undefined;
  }
  const args = parseArgs(body.slice(0, end));
  if (!args) {
    return undefined;
  }

  const rest = body.slice(end).replace(/^\s*<\/call:default_api:[^>]*>/, '');
  return { name, args, rest };
}

/**
 * The declared tool a leaked name stands for. The name sometimes comes out
 * with a few stray characters after it (`rename_chatashions`), so the longest
 * declared name it starts with is taken when none matches exactly.
 */
function resolveTool(leaked: string, tools: readonly string[]): string | undefined {
  if (tools.includes(leaked)) {
    return leaked;
  }
  return tools
    .filter((tool) => tool.length >= 3 && leaked.startsWith(tool))
    .sort((a, b) => b.length - a.length)[0];
}

/** The index just past the `}` closing the object `text` opens, or -1. */
function objectEnd(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') {
        i++;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

/** JSON, or Gemini's own form of it with bare keys. */
function parseArgs(text: string): Record<string, unknown> | undefined {
  for (const candidate of [text, text.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Try the next reading.
    }
  }
  return undefined;
}

/** How many characters at the end of `text` could begin the marker. */
function markerPrefixLength(text: string): number {
  for (let length = Math.min(MARKER.length - 1, text.length); length > 0; length--) {
    if (MARKER.startsWith(text.slice(text.length - length))) {
      return length;
    }
  }
  return 0;
}
