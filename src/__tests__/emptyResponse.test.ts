import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

// The client reads settings through `vscode`, which only exists in the host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const http = require('../utils/http');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  CloudCodeClient,
  UpstreamError,
  configureTransientRetries,
  resetEndpointHealth,
} = require('../upstream/cloudCodeClient');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EmptyResponseWatch } = require('../upstream/emptyResponse');

configureTransientRetries([]);

/** An SSE response body made of the given event payloads. */
function sse(...payloads: unknown[]) {
  const body = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('');
  return { status: 200, headers: {}, stream: Readable.from([Buffer.from(body)]) };
}

function params(extra: Record<string, unknown> = {}) {
  return { model: 'gemini-3-flash-agent', request: {}, accessToken: 'token', ...extra };
}

async function collect(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function withTransport(reply: () => unknown) {
  const original = http.request;
  http.request = async () => reply();
  return () => (http.request = original);
}

test('stream: a rate limit reported inside the stream is thrown, not yielded', async () => {
  resetEndpointHealth();
  const restore = withTransport(() =>
    sse({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for model' },
    }),
  );

  try {
    const stream = await new CloudCodeClient().streamGenerate(params());
    await assert.rejects(
      () => collect(stream),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamError, `got ${error}`);
        // Classified as a rate limit, so the lease rotates to another account
        // instead of handing the caller a stream that produced nothing.
        assert.equal((error as any).status, 429);
        assert.equal((error as any).isRateLimit, true);
        return true;
      },
    );
  } finally {
    restore();
    resetEndpointHealth();
  }
});

test('stream: an error named only by its gRPC status still gets an HTTP status', async () => {
  resetEndpointHealth();
  const restore = withTransport(() =>
    sse({ error: { status: 'UNAVAILABLE', message: 'No capacity available for model' } }),
  );

  try {
    const stream = await new CloudCodeClient().streamGenerate(params());
    await assert.rejects(
      () => collect(stream),
      (error: unknown) => {
        assert.equal((error as any).status, 503);
        return true;
      },
    );
  } finally {
    restore();
    resetEndpointHealth();
  }
});

test('stream: ordinary chunks are still passed through untouched', async () => {
  resetEndpointHealth();
  const restore = withTransport(() =>
    sse({ response: { candidates: [{ content: { parts: [{ text: 'hello' }] } }] } }),
  );

  try {
    const chunks = (await collect(
      await new CloudCodeClient().streamGenerate(params()),
    )) as any[];
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].candidates[0].content.parts[0].text, 'hello');
  } finally {
    restore();
    resetEndpointHealth();
  }
});

test('empty response: a stream that carried nothing is a retryable failure', () => {
  const watch = new EmptyResponseWatch();
  watch.note({ candidates: [{ content: { parts: [] } }] });
  watch.note({ usageMetadata: { promptTokenCount: 12 } });

  const failure = watch.failure();
  assert.ok(failure, 'an empty stream should produce a failure');
  // Nothing reached the user, so asking again cannot duplicate an answer.
  assert.equal(failure.retryable, true);
  assert.match(failure.message, /empty response/i);
});

test('empty response: a safety stop is reported, never retried', () => {
  const watch = new EmptyResponseWatch();
  watch.note({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] });

  const failure = watch.failure();
  assert.ok(failure);
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /SAFETY/);
});

test('empty response: a blocked prompt names the block reason', () => {
  const watch = new EmptyResponseWatch();
  watch.note({ promptFeedback: { blockReason: 'OTHER' } });

  const failure = watch.failure();
  assert.ok(failure);
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /blocked the prompt \(OTHER\)/);
});

test('empty response: text, tool calls and shown thoughts all count as content', () => {
  const withText = new EmptyResponseWatch();
  withText.note({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
  assert.equal(withText.failure(), undefined);

  const withTool = new EmptyResponseWatch();
  withTool.note({
    candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: {} } }] } }],
  });
  assert.equal(withTool.failure(), undefined);

  // A thought was shown to the user even though it carries no answer; the
  // caller says so, and re-asking would print it twice.
  const withThought = new EmptyResponseWatch();
  withThought.note({ candidates: [{ content: { parts: [] } }] });
  withThought.markProduced();
  assert.equal(withThought.failure(), undefined);
});

test('empty response: a stream cut short by the token cap is not re-asked', () => {
  const watch = new EmptyResponseWatch();
  watch.note({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] });

  const failure = watch.failure();
  assert.ok(failure);
  assert.equal(failure.retryable, false);
});
