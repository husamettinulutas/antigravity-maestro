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
const {
  BROKEN_CALL_NUDGE,
  CONTINUE_NUDGE,
  EmptyResponseWatch,
  overlongPrompt,
  overlongResponse,
  retryAfter,
  withNudge,
} = require('../upstream/emptyResponse');

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

/** A watch that has seen `chunks`. */
function watched(...chunks: unknown[]) {
  const watch = new EmptyResponseWatch();
  chunks.forEach((chunk) => watch.note(chunk));
  return watch;
}

const REQUEST = {
  contents: [
    { role: 'user', parts: [{ text: 'fix the bug' }] },
    { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'edit_file', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'edit_file', response: { output: 'ok' } } }] },
  ],
};

test('empty response: a model that stops with nothing to say has finished its turn', () => {
  // What ends every autopilot session: the upstream closes with STOP and no
  // parts, usually right after a tool result. The model has decided it is done.
  const silence = watched(
    { candidates: [{ content: { parts: [] } }] },
    { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12 } },
  ).silence();

  assert.deepEqual(silence, { kind: 'finished', finishReason: 'STOP', thought: false });
});

test('empty response: a finished turn is asked once more with a nudge, never unchanged', () => {
  const silence = { kind: 'finished', finishReason: 'STOP', thought: false };
  const again = retryAfter(silence, REQUEST);

  // The identical request only gets the identical decision.
  assert.notEqual(again, REQUEST);
  assert.equal(again.contents.length, REQUEST.contents.length + 2);
  assert.equal(again.contents.at(-1).parts.at(-1).text, CONTINUE_NUDGE);
  // A model that reasoned before stopping is not asked again: its thoughts
  // are already on screen, and it has said its piece.
  assert.equal(retryAfter({ ...silence, thought: true }, REQUEST), undefined);
});

test('empty response: a stream with no finish reason was cut off and is re-sent unchanged', () => {
  const silence = watched({ candidates: [{ content: { parts: [] } }] }).silence();

  assert.equal(silence.kind, 'cutOff');
  assert.match(silence.message, /empty response \(1 chunk, none with content, no finish reason\)/);
  assert.equal(retryAfter(silence, REQUEST), REQUEST);
});

test('empty response: a safety stop is refused, never retried', () => {
  const silence = watched({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }).silence();

  assert.equal(silence.kind, 'refused');
  assert.match(silence.message, /SAFETY/);
  assert.equal(retryAfter(silence, REQUEST), undefined);
});

test('empty response: a blocked prompt names the block reason', () => {
  const silence = watched({ promptFeedback: { blockReason: 'OTHER' } }).silence();

  assert.equal(silence.kind, 'refused');
  assert.match(silence.message, /blocked the prompt \(OTHER\)/);
});

test('empty response: text and tool calls are answers; thoughts alone are not', () => {
  assert.equal(watched({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }).silence(), undefined);
  assert.equal(
    watched({
      candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: {} } }] } }],
    }).silence(),
    undefined,
  );

  // Copilot Chat counts only text and tool calls as a response, so a turn of
  // reasoning alone has to be settled like any other silent one.
  const thoughtOnly = watched({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'All done.', thought: true }] } }],
  }).silence();
  assert.deepEqual(thoughtOnly, { kind: 'finished', finishReason: 'STOP', thought: true });

  // The final answer's signature can arrive on an empty text part; that is
  // still nothing to show.
  const signatureOnly = watched({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '', thoughtSignature: 'sig-0123456789' }] } }],
  }).silence();
  assert.equal(signatureOnly.kind, 'finished');
});

test('empty response: a stream cut short by the token cap is not re-asked', () => {
  const silence = watched({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }).silence();

  assert.equal(silence.kind, 'refused');
  assert.equal(retryAfter(silence, REQUEST), undefined);
});

test('empty response: a malformed tool call is asked again, told what went wrong', () => {
  const silence = watched({
    candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'bad json', content: { parts: [] } }],
  }).silence();

  assert.equal(silence.kind, 'brokenCall');
  // The upstream's own explanation is kept for the log and the user.
  assert.match(silence.message, /MALFORMED_FUNCTION_CALL: bad json/);
  assert.equal(retryAfter(silence, REQUEST).contents.at(-1).parts.at(-1).text, BROKEN_CALL_NUDGE);
});

test('nudge: after tool results a model turn keeps the roles alternating', () => {
  const nudged = withNudge(REQUEST, 'go on');

  assert.deepEqual(nudged.contents.slice(-2), [
    { role: 'model', parts: [{ text: '[Tool execution completed.]' }] },
    { role: 'user', parts: [{ text: 'go on' }] },
  ]);
  // The caller's request — and so the client's history — is left alone.
  assert.equal(REQUEST.contents.length, 3);
});

test('nudge: after a user message it joins that message', () => {
  const request = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
  const nudged = withNudge(request, 'go on');

  assert.deepEqual(nudged.contents, [{ role: 'user', parts: [{ text: 'hi' }, { text: 'go on' }] }]);
  assert.deepEqual(request.contents[0].parts, [{ text: 'hi' }]);
});

// ── An overlong prompt ────────────────────────────────────────────────────────

const OPUS = { id: 'claude-opus-4-6-thinking', maxInputTokens: 200_000 };

test('overlong prompt: a conversation within the limit is sent', () => {
  // ~200k tokens of characters — right at the limit, where the character
  // estimate is not accurate enough to refuse.
  assert.equal(overlongPrompt(740_000, OPUS), undefined);
});

test('overlong prompt: only an impossible one is refused unsent', () => {
  // Nothing the estimate could get wrong explains 400k tokens against a 200k
  // limit, so this one never leaves.
  const refusal = overlongPrompt(1_480_000, OPUS);
  assert.match(refusal ?? '', /past what claude-opus-4-6-thinking accepts \(200k\)/);
  assert.match(refusal ?? '', /was not sent/);
});

test('overlong prompt: the upstream token count settles the near miss', () => {
  // The case the logs show: 208k prompt tokens against a 200k limit. The
  // upstream bills it and answers with nothing, and only its own count — not
  // the character estimate — can tell this from a conversation that fits.
  const message = overlongResponse({ promptTokenCount: 208_000 }, OPUS);
  assert.match(message ?? '', /208k tokens, past what claude-opus-4-6-thinking accepts/);
  assert.match(message ?? '', /billed and answered with nothing/);

  assert.equal(overlongResponse({ promptTokenCount: 199_000 }, OPUS), undefined);
  assert.equal(overlongResponse(undefined, OPUS), undefined);
});

test('overlong prompt: the silence it causes is a refusal, not a finished turn', () => {
  // Nudging would pay for the whole prompt a second time, for the same silence.
  const silence = watched({
    candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
    usageMetadata: { promptTokenCount: 208_000 },
  }).silence(OPUS);

  assert.equal(silence.kind, 'refused');
  assert.match(silence.message, /208k tokens, past what claude-opus-4-6-thinking accepts/);
});

// ── Decoding ──────────────────────────────────────────────────────────────────

test('sse: a character split across network chunks survives', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseSse } = require('../utils/sse');
  const bytes = Buffer.from('data: {"text":"düzeltiş 🚀"}\n\n', 'utf8');
  // Cut inside "ü" (two bytes) and inside the emoji (four).
  const u = bytes.indexOf(Buffer.from('ü', 'utf8'));
  const rocket = bytes.indexOf(Buffer.from('🚀', 'utf8'));
  const pieces = [bytes.subarray(0, u + 1), bytes.subarray(u + 1, rocket + 2), bytes.subarray(rocket + 2)];

  const texts: string[] = [];
  for await (const event of parseSse(Readable.from(pieces))) {
    texts.push(JSON.parse(event.data).text);
  }
  assert.deepEqual(texts, ['düzeltiş 🚀']);
});

// ── A stream that stops partway ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { testSettings } = require('./stubs/vscode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StreamBrokenError } = require('../upstream/cloudCodeClient');

const ONE_CHUNK = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n';

/** A response body that sends one chunk and then nothing, and never ends. */
function stalledBody(): Readable {
  const body = new Readable({ read() {} });
  body.push(Buffer.from(ONE_CHUNK));
  return body;
}

test('stream: an upstream that goes quiet is dropped with a named error', async () => {
  resetEndpointHealth();
  testSettings['requestTimeoutSeconds'] = 0.05;
  const restore = withTransport(() => ({ status: 200, headers: {}, stream: stalledBody() }));

  try {
    const seen: unknown[] = [];
    const stream = await new CloudCodeClient().streamGenerate(params());
    await assert.rejects(
      async () => {
        for await (const chunk of stream) {
          seen.push(chunk);
        }
      },
      (error: unknown) => {
        // Classified, so the turn can be asked again before anything is shown
        // — where it used to end as a bare "aborted".
        assert.ok(error instanceof StreamBrokenError, `got ${error}`);
        assert.equal((error as any).status, 504);
        assert.match((error as Error).message, /sent nothing for/);
        return true;
      },
    );
    assert.equal(seen.length, 1);
  } finally {
    restore();
    delete testSettings['requestTimeoutSeconds'];
    resetEndpointHealth();
  }
});

test('stream: a connection that drops mid-stream is a broken stream, not a bare abort', async () => {
  resetEndpointHealth();
  const body = stalledBody();
  setTimeout(() => body.destroy(new Error('aborted')), 10);
  const restore = withTransport(() => ({ status: 200, headers: {}, stream: body }));

  try {
    const stream = await new CloudCodeClient().streamGenerate(params());
    await assert.rejects(
      () => collect(stream),
      (error: unknown) => {
        assert.ok(error instanceof StreamBrokenError, `got ${error}`);
        assert.match((error as Error).message, /broke off \(aborted\)/);
        return true;
      },
    );
  } finally {
    restore();
    resetEndpointHealth();
  }
});
