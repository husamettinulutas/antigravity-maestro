import type { IncomingMessage } from 'http';

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Parse a text/event-stream body into events. Chunk boundaries never split an
 * event: incomplete tail data stays in the buffer until the next chunk arrives.
 */
export async function* parseSse(stream: IncomingMessage): AsyncGenerator<SseEvent> {
  let buffer = '';

  for await (const chunk of stream) {
    buffer += chunk.toString('utf-8');

    for (;;) {
      const separator = findSeparator(buffer);
      if (!separator) {
        break;
      }
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const event = parseBlock(block);
      if (event) {
        yield event;
      }
    }
  }

  const trailing = parseBlock(buffer);
  if (trailing) {
    yield trailing;
  }
}

function findSeparator(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');

  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  if (lf !== -1) {
    return { index: lf, length: 2 };
  }
  return null;
}

function parseBlock(block: string): SseEvent | null {
  const dataLines: string[] = [];
  let event: string | undefined;

  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    }
  }

  if (dataLines.length === 0) {
    return null;
  }
  return { event, data: dataLines.join('\n') };
}

/** Serialize an SSE event for the local gateway's responses. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
